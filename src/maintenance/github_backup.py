"""Automated GitHub backup — push project state to backup/* branches.

Creates a dated branch (backup/YYYY-MM-DD), commits all tracked + untracked
files (respecting .gitignore), and pushes to origin. NEVER touches main.
NEVER force-pushes. If the date branch already exists, appends a time suffix.
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
    return subprocess.run(
        ["git", *args],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
        timeout=120,
        check=check,
    )


def run_backup(dry_run: bool = False, remote: str | None = None) -> dict:
    remote = remote or DEFAULT_REMOTE
    now = datetime.now()
    base_branch = f"backup/{now.strftime('%Y-%m-%d')}"

    # If date branch exists on remote, append time suffix
    check = _git("ls-remote", "--heads", remote, base_branch, check=False)
    branch = f"backup/{now.strftime('%Y-%m-%d-%H%M')}" if check.stdout.strip() else base_branch
    commit_msg = f"Automated backup {now.strftime('%Y-%m-%d %H:%M')}"

    result: dict = {"branch": branch, "remote": remote, "dry_run": dry_run, "status": "unknown"}

    try:
        # Always return to main
        current = _git("rev-parse", "--abbrev-ref", "HEAD", check=False).stdout.strip()
        if not current or current == "HEAD" or current.startswith("backup/"):
            current = "main"
        result["original_branch"] = current

        # Stash if dirty
        stashed = False
        if _git("status", "--porcelain").stdout.strip():
            _git("stash", "push", "-m", "github-backup-temp", check=False)
            stashed = True

        try:
            _git("checkout", "-B", branch)
            if stashed:
                _git("stash", "pop", check=False)
                stashed = False

            _git("add", "-A")
            diff = _git("diff", "--cached", "--stat").stdout.strip()
            if not diff:
                result["status"] = "nothing_to_backup"
                return result

            result["files_changed"] = len(diff.strip().split("\n"))

            if dry_run:
                result["status"] = "dry_run"
                result["message"] = f"Would commit {result['files_changed']} files to {branch}"
                _git("reset", "HEAD", check=False)
                return result

            _git("commit", "-m", commit_msg)
            commit_hash = _git("rev-parse", "--short", "HEAD").stdout.strip()
            result["commit"] = commit_hash

            push = _git("push", "-u", remote, branch, check=False)
            if push.returncode != 0:
                push2 = _git("push", remote, branch, check=False)
                if push2.returncode != 0:
                    result["status"] = "push_failed"
                    result["error"] = (push2.stderr or push2.stdout)[:300]
                    _log_failure(result)
                    return result

            result["status"] = "success"
            result["message"] = f"Backed up {result['files_changed']} files to {branch} ({commit_hash})"
        finally:
            _git("checkout", current, check=False)
            if stashed:
                _git("stash", "pop", check=False)

    except subprocess.TimeoutExpired:
        result["status"] = "timeout"
        result["error"] = "Git command timed out"
        _log_failure(result)
    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)[:300]
        _log_failure(result)

    return result


def _log_failure(result: dict) -> None:
    try:
        from src.db import log_audit
        log_audit(action="github_backup_failed", category="maintenance", details=result)
    except Exception:
        pass
    try:
        from src.config import settings
        if settings.telegram_enabled:
            from src.alerts.telegram import send_telegram
            send_telegram(f"🚨 <b>GitHub Backup Failed</b>\n\n{result.get('error', 'unknown')[:200]}")
    except Exception:
        pass
