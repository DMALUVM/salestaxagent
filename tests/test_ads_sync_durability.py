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
    assert main_mod._defer_ads_job("ads_search_terms_sync", 0) is True
    assert added == ["ads_search_terms_gap_fill_retry_1"]
    # Cap=1: second 425 defer must not schedule another date-trigger.
    assert main_mod._defer_ads_job("ads_search_terms_sync", 1) is False
    assert added == ["ads_search_terms_gap_fill_retry_1"]


def test_defer_caps_at_one_and_is_not_a_wait_loop():
    import inspect
    from src import main as main_mod
    src = inspect.getsource(main_mod._defer_ads_job)
    assert "AwaitShell" not in src
    assert "while " not in src
    assert "sleep" not in src
    waiter = inspect.getsource(main_mod._wait_ads_lease_then)
    assert "while " not in waiter
    assert "sleep" not in waiter
    assert "job_start" not in waiter
    sched = inspect.getsource(main_mod._schedule_ads_retry)
    assert "replace_existing=True" in sched
    assert main_mod._ADS_RETRY_MAX == 1
    assert main_mod._ADS_LEASE_POLL_SECONDS <= 120
    assert main_mod._ads_lease_wait_cap() * main_mod._ADS_LEASE_POLL_SECONDS >= 6 * 3600


def test_placements_stop_on_425(monkeypatch):
    import src.amazon_ads.reports as reports
    from datetime import date
    from src.amazon_ads.client import AdsReportSlotBusy

    calls = []

    def fake(cs, ce):
        calls.append((cs, ce))
        if len(calls) == 1:
            raise AdsReportSlotBusy("HTTP 425")
        return []

    monkeypatch.setattr(reports, "_fetch_placements_chunk", fake)
    r = reports.fetch_placements(date(2026, 8, 1), date(2026, 9, 5))
    assert len(calls) == 1
    assert r["stopped"] == "slot_busy"
    assert reports.ads_slot_busy_in_result({"placements": r})


def test_lease_busy_queues_one_retry_not_a_poll(monkeypatch):
    """AdsSyncBusy arms one lease waiter — not 20-minute skip retries."""
    from src import main as main_mod
    added = []
    main_mod._PENDING_AFTER_LEASE.clear()

    class Sched:
        def add_job(self, fn, kind, run_date=None, id=None, **k):
            added.append(id)

    monkeypatch.setattr(main_mod, "_SCHEDULER", Sched())
    assert main_mod._defer_ads_job("ads_placements_sync", 0, after_lease=True)
    assert main_mod._defer_ads_job("ads_placements_sync", 1, after_lease=True) is False
    assert added == ["ads_placements_sync_after_lease"]
    assert list(main_mod._PENDING_AFTER_LEASE) == ["ads_placements_sync"]
    main_mod._flush_ads_after_lease()
    assert added == [
        "ads_placements_sync_after_lease", "ads_placements_sync_after_lease"]
    assert main_mod._PENDING_AFTER_LEASE == {}


def test_lease_waiter_rearms_quietly_while_live(monkeypatch, lock_dir):
    """Other-process holder: poll lease file, write no job_runs."""
    from src import main as main_mod
    import src.amazon_ads.sync_lock as sl
    import os
    added = []
    started = []
    ran = []
    main_mod._PENDING_AFTER_LEASE.clear()

    class Sched:
        def add_job(self, fn, kind, run_date=None, id=None, **k):
            added.append(id)

    sl._write_lease(lock_dir, {
        "pid": os.getpid(),
        "heartbeat_at": _utc().isoformat(),
        "started_at": _utc().isoformat(),
        "job": "ads_sync",
    })
    monkeypatch.setattr(main_mod, "_SCHEDULER", Sched())
    monkeypatch.setattr("src.db.job_start",
                        lambda name: started.append(name) or "run-x")
    main_mod._wait_ads_lease_then(
        "ads_search_terms_gap_fill", lambda: ran.append(1), attempt=0)
    assert ran == []
    assert started == []
    assert added == ["ads_search_terms_gap_fill_after_lease"]


