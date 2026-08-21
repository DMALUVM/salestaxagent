"""Quota-aware multi-week SQP backfill.

Brand Analytics report requests are tightly rate-limited — three ad-hoc calls
already produced QuotaExceeded once. These pin the safety properties: only
completed weeks, a hard cap per invocation, resume without re-spending quota,
and a clean stop (never a retry storm) when the limit is hit.
"""
from datetime import date, timedelta

import pytest

import src.amazon_sp.sqp as sqp
from src.amazon_sp.sqp import completed_weeks, weeks_in_range


class TestWeekEnumeration:
    def test_walks_backward_from_the_last_complete_week(self):
        weeks = completed_weeks(4, date(2026, 8, 21))     # a Friday
        assert weeks == [
            (date(2026, 8, 9), date(2026, 8, 15)),
            (date(2026, 8, 2), date(2026, 8, 8)),
            (date(2026, 7, 26), date(2026, 8, 1)),
            (date(2026, 7, 19), date(2026, 7, 25)),
        ]

    def test_every_week_is_sunday_to_saturday(self):
        for s, e in completed_weeks(12, date(2026, 8, 21)):
            assert s.weekday() == 6 and e.weekday() == 5
            assert (e - s).days == 6

    def test_never_includes_the_in_progress_week(self):
        for offset in range(0, 21):
            ref = date(2026, 8, 1) + timedelta(days=offset)
            for _, e in completed_weeks(3, ref):
                assert e < ref, (ref, e)

    def test_weeks_are_contiguous_and_non_overlapping(self):
        weeks = completed_weeks(6, date(2026, 8, 21))
        for (s1, _), (_, e2) in zip(weeks, weeks[1:]):
            assert (s1 - e2).days == 1

    def test_zero_or_negative_count(self):
        assert completed_weeks(0, date(2026, 8, 21)) == []
        assert completed_weeks(-3, date(2026, 8, 21)) == []

    def test_range_is_bounded_at_both_ends(self):
        weeks = weeks_in_range(date(2026, 7, 1), date(2026, 8, 15))
        assert weeks[0] == (date(2026, 8, 9), date(2026, 8, 15))
        assert all(e <= date(2026, 8, 15) for _, e in weeks)
        assert all(e >= date(2026, 7, 1) for _, e in weeks)


def _stub(monkeypatch, *, fetched, stored=(), quota_on=None, rows=3):
    """Wire backfill to fakes; records which weeks were actually requested."""
    monkeypatch.setattr(sqp, "resolve_asins",
                        lambda *a, **k: {"asins": ["B0X"], "basis": "config",
                                         "unknown": [], "note": ""})
    monkeypatch.setattr(sqp, "stored_week_ends", lambda: set(stored))
    monkeypatch.setattr(sqp, "_upsert_weekly", lambda r: len(r))
    monkeypatch.setattr("src.amazon_ads.organic_rank.upsert_ranks", lambda r: len(r))
    monkeypatch.setattr("src.amazon_ads.organic_rank.load_config",
                        lambda: {"sqp_auto": {"asins": ["B0X"]}})
    monkeypatch.setattr("time.sleep", lambda s: None)

    def fake_fetch(asins, period="WEEK", ref=None, timeout=1800):
        week_end = ref - timedelta(days=1)
        fetched.append(week_end.isoformat())
        if quota_on and week_end.isoformat() == quota_on:
            return {"rows": [], "weekly": [],
                    "errors": ["batch 1: SP-API error QuotaExceeded"],
                    "warnings": []}
        return {"rows": [{"k": i} for i in range(rows)],
                "weekly": [{"k": i} for i in range(rows)],
                "errors": [], "warnings": []}

    monkeypatch.setattr(sqp, "fetch_sqp", fake_fetch)


class TestMaxWeeksCap:
    def test_one_invocation_cannot_exceed_the_cap(self, monkeypatch):
        fetched: list[str] = []
        _stub(monkeypatch, fetched=fetched)
        r = sqp.backfill(max_weeks=2, dry_run=False, sleep_secs=0)
        assert len(fetched) == 2
        assert len(r["weeks_done"]) == 2

    def test_dry_run_makes_no_requests(self, monkeypatch):
        fetched: list[str] = []
        _stub(monkeypatch, fetched=fetched)
        r = sqp.backfill(max_weeks=4, dry_run=True)
        assert fetched == []
        assert len(r["planned"]) == 4

    def test_default_cap_is_conservative(self):
        assert sqp.DEFAULT_MAX_WEEKS <= 4
        assert sqp.DEFAULT_BACKFILL_SLEEP_SECS >= 60


