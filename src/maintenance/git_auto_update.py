"""Safe auto-update: fast-forward `main` from origin, then respawn.

The Mac Mini tracks `origin/main` without a human `git pull` + kickstart.
This module is the only write path. It is intentionally narrow.

Allowed git:
  - read-only inspection (`rev-parse`, `diff`, `merge-base`, `fetch`)
  - `git pull --ff-only --no-rebase --no-edit --no-autostash origin main`

Never:
  - push (including to main)
  - `reset --hard` / `--force` / `clean` / rebase / checkout
  - delete `.env` or any other untracked local file

Dirty tree or a diverged history aborts and leaves the checkout untouched.
If HEAD did not move, this is a no-op (idempotent).

Restart: after a successful pull that changed HEAD we exit the process
(SIGTERM → existing shutdown handler). launchd `KeepAlive` respawns
`python -m src.main run` so the new code is loaded. We do **not** call
`launchctl kickstart` from inside the process — killing ourselves via
launchctl races the `job_runs` write and the graceful shutdown. Manual
kickstart remains an emergency fallback if KeepAlive is off.
"""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

log = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_REMOTE = "origin"
DEFAULT_BRANCH = "main"
ENV_PATH = PROJECT_ROOT / ".env"

# 04:30 ET — before ads_campaigns_sync at 05:00. Times are AGENT_TZ.
CRON_HOUR = 4
CRON_MINUTE = 30
STARTUP_DELAY_SECONDS = 90

# Read-only inspection + one ff-only pull. Anything else is a hard refuse.
_ALLOWED_SUBCOMMANDS = frozenset({
    "rev-parse",
    "diff",
    "fetch",
    "merge-base",
    "pull",
})

_FORBIDDEN_FLAGS = frozenset({
    "--force",
    "-f",
    "--hard",
    "--soft",
    "--mixed",
    "--force-with-lease",
    "--delete",
    "-D",
    "--autostash",
})

_IN_PROGRESS = (
    ("MERGE_HEAD", "merge"),
    ("rebase-merge", "rebase"),
    ("rebase-apply", "rebase"),
    ("CHERRY_PICK_HEAD", "cherry-pick"),
    ("REVERT_HEAD", "revert"),
)

_LOCK = threading.Lock()

# Statuses that mean "a human has to look" — job_runs fail + Telegram.
_ALERT_STATUSES = frozenset({
    "dirty",
    "diverged",
    "wrong_branch",
    "in_progress",
    "unsafe",
    "env_missing",
})


def is_enabled() -> bool:
    """GIT_AUTO_UPDATE=0 disables the job. Default is on."""
    return os.environ.get("GIT_AUTO_UPDATE", "1").strip().lower() not in {
        "0", "false", "no", "off",
    }


def should_restart_process() -> bool:
    """Exit after a HEAD-changing pull so KeepAlive loads the new checkout.

    GIT_AUTO_UPDATE_RESTART=0 never exits.
    GIT_AUTO_UPDATE_RESTART=1 always exits.
    Unset: exit only when stdin is not a TTY (launchd / daemon). An
    interactive `python -m src.main run` keeps running and logs the
    kickstart command instead of surprising the operator.
    """
    raw = os.environ.get("GIT_AUTO_UPDATE_RESTART", "").strip().lower()
    if raw in {"0", "false", "no", "off"}:
        return False
    if raw in {"1", "true", "yes", "on"}:
        return True
    try:
        return not sys.stdin.isatty()
    except Exception:
        return True


def _git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    """Run a tightly allow-listed git command. Never push, reset, or clean."""
    if not args:
        raise RuntimeError("refusing empty git command")
    sub = args[0]
    if sub not in _ALLOWED_SUBCOMMANDS:
        raise RuntimeError(f"refusing git {sub} — not on the auto-update allow-list")
    if any(a in _FORBIDDEN_FLAGS for a in args):
        raise RuntimeError(f"refusing destructive git flags: {args}")
    if sub == "pull":
        if "--ff-only" not in args:
            raise RuntimeError("pull without --ff-only is forbidden")
        if "--no-rebase" not in args:
            raise RuntimeError("pull without --no-rebase is forbidden")
        if any(a in {"--rebase", "--rebase=true", "--rebase=merges"} for a in args):
            raise RuntimeError("refusing git pull --rebase")
    if sub == "push":
        raise RuntimeError("refusing git push")

    return subprocess.run(
        ["git", *args],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        timeout=120,
        check=check,
    )


def _stdout(proc: subprocess.CompletedProcess) -> str:
    return (proc.stdout or "").strip()


def _env_exists() -> bool:
    return ENV_PATH.exists()


def _in_progress_operation() -> str | None:
    git_dir = PROJECT_ROOT / ".git"
    if git_dir.is_file():
        # worktree pointer — do not walk another checkout
        return None
    for name, label in _IN_PROGRESS:
        if (git_dir / name).exists():
            return label
    return None


def _tracked_dirty() -> str | None:
    """Return a short reason if tracked files (index or worktree) differ from HEAD.

    Untracked files (logs, .env, .venv) are ignored: they are local runtime
    state and `git pull --ff-only` will not delete them. If an incoming file
    would collide with an untracked path, the pull itself fails and we abort.
    """
    worktree = _git("diff", "--quiet", check=False)
    if worktree.returncode != 0:
        return "tracked working tree has uncommitted changes"
    index = _git("diff", "--cached", "--quiet", check=False)
    if index.returncode != 0:
        return "index has staged changes"
    return None


def _result(status: str, **extra) -> dict:
    out = {"status": status, "restart": False}
    out.update(extra)
    return out