def test_lease_waiter_runs_once_when_heartbeat_dead(monkeypatch, lock_dir):
    from src import main as main_mod
    import src.amazon_ads.sync_lock as sl
    ran = []
    main_mod._PENDING_AFTER_LEASE["ads_placements_sync"] = lambda: ran.append(1)
    sl._write_lease(lock_dir, {
        "pid": 999_999_999,
        "heartbeat_at": _utc().isoformat(),
        "started_at": _utc().isoformat(),
        "job": "ads_campaigns_sync",
    })
    main_mod._wait_ads_lease_then(
        "ads_placements_sync", lambda: ran.append(1), attempt=0)
    assert ran == [1]
    assert "ads_placements_sync" not in main_mod._PENDING_AFTER_LEASE


def test_gap_fill_and_gno_share_the_after_lease_queue(monkeypatch):
    from src import main as main_mod
    main_mod._PENDING_AFTER_LEASE.clear()
    main_mod._defer_ads_job("ads_search_terms_gap_fill", 0, after_lease=True)
    main_mod._defer_ads_job("ads_search_terms_sync", 0, after_lease=True)
    main_mod._defer_ads_job("ads_gno_campaigns_sync", 0, after_lease=True)
    assert set(main_mod._PENDING_AFTER_LEASE) == {
        "ads_search_terms_gap_fill", "ads_gno_campaigns_sync",
    }
    main_mod._PENDING_AFTER_LEASE.clear()


def test_already_queued_busy_job_writes_no_job_run(monkeypatch):
    from src import main as main_mod
    from src.amazon_ads.reports import AdsSyncBusy
    starts = []
    main_mod._PENDING_AFTER_LEASE.clear()
    main_mod._enqueue_ads_after_lease("ads_placements_sync", lambda: None)
    monkeypatch.setattr("src.db.job_start",
                        lambda name: starts.append(name) or "run-x")
    monkeypatch.setattr("src.db.job_finish", lambda *a, **k: None)
    monkeypatch.setattr(
        "src.amazon_ads.reports.sync_ads",
        lambda **k: (_ for _ in ()).throw(AdsSyncBusy("busy")))
    status = main_mod._run_ads_sync_job(
        "ads_placements_sync", days=14, placements_only=True, label="placements")
    assert status == "skipped"
    assert starts == []
    main_mod._PENDING_AFTER_LEASE.clear()


def test_release_lease_flushes_pending_retry(monkeypatch, lock_dir):
    from src import main as main_mod
    import src.amazon_ads.sync_lock as sl
    added = []
    main_mod._PENDING_AFTER_LEASE.clear()

    class Sched:
        def add_job(self, fn, kind, run_date=None, id=None, **k):
            added.append(id)

    monkeypatch.setattr(main_mod, "_SCHEDULER", Sched())
    main_mod._defer_ads_job("ads_search_terms_gap_fill", 0, after_lease=True)
    sl.release_ads_lease()
    # Waiter armed on enqueue; same-process release replaces it with the job.
    assert added == [
        "ads_search_terms_gap_fill_after_lease",
        "ads_search_terms_gap_fill_after_lease",
    ]
    assert main_mod._PENDING_AFTER_LEASE == {}


def test_sb_sd_timeout_stops_remaining_days(monkeypatch):
    import src.amazon_ads.reports as reports
    from datetime import date
    from src.amazon_ads.client import AdsReportSlotBusy

    fetched = []

    def fake(cs, ce, product="SP"):
        fetched.append((product, cs))
        if product == "SP":
            return [{"date": ce.isoformat(), "campaignId": "sp-1",
                     "campaignName": "sp", "impressions": 1, "clicks": 1,
                     "spend": 10}]
        if product == "SB":
            raise TimeoutError("Report sb timed out after 1800s")
        raise AdsReportSlotBusy("425")

    monkeypatch.setattr(reports, "_fetch_campaigns_chunk", fake)
    monkeypatch.setattr(reports, "upsert_rows",
                        lambda *a, **k: 1)
    r = reports.fetch_campaigns_daily(
        date(2026, 9, 1), date(2026, 9, 7), sb_sd_days=7)
    sb = [cs for product, cs in fetched if product == "SB"]
    sd = [cs for product, cs in fetched if product == "SD"]
    assert len(sb) == 1
    assert sd == []
    assert r["by_type"]["SP"]["ok"] is True
    assert r["partial"] is True


def test_sb_sd_should_release_lock_on_timeout_and_425():
    from src.amazon_ads.client import AdsReportSlotBusy
    from src.amazon_ads.reports import _sb_sd_should_release_lock
    assert _sb_sd_should_release_lock(TimeoutError("timed out after 1800s"))
    assert _sb_sd_should_release_lock(AdsReportSlotBusy("HTTP 425"))
    assert not _sb_sd_should_release_lock(RuntimeError("429 rate limited"))


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


