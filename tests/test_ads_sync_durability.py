"""Ads sync durability: PID/heartbeat lease, deferred 425, ST day gaps.

Run: pytest tests/test_ads_sync_durability.py -v
"""
from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone

import pytest


def _utc(hours_ago: float = 0) -> datetime:
    return datetime.now(timezone.utc) - timedelta(hours=hours_ago)


class _Result:
    def __init__(self, data):
        self.data = data


class _JobQuery:
    def __init__(self, rows):
        self._rows = rows
        self._status = None

    def select(self, *a, **k):
        return self

    def eq(self, key, val):
        if key == "status":
            self._status = val
        return self

    def order(self, *a, **k):
        return self

    def limit(self, n):
        return self

    def execute(self):
        rows = self._rows
        if self._status is not None:
            rows = [r for r in rows if r.get("status") == self._status]
        return _Result(rows)


class _JobClient:
    def __init__(self, rows):
        self.rows = rows

    def table(self, name):
        assert name == "job_runs"
        return _JobQuery(self.rows)


@pytest.fixture
def lock_dir(tmp_path, monkeypatch):
    path = tmp_path / "ads_sync.lock.json"
    import src.amazon_ads.sync_lock as sl
    monkeypatch.setattr(sl, "_LOCK_PATH_OVERRIDE", path)
    yield path
    sl.release_ads_lease()
    monkeypatch.setattr(sl, "_LOCK_PATH_OVERRIDE", None)


def test_dead_pid_lease_is_not_live(lock_dir):
    import src.amazon_ads.sync_lock as sl
    sl._write_lease(lock_dir, {
        "pid": 999_999_999,
        "heartbeat_at": _utc().isoformat(),
        "started_at": _utc().isoformat(),
        "job": "ads_campaigns_sync",
    })
    assert sl.lease_is_live(sl.read_lease()) is False


def test_live_pid_fresh_heartbeat_is_live(lock_dir):
    import src.amazon_ads.sync_lock as sl
    sl._write_lease(lock_dir, {
        "pid": os.getpid(),
        "heartbeat_at": _utc().isoformat(),
        "started_at": _utc().isoformat(),
        "job": "ads_campaigns_sync",
    })
    assert sl.lease_is_live(sl.read_lease()) is True


def test_stale_heartbeat_is_dead_even_if_pid_alive(lock_dir):
    import src.amazon_ads.sync_lock as sl
    sl._write_lease(lock_dir, {
        "pid": os.getpid(),
        "heartbeat_at": _utc(hours_ago=2).isoformat(),
        "started_at": _utc(hours_ago=2).isoformat(),
        "job": "ads_campaigns_sync",
    })
    assert sl.lease_is_live(sl.read_lease()) is False


def test_claim_steals_dead_pid_and_rejects_other_live(lock_dir, monkeypatch):
    import src.amazon_ads.sync_lock as sl
    sl._write_lease(lock_dir, {
        "pid": 999_999_999,
        "heartbeat_at": _utc().isoformat(),
        "started_at": _utc().isoformat(),
        "job": "ads_campaigns_sync",
    })
    assert sl.claim_ads_lease("ads_placements_sync") is True
    sl.release_ads_lease()

    sl._write_lease(lock_dir, {
        "pid": 1,
        "heartbeat_at": _utc().isoformat(),
        "started_at": _utc().isoformat(),
        "job": "ads_campaigns_sync",
    })
    monkeypatch.setattr(sl, "pid_is_alive", lambda pid: pid == 1)
    assert sl.claim_ads_lease("ads_sync") is False


def test_fail_stale_clears_orphan_running_row(lock_dir, monkeypatch):
    import src.amazon_ads.sync_lock as sl
    finished = []
    rows = [{
        "id": "run-orphan",
        "job_name": "ads_campaigns_sync",
        "status": "running",
        "started_at": _utc(hours_ago=5).isoformat(),
    }]
    monkeypatch.setattr("src.db.get_client", lambda: _JobClient(rows))
    monkeypatch.setattr("src.db.job_finish",
                        lambda rid, status, message, stats=None:
                        finished.append((rid, status, message)))

    failed = sl.fail_stale_ads_job_runs(now=_utc())
    assert len(failed) == 1
    assert finished == [("run-orphan", "fail", sl.STALE_RUNNING_MESSAGE)]
    assert "no heartbeat" in sl.STALE_RUNNING_MESSAGE


