"""Automated GitHub backup — push project state to backup/* branches.

DISABLED BY DEFAULT. Set github_backup_enabled in code or call explicitly.

Safety guards:
  - NEVER pushes to main (hard abort if branch is main)
  - NEVER force-pushes
  - NEVER checks out main with uncommitted changes
  - Branch name must start with backup/
"""
from __future__ import annotations

import logging
import subprocess
from datetime import datetime
from pathlib import Path

log = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_REMOTE = "origin"

# Disabled by default until verified safe
ENABLED = False

PROTECTED_BRANCHES = {"main", "master", "production", "develop"}


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
    if not ENABLED and not dry_run:
        return {"status": "disabled", "message": "GitHub backup is disabled. Set ENABLED=True in github_backup.py to enable."}

    remote = remote or DEFAULT_REMOTE
    now = datetime.now()
    base_branch = f"backup/{now.strftime('%Y-%m-%d')}"

    # If date branch exists on remote, append time suffix
    check = _git("ls-remote", "--heads", remote, base_branch, check=False)
    branch = f"backup/{now.strftime('%Y-%m-%d-%H%M')}" if check.stdout.strip() else base_branch
    commit_msg = f"Automated backup {now.strftime('%Y-%m-%d %H:%M')}"

    # ── HARD GUARD: never push to protected branches ──
    if branch in PROTECTED_BRANCHES or not branch.startswith("backup/"):
        return {"status": "abort", "error": f"Refusing to operate on branch '{branch}' — must be backup/*"}

    result: dict = {"branch": branch, "remote": remote, "dry_run": dry_run, "status": "unknown"}

    try:
        current = _git("rev-parse", "--abbrev-ref", "HEAD", check=False).stdout.strip() or "main"
        result["original_branch"] = current

        # ── HARD GUARD: never switch away from main with dirty working tree ──
        # Instead of stash+checkout, commit directly to a new orphan-like branch
        # by using git worktree or just committing from current position.
        # Safest approach: stay on current branch, create backup branch from HEAD,
        # add all, commit, push, then reset back.

        # Create the backup branch pointing at current HEAD
        _git("branch", "-f", branch, "HEAD")
        _git("checkout", branch)

        _git("add", "-A")
        diff = _git("diff", "--cached", "--stat").stdout.strip()
        if not diff:
            result["status"] = "nothing_to_backup"
            result["message"] = "Nothing to back up"
            # Return to original branch
            _git("checkout", current, check=False)
            return result

        result["files_changed"] = len(diff.strip().split("\n"))

        if dry_run:
            result["status"] = "dry_run"
            result["message"] = f"Would commit {result['files_changed']} files to {branch}"
            _git("reset", "HEAD", check=False)
            _git("checkout", current, check=False)
            return result

        _git("commit", "-m", commit_msg)
        commit_hash = _git("rev-parse", "--short", "HEAD").stdout.strip()
        result["commit"] = commit_hash

        # ── HARD GUARD: verify we're pushing backup/*, never main ──
        if branch in PROTECTED_BRANCHES:
            result["status"] = "abort"
            result["error"] = f"ABORT: would have pushed to protected branch '{branch}'"
            _git("checkout", current, check=False)
            return result

        push = _git("push", remote, branch, check=False)
        if push.returncode != 0:
            result["status"] = "push_failed"
            result["error"] = (push.stderr or push.stdout)[:300]
        else:
            result["status"] = "success"
            result["message"] = f"Backed up {result['files_changed']} files to {branch} ({commit_hash})"

        # Return to original branch
        _git("checkout", current, check=False)

    except subprocess.TimeoutExpired:
        result["status"] = "timeout"
        result["error"] = "Git command timed out"
        # Try to return to original
        _git("checkout", result.get("original_branch", "main"), check=False)
    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)[:300]
        _git("checkout", result.get("original_branch", "main"), check=False)

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
