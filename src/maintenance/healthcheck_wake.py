"""Failure-only wake-up for the Mac Mini sync agent.

Runs from launchd at 07:23 America/New_York, off every scheduled job
minute (``ga4_sync`` is 07:20, ``gsc_sync`` is 07:25). Success is silent:
no webhook, no Telegram, exit 0. Any broken check POSTs compact JSON
``{checked_at, failures:[{check, detail}]}`` to
``GROKBOT_HEALTH_WEBHOOK_URL``.

Checks:
  1. Latest Vercel production deployment of project ``dashboard`` is READY.
     No ``VERCEL_TOKEN`` (or ``VERCEL_ACCESS_TOKEN``) → log once and skip.
  2. If the checkout is behind ``origin/main``, ff-only pull (same rules as
     ``git_auto_update``) then ``launchctl kickstart`` the sync agent.
     If any ``job_runs`` row is ``running``, skip the pull and the
     kickstart and report nothing — the checkout stays behind so the
     04:30 auto-update can still fast-forward and respawn. If the pull
     already landed and kickstart must wait, a marker file records the
     pending restart; the next quiet health check or 04:30 run honors
     it. A ``job_runs`` re-read that raises after the pull is a failure.
     Report when the pull fails or a kickstart that was sent fails.
  3. Each scheduled job that writes ``job_runs`` has a latest meaningful
     row of success (or partial) inside the freshness window from
     ``job_schedule``. A ``running`` row is healthy until it is older than
     its max runtime: the ads lock TTL (4h) for ads pulls and the long
     SP-API / Sunday backfill jobs, 1h otherwise. A live ads lock-file
     heartbeat keeps a pull healthy past that TTL. ``skipped`` /
     "another ads pull is running" rows are not failures.
  4. ``ads_day_completeness`` for Amazon D-1 (``amazon_as_of``) is CLEAR
     once ``GROKBOT_ADS_CLEAR_DEADLINE`` (default 07:15 America/New_York)
     has passed.

Read-only against Supabase. Does not import the Telegram notifier.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from src.alerts.job_health import INTERRUPTION_MARKERS
from src.maintenance.job_schedule import (
    JobSpec,
    required_started_at,
    scheduled_names,
)

log = logging.getLogger("healthcheck_wake")

WEBHOOK_URL_ENV = "GROKBOT_HEALTH_WEBHOOK_URL"
WEBHOOK_KEY_ENV = "GROKBOT_HEALTH_WEBHOOK_KEY"
WEBHOOK_HEADER_ENV = "GROKBOT_HEALTH_WEBHOOK_HEADER"
DEFAULT_WEBHOOK_HEADER = "Authorization: Bearer <key>"
ADS_DEADLINE_ENV = "GROKBOT_ADS_CLEAR_DEADLINE"
DEFAULT_ADS_DEADLINE = "07:15"
ADS_DEADLINE_TZ = "America/New_York"
SYNC_LABEL_ENV = "GROKBOT_SYNC_LAUNCHD_LABEL"
DEFAULT_SYNC_LABEL = "com.tallowbourn.salestax"
VERCEL_PROJECT = "dashboard"
VERCEL_API = "https://api.vercel.com/v6/deployments"

# Settled rows that mean the job is not broken. `partial` is how ads
# records "some data landed" (a timed-out chunk). `skipped` is handled
# separately so a busy-lock row is not the verdict.
OK_STATUSES = frozenset({"success", "partial"})
IGNORE_STATUSES = frozenset({"skipped", "cancelled"})
# SIGTERM during kickstart writes this from the ads job `finally`.
# It is a restart, not a broken sync. Kept local so the Telegram digest's
# interruption list is unchanged.
_EXTRA_IGNORE_MARKERS = (
    "interrupted before job_finish",
)
# A run may start a couple of minutes before its cron minute.
START_SKEW = timedelta(minutes=2)
# Short crons. Ads pulls and the long SP-API / Sunday jobs use the ads
# lock TTL instead (see max_running). A live ads lock-file heartbeat
# extends an ads pull past that TTL.
DEFAULT_MAX_RUNNING = timedelta(hours=1)
# No mid-run heartbeat. These are still inside a normal window at 07:23
# when they started at 04:00–06:20, so a 1h cap false-wakes.
_LONG_RUNNING_JOBS = frozenset({
    "spapi_refresh",
    "amazon_sku_month",
    "inventory_ledger_backfill",
    "sqp_sync",
})
_HEARTBEAT_KEYS = ("heartbeat_at", "last_heartbeat_at", "last_heartbeat")
JOB_LOOKBACK = timedelta(days=10)
DETAIL_LIMIT = 800

MISSING_WEBHOOK_LOG = (
    "GROKBOT_HEALTH_WEBHOOK_URL and GROKBOT_HEALTH_WEBHOOK_KEY are required; "
    "health check cannot report"
)
VERCEL_SKIP_LOG = (
    "vercel check skipped: no VERCEL_TOKEN (or VERCEL_ACCESS_TOKEN) configured"
)


@dataclass(frozen=True)
class Failure:
    check: str
    detail: str


def _clip(text: str, limit: int = DETAIL_LIMIT) -> str:
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def webhook_configured(env: Mapping[str, str]) -> bool:
    return bool((env.get(WEBHOOK_URL_ENV) or "").strip()) and bool(
        (env.get(WEBHOOK_KEY_ENV) or "").strip()
    )


def parse_webhook_header(spec: str, key: str) -> tuple[str, str]:
    """``Authorization: Bearer <key>`` → (``Authorization``, ``Bearer <key>``).

    A bare header name sends the key as the whole value.
    """
    raw = (spec or "").strip() or DEFAULT_WEBHOOK_HEADER
    rendered = raw.replace("<key>", key)
    if ":" in rendered:
        name, value = rendered.split(":", 1)
    else:
        name, value = rendered, key
    name = name.strip()
    value = value.strip()
    if not name or any(c in name + value for c in "\r\n"):
        raise ValueError("webhook header is empty or contains a newline")
    return name, value


def vercel_token(env: Mapping[str, str]) -> str:
    for name in ("VERCEL_TOKEN", "VERCEL_ACCESS_TOKEN"):
        value = (env.get(name) or "").strip()
        if value:
            return value
    return ""


def vercel_deployments_url(env: Mapping[str, str]) -> str:
    project = (env.get("VERCEL_PROJECT_ID") or VERCEL_PROJECT).strip() or VERCEL_PROJECT
    query = {
        "projectId": project,
        "target": "production",
        "limit": "5",
    }
    team = (env.get("VERCEL_ORG_ID") or env.get("VERCEL_TEAM_ID") or "").strip()
    if team:
        query["teamId"] = team
    return VERCEL_API + "?" + urllib.parse.urlencode(query)


def vercel_failure_from_payload(payload: dict) -> Failure | None:
    deployments = payload.get("deployments")
    if not isinstance(deployments, list) or not deployments:
        err = payload.get("error") or payload.get("message") or "no production deployments returned"
        if isinstance(err, dict):
            err = err.get("message") or json.dumps(err)
        return Failure("vercel", _clip(str(err)))
    prod = []
    for row in deployments:
        if not isinstance(row, dict):
            continue
        target = str(row.get("target") or "production").lower()
        if target != "production":
            continue
        prod.append(row)
    if not prod:
        return Failure("vercel", "no production deployment for project dashboard")
    latest = max(prod, key=lambda row: row.get("created") or row.get("createdAt") or 0)
    state = str(latest.get("readyState") or latest.get("state") or "").upper()
    uid = latest.get("uid") or latest.get("id") or "?"
    if state != "READY":
        return Failure(
            "vercel",
            _clip(f"latest production deployment {uid} is {state or 'UNKNOWN'}"),
        )
    return None


def parse_ads_deadline(raw: str | None) -> tuple[int, int]:
    text = (raw or "").strip() or DEFAULT_ADS_DEADLINE
    hour_s, minute_s = text.split(":", 1)
    hour, minute = int(hour_s), int(minute_s)
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"deadline out of range: {text}")
    return hour, minute


def deadline_reached(now: datetime, hour: int, minute: int, tz_name: str = ADS_DEADLINE_TZ) -> bool:
    local = now.astimezone(ZoneInfo(tz_name))
    due = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return local >= due


def parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _is_ignorable(row: dict) -> bool:
    status = str(row.get("status") or "").strip().lower()
    if status in IGNORE_STATUSES:
        return True
    message = str(row.get("message") or "")
    lowered = message.lower()
    markers = INTERRUPTION_MARKERS + _EXTRA_IGNORE_MARKERS
    return any(marker in lowered for marker in markers)


def max_running(job_name: str) -> timedelta:
    """How long a `running` row may stay open with no live heartbeat.

    Ads pulls use ``ads.lock_ttl_hours`` (4h), the same ceiling
    ``fail_stale_ads_job_runs`` uses when the lease is dead. SP-API
    refresh and the Sunday backfills have no lock file and no mid-run
    ``job_runs`` heartbeat; they share that 4h ceiling so a pull that is
    still going at 07:23 is not a wake. A live ads lock-file heartbeat
    extends an ads pull past the ceiling. Other crons are 1h.
    """
    from src.amazon_ads.sync_lock import is_ads_pull_job
    from src.rules import ADS_LOCK_TTL_HOURS

    if is_ads_pull_job(job_name) or job_name in _LONG_RUNNING_JOBS:
        return timedelta(hours=int(ADS_LOCK_TTL_HOURS))
    return DEFAULT_MAX_RUNNING


def _ads_lock_covers(row: dict, now: datetime) -> bool:
    """True when the ads lock file's heartbeat belongs to this running row.

    Nothing writes ``heartbeat_at`` onto ``job_runs`` (stats land at
    ``job_finish``). The live beat is ``logs/ads_sync.lock.json``.
    """
    from src.amazon_ads.sync_lock import (
        _row_belongs_to_live_lease,
        is_ads_pull_job,
        lease_is_live,
        read_lease,
    )

    name = str(row.get("job_name") or "")
    if not is_ads_pull_job(name):
        return False
    lease = read_lease()
    if not lease_is_live(lease, now):
        return False
    job = str((lease or {}).get("job") or "")
    if job != name:
        return False
    return _row_belongs_to_live_lease(row, lease)


def _heartbeat_stale_after() -> timedelta:
    """Same window the ads lease uses for a live heartbeat."""
    from src.rules import ADS_LOCK_HEARTBEAT_STALE_MINUTES

    return timedelta(minutes=int(ADS_LOCK_HEARTBEAT_STALE_MINUTES))


def _row_heartbeat(row: dict) -> datetime | None:
    """Heartbeat on the row, when job_runs carries one.

    Top-level columns and `stats` (object or JSON string) are both read.
    `started_at` is not a heartbeat.
    """
    for key in _HEARTBEAT_KEYS:
        found = parse_ts(row.get(key))
        if found is not None:
            return found
    stats = row.get("stats")
    if isinstance(stats, str) and stats.strip():
        try:
            stats = json.loads(stats)
        except (TypeError, ValueError):
            stats = None
    if isinstance(stats, dict):
        for key in _HEARTBEAT_KEYS:
            found = parse_ts(stats.get(key))
            if found is not None:
                return found
    return None


def _heartbeat_is_fresh(row: dict, now: datetime) -> bool:
    beat = _row_heartbeat(row)
    if beat is None:
        return False
    moment = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    beat_at = beat if beat.tzinfo else beat.replace(tzinfo=timezone.utc)
    return moment - beat_at <= _heartbeat_stale_after()


def _running_is_healthy(spec: JobSpec, row: dict, now: datetime) -> bool:
    """True while the run is inside its max runtime, or a real heartbeat is live.

    Yesterday's success can still satisfy the grace window. A `running`
    row older than ``max_running`` is stuck unless the ads lock file (or
    a heartbeat actually stored on the row) is still fresh.
    """
    if _heartbeat_is_fresh(row, now) or _ads_lock_covers(row, now):
        return True
    started = parse_ts(row.get("started_at"))
    if started is None:
        return False
    moment = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    started_at = started if started.tzinfo else started.replace(tzinfo=timezone.utc)
    return moment - started_at <= max_running(spec.name)


def evaluate_job(spec: JobSpec, rows: list[dict], now: datetime) -> Failure | None:
    """Latest meaningful row must be success/partial and inside the window."""
    required = required_started_at(spec, now)
    mine = [r for r in rows if (r.get("job_name") or "") == spec.name]
    mine.sort(key=lambda r: r.get("started_at") or "", reverse=True)
    meaningful = [r for r in mine if not _is_ignorable(r)]
    if not meaningful:
        if mine:
            latest = mine[0]
            msg = str(latest.get("message") or latest.get("status") or "skipped")
            return Failure(
                f"job:{spec.name}",
                _clip(
                    f"no success since {required.isoformat()} "
                    f"(newest row {latest.get('status')}: {msg})"
                ),
            )
        return Failure(
            f"job:{spec.name}",
            _clip(f"no job_runs row since {required.isoformat()}"),
        )

    latest = meaningful[0]
    status = str(latest.get("status") or "").strip().lower()
    started = parse_ts(latest.get("started_at"))
    message = str(latest.get("message") or "").strip()
    fresh = started is not None and started >= required - START_SKEW

    if status == "running" and _running_is_healthy(spec, latest, now):
        return None
    if status in OK_STATUSES and fresh:
        return None
    if status in OK_STATUSES and not fresh:
        when = started.isoformat() if started else "unknown"
        return Failure(
            f"job:{spec.name}",
            _clip(f"stale {status} at {when}; need a run since {required.isoformat()}"),
        )
    if status == "running":
        when = started.isoformat() if started else "unknown"
        hours = int(max_running(spec.name).total_seconds() // 3600)
        return Failure(
            f"job:{spec.name}",
            _clip(f"still running since {when} (older than {hours}h)"),
        )
    detail = message or status or "failed"
    return Failure(f"job:{spec.name}", _clip(f"{status or 'fail'}: {detail}"))


def evaluate_jobs(
    specs: list[JobSpec],
    gates: Mapping[str, bool],
    rows: list[dict],
    now: datetime,
) -> list[Failure]:
    failures = []
    for name in scheduled_names(list(specs), dict(gates)):
        spec = next(s for s in specs if s.name == name)
        found = evaluate_job(spec, rows, now)
        if found:
            failures.append(found)
    failures.sort(key=lambda f: f.check)
    return failures


def evaluate_completeness(row: dict | None, day: date) -> Failure | None:
    if not row:
        return Failure(
            "ads_day_completeness",
            f"{day.isoformat()} has no row (want CLEAR)",
        )
    status = str(row.get("status") or "").strip().upper()
    if status == "CLEAR":
        return None
    reason = str(row.get("reason") or "").strip()
    detail = f"{day.isoformat()} status={status or 'MISSING'}"
    if reason:
        detail += f" reason={reason}"
    return Failure("ads_day_completeness", _clip(detail))


def any_job_running(rows: list[dict]) -> bool:
    """True when any job_runs row is `running`, scheduled or not.

    `launchctl kickstart -k` SIGKILLs the sync agent. A stuck row counts
    too: the 04:30 auto-update loads new code without this check killing
    the process.
    """
    for row in rows:
        if str(row.get("status") or "").strip().lower() == "running":
            return True
    return False


_QUIET_CHECKOUT = frozenset({"up_to_date", "disabled", "skipped", "dry_run"})


def _defer_kickstart(commit: str | None) -> None:
    from src.maintenance.restart_pending import mark_restart_pending

    mark_restart_pending(commit)


def apply_checkout(
    git_update: Callable[[], dict],
    kickstart: Callable[[], tuple[bool, str]],
    job_running: Callable[[], bool] | None = None,
) -> Failure | None:
    """Ff-only pull when behind, then kickstart. Silent when that works.

    If a job is already running, do not pull and do not kickstart. The
    checkout stays behind so the 04:30 auto-update can fast-forward and
    respawn. That skip is not a failure.

    If the pull already happened and a job is running (or the job_runs
    re-read raises), record a pending restart instead of dropping it.
    The re-read error is reported. The next quiet health check, or the
    04:30 job, performs the restart.
    """
    from src.maintenance.restart_pending import (
        clear_restart_pending,
        restart_is_pending,
    )

    pending = restart_is_pending()
    if job_running is not None and not pending:
        try:
            busy = job_running()
        except Exception as e:
            log.warning("checkout skipped; could not read job_runs: %s", e)
            return None
        if busy:
            log.info(
                "checkout skipped because a job is running; "
                "04:30 auto-update will catch up"
            )
            return None
    try:
        result = git_update()
    except Exception as e:
        return Failure("mini_checkout", _clip(f"auto-update raised: {e}"))
    status = str(result.get("status") or "")
    commit = str(result.get("commit") or "") or None
    want_kick = status == "updated" or (pending and status in _QUIET_CHECKOUT)
    if want_kick:
        if job_running is not None:
            try:
                busy = job_running()
            except Exception as e:
                _defer_kickstart(commit)
                return Failure(
                    "mini_checkout",
                    _clip(
                        "fast-forwarded but could not re-read job_runs "
                        f"before kickstart: {e}"
                    ),
                )
            if busy:
                _defer_kickstart(commit)
                log.info(
                    "kickstart deferred; restart pending until no job is running"
                )
                return None
        try:
            ok, err = kickstart()
        except Exception as e:
            _defer_kickstart(commit)
            return Failure(
                "mini_checkout",
                _clip(f"fast-forwarded but kickstart raised: {e}"),
            )
        if not ok:
            _defer_kickstart(commit)
            return Failure(
                "mini_checkout",
                _clip(f"fast-forwarded but launchctl kickstart failed: {err}"),
            )
        clear_restart_pending()
        return None
    if status in _QUIET_CHECKOUT:
        return None
    detail = result.get("error") or result.get("message") or status or "failed"
    return Failure("mini_checkout", _clip(f"{status}: {detail}"))


def failure_payload(checked_at: datetime, failures: list[Failure]) -> dict:
    moment = checked_at if checked_at.tzinfo else checked_at.replace(tzinfo=timezone.utc)
    return {
        "checked_at": moment.astimezone(timezone.utc).isoformat(),
        "failures": [{"check": f.check, "detail": f.detail} for f in failures],
    }


def execute(
    env: Mapping[str, str],
    *,
    now: datetime,
    specs: list[JobSpec],
    gates: Mapping[str, bool],
    fetch_job_runs: Callable[[datetime], list[dict]],
    fetch_completeness: Callable[[date], dict | None],
    fetch_vercel: Callable[[str, str], dict],
    git_update: Callable[[], dict],
    kickstart: Callable[[], tuple[bool, str]],
    post_webhook: Callable[[str, dict, str, str], None],
    as_of: Callable[[datetime], date],
) -> int:
    """Run every check. Exit 0 when healthy. Exit 2 when the webhook is unset."""
    if not webhook_configured(env):
        log.error(MISSING_WEBHOOK_LOG)
        return 2

    failures: list[Failure] = []

    token = vercel_token(env)
    if not token:
        log.warning(VERCEL_SKIP_LOG)
    else:
        try:
            payload = fetch_vercel(vercel_deployments_url(env), token)
            found = vercel_failure_from_payload(payload)
        except Exception as e:
            found = Failure("vercel", _clip(f"request failed: {e}"))
        if found:
            failures.append(found)

    # Read the warehouse before any kickstart. `launchctl kickstart -k`
    # SIGTERMs the sync agent and can write an interrupt row; judging
    # that row would page on a checkout this check just refreshed.
    try:
        rows = fetch_job_runs(now)
    except Exception as e:
        failures.append(Failure("job_runs", _clip(f"read failed: {e}")))
    else:
        failures.extend(evaluate_jobs(specs, gates, rows, now))

    try:
        hour, minute = parse_ads_deadline(env.get(ADS_DEADLINE_ENV))
    except ValueError as e:
        failures.append(Failure("ads_day_completeness", _clip(f"bad deadline: {e}")))
    else:
        if deadline_reached(now, hour, minute):
            day = as_of(now)
            try:
                row = fetch_completeness(day)
            except Exception as e:
                failures.append(
                    Failure("ads_day_completeness", _clip(f"read failed: {e}"))
                )
            else:
                found = evaluate_completeness(row, day)
                if found:
                    failures.append(found)

    def _job_running() -> bool:
        # Re-read after the pull. A job that started while git ran still
        # blocks kickstart. Any `running` row counts, not only scheduled ones.
        return any_job_running(fetch_job_runs(datetime.now(timezone.utc)))

    checkout = apply_checkout(git_update, kickstart, job_running=_job_running)
    if checkout:
        failures.append(checkout)

    if not failures:
        return 0

    log.error(
        "health check failures: %s",
        "; ".join(f"{f.check}: {f.detail}" for f in failures)[:2000],
    )
    url = (env.get(WEBHOOK_URL_ENV) or "").strip()
    key = (env.get(WEBHOOK_KEY_ENV) or "").strip()
    try:
        header_name, header_value = parse_webhook_header(
            env.get(WEBHOOK_HEADER_ENV) or "", key,
        )
        post_webhook(url, failure_payload(now, failures), header_name, header_value)
    except Exception as e:
        log.error("webhook post failed: %s", e)
        return 1
    return 1


def fetch_vercel_deployments(url: str, token: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:300]
        raise RuntimeError(f"Vercel HTTP {e.code}: {body}") from None


def post_json(url: str, payload: dict, header_name: str, header_value: str) -> None:
    body = json.dumps(payload, separators=(",", ":")).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            header_name: header_value,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"webhook HTTP {e.code}") from None


def select_job_runs(client, since: datetime) -> list[dict]:
    """Read recent job_runs. Selects only — never insert, update, or delete."""
    since_iso = since.astimezone(timezone.utc).isoformat()
    rows: list[dict] = []
    page = 1000
    offset = 0
    while offset < 20000:
        resp = (
            client.table("job_runs")
            .select("job_name,status,message,started_at,finished_at,stats")
            .gte("started_at", since_iso)
            .order("started_at", desc=True)
            .range(offset, offset + page - 1)
            .execute()
        )
        batch = list(resp.data or [])
        rows.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return rows


def select_ads_day_completeness(client, day: date) -> dict | None:
    """Read one completeness row. Does not refresh or upsert it."""
    resp = (
        client.table("ads_day_completeness")
        .select("date,status,reason,updated_at")
        .eq("date", day.isoformat())
        .limit(1)
        .execute()
    )
    data = list(resp.data or [])
    return data[0] if data else None


def checkout_git_update() -> dict:
    """Ff-only pull. Does not exit this process and does not Telegram."""
    from src.maintenance.git_auto_update import run_auto_update

    return run_auto_update(restart=False, force=True)


def kickstart_sync_agent(label: str | None = None, uid: int | None = None) -> tuple[bool, str]:
    """Reload the existing sync LaunchAgent so it picks up the new checkout."""
    name = (label or os.environ.get(SYNC_LABEL_ENV) or DEFAULT_SYNC_LABEL).strip()
    user = os.getuid() if uid is None else uid
    target = f"gui/{user}/{name}"
    try:
        proc = subprocess.run(
            ["launchctl", "kickstart", "-k", target],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except Exception as e:
        return False, _clip(f"{target}: {e}")
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "kickstart failed").strip()
        return False, _clip(f"{target}: {err}")
    return True, ""


def current_gates() -> dict[str, bool]:
    from src.config import settings
    from src.maintenance.git_auto_update import is_enabled
    from src.maintenance.job_schedule import sqp_schedule_enabled
    from src.phase2_connectors import connector_env_ready

    sp = bool(settings.amazon_sp_enabled)
    return {
        "shopify": bool(settings.shopify_enabled),
        "amazon_sp": sp,
        "amazon_ads": bool(settings.amazon_ads_enabled),
        "sqp": sp and sqp_schedule_enabled(),
        "ga4": connector_env_ready("ga4"),
        "gsc": connector_env_ready("gsc"),
        "google_ads": connector_env_ready("google_ads"),
        "meta_ads": connector_env_ready("meta_ads"),
        "git": is_enabled(),
    }


def main() -> int:
    from src.config import load_project_dotenv
    from src.maintenance.job_schedule import build_job_specs
    from src.rules import amazon_as_of

    load_project_dotenv()
    now = datetime.now(timezone.utc)

    def fetch_runs(_now: datetime) -> list[dict]:
        from src.db import get_client

        return select_job_runs(get_client(), _now - JOB_LOOKBACK)

    def fetch_day(day: date) -> dict | None:
        from src.db import get_client

        return select_ads_day_completeness(get_client(), day)

    label = os.environ.get(SYNC_LABEL_ENV) or DEFAULT_SYNC_LABEL

    return execute(
        os.environ,
        now=now,
        specs=build_job_specs(),
        gates=current_gates(),
        fetch_job_runs=fetch_runs,
        fetch_completeness=fetch_day,
        fetch_vercel=fetch_vercel_deployments,
        git_update=checkout_git_update,
        kickstart=lambda: kickstart_sync_agent(label),
        post_webhook=post_json,
        as_of=amazon_as_of,
    )


if __name__ == "__main__":
    raise SystemExit(main())
