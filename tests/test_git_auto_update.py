"""Safety tests for the Mac Mini ff-only auto-update path.

No real git remotes, no network. `_git` is mocked so a test can never
push, reset, or touch `.env`. The allow-list is also exercised against
the real wrapper to prove forbidden commands never reach subprocess.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.maintenance import git_auto_update as gau


def _proc(stdout="", stderr="", returncode=0):
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


class TestGitAllowList:
    def test_push_is_refused_before_subprocess(self, monkeypatch):
        def boom(*_a, **_k):
            raise AssertionError("subprocess ran")
        monkeypatch.setattr(gau.subprocess, "run", boom)
        with pytest.raises(RuntimeError, match="allow-list"):
            gau._git("push", "origin", "main")

    def test_reset_hard_is_refused(self, monkeypatch):
        monkeypatch.setattr(gau.subprocess, "run", lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("subprocess ran")))
        with pytest.raises(RuntimeError, match="allow-list"):
            gau._git("reset", "--hard", "origin/main")

    def test_clean_is_refused(self, monkeypatch):
        monkeypatch.setattr(gau.subprocess, "run", lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("subprocess ran")))
        with pytest.raises(RuntimeError, match="allow-list"):
            gau._git("clean", "-fd")

    def test_pull_without_ff_only_is_refused(self, monkeypatch):
        monkeypatch.setattr(gau.subprocess, "run", lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("subprocess ran")))
        with pytest.raises(RuntimeError, match="ff-only"):
            gau._git("pull", "origin", "main")

    def test_pull_with_force_is_refused(self, monkeypatch):
        monkeypatch.setattr(gau.subprocess, "run", lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("subprocess ran")))
        with pytest.raises(RuntimeError, match="destructive"):
            gau._git("pull", "--ff-only", "--no-rebase", "--force", "origin", "main")

    def test_pull_rebase_is_refused(self, monkeypatch):
        monkeypatch.setattr(gau.subprocess, "run", lambda *_a, **_k: (_ for _ in ()).throw(
            AssertionError("subprocess ran")))
        with pytest.raises(RuntimeError, match="rebase"):
            gau._git("pull", "--ff-only", "--no-rebase", "--rebase", "origin", "main")

    def test_allowed_ff_only_pull_reaches_subprocess(self, monkeypatch):
        seen = {}

        def fake_run(cmd, **kwargs):
            seen["cmd"] = cmd
            return _proc()

        monkeypatch.setattr(gau.subprocess, "run", fake_run)
        gau._git("pull", "--ff-only", "--no-rebase", "--no-edit",
                 "--no-autostash", "origin", "main")
        assert seen["cmd"][:2] == ["git", "pull"]
        assert "--ff-only" in seen["cmd"]
        assert "push" not in seen["cmd"]
        assert "--hard" not in seen["cmd"]


class FakeGit:
    """Scripted `_git` for run_auto_update. Records every invocation."""

    def __init__(self, answers: dict[tuple[str, ...], SimpleNamespace],
                 defaults: dict[str, SimpleNamespace] | None = None):
        self.answers = answers
        self.defaults = defaults or {}
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, *args, check=True):
        self.calls.append(args)
        if args in self.answers:
            proc = self.answers[args]
        elif args[:1] in self.defaults:
            proc = self.defaults[args[:1]]
        else:
            proc = _proc()
        if check and proc.returncode != 0:
            raise subprocess.CalledProcessError(proc.returncode, args)
        return proc


def _base_answers(over=None):
    answers = {
        ("rev-parse", "--is-inside-work-tree"): _proc("true"),
        ("rev-parse", "--abbrev-ref", "HEAD"): _proc("main"),
        ("diff", "--quiet"): _proc(returncode=0),
        ("diff", "--cached", "--quiet"): _proc(returncode=0),
        ("fetch", "origin", "main"): _proc(),
        ("rev-parse", "HEAD"): _proc("aaa111aaa111aaa111aaa111aaa111aaa111aaa1"),
        ("rev-parse", "origin/main"): _proc("aaa111aaa111aaa111aaa111aaa111aaa111aaa1"),
        ("merge-base", "HEAD", "origin/main"): _proc(
            "aaa111aaa111aaa111aaa111aaa111aaa111aaa1"),
    }
    if over:
        answers.update(over)
    return answers


class TestRunAutoUpdate:
    def test_already_on_latest_main_is_noop(self, monkeypatch):
        fake = FakeGit(_base_answers())
        monkeypatch.setattr(gau, "_git", fake)
        monkeypatch.setattr(gau, "_in_progress_operation", lambda: None)
        r = gau.run_auto_update()
        assert r["status"] == "up_to_date"
        assert r["restart"] is False
        assert not any(c[0] == "pull" for c in fake.calls)

    def test_dirty_tracked_tree_aborts_without_pull(self, monkeypatch):
        fake = FakeGit(_base_answers({
            ("diff", "--quiet"): _proc(returncode=1),
        }))
        monkeypatch.setattr(gau, "_git", fake)
        monkeypatch.setattr(gau, "_in_progress_operation", lambda: None)
        r = gau.run_auto_update()
        assert r["status"] == "dirty"
        assert "will not reset" in r["error"]
        assert not any(c[0] == "pull" for c in fake.calls)
        assert not any(c[0] == "fetch" for c in fake.calls)

    def test_diverged_history_aborts_without_pull(self, monkeypatch):
        local = "aaa111aaa111aaa111aaa111aaa111aaa111aaa1"
        remote = "bbb222bbb222bbb222bbb222bbb222bbb222bbb2"
        ancestor = "ccc333ccc333ccc333ccc333ccc333ccc333ccc3"
        fake = FakeGit(_base_answers({
            ("rev-parse", "HEAD"): _proc(local),
            ("rev-parse", "origin/main"): _proc(remote),
            ("merge-base", "HEAD", "origin/main"): _proc(ancestor),
        }))
        monkeypatch.setattr(gau, "_git", fake)
        monkeypatch.setattr(gau, "_in_progress_operation", lambda: None)
        r = gau.run_auto_update()
        assert r["status"] == "diverged"
        assert "will not reset" in r["error"]
        assert not any(c[0] == "pull" for c in fake.calls)

    def test_wrong_branch_aborts(self, monkeypatch):
        fake = FakeGit(_base_answers({
            ("rev-parse", "--abbrev-ref", "HEAD"): _proc("cursor/something"),
        }))
        monkeypatch.setattr(gau, "_git", fake)
        r = gau.run_auto_update()
        assert r["status"] == "wrong_branch"
        assert not any(c[0] == "pull" for c in fake.calls)

    def test_dry_run_does_not_pull(self, monkeypatch):
        local = "aaa111aaa111aaa111aaa111aaa111aaa111aaa1"
        remote = "bbb222bbb222bbb222bbb222bbb222bbb222bbb2"
        fake = FakeGit(_base_answers({
            ("rev-parse", "HEAD"): _proc(local),
            ("rev-parse", "origin/main"): _proc(remote),
            ("merge-base", "HEAD", "origin/main"): _proc(local),
        }))
        monkeypatch.setattr(gau, "_git", fake)
        monkeypatch.setattr(gau, "_in_progress_operation", lambda: None)
        r = gau.run_auto_update(dry_run=True)
        assert r["status"] == "dry_run"
        assert not any(c[0] == "pull" for c in fake.calls)
        assert r["restart"] is False

    def test_successful_ff_pull_requests_restart(self, monkeypatch):
        local = "aaa111aaa111aaa111aaa111aaa111aaa111aaa1"
        remote = "bbb222bbb222bbb222bbb222bbb222bbb222bbb2"
        heads = iter([local, remote])  # before pull, after pull

        answers = _base_answers({
            ("rev-parse", "origin/main"): _proc(remote),
            ("merge-base", "HEAD", "origin/main"): _proc(local),
            ("pull", "--ff-only", "--no-rebase", "--no-edit", "--no-autostash",
             "origin", "main"): _proc(),
        })

        def fake_git(*args, check=True):
            if args == ("rev-parse", "HEAD"):
                return _proc(next(heads))
            return FakeGit(answers)(*args, check=check)

        recorded = []

        def recording_git(*args, check=True):
            recorded.append(args)
            return fake_git(*args, check=check)

        monkeypatch.setattr(gau, "_git", recording_git)
        monkeypatch.setattr(gau, "_in_progress_operation", lambda: None)
        monkeypatch.setattr(gau, "_env_exists", lambda: True)
        r = gau.run_auto_update(restart=True)
        assert r["status"] == "updated"
        assert r["restart"] is True
        assert r["previous"][:6] == "aaa111"
        assert r["commit"][:6] == "bbb222"
        assert any(c[0] == "pull" and "--ff-only" in c for c in recorded)
        assert not any(c[0] == "push" for c in recorded)
        assert not any("--hard" in c for c in recorded)

    def test_env_gone_after_pull_is_flagged(self, monkeypatch):
        local = "aaa111aaa111aaa111aaa111aaa111aaa111aaa1"
        remote = "bbb222bbb222bbb222bbb222bbb222bbb222bbb2"
        heads = iter([local, remote])
        answers = _base_answers({
            ("rev-parse", "origin/main"): _proc(remote),
            ("merge-base", "HEAD", "origin/main"): _proc(local),
            ("pull", "--ff-only", "--no-rebase", "--no-edit", "--no-autostash",
             "origin", "main"): _proc(),
        })
        recorded = []

        def recording_git(*args, check=True):
            recorded.append(args)
            if args == ("rev-parse", "HEAD"):
                return _proc(next(heads))
            return FakeGit(answers)(*args, check=check)

        monkeypatch.setattr(gau, "_git", recording_git)
        monkeypatch.setattr(gau, "_in_progress_operation", lambda: None)
        calls = {"n": 0}

        def exists_then_gone():
            calls["n"] += 1
            return calls["n"] == 1

        monkeypatch.setattr(gau, "_env_exists", exists_then_gone)
        r = gau.run_auto_update(restart=False)
        assert r["status"] == "env_missing"
        assert r["restart"] is False

    def test_disabled_is_noop(self, monkeypatch):
        monkeypatch.setenv("GIT_AUTO_UPDATE", "0")
        r = gau.run_auto_update()
        assert r["status"] == "disabled"
        assert r["restart"] is False

    def test_restart_default_skips_on_tty(self, monkeypatch):
        monkeypatch.delenv("GIT_AUTO_UPDATE_RESTART", raising=False)
        monkeypatch.setattr(gau.sys.stdin, "isatty", lambda: True)
        assert gau.should_restart_process() is False

    def test_restart_default_fires_without_tty(self, monkeypatch):
        monkeypatch.delenv("GIT_AUTO_UPDATE_RESTART", raising=False)
        monkeypatch.setattr(gau.sys.stdin, "isatty", lambda: False)
        assert gau.should_restart_process() is True

    def test_in_progress_rebase_aborts(self, monkeypatch):
        fake = FakeGit(_base_answers())
        monkeypatch.setattr(gau, "_git", fake)
        monkeypatch.setattr(gau, "_in_progress_operation", lambda: "rebase")
        r = gau.run_auto_update()
        assert r["status"] == "in_progress"
        assert not any(c[0] == "pull" for c in fake.calls)

    def test_staged_changes_count_as_dirty(self, monkeypatch):
        fake = FakeGit(_base_answers({
            ("diff", "--cached", "--quiet"): _proc(returncode=1),
        }))
        monkeypatch.setattr(gau, "_git", fake)
        monkeypatch.setattr(gau, "_in_progress_operation", lambda: None)
        r = gau.run_auto_update()
        assert r["status"] == "dirty"
        assert not any(c[0] == "fetch" for c in fake.calls)