def test_run_ads_sync_job_does_not_defer_when_sp_landed_on_425(monkeypatch):
    from src import main as main_mod
    deferred = []
    main_mod._PENDING_AFTER_LEASE.clear()
    monkeypatch.setattr(main_mod, "_defer_ads_job",
                        lambda *a, **k: deferred.append((a, k)))
    monkeypatch.setattr("src.db.job_start", lambda name: "run-1")
    monkeypatch.setattr("src.db.job_finish", lambda *a, **k: None)
    monkeypatch.setattr(
        "src.amazon_ads.reports.sync_ads",
        lambda **k: {
            "ran": ["campaigns"],
            "campaigns": {
                "errors": ["SB chunk 1: Amazon Ads reporting slot busy (HTTP 425)."],
                "by_type": {"SP": {"ok": True, "rows": 8, "spend": 10, "clicks": 4}},
                "products_ok": ["SP"],
                "products_failed": ["SB"],
            },
        })
    status = main_mod._run_ads_sync_job(
        "ads_campaigns_sync", days=7, campaigns_only=True, label="campaigns")
    assert status == "partial"
    assert deferred == []


def test_run_ads_sync_job_defers_on_busy(monkeypatch):
    from src import main as main_mod
    from src.amazon_ads.reports import AdsSyncBusy
    deferred = []
    main_mod._PENDING_AFTER_LEASE.clear()
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


@pytest.fixture
def pending_dir(tmp_path, monkeypatch):
    path = tmp_path / "ads_pending_reports.json"
    import src.amazon_ads.pending_reports as pr
    monkeypatch.setattr(pr, "_PATH_OVERRIDE", path)
    yield path
    monkeypatch.setattr(pr, "_PATH_OVERRIDE", None)
    if path.exists():
        path.unlink()


def test_kind_from_config_campaigns_st_placements():
    from src.amazon_ads.pending_reports import kind_from_config
    assert kind_from_config({
        "configuration": {"reportTypeId": "spCampaigns", "groupBy": ["campaign"]},
    }) == "campaigns"
    assert kind_from_config({
        "configuration": {"reportTypeId": "spSearchTerm", "groupBy": ["searchTerm"]},
    }) == "search_terms"
    assert kind_from_config({
        "configuration": {
            "reportTypeId": "spCampaigns",
            "groupBy": ["campaignPlacement"],
        },
    }) == "placements"


def test_pending_registry_register_persist_clear(pending_dir):
    from src.amazon_ads.pending_reports import (
        clear_pending_report,
        read_pending_reports,
        register_pending_report,
    )
    entry = register_pending_report(
        "rep-1",
        config={
            "startDate": "2026-09-01",
            "endDate": "2026-09-07",
            "configuration": {
                "adProduct": "SPONSORED_PRODUCTS",
                "reportTypeId": "spSearchTerm",
            },
        },
    )
    assert entry["report_id"] == "rep-1"
    assert entry["kind"] == "search_terms"
    assert entry["ad_product"] == "SPONSORED_PRODUCTS"
    assert entry["start_date"] == "2026-09-01"
    assert entry["end_date"] == "2026-09-07"
    rows = read_pending_reports()
    assert len(rows) == 1
    assert rows[0]["report_id"] == "rep-1"
    raw = pending_dir.read_text()
    assert "rep-1" in raw
    assert clear_pending_report("rep-1") is True
    assert read_pending_reports() == []


def test_pending_registry_replace_same_id(pending_dir):
    from src.amazon_ads.pending_reports import (
        read_pending_reports,
        register_pending_report,
    )
    register_pending_report("rep-1", kind="campaigns", ad_product="SP")
    register_pending_report("rep-1", kind="search_terms", ad_product="SP")
    rows = read_pending_reports()
    assert [r["report_id"] for r in rows] == ["rep-1"]
    assert rows[0]["kind"] == "search_terms"