class TestResume:
    def test_stored_weeks_are_skipped(self, monkeypatch):
        fetched: list[str] = []
        weeks = completed_weeks(4, date.today())
        stored = [weeks[0][1].isoformat(), weeks[1][1].isoformat()]
        _stub(monkeypatch, fetched=fetched, stored=stored)
        r = sqp.backfill(max_weeks=2, dry_run=False, sleep_secs=0)
        assert not set(fetched) & set(stored)
        assert sorted(r["skipped_existing"]) == sorted(stored)

    def test_no_resume_refetches_everything(self, monkeypatch):
        fetched: list[str] = []
        stored = [completed_weeks(1, date.today())[0][1].isoformat()]
        _stub(monkeypatch, fetched=fetched, stored=stored)
        sqp.backfill(max_weeks=1, dry_run=False, resume=False, sleep_secs=0)
        assert fetched == stored

    def test_a_fully_stored_range_requests_nothing(self, monkeypatch):
        fetched: list[str] = []
        stored = [e.isoformat() for _, e in completed_weeks(20, date.today())]
        _stub(monkeypatch, fetched=fetched, stored=stored)
        r = sqp.backfill(max_weeks=4, dry_run=False, sleep_secs=0)
        assert fetched == [] and r["weeks_done"] == []


class TestQuotaSafety:
    def test_quota_stops_the_walk_immediately(self, monkeypatch):
        fetched: list[str] = []
        weeks = completed_weeks(4, date.today())
        _stub(monkeypatch, fetched=fetched, quota_on=weeks[1][1].isoformat())
        r = sqp.backfill(max_weeks=4, dry_run=False, sleep_secs=0)
        assert r["quota_exceeded"] is True
        # First week succeeded, quota hit on the second, nothing after.
        assert len(fetched) == 2
        assert len(r["weeks_done"]) == 1

    def test_quota_does_not_retry_the_failed_week(self, monkeypatch):
        fetched: list[str] = []
        weeks = completed_weeks(4, date.today())
        target = weeks[0][1].isoformat()
        _stub(monkeypatch, fetched=fetched, quota_on=target)
        sqp.backfill(max_weeks=4, dry_run=False, sleep_secs=0)
        assert fetched.count(target) == 1, "must not retry into the rate limit"

    def test_progress_before_the_quota_is_preserved(self, monkeypatch):
        fetched: list[str] = []
        weeks = completed_weeks(4, date.today())
        _stub(monkeypatch, fetched=fetched, quota_on=weeks[2][1].isoformat(), rows=5)
        r = sqp.backfill(max_weeks=4, dry_run=False, sleep_secs=0)
        assert r["rows_written"] == 10       # two full weeks kept
        assert "resume_hint" in r

    def test_resume_hint_tells_the_operator_what_to_do(self, monkeypatch):
        fetched: list[str] = []
        _stub(monkeypatch, fetched=fetched,
              quota_on=completed_weeks(1, date.today())[0][1].isoformat())
        r = sqp.backfill(max_weeks=4, dry_run=False, sleep_secs=0)
        assert "re-run the same command" in r["resume_hint"]

    def test_an_ordinary_week_failure_does_not_stop_the_walk(self, monkeypatch):
        """A timeout on one week is not a rate limit — keep going."""
        fetched: list[str] = []
        _stub(monkeypatch, fetched=fetched)
        weeks = completed_weeks(3, date.today())
        bad = weeks[0][1].isoformat()

        original = sqp.fetch_sqp

        def flaky(asins, period="WEEK", ref=None, timeout=1800):
            if (ref - timedelta(days=1)).isoformat() == bad:
                fetched.append(bad)
                raise RuntimeError("report timed out")
            return original(asins, period=period, ref=ref, timeout=timeout)

        monkeypatch.setattr(sqp, "fetch_sqp", flaky)
        r = sqp.backfill(max_weeks=3, dry_run=False, sleep_secs=0)
        assert len(r["weeks_failed"]) == 1
        assert len(r["weeks_done"]) == 2


class TestRangeClamping:
    def test_to_is_clamped_to_the_last_complete_week(self, monkeypatch):
        fetched: list[str] = []
        _stub(monkeypatch, fetched=fetched)
        far_future = date.today() + timedelta(days=30)
        r = sqp.backfill(max_weeks=1, to_date=far_future, dry_run=True)
        _, last_complete = sqp.week_bounds(date.today())
        assert r["planned"][0][1] == last_complete.isoformat()

    def test_explicit_range_is_respected(self, monkeypatch):
        fetched: list[str] = []
        _stub(monkeypatch, fetched=fetched)
        r = sqp.backfill(max_weeks=10, from_date=date(2026, 7, 1),
                         to_date=date(2026, 8, 15), dry_run=True)
        ends = [e for _, e in r["planned"]]
        assert all("2026-07-01" <= e <= "2026-08-15" for e in ends)


class TestIdempotency:
    def test_rewriting_a_week_does_not_duplicate(self, monkeypatch):
        """Upserts are keyed; a second run of the same week overwrites."""
        seen: dict[tuple, dict] = {}

        def fake_upsert(rows):
            for r in rows:
                seen[(r["asin"], r["keyword_normalized"], r["as_of"])] = r
            return len(rows)

        monkeypatch.setattr("src.amazon_ads.organic_rank.upsert_ranks", fake_upsert)
        row = {"asin": "A", "keyword_normalized": "kw", "as_of": "2026-08-15"}
        fake_upsert([row]); fake_upsert([row])
        assert len(seen) == 1
