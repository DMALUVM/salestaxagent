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


def jobs_are_quiet() -> bool | None:
    """True when no job_runs row is `running`. None when the read fails.

    None means "do not kill the agent" — a missed read is not proof the
    scheduler is idle.
    """
    try:
        from src.db import get_client

        resp = (
            get_client()
            .table("job_runs")
            .select("job_name,status")
            .eq("status", "running")
            .limit(1)
            .execute()
        )
    except Exception as e:
        log.warning("restart pending: job_runs read failed: %s", e)
        return None
    return not list(resp.data or [])