def test_fail_stale_keeps_live_lease_row(lock_dir, monkeypatch):
    import src.amazon_ads.sync_lock as sl
    sl._write_lease(lock_dir, {
        "pid": os.getpid(),
        "heartbeat_at": _utc().isoformat(),
        "started_at": _utc(hours_ago=0.1).isoformat(),
        "job": "ads_campaigns_sync",
    })
    finished = []
    rows = [{
        "id": "run-live",
        "job_name": "ads_campaigns_sync",
        "status": "running",
        "started_at": _utc(hours_ago=0.05).isoformat(),
    }]
    monkeypatch.setattr("src.db.get_client", lambda: _JobClient(rows))
    monkeypatch.setattr("src.db.job_finish",
                        lambda rid, status, message, stats=None:
                        finished.append((rid, status, message)))

    assert sl.fail_stale_ads_job_runs(now=_utc()) == []
    assert finished == []


def test_fail_stale_skips_non_pull_jobs(lock_dir, monkeypatch):
    import src.amazon_ads.sync_lock as sl
    finished = []
    rows = [{
        "id": "run-actions",
        "job_name": "ads_actions",
        "status": "running",
        "started_at": _utc(hours_ago=6).isoformat(),
    }]
    monkeypatch.setattr("src.db.get_client", lambda: _JobClient(rows))
    monkeypatch.setattr("src.db.job_finish",
                        lambda rid, status, message, stats=None:
                        finished.append(rid))
    assert sl.fail_stale_ads_job_runs(now=_utc()) == []
    assert finished == []


def test_fail_stale_source_is_quiet():
    import inspect
    from src.amazon_ads.sync_lock import fail_stale_ads_job_runs
    src = inspect.getsource(fail_stale_ads_job_runs)
    assert "send_telegram" not in src
    assert "_ads_alert" not in src
    from src.amazon_ads.sync_lock import STALE_RUNNING_MESSAGE
    assert STALE_RUNNING_MESSAGE == "stale running row auto-failed (no heartbeat)"
    assert "STALE_RUNNING_MESSAGE" in src


def test_scheduler_start_sweeps_stale_rows():
    import inspect
    from src import main as main_mod
    src = inspect.getsource(main_mod.run.callback)
    assert "fail_stale_ads_job_runs" in src
    assert "stale running row" in src


def test_sync_ads_single_writer_docstring():
    from src.amazon_ads.reports import sync_ads
    assert "Single-writer" in (sync_ads.__doc__ or "")
    assert "ads-sync" in (sync_ads.__doc__ or "")


def test_ads_slot_busy_detects_stopped_and_425():
    from src.amazon_ads.reports import ads_slot_busy_in_result
    assert ads_slot_busy_in_result(
        {"search_terms": {"stopped": "slot_busy", "errors": ["HTTP 425"]}})
    assert ads_slot_busy_in_result(
        {"campaigns": {"errors": ["SP chunk 1: Amazon Ads reporting slot busy (HTTP 425)."]}})
    assert ads_slot_busy_in_result(
        {"placements": {"error": "AdsReportSlotBusy: 425 Too Early"}})
    assert not ads_slot_busy_in_result(
        {"search_terms": {"stopped": None, "errors": ["timeout"]}})
    assert not ads_slot_busy_in_result({})


def test_defer_ads_job_schedules_one_replaceable_retry(monkeypatch):
    from src import main as main_mod
    added = []

    class Sched:
        def add_job(self, fn, kind, run_date=None, id=None, **k):
            added.append({"id": id, "kind": kind, "replace": k.get("replace_existing")})

    monkeypatch.setattr(main_mod, "_SCHEDULER", Sched())
    main_mod._defer_ads_job("ads_campaigns_sync", 0)
    main_mod._defer_ads_job("ads_campaigns_sync", 0)
    assert [a["id"] for a in added] == [
        "ads_campaigns_sync_retry_1", "ads_campaigns_sync_retry_1"]
    assert all(a["kind"] == "date" for a in added)
    assert all(a["replace"] is True for a in added)