def run_auto_update(
    dry_run: bool = False,
    restart: bool | None = None,
    remote: str | None = None,
    branch: str | None = None,
) -> dict:
    """Fetch origin/main and fast-forward if it is a clean ancestor.

    Returns a result dict. `restart` is True only when HEAD moved and a
    process exit was requested. The caller writes `job_runs` and, when
    `restart` is True, calls `request_process_exit()`.
    """
    remote = remote or DEFAULT_REMOTE
    branch = branch or DEFAULT_BRANCH

    if not is_enabled() and not dry_run:
        return _result("disabled", message="GIT_AUTO_UPDATE=0")

    if not _LOCK.acquire(blocking=False):
        return _result("skipped", message="another auto-update is already running")

    try:
        return _run_locked(dry_run=dry_run, restart=restart,
                           remote=remote, branch=branch)
    finally:
        _LOCK.release()


def _run_locked(*, dry_run: bool, restart: bool | None,
                remote: str, branch: str) -> dict:
    inside = _git("rev-parse", "--is-inside-work-tree", check=False)
    if inside.returncode != 0 or _stdout(inside) != "true":
        return _result("error", error="not a git work tree")

    current = _stdout(_git("rev-parse", "--abbrev-ref", "HEAD", check=False)) or ""
    if current != branch:
        return _result(
            "wrong_branch",
            error=f"on '{current}', not '{branch}' — aborting (no checkout, no pull)",
            branch=current,
        )

    op = _in_progress_operation()
    if op:
        return _result(
            "in_progress",
            error=f"git {op} in progress — aborting so local state is left untouched",
        )

    dirty = _tracked_dirty()
    if dirty:
        return _result(
            "dirty",
            error=f"{dirty} — aborting; will not reset or stash",
            branch=current,
        )

    env_existed = _env_exists()

    fetched = _git("fetch", remote, branch, check=False)
    if fetched.returncode != 0:
        err = (fetched.stderr or fetched.stdout or "fetch failed")[:300]
        return _result("error", error=f"git fetch {remote} {branch} failed: {err}")

    local = _stdout(_git("rev-parse", "HEAD"))
    remote_ref = f"{remote}/{branch}"
    upstream = _git("rev-parse", remote_ref, check=False)
    if upstream.returncode != 0:
        return _result("error", error=f"missing {remote_ref} after fetch")
    remote_sha = _stdout(upstream)

    if local == remote_sha:
        return _result(
            "up_to_date",
            message=f"already at {remote_ref} ({local[:10]})",
            commit=local,
            branch=current,
        )

    base = _git("merge-base", "HEAD", remote_ref, check=False)
    if base.returncode != 0 or _stdout(base) != local:
        return _result(
            "diverged",
            error=(
                f"HEAD and {remote_ref} have diverged "
                f"(local {local[:10]}, remote {remote_sha[:10]}) — "
                "aborting; will not reset or rebase"
            ),
            commit=local,
            remote_commit=remote_sha,
            branch=current,
        )

    if dry_run:
        return _result(
            "dry_run",
            message=f"would ff-only pull {local[:10]} → {remote_sha[:10]}",
            commit=local,
            remote_commit=remote_sha,
            branch=current,
        )

    pull = _git(
        "pull",
        "--ff-only",
        "--no-rebase",
        "--no-edit",
        "--no-autostash",
        remote,
        branch,
        check=False,
    )
    if pull.returncode != 0:
        err = (pull.stderr or pull.stdout or "pull failed")[:300]
        return _result(
            "error",
            error=f"git pull --ff-only failed: {err}",
            commit=local,
        )

    new_head = _stdout(_git("rev-parse", "HEAD"))
    if env_existed and not _env_exists():
        return _result(
            "env_missing",
            error=".env was present before pull and is gone after — local secrets may be missing",
            commit=new_head,
            previous=local,
        )

    if new_head == local:
        return _result(
            "up_to_date",
            message=f"pull was a no-op; still {local[:10]}",
            commit=local,
            branch=current,
        )

    do_restart = should_restart_process() if restart is None else bool(restart)
    return _result(
        "updated",
        message=f"fast-forwarded {local[:10]} → {new_head[:10]}",
        commit=new_head,
        previous=local,
        branch=current,
        restart=do_restart,
    )


def request_process_exit(delay_seconds: float = 2.0) -> None:
    """SIGTERM after a short delay so job_finish can land, then hard-exit.

    launchd KeepAlive sees the exit and starts a new `src.main run` on the
    updated checkout. Delay is so the APScheduler thread can finish writing
    the job_runs row before the shutdown handler stops the scheduler.
    """
    def _exit() -> None:
        time.sleep(delay_seconds)
        try:
            os.kill(os.getpid(), signal.SIGTERM)
        except Exception as e:
            log.warning("SIGTERM after auto-update failed: %s", e)
        time.sleep(5)
        os._exit(0)

    threading.Thread(
        target=_exit, name="git-auto-update-restart", daemon=True,
    ).start()


def alert_if_needed(result: dict) -> None:
    """job_runs is the caller's job. This is the optional human nudge."""
    status = result.get("status")
    if status not in _ALERT_STATUSES and status != "error":
        return
    detail = result.get("error") or result.get("message") or status
    log.error("git_auto_update %s: %s", status, detail)
    try:
        from src.db import log_audit
        log_audit(action="git_auto_update_aborted", category="maintenance",
                  details=result)
    except Exception:
        pass
    # Transient fetch/network errors stay in job_runs for the morning
    # check-in. Dirty / diverged persist until a human acts, so ping now.
    if status not in _ALERT_STATUSES:
        return
    try:
        from src.config import settings
        if settings.telegram_enabled:
            from src.alerts.telegram import send_telegram
            send_telegram(
                f"🚨 <b>Git auto-update aborted</b>\n\n"
                f"{status}: {str(detail)[:300]}"
            )
    except Exception:
        pass