def test_cancel_persisted_clears_success_keeps_failure(pending_dir, monkeypatch):
    from src.amazon_ads import pending_reports as pr
    pr.register_pending_report("rep-ok", kind="campaigns")
    pr.register_pending_report("rep-fail", kind="search_terms")

    def fake_cancel(rid):
        return rid == "rep-ok"

    monkeypatch.setattr("src.amazon_ads.client.cancel_report", fake_cancel)
    swept = pr.cancel_persisted_pending_reports()
    assert swept["cancelled"] == ["rep-ok"]
    assert swept["failed"] == ["rep-fail"]
    left = pr.read_pending_reports()
    assert [r["report_id"] for r in left] == ["rep-fail"]


def test_create_report_registers_pending(pending_dir, monkeypatch):
    import src.amazon_ads.client as client

    class Resp:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"reportId": "rep-new"}

    monkeypatch.setattr(client, "ads_headers", lambda: {})
    monkeypatch.setattr(client.httpx, "post", lambda *a, **k: Resp())
    rid = client.create_report({
        "startDate": "2026-09-06",
        "endDate": "2026-09-06",
        "configuration": {
            "adProduct": "SPONSORED_DISPLAY",
            "reportTypeId": "sdCampaigns",
            "groupBy": ["campaign"],
        },
    })
    assert rid == "rep-new"
    from src.amazon_ads.pending_reports import read_pending_reports
    rows = read_pending_reports()
    assert rows[0]["report_id"] == "rep-new"
    assert rows[0]["kind"] == "campaigns"
    assert rows[0]["ad_product"] == "SPONSORED_DISPLAY"


def test_create_report_425_cancels_persisted_no_wait_loop(
        pending_dir, monkeypatch):
    import src.amazon_ads.client as client
    from src.amazon_ads.pending_reports import register_pending_report

    register_pending_report("rep-zombie", kind="campaigns",
                            ad_product="SPONSORED_PRODUCTS")
    posts = []
    cancelled = []

    class Resp:
        status_code = 425
        text = "Too Early"

        def json(self):
            return {}

        def raise_for_status(self):
            raise AssertionError("425 must not fall through to raise_for_status")

    monkeypatch.setattr(client, "ads_headers", lambda: {})
    monkeypatch.setattr(client.httpx, "post",
                        lambda *a, **k: posts.append(1) or Resp())
    monkeypatch.setattr(client, "cancel_report",
                        lambda rid: cancelled.append(rid) or True)
    slept = []
    monkeypatch.setattr(client.time, "sleep", lambda s: slept.append(s))

    with pytest.raises(client.AdsReportSlotBusy, match="Cancelled 1") as ei:
        client.create_report({"configuration": {"reportTypeId": "spSearchTerm"}})
    assert ei.value.cancelled_ids == ["rep-zombie"]
    assert cancelled == ["rep-zombie"]
    assert posts == [1]
    assert slept == []
    from src.amazon_ads.pending_reports import read_pending_reports
    assert read_pending_reports() == []


def test_425_then_single_defer_not_inline_retry(monkeypatch, pending_dir):
    """425 cancels persisted ids, then exactly one deferred retry — no loop."""
    import inspect
    import src.amazon_ads.client as client
    from src import main as main_mod

    src = inspect.getsource(client.create_report)
    assert "_clear_slot_after_busy" in src
    assert "sleep" not in src
    backoff = inspect.getsource(__import__(
        "src.amazon_ads.reports", fromlist=["_fetch_report_with_backoff"]
    )._fetch_report_with_backoff)
    assert "except AdsReportSlotBusy" in backoff
    assert "raise" in backoff.split("except AdsReportSlotBusy")[1].split("except")[0]

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
    monkeypatch.setattr(main_mod, "_ads_alert", lambda *a, **k: None)

    status = main_mod._run_ads_sync_job(
        "ads_search_terms_sync", days=7, search_terms_only=True,
        label="search terms")
    assert status == "deferred"
    assert deferred == [("ads_search_terms_sync", 0)]


def test_fetch_report_clears_pending_on_complete(pending_dir, monkeypatch):
    import src.amazon_ads.client as client
    from src.amazon_ads.pending_reports import (
        read_pending_reports,
        register_pending_report,
    )

    register_pending_report("rep-done", kind="campaigns")
    monkeypatch.setattr(client, "create_report", lambda cfg: "rep-done")
    monkeypatch.setattr(client, "poll_report",
                        lambda *a, **k: {"status": "COMPLETED", "url": "http://x"})
    monkeypatch.setattr(client, "download_report", lambda url: [{"ok": 1}])
    rows = client.fetch_report({"configuration": {}})
    assert rows == [{"ok": 1}]
    assert read_pending_reports() == []