def test_search_term_425_defers_gap_fill_not_7d_rewrite(monkeypatch):
    from src import main as main_mod
    added = []

    class Sched:
        def add_job(self, fn, kind, run_date=None, id=None, **k):
            added.append(id)

    monkeypatch.setattr(main_mod, "_SCHEDULER", Sched())
    main_mod._defer_ads_job("ads_search_terms_sync", 2)
    assert added == ["ads_search_terms_gap_fill_retry_3"]


def test_defer_caps_and_is_not_a_wait_loop():
    import inspect
    from src import main as main_mod
    src = inspect.getsource(main_mod._defer_ads_job)
    assert "AwaitShell" not in src
    assert "while " not in src
    assert "sleep" not in src
    sched = inspect.getsource(main_mod._schedule_ads_retry)
    assert "replace_existing=True" in sched
    assert main_mod._ADS_RETRY_MAX >= 1


def test_run_ads_sync_job_defers_on_425(monkeypatch):
    from src import main as main_mod
    deferred = []

    monkeypatch.setattr(main_mod, "_defer_ads_job",
                        lambda name, retry, **k: deferred.append((name, retry)))
    monkeypatch.setattr("src.db.job_start", lambda name: "run-1")
    monkeypatch.setattr("src.db.job_finish", lambda *a, **k: None)
    monkeypatch.setattr(
        "src.amazon_ads.reports.sync_ads",
        lambda **k: {"ran": ["search_terms"],
                     "search_terms": {"stopped": "slot_busy",
                                      "errors": ["HTTP 425"], "rows": 0}})
    monkeypatch.setattr(main_mod, "_ads_sync_outcome",
                        lambda result, days: ("partial", "425"))
    monkeypatch.setattr(main_mod, "_ads_alert", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("425 must not Telegram")))

    status = main_mod._run_ads_sync_job(
        "ads_search_terms_sync", days=7, search_terms_only=True,
        label="search terms")
    assert status == "deferred"
    assert deferred == [("ads_search_terms_sync", 0)]


def test_run_ads_sync_job_defers_on_busy(monkeypatch):
    from src import main as main_mod
    from src.amazon_ads.reports import AdsSyncBusy
    deferred = []
    monkeypatch.setattr(main_mod, "_defer_ads_job",
                        lambda name, retry, **k: deferred.append(name))
    monkeypatch.setattr("src.db.job_start", lambda name: "run-1")
    monkeypatch.setattr("src.db.job_finish", lambda *a, **k: None)

    def boom(**k):
        raise AdsSyncBusy("another ads pull is running")

    monkeypatch.setattr("src.amazon_ads.reports.sync_ads", boom)
    status = main_mod._run_ads_sync_job(
        "ads_placements_sync", days=14, placements_only=True, label="placements")
    assert status == "skipped"
    assert deferred == ["ads_placements_sync"]


def test_missing_day_between_neighbors():
    from src.amazon_ads.reports import missing_search_term_days
    gaps = missing_search_term_days(
        date(2026, 9, 1), date(2026, 9, 5),
        {date(2026, 9, 2), date(2026, 9, 4), date(2026, 9, 5)})
    assert gaps == [date(2026, 9, 3)]


def test_successful_summary_stamp_does_not_cascade():
    """7d SUMMARY stamps yesterday only — do not fill the other six days."""
    from src.amazon_ads.reports import missing_search_term_days
    gaps = missing_search_term_days(
        date(2026, 8, 31), date(2026, 9, 6),
        {date(2026, 9, 6)})
    assert gaps == []


def test_trailing_miss_after_failed_night():
    from src.amazon_ads.reports import missing_search_term_days
    gaps = missing_search_term_days(
        date(2026, 9, 1), date(2026, 9, 6),
        {date(2026, 9, 1), date(2026, 9, 2), date(2026, 9, 3),
         date(2026, 9, 4), date(2026, 9, 5)},
        spend_dates={date(2026, 9, 6)})
    assert gaps == [date(2026, 9, 6)]


