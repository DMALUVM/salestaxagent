"""Remember a fast-forward whose kickstart was deferred.

The health check pulls `origin/main` and then `launchctl kickstart -k`.
If a job is running after that pull, killing the agent is unsafe, but
the checkout is already current — the 04:30 auto-update would see
`up_to_date` and never respawn. This marker is that debt.

The scheduler clears it when a new `src.main run` actually starts.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent.parent
MARKER_PATH = ROOT / "logs" / "healthcheck_restart_pending.json"
# The caller inserts its own job_runs row before this check. Counting
# that row as busy means a pending restart can never fire at 04:30.
SELF_JOB_NAMES = frozenset({"git_auto_update", "healthcheck"})


def mark_restart_pending(commit: str | None = None) -> None:
    MARKER_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "commit": commit or "",
        "at": datetime.now(timezone.utc).isoformat(),
    }
    tmp = MARKER_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload))
    tmp.replace(MARKER_PATH)


def restart_is_pending() -> bool:
    return MARKER_PATH.is_file()


def clear_restart_pending() -> None:
    try:
        MARKER_PATH.unlink()
    except FileNotFoundError:
        return


def other_job_running(rows: list[dict], *, ignore: frozenset[str] = SELF_JOB_NAMES) -> bool:
    """True when some other job_runs row is `running`.

    ``git_auto_update`` and ``healthcheck`` are the callers. Their own
    ``running`` row is not a reason to skip the restart.
    """
    for row in rows:
        if str(row.get("status") or "").strip().lower() != "running":
            continue
        if str(row.get("job_name") or "") in ignore:
            continue
        return True
    return False


def jobs_are_quiet() -> bool | None:
    """True when no other job_runs row is `running`. None when the read fails.

    None means "do not kill the agent" — a missed read is not proof the
    scheduler is idle. The caller's own ``running`` row is ignored.
    More than one row is read so a self-row cannot hide a real job.
    """
    try:
        from src.db import get_client

        resp = (
            get_client()
            .table("job_runs")
            .select("job_name,status")
            .eq("status", "running")
            .limit(50)
            .execute()
        )
    except Exception as e:
        log.warning("restart pending: job_runs read failed: %s", e)
        return None
    return not other_job_running(list(resp.data or []))