def test_claim_steals_stale_heartbeat_even_if_pid_alive(lock_dir):
    import src.amazon_ads.sync_lock as sl
    sl._write_lease(lock_dir, {
        "pid": os.getpid(),
        "heartbeat_at": _utc(hours_ago=2).isoformat(),
        "started_at": _utc(hours_ago=2).isoformat(),
        "job": "ads_campaigns_sync",
    })
    assert sl.lease_is_live(sl.read_lease()) is False
    assert sl.claim_ads_lease("ads_search_terms_sync") is True
    held = sl.read_lease()
    assert held["pid"] == os.getpid()
    assert held["job"] == "ads_search_terms_sync"
    sl.release_ads_lease()


def test_beat_does_not_update_other_pid_lease(lock_dir):
    import src.amazon_ads.sync_lock as sl
    sl._write_lease(lock_dir, {
        "pid": 1,
        "heartbeat_at": "2026-09-01T00:00:00+00:00",
        "started_at": "2026-09-01T00:00:00+00:00",
        "job": "ads_sync",
    })
    sl.beat_ads_lease()
    lease = sl.read_lease()
    assert lease["pid"] == 1
    assert lease["heartbeat_at"] == "2026-09-01T00:00:00+00:00"


def test_fail_stale_keeps_own_pid_row_started_before_lease(
        lock_dir, monkeypatch):
    import src.amazon_ads.sync_lock as sl
    lease_start = _utc(hours_ago=0.02)
    sl._write_lease(lock_dir, {
        "pid": os.getpid(),
        "heartbeat_at": _utc().isoformat(),
        "started_at": lease_start.isoformat(),
        "job": "ads_campaigns_sync",
    })
    finished = []
    rows = [{
        "id": "run-cli",
        "job_name": "ads_campaigns_sync",
        "status": "running",
        "started_at": (lease_start - timedelta(minutes=2)).isoformat(),
    }]
    monkeypatch.setattr("src.db.get_client", lambda: _JobClient(rows))
    monkeypatch.setattr("src.db.job_finish",
                        lambda rid, status, message, stats=None:
                        finished.append((rid, status, message)))
    assert sl.fail_stale_ads_job_runs(now=_utc()) == []
    assert finished == []


def test_fail_stale_still_clears_old_orphan_after_we_steal(
        lock_dir, monkeypatch):
    import src.amazon_ads.sync_lock as sl
    sl._write_lease(lock_dir, {
        "pid": os.getpid(),
        "heartbeat_at": _utc().isoformat(),
        "started_at": _utc().isoformat(),
        "job": "ads_search_terms_sync",
    })
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
                        finished.append(rid))
    failed = sl.fail_stale_ads_job_runs(now=_utc())
    assert [r["id"] for r in failed] == ["run-orphan"]
    assert finished == ["run-orphan"]


def test_sync_ads_fail_stale_runs_after_claim():
    import inspect
    from src.amazon_ads.reports import sync_ads, sync_search_term_gap_days
    for fn in (sync_ads, sync_search_term_gap_days):
        src = inspect.getsource(fn)
        claim_at = src.index("claim_ads_lease")
        stale_at = src.index("fail_stale_ads_job_runs")
        assert claim_at < stale_at, fn.__name__


def test_lease_exit_hooks_document_sigkill():
    import inspect
    from src.amazon_ads.sync_lock import (
        claim_ads_lease,
        install_ads_lease_exit_hooks,
    )
    src = inspect.getsource(install_ads_lease_exit_hooks)
    assert "atexit" in src
    assert "SIGTERM" in src
    assert "SIGKILL" in src
    claim = inspect.getsource(claim_ads_lease)
    assert "install_ads_lease_exit_hooks" in claim
    assert "stealing" in claim or "steal" in claim


def test_ads_sync_cli_has_cancel_stale_reports():
    import inspect
    from src import main as main_mod
    src = inspect.getsource(main_mod)
    start = src.index("def ads_sync_cmd")
    body = src[start:src.index("def _print_search_term_coverage")]
    assert "--cancel-stale-reports" in src
    assert "--cancel-all-pending" in src
    assert "cancel_all_pending" in body
    assert "_cancel_ads_reports_cli" in body
    assert "SIGKILL" in body
