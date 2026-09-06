"""Durable single-writer lease for Amazon Ads pulls.

Single-writer: only the scheduler and the explicit `ads-sync` CLI may pull
(the Sunday/one-shot `ads-search-terms-backfill` twin uses this same lease).
`job_runs.status=running` is an audit row, not the lock. After kickstart,
kill, or crash the lease dies with the PID / heartbeat so morning jobs are
not blocked by an orphan row.

Telegram stays quiet for routine stale clears — one log line only.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

from src.rules import ADS_LOCK_HEARTBEAT_STALE_MINUTES, ADS_LOCK_TTL_HOURS

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent.parent
STALE_RUNNING_MESSAGE = "stale running row auto-failed (no heartbeat)"

# Pull jobs that take the ads reporting slot. ads_actions / ads_outcomes
# are not pulls and must not be auto-failed when the lease is idle.
ADS_PULL_JOBS = frozenset({
    "ads_sync",
    "ads_campaigns_sync",
    "ads_search_terms_sync",
    "ads_search_terms_backfill",
    "ads_search_terms_gap_fill",
    "ads_placements_sync",
    "ads_campaigns_backfill",
    "ads_sb_sd_heal",
})

# In-process mutex — same object reports.py exposes as _SYNC_LOCK so
# existing overlap tests keep working.
THREAD_LOCK = threading.Lock()
LOCK_WAIT_SECONDS = 45

_LOCK_PATH_OVERRIDE: Path | None = None
_beat_stop = threading.Event()
_beat_thread: threading.Thread | None = None
_BEAT_INTERVAL_SECONDS = 60


def ads_lock_path() -> Path:
    if _LOCK_PATH_OVERRIDE is not None:
        return _LOCK_PATH_OVERRIDE
    override = os.environ.get("ADS_SYNC_LOCK_PATH")
    if override:
        return Path(override)
    return ROOT / "logs" / "ads_sync.lock.json"


def pid_is_alive(pid: int) -> bool:
    """True when `pid` names a live process. Dead / bogus PIDs are False."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _parse_iso(raw) -> datetime | None:
    if not raw:
        return None
    try:
        text = str(raw).replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except (TypeError, ValueError):
        return None


def read_lease(path: Path | None = None) -> dict | None:
    p = path or ads_lock_path()
    try:
        data = json.loads(p.read_text())
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def lease_is_live(lease: dict | None, now: datetime | None = None) -> bool:
    """Live = PID alive AND heartbeat fresher than the stale window."""
    if not lease:
        return False
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    if not pid_is_alive(lease.get("pid")):
        return False
    beat = _parse_iso(lease.get("heartbeat_at") or lease.get("started_at"))
    if beat is None:
        return False
    stale_after = timedelta(minutes=ADS_LOCK_HEARTBEAT_STALE_MINUTES)
    return (now - beat) <= stale_after


def _write_lease(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload))
    tmp.replace(path)


def _lease_payload(job: str | None = None) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    return {
        "pid": os.getpid(),
        "heartbeat_at": now,
        "started_at": now,
        "job": job or "ads_sync",
    }


def beat_ads_lease() -> None:
    """Refresh heartbeat_at while this process holds the lease."""
    path = ads_lock_path()
    lease = read_lease(path) or {}
    if lease.get("pid") not in (None, os.getpid()):
        return
    lease = dict(lease)
    lease["pid"] = os.getpid()
    lease["heartbeat_at"] = datetime.now(timezone.utc).isoformat()
    lease.setdefault("started_at", lease["heartbeat_at"])
    lease.setdefault("job", "ads_sync")
    try:
        _write_lease(path, lease)
    except Exception as e:
        log.warning("Ads lock heartbeat write failed: %s", e)


def _start_beater() -> None:
    global _beat_thread
    _beat_stop.clear()

    def loop() -> None:
        while not _beat_stop.wait(_BEAT_INTERVAL_SECONDS):
            try:
                beat_ads_lease()
            except Exception as e:
                log.warning("Ads lock heartbeat: %s", e)

    _beat_thread = threading.Thread(
        target=loop, name="ads-lock-beat", daemon=True)
    _beat_thread.start()


def _stop_beater() -> None:
    _beat_stop.set()


def claim_ads_lease(job: str | None = None) -> bool:
    """Write our PID+heartbeat. False when another live holder exists."""
    path = ads_lock_path()
    existing = read_lease(path)
    if lease_is_live(existing) and existing.get("pid") != os.getpid():
        return False
    payload = _lease_payload(job)
    if existing and existing.get("pid") == os.getpid() and existing.get("started_at"):
        payload["started_at"] = existing["started_at"]
        payload["job"] = existing.get("job") or payload["job"]
    _write_lease(path, payload)
    check = read_lease(path)
    if not check or check.get("pid") != os.getpid():
        return False
    _start_beater()
    return True


def release_ads_lease() -> None:
    """Drop the file lease if we own it. Safe to call when we do not."""
    _stop_beater()
    path = ads_lock_path()
    lease = read_lease(path)
    if lease and lease.get("pid") not in (None, os.getpid()):
        return
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass
    tmp = path.with_suffix(".tmp")
    try:
        tmp.unlink(missing_ok=True)
    except Exception:
        pass


def is_ads_pull_job(job_name: str) -> bool:
    return (job_name or "") in ADS_PULL_JOBS


def _row_started(row: dict) -> datetime | None:
    return _parse_iso(row.get("started_at"))


def _row_belongs_to_live_lease(row: dict, lease: dict) -> bool:
    """Keep the current holder's running row; fail leftovers from before it."""
    row_start = _row_started(row)
    lease_start = _parse_iso(lease.get("started_at"))
    if row_start is None or lease_start is None:
        return lease.get("pid") == os.getpid()
    return row_start >= lease_start - timedelta(seconds=90)


def fail_stale_ads_job_runs(*, now: datetime | None = None) -> list[dict]:
    """Auto-fail orphan ads pull rows. Quiet — log only, no Telegram.

    A row is failed when the PID/heartbeat lease is dead, or the row is
    older than ADS_LOCK_TTL_HOURS with no live lease of its own. A live
    heartbeat keeps a long in-flight pull (3h+ SB/SD) from being failed.
    """
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    try:
        from src.db import get_client, job_finish
        rows = (
            get_client().table("job_runs")
            .select("id,job_name,status,started_at")
            .eq("status", "running")
            .order("started_at", desc=True)
            .limit(80)
            .execute().data
        ) or []
    except Exception as e:
        log.warning("fail_stale_ads_job_runs: could not read job_runs: %s", e)
        return []

    lease = read_lease()
    live = lease_is_live(lease, now)
    ttl = timedelta(hours=ADS_LOCK_TTL_HOURS)
    failed: list[dict] = []

    for row in rows:
        name = row.get("job_name") or ""
        if not is_ads_pull_job(name):
            continue
        if live and lease is not None and _row_belongs_to_live_lease(row, lease):
            continue
        started = _row_started(row)
        age = (now - started) if started is not None else ttl
        dead = not live
        past_ttl = age >= ttl
        if not (dead or past_ttl):
            continue
        try:
            from src.db import job_finish
            job_finish(row.get("id"), "fail", STALE_RUNNING_MESSAGE)
        except Exception as e:
            log.warning("fail_stale_ads_job_runs: finish %s failed: %s",
                        row.get("id"), e)
            continue
        failed.append(row)
        log.info("Ads lock: %s id=%s job=%s",
                 STALE_RUNNING_MESSAGE, row.get("id"), name)
    return failed
