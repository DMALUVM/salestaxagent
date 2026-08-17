"""Automated GitHub backup — push project state to backup/* branches.

Creates a dated branch (backup/YYYY-MM-DD), commits all tracked + untracked
files (respecting .gitignore), and pushes to origin. NEVER touches main.
NEVER force-pushes.

Usage:
    from src.maintenance.github_backup import run_backup
    result = run_backup(dry_run=False)
"""
from __future__ import annotations

import logging
import subprocess
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_REMOTE = "origin"


def _git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    """Run a git command in the project root."""
    return subprocess.run(
        ["git", *args],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        timeout=120,
        check=check,
    )


def run_backup(
    dry_run: bool = False,
    remote: str | None = None,
) -> dict:
    """Create a dated backup branch and push to origin.

    Returns dict with status, branch, commit info, or error.
    """
    remote = remote or DEFAULT_REMOTE
    now = datetime.now()
    base_branch = f"backup/{now.strftime('%Y-%m-%d')}"

    # If the date branch already exists on remote, append time suffix
    check = _git("ls-remote", "--heads", remote, base_branch, check=False)
    if check.stdout.strip():
        branch = f"backup/{now.strftime('%Y-%m-%d-%H%M')}"
    else:
        branch = base_branch

    commit_msg = f"Automated backup {now.strftime('%Y-%m-%d %H:%M')}"

    result: dict = {
        "branch": branch,
        "remote": remote,
        "dry_run": dry_run,
        "status": "unknown",
    }

    try:
        # 1. Get current branch to return to (always main for safety)
        current = _git("rev-parse", "--abbrev-ref", "HEAD", check=False).stdout.strip()
        if not current or current == "HEAD" or current.startswith("backup/"):
            current = "main"
        result["original_branch"] = current

        # 2. Ensure working tree is clean enough to switch branches
        #    (stash any uncommitted changes, restore after)
        stashed = False
        status = _git("status", "--porcelain").stdout.strip()
        if status:
            _git("stash", "push", "-m", "github-backup-temp", check=False)
            stashed = True

        try:
            # 3. Create or reset the backup branch from current HEAD
            _git("checkout", "-B", branch)

            # 4. Pop stash if we stashed (brings back all changes)
            if stashed:
                _git("stash", "pop", check=False)
                stashed = False

            # 5. Stage everything (.gitignore is respected by git add -A)
            _git("add", "-A")

            # 6. Check if there's anything to commit
            diff = _git("diff", "--cached", "--stat").stdout.strip()
            if not diff:
                result["status"] = "nothing_to_backup"
                result["message"] = "No changes to back up"
                log.info("[Backup] Nothing to back up")
                return result

            result["files_changed"] = len(diff.strip().split("\n"))

            if dry_run:
                result["status"] = "dry_run"
                result["message"] = f"Would commit {result['files_changed']} files to {branch}"
                log.info("[Backup] Dry run: %d files to %s", result["files_changed"], branch)
                # Unstage
                _git("reset", "HEAD", check=False)
                return result

            # 7. Commit
            _git("commit", "-m", commit_msg)
            commit_hash = _git("rev-parse", "--short", "HEAD").stdout.strip()
            result["commit"] = commit_hash

            # 8. Push (never force)
            push = _git("push", "-u", remote, branch, check=False)
            if push.returncode != 0:
                # If branch already exists on remote, try with regular push
                push2 = _git("push", remote, branch, check=False)
                if push2.returncode != 0:
                    result["status"] = "push_failed"
                    result["error"] = (push2.stderr or push2.stdout)[:300]
                    log.error("[Backup] Push failed: %s", result["error"])
                    _log_failure(result)
                    return result

            result["status"] = "success"
            result["message"] = f"Backed up {result['files_changed']} files to {branch} ({commit_hash})"
            log.info("[Backup] %s", result["message"])

        finally:
            # 9. Return to original branch
            _git("checkout", current, check=False)
            # Pop stash if we never got to pop it
            if stashed:
                _git("stash", "pop", check=False)

    except subprocess.TimeoutExpired:
        result["status"] = "timeout"
        result["error"] = "Git command timed out (120s)"
        log.error("[Backup] Timeout")
        _log_failure(result)
    except subprocess.CalledProcessError as e:
        result["status"] = "git_error"
        result["error"] = (e.stderr or e.stdout or str(e))[:300]
        log.error("[Backup] Git error: %s", result["error"])
        _log_failure(result)
    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)[:300]
        log.error("[Backup] Error: %s", e)
        _log_failure(result)

    return result


def _log_failure(result: dict) -> None:
    """Log backup failure to audit_log and optionally send Telegram alert."""
    try:
        from src.db import log_audit
        log_audit(
            action="github_backup_failed",
            category="maintenance",
            details=result,
        )
    except Exception:
        pass

    try:
        from src.config import settings
        if settings.telegram_enabled:
            from src.alerts.telegram import send_telegram
            send_telegram(
                f"🚨 <b>GitHub Backup Failed</b>\n\n"
                f"Branch: {result.get('branch', '?')}\n"
                f"Error: {result.get('error', 'unknown')[:200]}"
            )
    except Exception:
        pass
