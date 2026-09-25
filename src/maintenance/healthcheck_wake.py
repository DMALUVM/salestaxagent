"""Failure-only wake-up for the Mac Mini sync agent.

Runs from launchd at 07:20 America/New_York. Success is silent: no
webhook, no Telegram, exit 0. Any broken check POSTs compact JSON
``{checked_at, failures:[{check, detail}]}`` to
``GROKBOT_HEALTH_WEBHOOK_URL``.

Checks:
  1. Latest Vercel production deployment of project ``dashboard`` is READY.
     No ``VERCEL_TOKEN`` (or ``VERCEL_ACCESS_TOKEN``) → log once and skip.
  2. If the checkout is behind ``origin/main``, ff-only pull (same rules as
     ``git_auto_update``) then ``launchctl kickstart`` the sync agent.
     Kickstart waits while a job is in flight or a cron is inside 3
     minutes (07:20 is also ``ga4_sync``). If the agent is still busy
     after 45 minutes, it is left running and that is reported.
     Report only when the pull, the wait, or the kickstart fails.
  3. Each scheduled job that writes ``job_runs`` has a latest meaningful
     row of success (or partial) inside the freshness window from
     ``job_schedule``. ``skipped`` / "another ads pull is running" rows
     are not failures.
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
import time
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
    next_fire,
    previous_fire,
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
# Longer than this, a `running` row is hung. Matches the ads lease TTL:
# job_runs.status=running is not itself a lock, and a live pull is not
# still in flight a day later just because misfire grace reached back
# to yesterday's slot.
JOB_LOOKBACK = timedelta(days=10)
DETAIL_LIMIT = 800
# `launchctl kickstart -k` SIGKILLs the sync agent. 07:20 is also ga4_sync,
# then gsc / google ads / meta through 07:35. Do not kill a fresh running
# job or a cron that is about to start. Wait, and if the agent is still
# busy, report that and leave it running.
KICKSTART_FIRE_GUARD = timedelta(minutes=3)
KICKSTART_POLL_SECONDS = 15
KICKSTART_MAX_WAIT_SECONDS = 45 * 60

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


def _max_running() -> timedelta:
    from src.rules import ADS_LOCK_TTL_HOURS

    return timedelta(hours=int(ADS_LOCK_TTL_HOURS))


def _running_is_in_flight(spec: JobSpec, started: datetime | None, now: datetime) -> bool:
    """True when this `running` row is the current slot, not a hung prior day.

    Success may use the grace-relaxed window (yesterday's ga4 success is
    fine at 07:20, before today's slot has to have finished). A running
    row may not: it has to have started at or after the latest cron fire,
    and it cannot be older than the ads lock TTL.
    """
    if started is None:
        return False
    moment = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    started_at = started if started.tzinfo else started.replace(tzinfo=timezone.utc)
    if moment - started_at > _max_running():
        return False
    if spec.interval_seconds:
        required = required_started_at(spec, moment)
        return started_at >= required - START_SKEW
    last = previous_fire(spec, moment)
    if last is None:
        return False
    return started_at >= last - START_SKEW


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

    if status == "running" and _running_is_in_flight(spec, started, now):
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
        return Failure(
            f"job:{spec.name}",
            _clip(f"still running since {when}"),
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


def _latest_meaningful(rows: list[dict], name: str) -> dict | None:
    mine = [r for r in rows if (r.get("job_name") or "") == name and not _is_ignorable(r)]
    if not mine:
        return None
    mine.sort(key=lambda r: r.get("started_at") or "", reverse=True)
    return mine[0]


def _slot_settled(rows: list[dict], name: str, fire: datetime) -> bool:
    """True when this fire already has a terminal row (not still running)."""
    latest = _latest_meaningful(rows, name)
    if latest is None:
        return False
    started = parse_ts(latest.get("started_at"))
    if started is None or started < fire - START_SKEW:
        return False
    status = str(latest.get("status") or "").strip().lower()
    return status != "running"


def kickstart_blockers(
    specs: list[JobSpec],
    gates: Mapping[str, bool],
    rows: list[dict],
    now: datetime,
) -> list[str]:
    """Jobs that make `kickstart -k` unsafe right now.

    A fresh `running` row is an in-flight sync. A cron inside the guard
    window is either about to start or just started and may not have
    written `job_runs` yet. Interval jobs block only while a fresh row
    is `running` — their next tick is not a clock time we can see.
    """
    blocked: list[str] = []
    moment = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    for name in scheduled_names(list(specs), dict(gates)):
        spec = next(s for s in specs if s.name == name)
        latest = _latest_meaningful(rows, name)
        if latest is not None:
            status = str(latest.get("status") or "").strip().lower()
            started = parse_ts(latest.get("started_at"))
            if status == "running" and _running_is_in_flight(spec, started, moment):
                blocked.append(name)
                continue
        if spec.interval_seconds:
            continue
        upcoming = next_fire(spec, moment)
        if upcoming is not None and upcoming - moment.astimezone(upcoming.tzinfo) <= KICKSTART_FIRE_GUARD:
            blocked.append(name)
            continue
        last = previous_fire(spec, moment)
        if last is None:
            continue
        age = moment.astimezone(last.tzinfo) - last
        if timedelta(0) <= age <= KICKSTART_FIRE_GUARD and not _slot_settled(rows, name, last):
            blocked.append(name)
    return sorted(set(blocked))


def wait_until_kickstart_quiet(
    specs: list[JobSpec],
    gates: Mapping[str, bool],
    fetch_job_runs: Callable[[datetime], list[dict]],
    *,
    clock: Callable[[], datetime],
    sleep: Callable[[float], None],
    max_wait_seconds: float = KICKSTART_MAX_WAIT_SECONDS,
    poll_seconds: float = KICKSTART_POLL_SECONDS,
) -> tuple[bool, str]:
    """Poll until kickstart will not SIGKILL an active or imminent job."""
    deadline = clock() + timedelta(seconds=max_wait_seconds)
    while True:
        moment = clock()
        try:
            rows = fetch_job_runs(moment)
        except Exception as e:
            blockers = ["job_runs"]
            why = f"could not read job_runs before kickstart: {e}"
        else:
            blockers = kickstart_blockers(specs, gates, rows, moment)
            why = "still busy: " + ", ".join(blockers)
        if not blockers:
            return True, ""
        if moment >= deadline:
            return False, _clip(why)
        sleep(poll_seconds)


def apply_checkout(
    git_update: Callable[[], dict],
    kickstart: Callable[[], tuple[bool, str]],
    ready: Callable[[], tuple[bool, str]] | None = None,
) -> Failure | None:
    """Ff-only pull when behind, then kickstart. Silent when that works.

    `ready` waits until an in-flight morning job has finished. If it
    never clears, the checkout stays updated and the agent is left
    running — `kickstart -k` is not sent.
    """
    try:
        result = git_update()
    except Exception as e:
        return Failure("mini_checkout", _clip(f"auto-update raised: {e}"))
    status = str(result.get("status") or "")
    if status == "updated":
        if ready is not None:
            try:
                clear, why = ready()
            except Exception as e:
                return Failure(
                    "mini_checkout",
                    _clip(f"fast-forwarded but did not kickstart: {e}"),
                )
            if not clear:
                return Failure(
                    "mini_checkout",
                    _clip(f"fast-forwarded but did not kickstart: {why}"),
                )
        try:
            ok, err = kickstart()
        except Exception as e:
            return Failure(
                "mini_checkout",
                _clip(f"fast-forwarded but kickstart raised: {e}"),
            )
        if not ok:
            return Failure(
                "mini_checkout",
                _clip(f"fast-forwarded but launchctl kickstart failed: {err}"),
            )
        return None
    if status in {"up_to_date", "disabled", "skipped", "dry_run"}:
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
    clock: Callable[[], datetime] | None = None,
    sleep: Callable[[float], None] | None = None,
    max_kickstart_wait: float = KICKSTART_MAX_WAIT_SECONDS,
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

    def _ready() -> tuple[bool, str]:
        return wait_until_kickstart_quiet(
            specs,
            gates,
            fetch_job_runs,
            clock=clock or (lambda: datetime.now(timezone.utc)),
            sleep=sleep or time.sleep,
            max_wait_seconds=max_kickstart_wait,
        )

    checkout = apply_checkout(git_update, kickstart, ready=_ready)
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
            .select("job_name,status,message,started_at,finished_at")
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