def test_no_st_dates_exits_empty():
    from src.amazon_ads.reports import missing_search_term_days
    assert missing_search_term_days(
        date(2026, 9, 1), date(2026, 9, 7),
        set(), spend_dates={date(2026, 9, 3)}) == []


def test_covered_days_not_returned():
    from src.amazon_ads.reports import missing_search_term_days
    days = {date(2026, 9, 1) + timedelta(days=i) for i in range(7)}
    assert missing_search_term_days(
        date(2026, 9, 1), date(2026, 9, 7), days) == []


def test_gap_fill_exits_without_lock_when_no_gaps(monkeypatch):
    import src.amazon_ads.reports as reports
    lock_calls = []

    class FakeLock:
        def acquire(self, timeout=None):
            lock_calls.append(timeout)
            return True

        def release(self):
            return None

    monkeypatch.setattr(reports, "amazon_as_of", lambda: date(2026, 9, 6))
    monkeypatch.setattr(reports, "detect_missing_search_term_days",
                        lambda days=7, as_of=None: [])
    monkeypatch.setattr(reports, "_SYNC_LOCK", FakeLock())
    result = reports.sync_search_term_gap_days(lookback_days=7)
    assert lock_calls == []
    assert result["search_terms"]["no_gaps"] is True


def test_gap_fill_pulls_only_missing_days(monkeypatch):
    import src.amazon_ads.reports as reports
    fetched = []
    monkeypatch.setattr(
        reports, "_search_term_chunk_present",
        lambda end, start=None: end == date(2026, 9, 4))
    monkeypatch.setattr(
        reports, "fetch_search_terms",
        lambda cs, ce, chunk_days=1: fetched.append((cs, ce, chunk_days)) or {
            "rows": 1, "inserted": 1, "errors": [], "stopped": None})
    monkeypatch.setattr(reports, "beat_ads_lease", lambda: None)

    result = reports.fetch_search_term_gap_days(
        [date(2026, 9, 3), date(2026, 9, 4), date(2026, 9, 6)])
    assert fetched == [
        (date(2026, 9, 3), date(2026, 9, 3), 1),
        (date(2026, 9, 6), date(2026, 9, 6), 1),
    ]
    assert result["chunks_skipped_existing"] == 1
    assert result["chunk_days"] == 1


def test_gap_fill_425_stops_remaining_days(monkeypatch):
    import src.amazon_ads.reports as reports
    fetched = []

    def fake(cs, ce, chunk_days=1):
        fetched.append(cs)
        if cs == date(2026, 9, 3):
            return {"rows": 0, "inserted": 0, "errors": ["HTTP 425"],
                    "stopped": "slot_busy"}
        return {"rows": 1, "inserted": 1, "errors": [], "stopped": None}

    monkeypatch.setattr(reports, "_search_term_chunk_present",
                        lambda end, start=None: False)
    monkeypatch.setattr(reports, "fetch_search_terms", fake)
    monkeypatch.setattr(reports, "beat_ads_lease", lambda: None)
    result = reports.fetch_search_term_gap_days(
        [date(2026, 9, 2), date(2026, 9, 3), date(2026, 9, 4)])
    assert fetched == [date(2026, 9, 2), date(2026, 9, 3)]
    assert result["stopped"] == "slot_busy"


def test_weekday_gap_job_exits_without_sync_when_no_gaps(monkeypatch):
    from src import main as main_mod
    import src.amazon_ads.reports as reports
    sync_calls = []
    jobs = []
    monkeypatch.setattr(reports, "detect_missing_search_term_days",
                        lambda days=7, as_of=None: [])
    monkeypatch.setattr(reports, "sync_search_term_gap_days",
                        lambda **k: sync_calls.append(k))
    monkeypatch.setattr("src.db.job_start",
                        lambda name: jobs.append(name) or "run-1")
    assert main_mod._run_ads_search_terms_day_gaps() == "success"
    assert sync_calls == []
    assert jobs == []


def test_sunday_backfill_does_not_call_day_gaps():
    import inspect
    from src.main import _run_ads_search_terms_backfill
    src = inspect.getsource(_run_ads_search_terms_backfill)
    assert "_run_ads_search_terms_day_gaps" not in src
    assert "skip_existing_search_term_weeks=True" in src
