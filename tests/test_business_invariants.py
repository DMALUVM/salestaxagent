"""Business invariants — guard-rails that MUST pass after any sales/ads change.

Run: pytest tests/test_business_invariants.py -v

These tests enforce the rules in config/business_rules.json via src/rules.py.
They are pure logic tests — no database, no API calls, no network.
"""
from __future__ import annotations

import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest


# ── 1. Config file loads and is well-formed ───────────────────


class TestBusinessRulesConfig:
    @pytest.fixture(autouse=True)
    def load_config(self):
        path = Path(__file__).resolve().parent.parent / "config" / "business_rules.json"
        with open(path) as f:
            self.cfg = json.load(f)

    def test_config_has_required_sections(self):
        for key in ("amazon", "shopify", "spapi", "ads", "pnl"):
            assert key in self.cfg, f"Missing section: {key}"

    def test_amazon_timezone_is_pacific(self):
        assert self.cfg["amazon"]["timezone"] == "America/Los_Angeles"

    def test_shopify_timezone_is_eastern(self):
        assert self.cfg["shopify"]["timezone"] == "America/New_York"

    def test_amazon_date_field(self):
        assert self.cfg["amazon"]["date_field"] == "purchase-date"

    def test_amazon_pulse_source(self):
        assert self.cfg["amazon"]["pulse_source"] == "amazon_spapi"

    def test_sku_economics_min_date(self):
        assert self.cfg["ads"]["sku_economics_min_date"] == "2024-09-01"

    def test_ads_mandatory_chunking(self):
        assert self.cfg["ads"]["mandatory_chunking"] is True

    def test_ads_chunk_within_api_limit(self):
        assert self.cfg["ads"]["max_chunk_days"] <= self.cfg["ads"]["max_report_days"]

    def test_ads_sb_sd_timeouts_are_durable(self):
        ads = self.cfg["ads"]
        assert ads["campaign_report_timeout_sb_seconds"] >= 900
        assert ads["campaign_report_timeout_sd_seconds"] >= 900
        # Still below the SP client default so SP remains the longer path.
        assert ads["campaign_report_timeout_sb_seconds"] < 1800
        assert ads["campaign_report_timeout_sd_seconds"] < 1800

    def test_ads_campaign_chunk_days_avoid_30day_sb_timeout(self):
        ads = self.cfg["ads"]
        assert ads["campaign_chunk_days"] == 7
        assert ads["campaign_chunk_days"] <= ads["max_chunk_days"]

    def test_ads_sb_sd_use_one_day_chunks(self):
        """SB/SD must chunk per day so one timeout cannot wipe a week.

        2026-08-25: a single 7-day SB/SD chunk timed out → SB+SD $0, SP kept,
        Aug 23–24 SP-only vs Seller Central.
        """
        ads = self.cfg["ads"]
        assert ads["campaign_sb_sd_chunk_days"] == 1
        assert ads["campaign_sb_sd_daily_days"] == 7
        assert ads["campaign_sb_sd_backfill_days"] == 7
        assert ads["campaign_sb_sd_chunk_days"] <= ads["campaign_chunk_days"]

    def test_spapi_chunk_limit(self):
        assert self.cfg["spapi"]["max_chunk_days"] <= 31

    def test_pnl_contribution_formula(self):
        assert "cogs" in self.cfg["pnl"]["contribution_formula"]
        assert "ad_spend" in self.cfg["pnl"]["contribution_formula"]
        assert "reimburse" not in self.cfg["pnl"]["contribution_formula"]

    def test_spapi_reimbursements_window_covers_a_closed_month(self):
        assert self.cfg["spapi"]["reimbursements_days"] >= 90
        assert self.cfg["spapi"]["reimbursements_days"] >= self.cfg["spapi"]["max_chunk_days"]


# ── 2. Rules module exposes correct constants ─────────────────


class TestRulesModule:
    def test_amazon_tz_is_pacific(self):
        from src.rules import AMAZON_TZ_NAME
        assert AMAZON_TZ_NAME == "America/Los_Angeles"

    def test_shopify_tz_is_eastern(self):
        from src.rules import SHOPIFY_TZ_NAME
        assert SHOPIFY_TZ_NAME == "America/New_York"

    def test_pending_is_included(self):
        from src.rules import AMAZON_INCLUDE_STATUSES
        assert "pending" in AMAZON_INCLUDE_STATUSES

    def test_unshipped_is_included(self):
        from src.rules import AMAZON_INCLUDE_STATUSES
        assert "unshipped" in AMAZON_INCLUDE_STATUSES

    def test_partiallyshipped_is_included(self):
        from src.rules import AMAZON_INCLUDE_STATUSES
        assert "partiallyshipped" in AMAZON_INCLUDE_STATUSES

    def test_shipped_is_included(self):
        from src.rules import AMAZON_INCLUDE_STATUSES
        assert "shipped" in AMAZON_INCLUDE_STATUSES

    def test_cancelled_is_excluded(self):
        from src.rules import AMAZON_EXCLUDE_STATUSES
        assert "cancelled" in AMAZON_EXCLUDE_STATUSES

    def test_shipped_only_is_not_default(self):
        """shipped-only filtering would miss pending/unshipped revenue."""
        from src.rules import AMAZON_EXCLUDE_STATUSES
        assert "pending" not in AMAZON_EXCLUDE_STATUSES
        assert "unshipped" not in AMAZON_EXCLUDE_STATUSES
        assert "partiallyshipped" not in AMAZON_EXCLUDE_STATUSES

    def test_is_excluded_status_cancelled(self):
        from src.rules import is_excluded_status
        assert is_excluded_status("cancelled") is True
        assert is_excluded_status("Cancelled") is True

    def test_is_excluded_status_pending_not_excluded(self):
        from src.rules import is_excluded_status
        assert is_excluded_status("pending") is False
        assert is_excluded_status("Pending") is False

    def test_is_excluded_status_shipped_not_excluded(self):
        from src.rules import is_excluded_status
        assert is_excluded_status("shipped") is False

    def test_ads_chunk_size_within_limit(self):
        from src.rules import ADS_MAX_CHUNK_DAYS, ADS_MAX_REPORT_DAYS
        assert ADS_MAX_CHUNK_DAYS <= ADS_MAX_REPORT_DAYS
        assert ADS_MAX_CHUNK_DAYS <= 31

    def test_ads_sb_sd_timeouts_from_config(self):
        from src.rules import (
            ADS_CAMPAIGN_TIMEOUT_SB_SECONDS,
            ADS_CAMPAIGN_TIMEOUT_SD_SECONDS,
        )
        assert ADS_CAMPAIGN_TIMEOUT_SB_SECONDS >= 900
        assert ADS_CAMPAIGN_TIMEOUT_SD_SECONDS >= 900
        assert ADS_CAMPAIGN_TIMEOUT_SB_SECONDS < 1800
        assert ADS_CAMPAIGN_TIMEOUT_SD_SECONDS < 1800

    def test_ads_campaign_chunks_are_smaller_than_the_api_cap(self):
        from src.rules import ADS_CAMPAIGN_CHUNK_DAYS, ADS_MAX_CHUNK_DAYS
        assert 1 <= ADS_CAMPAIGN_CHUNK_DAYS <= ADS_MAX_CHUNK_DAYS
        assert ADS_CAMPAIGN_CHUNK_DAYS == 7

    def test_ads_sb_sd_windows_from_config(self):
        from src.rules import (
            ADS_SB_SD_BACKFILL_DAYS,
            ADS_SB_SD_CHUNK_DAYS,
            ADS_SB_SD_DAILY_DAYS,
        )
        assert ADS_SB_SD_DAILY_DAYS == 7
        assert ADS_SB_SD_BACKFILL_DAYS == 7
        assert ADS_SB_SD_CHUNK_DAYS == 1
        assert ADS_SB_SD_CHUNK_DAYS <= ADS_SB_SD_DAILY_DAYS

    def test_spapi_chunk_size_within_limit(self):
        from src.rules import SPAPI_MAX_CHUNK_DAYS
        assert SPAPI_MAX_CHUNK_DAYS <= 31

    def test_orders_report_floor_is_two_calendar_years(self):
        from datetime import date
        from src.rules import orders_report_floor
        assert orders_report_floor(date(2026, 8, 24)) == date(2024, 8, 24)

    def test_orders_report_range_before_floor_is_skipped(self):
        from datetime import date
        from src.rules import clamp_orders_report_range
        start, end, warning = clamp_orders_report_range(
            date(2024, 1, 1), date(2024, 7, 31), as_of=date(2026, 8, 24),
        )
        assert start is None
        assert end == date(2024, 7, 31)
        assert warning and "2024-08-24" in warning

    def test_orders_report_range_is_clamped_to_floor(self):
        from datetime import date
        from src.rules import clamp_orders_report_range
        start, end, warning = clamp_orders_report_range(
            date(2024, 1, 1), date(2024, 9, 30), as_of=date(2026, 8, 24),
        )
        assert start == date(2024, 8, 24)
        assert end == date(2024, 9, 30)
        assert warning and "2024-08-24" in warning

    def test_pulse_source_is_spapi(self):
        from src.rules import AMAZON_PULSE_SOURCE
        assert AMAZON_PULSE_SOURCE == "amazon_spapi"


# ── 3. PST date boundary conversion ──────────────────────────


class TestPSTDateBoundary:
    """A UTC midnight timestamp must land on the PREVIOUS day in Pacific."""

    def test_utc_midnight_maps_to_previous_pst_day(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo
        from src.rules import AMAZON_TZ

        # 2026-08-19 00:00:00 UTC is still 2026-08-18 in Pacific
        utc_midnight = datetime(2026, 8, 19, 0, 0, 0, tzinfo=ZoneInfo("UTC"))
        pst_date = utc_midnight.astimezone(AMAZON_TZ).date()
        assert pst_date == date(2026, 8, 18)

    def test_utc_morning_maps_to_same_pst_day(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo
        from src.rules import AMAZON_TZ

        # 2026-08-19 15:00 UTC = 08:00 Pacific → same day
        utc_morning = datetime(2026, 8, 19, 15, 0, 0, tzinfo=ZoneInfo("UTC"))
        pst_date = utc_morning.astimezone(AMAZON_TZ).date()
        assert pst_date == date(2026, 8, 19)


# ── 4. Ads chunking produces valid chunks ─────────────────────


class TestAdsChunking:
    def test_chunks_never_exceed_limit(self):
        from src.rules import ADS_MAX_CHUNK_DAYS
        from src.amazon_ads.reports import _date_chunks

        start = date(2026, 1, 1)
        end = date(2026, 6, 30)  # 181 days
        chunks = _date_chunks(start, end)

        for cs, ce in chunks:
            span = (ce - cs).days + 1
            assert span <= ADS_MAX_CHUNK_DAYS, (
                f"Chunk {cs}→{ce} spans {span} days, "
                f"exceeds limit of {ADS_MAX_CHUNK_DAYS}"
            )

    def test_chunks_cover_full_range(self):
        from src.amazon_ads.reports import _date_chunks

        start = date(2026, 3, 1)
        end = date(2026, 5, 31)
        chunks = _date_chunks(start, end)

        assert chunks[0][0] == start
        assert chunks[-1][1] == end

        # No gaps
        for i in range(1, len(chunks)):
            prev_end = chunks[i - 1][1]
            curr_start = chunks[i][0]
            assert curr_start == prev_end + timedelta(days=1), (
                f"Gap between {prev_end} and {curr_start}"
            )

    def test_single_day_range(self):
        from src.amazon_ads.reports import _date_chunks

        d = date(2026, 8, 1)
        chunks = _date_chunks(d, d)
        assert len(chunks) == 1
        assert chunks[0] == (d, d)

    def test_90_day_range_requires_multiple_chunks(self):
        from src.amazon_ads.reports import _date_chunks

        start = date(2026, 1, 1)
        end = start + timedelta(days=89)
        chunks = _date_chunks(start, end)
        assert len(chunks) >= 3, "90 days should need at least 3 chunks of ≤30"


# ── 4b. Search-term chunking is smaller than campaign chunking ────


class TestSearchTermChunking:
    """Search-term reports are far heavier than campaign reports; a wide
    window times out. They chunk at 7 days by default."""

    def test_search_term_chunk_is_seven_days(self):
        from src.rules import ADS_SEARCH_TERM_CHUNK_DAYS
        assert ADS_SEARCH_TERM_CHUNK_DAYS == 7

    def test_search_term_chunk_not_larger_than_campaign_chunk(self):
        from src.rules import ADS_SEARCH_TERM_CHUNK_DAYS, ADS_MAX_CHUNK_DAYS
        assert ADS_SEARCH_TERM_CHUNK_DAYS <= ADS_MAX_CHUNK_DAYS

    def test_search_term_chunks_respect_requested_size(self):
        from src.amazon_ads.reports import _date_chunks

        start = date(2026, 1, 1)
        end = start + timedelta(days=27)  # 28 days
        chunks = _date_chunks(start, end, 7)

        assert len(chunks) == 4
        for cs, ce in chunks:
            assert (ce - cs).days + 1 <= 7

    def test_chunk_size_clamped_to_api_limit(self):
        """A caller asking for more than the API allows must not get it."""
        from src.rules import ADS_MAX_CHUNK_DAYS
        from src.amazon_ads.reports import _date_chunks

        start = date(2026, 1, 1)
        end = start + timedelta(days=99)
        chunks = _date_chunks(start, end, 90)

        for cs, ce in chunks:
            assert (ce - cs).days + 1 <= ADS_MAX_CHUNK_DAYS

    def test_search_term_chunks_cover_range_without_gaps(self):
        from src.amazon_ads.reports import _date_chunks

        start = date(2026, 2, 1)
        end = date(2026, 3, 15)
        chunks = _date_chunks(start, end, 7)

        assert chunks[0][0] == start
        assert chunks[-1][1] == end
        for i in range(1, len(chunks)):
            assert chunks[i][0] == chunks[i - 1][1] + timedelta(days=1)


# ── 4c. Scheduled ads sync stays independent ──────────────────


class TestAdsSyncSplit:
    """campaigns_only must never touch the search-term endpoint: the daily
    KPI refresh cannot be allowed to block on a 90-minute report."""

    def test_campaigns_only_skips_search_terms(self, monkeypatch):
        import src.amazon_ads.reports as reports

        called = []
        monkeypatch.setattr(reports, "fetch_campaigns_daily",
                            lambda s, e, **kw: called.append("campaigns") or {"rows": 1})
        monkeypatch.setattr(reports, "fetch_search_terms",
                            lambda s, e, **kw: called.append("search_terms") or {"rows": 1})

        result = reports.sync_ads(days=30, campaigns_only=True)

        assert called == ["campaigns"]
        assert "search_terms" not in result
        assert result["ran"] == ["campaigns"]

    def test_search_terms_only_skips_campaigns(self, monkeypatch):
        import src.amazon_ads.reports as reports

        called = []
        monkeypatch.setattr(reports, "fetch_campaigns_daily",
                            lambda s, e, **kw: called.append("campaigns") or {"rows": 1})
        monkeypatch.setattr(reports, "fetch_search_terms",
                            lambda s, e, **kw: called.append("search_terms") or {"rows": 1})

        result = reports.sync_ads(days=7, search_terms_only=True)

        assert called == ["search_terms"]
        assert "campaigns" not in result

    def test_search_term_failure_does_not_lose_campaigns(self, monkeypatch):
        """A search-term blowup must still return the campaign results."""
        import src.amazon_ads.reports as reports

        def boom(*a, **kw):
            raise TimeoutError("report timed out after 5400s")

        monkeypatch.setattr(reports, "fetch_campaigns_daily",
                            lambda s, e, **kw: {"rows": 42, "inserted": 42, "errors": []})
        monkeypatch.setattr(reports, "fetch_search_terms", boom)

        result = reports.sync_ads(days=7)

        assert result["campaigns"]["rows"] == 42
        assert "error" in result["search_terms"]

    def test_both_only_flags_is_rejected(self):
        import pytest
        from src.amazon_ads.reports import sync_ads
        with pytest.raises(ValueError):
            sync_ads(days=7, campaigns_only=True, search_terms_only=True)


# ── 4c2. Enqueue catch-up stays campaigns-only ────────────────


class TestAdsEnqueuePayload:
    """Dashboard / Dana ads_sync must not start a 90-minute search-term
    report unless the payload explicitly asks for it."""

    def test_empty_payload_is_7d_campaigns_only(self):
        from src.main import _ads_enqueue_kwargs
        kw = _ads_enqueue_kwargs({})
        assert kw["days"] == 7
        assert kw["campaigns_only"] is True
        assert kw["search_terms_only"] is False
        assert kw["placements_only"] is False

    def test_missing_payload_defaults(self):
        from src.main import _ads_enqueue_kwargs
        kw = _ads_enqueue_kwargs(None)
        assert kw["days"] == 7
        assert kw["campaigns_only"] is True

    def test_days_only_does_not_pull_search_terms(self, monkeypatch):
        """Kickstart `{days: 7}` must stay a short campaigns refresh."""
        import src.amazon_ads.reports as reports
        from src.main import _ads_enqueue_kwargs
        kw = _ads_enqueue_kwargs({"days": 7})
        assert kw["days"] == 7
        assert kw["campaigns_only"] is True
        assert kw["search_terms_only"] is False
        assert kw["placements_only"] is False

        called = []
        monkeypatch.setattr(reports, "fetch_campaigns_daily",
                            lambda s, e, **kw: called.append("campaigns") or {"rows": 1})
        monkeypatch.setattr(reports, "fetch_search_terms",
                            lambda s, e, **kw: called.append("search_terms") or {"rows": 1})
        monkeypatch.setattr(reports, "fetch_placements",
                            lambda s, e, **kw: called.append("placements") or {"rows": 1})
        result = reports.sync_ads(
            days=kw["days"], campaigns_only=kw["campaigns_only"],
            search_terms_only=kw["search_terms_only"],
            placements_only=kw["placements_only"])
        assert called == ["campaigns"]
        assert result["ran"] == ["campaigns"]

    def test_explicit_days_honored(self):
        from src.main import _ads_enqueue_kwargs
        assert _ads_enqueue_kwargs({"days": 3})["days"] == 3

    def test_campaigns_only_false_is_full_suite(self):
        from src.main import _ads_enqueue_kwargs
        kw = _ads_enqueue_kwargs({"campaigns_only": False})
        assert kw["campaigns_only"] is False
        assert kw["search_terms_only"] is False
        assert kw["placements_only"] is False

    def test_search_terms_only_explicit(self):
        from src.main import _ads_enqueue_kwargs
        kw = _ads_enqueue_kwargs({"search_terms_only": True})
        assert kw["search_terms_only"] is True
        assert kw["campaigns_only"] is False
        assert kw["placements_only"] is False

    def test_placements_only_explicit(self):
        from src.main import _ads_enqueue_kwargs
        kw = _ads_enqueue_kwargs({"placements_only": True, "days": 14})
        assert kw["placements_only"] is True
        assert kw["campaigns_only"] is False
        assert kw["days"] == 14

    def test_mutually_exclusive_only_flags_rejected(self):
        from src.main import _ads_enqueue_kwargs
        with pytest.raises(ValueError, match="mutually exclusive"):
            _ads_enqueue_kwargs(
                {"campaigns_only": True, "search_terms_only": True})
        with pytest.raises(ValueError, match="mutually exclusive"):
            _ads_enqueue_kwargs(
                {"search_terms_only": True, "placements_only": True})
        with pytest.raises(ValueError, match="mutually exclusive"):
            _ads_enqueue_kwargs(
                {"campaigns_only": True, "placements_only": True})

    def test_string_false_allows_full_suite(self):
        from src.main import _ads_enqueue_kwargs
        kw = _ads_enqueue_kwargs({"campaigns_only": "false", "days": "7"})
        assert kw["campaigns_only"] is False
        assert kw["days"] == 7

    def test_string_true_search_terms_only(self):
        from src.main import _ads_enqueue_kwargs
        kw = _ads_enqueue_kwargs({"search_terms_only": "true"})
        assert kw["search_terms_only"] is True
        assert kw["campaigns_only"] is False

    def test_job_worker_uses_payload_resolver(self):
        import inspect
        from src.main import _run_job_worker
        src = inspect.getsource(_run_job_worker)
        assert "_ads_enqueue_kwargs" in src
        assert 'payload.get("days", 14)' not in src

    def test_scheduled_jobs_keep_their_only_flags(self):
        import inspect
        from src.main import (
            _run_ads_campaigns_sync, _run_ads_search_terms_sync,
            _run_ads_placements_sync, _run_ads_campaigns_backfill,
        )
        camp = inspect.getsource(_run_ads_campaigns_sync)
        assert "days=7" in camp
        assert "campaigns_only=True" in camp
        st = inspect.getsource(_run_ads_search_terms_sync)
        assert "search_terms_only=True" in st
        assert "days=7" in st
        assert "days=90" not in st
        pl = inspect.getsource(_run_ads_placements_sync)
        assert "placements_only=True" in pl
        bf = inspect.getsource(_run_ads_campaigns_backfill)
        assert "days=90" in bf
        assert "campaigns_only=True" in bf


# ── 4d. Ads sync outcome classification ───────────────────────


class TestAdsSyncOutcome:
    """Campaigns landing while search terms fail is a partial, not a failure —
    the KPIs and trends are current either way."""

    def test_all_ok_is_success(self):
        from src.main import _ads_sync_outcome
        status, _ = _ads_sync_outcome(
            {"ran": ["campaigns", "search_terms"],
             "campaigns": {"errors": []}, "search_terms": {"errors": []}}, 7)
        assert status == "success"

    def test_campaigns_ok_search_terms_failed_is_partial(self):
        from src.main import _ads_sync_outcome
        status, _ = _ads_sync_outcome(
            {"ran": ["campaigns", "search_terms"],
             "campaigns": {"errors": []}, "search_terms": {"error": "timeout"}}, 7)
        assert status == "partial"

    def test_campaigns_only_success_is_not_partial(self):
        """The half that never ran must not drag the result down."""
        from src.main import _ads_sync_outcome
        status, _ = _ads_sync_outcome(
            {"ran": ["campaigns"], "campaigns": {"errors": []}}, 30)
        assert status == "success"

    def test_everything_failed_is_fail(self):
        from src.main import _ads_sync_outcome
        status, _ = _ads_sync_outcome(
            {"ran": ["campaigns", "search_terms"],
             "campaigns": {"error": "auth"}, "search_terms": {"error": "auth"}}, 7)
        assert status == "fail"


# ── 4d2. SP-API refresh outcome classification ────────────────


class TestSpapiRefreshOutcome:
    """Zero order rows must not be recorded as a green tax SoT refresh."""

    def test_orders_written_is_success(self):
        from src.main import _spapi_refresh_outcome
        status, msg = _spapi_refresh_outcome([], 51)
        assert status == "success"
        assert "51" in msg

    def test_zero_order_rows_is_partial(self):
        from src.main import _spapi_refresh_outcome
        status, msg = _spapi_refresh_outcome([], 0)
        assert status == "partial"
        assert "0" in msg

    def test_orders_error_is_fail(self):
        from src.main import _spapi_refresh_outcome
        status, msg = _spapi_refresh_outcome(["Orders: timeout"], 0)
        assert status == "fail"
        assert "Orders" in msg

    def test_inventory_error_is_fail_even_if_orders_wrote(self):
        from src.main import _spapi_refresh_outcome
        status, _ = _spapi_refresh_outcome(["Inventory: boom"], 12)
        assert status == "fail"


# ── 4e. Scheduler timezone is explicit ────────────────────────


class TestAgentTimezone:
    def test_agent_timezone_is_configured(self):
        from src.rules import AGENT_TZ_NAME
        assert AGENT_TZ_NAME == "America/New_York"

    def test_agent_tz_is_separate_from_amazon_tz(self):
        """Scheduling zone and Amazon's day-boundary zone are different rules."""
        from src.rules import AGENT_TZ_NAME, AMAZON_TZ_NAME
        assert AMAZON_TZ_NAME == "America/Los_Angeles"
        assert AGENT_TZ_NAME != AMAZON_TZ_NAME

    def test_agent_today_uses_eastern_not_utc(self):
        """00:30 UTC on the 21st is still the 20th in America/New_York."""
        from datetime import datetime, timezone
        from src.rules import agent_today
        utc = datetime(2026, 8, 21, 0, 30, tzinfo=timezone.utc)
        assert agent_today(utc).isoformat() == "2026-08-20"

    def test_amazon_today_uses_pacific_not_utc(self):
        """06:00 UTC on the 22nd is still the 21st in America/Los_Angeles."""
        from datetime import datetime, timezone
        from src.rules import amazon_as_of, amazon_today
        utc = datetime(2026, 8, 22, 6, 0, tzinfo=timezone.utc)
        assert amazon_today(utc).isoformat() == "2026-08-21"
        assert amazon_as_of(utc).isoformat() == "2026-08-20"


# ── 5. SP-API chunking produces valid chunks ─────────────────


class TestSPAPIChunking:
    def test_spapi_chunks_never_exceed_limit(self):
        from src.rules import SPAPI_MAX_CHUNK_DAYS
        from src.amazon_sp.reports import _date_chunks

        start = date(2026, 1, 1)
        end = date(2026, 3, 31)
        chunks = _date_chunks(start, end)

        for cs, ce in chunks:
            span = (ce - cs).days + 1
            assert span <= SPAPI_MAX_CHUNK_DAYS, (
                f"Chunk {cs}→{ce} spans {span} days"
            )

    def test_january_is_split_so_no_chunk_is_31_days(self):
        from src.amazon_sp.reports import _date_chunks
        chunks = _date_chunks(date(2026, 1, 1), date(2026, 1, 31))
        assert chunks == [
            (date(2026, 1, 1), date(2026, 1, 30)),
            (date(2026, 1, 31), date(2026, 1, 31)),
        ]


class TestAmazonPurchaseDate:
    def test_utc_early_morning_buckets_to_previous_la_day(self):
        from src.amazon_sp.reports import _parse_date
        assert _parse_date("2026-08-19T02:00:00+00:00") == date(2026, 8, 18)
        assert _parse_date("2026-08-19T02:00:00Z") == date(2026, 8, 18)

    def test_afternoon_utc_stays_same_la_day(self):
        from src.amazon_sp.reports import _parse_date
        assert _parse_date("2026-08-19T20:00:00+00:00") == date(2026, 8, 19)

    def test_date_only_is_unchanged(self):
        from src.amazon_sp.reports import _parse_date
        assert _parse_date("2026-08-19") == date(2026, 8, 19)


class TestSkuParserIncludesPending:
    def test_pending_order_is_counted(self):
        from src.amazon_sp.reports import parse_orders_by_sku
        report = (
            "amazon-order-id\torder-status\tship-country\tship-state"
            "\tsku\titem-price\tpurchase-date\tquantity\n"
            "111-1\tPending\tUS\tCA\tSKU-A\t10.00\t2026-08-19T20:00:00+00:00\t1\n"
            "111-2\tCancelled\tUS\tCA\tSKU-A\t10.00\t2026-08-19T20:00:00+00:00\t1\n"
        )
        result = parse_orders_by_sku(report)
        assert result["rows_parsed"] == 1
        assert result["rows_skipped"] == 1
        assert len(result["sku_rows"]) == 1
        assert result["sku_rows"][0]["gross_sales"] == 10.0


# ── 6. P&L defaults match config ─────────────────────────────


class TestPNLDefaults:
    def test_referral_pct(self):
        from src.rules import PNL_DEFAULT_REFERRAL_PCT
        assert PNL_DEFAULT_REFERRAL_PCT == 0.15

    def test_fba_fee(self):
        from src.rules import PNL_DEFAULT_FBA_FEE_PER_UNIT
        assert PNL_DEFAULT_FBA_FEE_PER_UNIT == 3.50

    def test_cogs_source(self):
        from src.rules import PNL_COGS_SOURCE
        assert PNL_COGS_SOURCE == "sku_costs"

    def test_units_without_sales_are_not_a_contribution_day(self):
        from src.pnl import is_unwritable_day
        assert is_unwritable_day(0, 62) is True
        assert is_unwritable_day(907.38, 58) is False


class TestAdProductCoverage:
    """Account ad spend must span Sponsored Products, Brands and Display.

    The Amazon Ads console totals all three. Fetching only Sponsored Products
    under-reports account spend — which is what made the agent read ~6% below
    the console — and a failure in one product must never discard the others.
    """

    def test_all_three_products_are_default(self):
        from src.amazon_ads.reports import AD_PRODUCTS, DEFAULT_AD_PRODUCTS
        assert set(DEFAULT_AD_PRODUCTS) == {"SP", "SB", "SD"}
        for p in DEFAULT_AD_PRODUCTS:
            assert p in AD_PRODUCTS
            assert AD_PRODUCTS[p]["ad_product"].startswith("SPONSORED_")
            assert AD_PRODUCTS[p]["column_sets"], f"{p} has no column sets"

    def test_rows_are_typed(self, monkeypatch):
        """Every stored row carries its campaign_type — never an untyped blend."""
        import src.amazon_ads.reports as reports
        from datetime import date

        def fake_chunk(cs, ce, product="SP"):
            return [{"date": "2026-08-19", "campaignId": f"{product}-1",
                     "campaignName": f"{product} camp",
                     "impressions": 100, "clicks": 10,
                     "spend" if product == "SP" else "cost": 5.0}]

        # One upsert per ad product: SP is committed before SB/SD are tried,
        # so collect across calls rather than assuming a single write.
        written: list[dict] = []

        def fake_upsert(table, rows, on_conflict=None):
            written.extend(rows)
            return len(rows)

        monkeypatch.setattr(reports, "_fetch_campaigns_chunk", fake_chunk)
        monkeypatch.setattr(reports, "upsert_rows", fake_upsert)

        r = reports.fetch_campaigns_daily(date(2026, 8, 19), date(2026, 8, 19))
        types = {row["campaign_type"] for row in written}
        assert types == {"SP", "SB", "SD"}
        # cost → spend normalisation: SB/SD spend must not silently be 0.
        assert all(row["spend"] == 5.0 for row in written)
        assert r["total_spend"] == 15.0
        assert r["by_type"]["SB"]["spend"] == 5.0

    def test_sb_failure_keeps_sp(self, monkeypatch):
        """SB/SD blowing up must not cost us the Sponsored Products rows."""
        import src.amazon_ads.reports as reports
        from datetime import date

        def fake_chunk(cs, ce, product="SP"):
            if product != "SP":
                raise RuntimeError("429 rate limited")
            return [{"date": "2026-08-19", "campaignId": "sp-1",
                     "campaignName": "sp", "impressions": 1, "clicks": 1,
                     "spend": 393.64}]

        monkeypatch.setattr(reports, "_fetch_campaigns_chunk", fake_chunk)
        monkeypatch.setattr(reports, "upsert_rows",
                            lambda t, rows, on_conflict=None: len(rows))

        r = reports.fetch_campaigns_daily(date(2026, 8, 19), date(2026, 8, 19))
        assert r["total_spend"] == 393.64
        assert r["products_ok"] == ["SP"]
        assert set(r["products_failed"]) == {"SB", "SD"}
        assert r["partial"] is True

    def test_sp_is_committed_before_sb_sd(self, monkeypatch):
        """SP rows must be written before SB/SD are attempted.

        SB reports hang on this account. If the whole run were buffered into a
        single upsert at the end, a hang would cost us the Sponsored Products
        rows the KPI cards and P&L read — the exact thing the soft-fail is for.
        """
        import src.amazon_ads.reports as reports
        from datetime import date

        events: list[str] = []

        def fake_chunk(cs, ce, product="SP"):
            events.append(f"fetch:{product}")
            if product == "SB":
                raise TimeoutError("Report abc timed out after 900s")
            return [{"date": "2026-08-19", "campaignId": f"{product}-1",
                     "campaignName": product, "impressions": 1, "clicks": 1,
                     "spend": 1.0}]

        def fake_upsert(table, rows, on_conflict=None):
            events.append(f"upsert:{rows[0]['campaign_type']}")
            return len(rows)

        monkeypatch.setattr(reports, "_fetch_campaigns_chunk", fake_chunk)
        monkeypatch.setattr(reports, "upsert_rows", fake_upsert)

        reports.fetch_campaigns_daily(date(2026, 8, 19), date(2026, 8, 19))
        assert events.index("upsert:SP") < events.index("fetch:SB")

    def test_sp_keeps_full_poll_headroom(self):
        """SP must not be given a tighter poll cap than SB/SD.

        Amazon's report queue goes through slow spells where even a one-day SP
        report sits PENDING for many minutes. SP feeds the KPI cards and P&L,
        so it keeps the client default; only the additive products are capped,
        and those caps come from business_rules.json (not a 300s hardcoded).
        """
        from src.amazon_ads.reports import CAMPAIGN_REPORT_TIMEOUT
        from src.rules import (
            ADS_CAMPAIGN_TIMEOUT_SB_SECONDS,
            ADS_CAMPAIGN_TIMEOUT_SD_SECONDS,
        )
        assert "SP" not in CAMPAIGN_REPORT_TIMEOUT
        assert CAMPAIGN_REPORT_TIMEOUT["SB"] == ADS_CAMPAIGN_TIMEOUT_SB_SECONDS
        assert CAMPAIGN_REPORT_TIMEOUT["SD"] == ADS_CAMPAIGN_TIMEOUT_SD_SECONDS
        assert CAMPAIGN_REPORT_TIMEOUT["SB"] >= 900
        assert CAMPAIGN_REPORT_TIMEOUT["SD"] >= 900
        assert CAMPAIGN_REPORT_TIMEOUT["SB"] < 1800
        assert CAMPAIGN_REPORT_TIMEOUT["SD"] < 1800

    def test_thirty_day_window_uses_seven_day_chunks(self, monkeypatch):
        """Nightly 30d must not be one all-or-nothing SB/SD report."""
        import src.amazon_ads.reports as reports
        from datetime import date

        calls: list[tuple[str, date, date]] = []

        def fake_chunk(cs, ce, product="SP"):
            calls.append((product, cs, ce))
            return []

        monkeypatch.setattr(reports, "_fetch_campaigns_chunk", fake_chunk)
        monkeypatch.setattr(reports, "upsert_rows",
                            lambda *a, **k: 0)

        reports.fetch_campaigns_daily(date(2026, 8, 1), date(2026, 8, 30))
        sp = [(cs, ce) for product, cs, ce in calls if product == "SP"]
        assert len(sp) == 5
        assert all((ce - cs).days + 1 <= 7 for cs, ce in sp)
        # Newest first: if a later chunk times out we still have yesterday.
        assert sp[0][1] == date(2026, 8, 30)
        assert sp[-1][0] == date(2026, 8, 1)

    def test_daily_sb_sd_uses_short_window(self, monkeypatch):
        """Nightly 30d SP must not also request 30d of SB/SD."""
        import src.amazon_ads.reports as reports
        from datetime import date

        calls: list[tuple[str, date, date]] = []

        def fake_chunk(cs, ce, product="SP"):
            calls.append((product, cs, ce))
            return [{"date": ce.isoformat(), "campaignId": f"{product}-1",
                     "campaignName": product, "impressions": 1, "clicks": 1,
                     "spend": 1.0}]

        monkeypatch.setattr(reports, "_fetch_campaigns_chunk", fake_chunk)
        monkeypatch.setattr(reports, "upsert_rows",
                            lambda *a, **k: 1)

        r = reports.fetch_campaigns_daily(
            date(2026, 8, 1), date(2026, 8, 30), sb_sd_days=7)
        sp = [(cs, ce) for product, cs, ce in calls if product == "SP"]
        sb = [(cs, ce) for product, cs, ce in calls if product == "SB"]
        sd = [(cs, ce) for product, cs, ce in calls if product == "SD"]
        assert len(sp) == 5
        # 7 closed days in 1-day chunks.
        assert len(sb) == 7 and len(sd) == 7
        assert max(ce for _, ce in sb) == date(2026, 8, 30)
        assert min(cs for cs, _ in sb) == date(2026, 8, 24)
        assert all((ce - cs).days == 0 for cs, ce in sb)
        assert r["by_type"]["SB"]["ok"] is True

    def test_sb_rows_count_as_present_even_with_chunk_errors(self, monkeypatch):
        """A timed-out older SB chunk is a gap, not 'SB missing'."""
        import src.amazon_ads.reports as reports
        from datetime import date

        def fake_chunk(cs, ce, product="SP"):
            if product == "SB" and cs <= date(2026, 8, 1):
                raise TimeoutError("old chunk timed out after 900s")
            return [{"date": ce.isoformat(), "campaignId": f"{product}-{ce}",
                     "campaignName": product, "impressions": 1, "clicks": 1,
                     "spend": 993.71 if product == "SB" else 1.0}]

        monkeypatch.setattr(reports, "_fetch_campaigns_chunk", fake_chunk)
        monkeypatch.setattr(reports, "upsert_rows",
                            lambda *a, **k: 1)

        r = reports.fetch_campaigns_daily(date(2026, 8, 1), date(2026, 8, 14))
        assert r["by_type"]["SB"]["ok"] is True
        assert r["by_type"]["SB"]["spend"] > 0
        assert r["by_type"]["SB"]["errors"]
        assert "SB" not in r["products_failed"]
        assert "SB" in r["products_ok"]


class TestAdsPollResilience:
    """A mid-poll 429 must not throw away a report Amazon is still building."""

    def test_transient_errors_are_retried(self):
        from src.amazon_ads.reports import _is_transient_report_error
        import httpx

        from src.amazon_ads.client import AdsReportSlotBusy

        assert _is_transient_report_error(TimeoutError("timed out after 900s"))
        assert _is_transient_report_error(RuntimeError("429 Too Many Requests"))
        assert _is_transient_report_error(httpx.ConnectError("connection reset"))
        assert not _is_transient_report_error(RuntimeError("400 bad column"))
        assert not _is_transient_report_error(PermissionError("Ads API auth failed (401)"))
        # 425 on create is slot-busy — do not treat as a backoff-and-recreate.
        assert not _is_transient_report_error(AdsReportSlotBusy("HTTP 425"))
        assert not _is_transient_report_error(RuntimeError("425 Too Early"))

    def test_backoff_retries_timeout_then_succeeds(self, monkeypatch):
        import src.amazon_ads.reports as reports

        attempts = {"n": 0}

        def flaky(config, timeout=None):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise TimeoutError("Report abc timed out after 900s")
            return [{"campaignId": "1"}]

        monkeypatch.setattr(reports, "fetch_report", flaky)
        import time as _time
        monkeypatch.setattr(_time, "sleep", lambda s: None)

        rows = reports._fetch_report_with_backoff({"startDate": "2026-08-01"})
        assert rows == [{"campaignId": "1"}]
        assert attempts["n"] == 2

    def test_poll_report_stays_on_report_after_429(self, monkeypatch):
        import src.amazon_ads.client as client

        clock = {"t": 0}

        def fake_time():
            clock["t"] += 1
            return clock["t"]

        responses = [
            type("R", (), {"status_code": 429, "raise_for_status": lambda self: None})(),
            type("R", (), {
                "status_code": 200,
                "raise_for_status": lambda self: None,
                "json": lambda self: {"status": "COMPLETED", "url": "http://x"},
            })(),
        ]

        monkeypatch.setattr(client.time, "time", fake_time)
        monkeypatch.setattr(client.time, "sleep", lambda s: None)
        monkeypatch.setattr(client.httpx, "get", lambda *a, **k: responses.pop(0))
        monkeypatch.setattr(client, "ads_headers", lambda **kw: {})

        data = client.poll_report("rep-1", timeout=30)
        assert data["status"] == "COMPLETED"

    def test_overlapping_sync_does_not_stack_reports(self, monkeypatch):
        import src.amazon_ads.reports as reports

        assert reports._SYNC_LOCK.acquire(blocking=False)
        try:
            monkeypatch.setattr(reports, "_SYNC_LOCK_TIMEOUT", 0.05)
            with pytest.raises(reports.AdsSyncBusy, match="another ads pull"):
                reports.sync_ads(days=1, campaigns_only=True)
        finally:
            reports._SYNC_LOCK.release()

    def test_lock_wait_is_seconds_not_hours(self):
        """Waiters must skip quickly. 180 minutes + Telegram was 2026-08-24."""
        from src.amazon_ads.reports import _SYNC_LOCK_TIMEOUT
        assert 1 <= _SYNC_LOCK_TIMEOUT <= 60

    def test_daily_campaigns_job_caps_sb_sd_and_chains(self):
        import inspect
        from src.main import _run_ads_campaigns_sync
        src = inspect.getsource(_run_ads_campaigns_sync)
        assert "days=7" in src
        assert "days=30" not in src
        assert "sb_sd_days" in src
        assert "ADS_SB_SD_DAILY_DAYS" in src
        assert "_run_ads_placements_sync" in src
        assert "_run_ads_search_terms_sync" in src
        assert 'status == "skipped"' in src

    def test_partial_sb_sd_failure_schedules_heal(self):
        import inspect
        from src.main import _run_ads_sync_job
        src = inspect.getsource(_run_ads_sync_job)
        assert "_run_ads_sb_sd_heal" in src
        assert "lost_products" in src

    def test_midday_heal_job_exists(self):
        import inspect
        from src import main as main_mod
        assert callable(main_mod._run_ads_sb_sd_heal)
        src = inspect.getsource(main_mod)
        assert 'id="ads_sb_sd_heal"' in src
        assert "_run_ads_sb_sd_heal" in src

    def test_sunday_backfill_caps_sb_sd(self):
        import inspect
        from src.main import _run_ads_campaigns_backfill
        src = inspect.getsource(_run_ads_campaigns_backfill)
        assert "sb_sd_days" in src
        assert "ADS_SB_SD_BACKFILL_DAYS" in src

    def test_sunday_search_terms_backfill_is_90d_own_cron(self):
        """Sunday 03:30 search-term 90d is its own job. Weekday 7d stays 7d."""
        import inspect
        from src import main as main_mod
        from src.main import (
            _run_ads_search_terms_backfill, _run_ads_search_terms_sync,
            _run_ads_campaigns_sync,
        )
        bf = inspect.getsource(_run_ads_search_terms_backfill)
        assert "days=90" in bf
        assert "search_terms_only=True" in bf
        assert "skip_existing_search_term_weeks=True" in bf
        assert "newest_first_search_terms=True" in bf
        assert "days=7" not in bf
        daily = inspect.getsource(_run_ads_search_terms_sync)
        assert "days=7" in daily
        assert "days=90" not in daily
        nightly = inspect.getsource(_run_ads_campaigns_sync)
        assert "_run_ads_search_terms_sync" in nightly
        assert "_run_ads_search_terms_backfill" not in nightly
        sched = inspect.getsource(main_mod)
        assert 'id="ads_search_terms_backfill"' in sched
        assert 'hour=3' in sched
        assert 'minute=30' in sched
        assert 'day_of_week="sun"' in sched

    def test_busy_ads_job_is_skipped_not_failed(self):
        import inspect
        from src.main import _run_ads_sync_job
        src = inspect.getsource(_run_ads_sync_job)
        assert "AdsSyncBusy" in src
        assert "skipped" in src
        assert "_schedule_ads_retry" in src
        assert "_ads_alert" not in src.split("except AdsSyncBusy")[1].split("except Exception")[0]

    def test_busy_retry_window_covers_a_sunday_overrun(self):
        """Three 20-minute retries from 05:15 would have given up at 06:15
        on 2026-08-24 while campaigns still held the lock at 08:51."""
        from src.main import _ADS_RETRY_MAX, _ADS_RETRY_SECONDS
        assert _ADS_RETRY_MAX * _ADS_RETRY_SECONDS >= 6 * 3600

    def test_spapi_refresh_does_not_pull_ads(self):
        import inspect
        from src.main import _run_spapi_refresh
        src = inspect.getsource(_run_spapi_refresh)
        assert "sync_ads(" not in src
        assert "from src.amazon_ads.reports import sync_ads" not in src
        assert "dedicated ads_* jobs" in src

    def test_spapi_refresh_orders_from_month_start(self):
        """Nightly dest rebuild is month-to-date, not a 7-day replace."""
        import inspect
        from src.main import _run_spapi_refresh
        src = inspect.getsource(_run_spapi_refresh)
        orders_src = src.split("inv_start")[0]
        assert "start = (end - timedelta(days=7)).replace(day=1)" in orders_src
        assert "start = end - timedelta(days=7)\n" not in orders_src


# ── 4f. SP-API order upsert stamps ingested_at ─────────────────


class TestSpapiOrderFreshness:
    """Re-upserted monthly sales_by_state rows must refresh ingested_at."""

    def test_period_starts_in_range_is_requested_months_only(self):
        from datetime import date
        from src.amazon_sp.reports import _period_starts_in_range

        assert _period_starts_in_range(date(2026, 8, 1), date(2026, 8, 30)) == {"2026-08-01"}
        assert _period_starts_in_range(date(2026, 7, 15), date(2026, 8, 15)) == {
            "2026-07-01", "2026-08-01",
        }

    def test_stamp_sets_iso_utc(self):
        from datetime import datetime, timezone
        from src.amazon_sp.reports import _stamp_ingested_at

        now = datetime(2026, 8, 22, 17, 52, tzinfo=timezone.utc)
        rows = [{"state_code": "TX", "source": "amazon_spapi"}]
        _stamp_ingested_at(rows, now=now)
        assert rows[0]["ingested_at"] == now.isoformat()

    def test_stamp_skips_period_starts_not_in_the_report(self):
        from datetime import datetime, timezone
        from src.amazon_sp.reports import _stamp_ingested_at

        now = datetime(2026, 8, 31, 17, 53, tzinfo=timezone.utc)
        rows = [
            {"period_start": "2026-08-01", "gross_sales": 92324.84},
            {"period_start": "2026-07-01", "gross_sales": 81332.82},
        ]
        _stamp_ingested_at(rows, now=now, period_starts={"2026-08-01"})
        assert rows[0]["ingested_at"] == now.isoformat()
        assert "ingested_at" not in rows[1]
        assert rows[1]["gross_sales"] == 81332.82

    def test_upsert_amazon_sku_rows_drops_months_outside_report(self, monkeypatch):
        from src.amazon_sp import reports as reports

        captured: dict = {}

        def fake_upsert(table, rows, on_conflict=None):
            captured["rows"] = rows
            return len(rows)

        monkeypatch.setattr(reports, "upsert_rows", fake_upsert)
        inserted, deduped = reports.upsert_amazon_sku_rows(
            [
                {
                    "channel": "amazon", "sku": "AA", "state_code": "TX",
                    "period_start": "2026-08-01", "source": "amazon_spapi",
                    "units": 10, "gross_sales": 100.0, "net_sales": 100.0,
                    "order_count": 1,
                },
                {
                    "channel": "amazon", "sku": "AA", "state_code": "TX",
                    "period_start": "2026-07-01", "source": "amazon_spapi",
                    "units": 5548, "gross_sales": 81332.82, "net_sales": 81332.82,
                    "order_count": 1,
                },
            ],
            period_starts={"2026-08-01"},
        )
        assert inserted == 1
        assert len(deduped) == 1
        assert captured["rows"][0]["period_start"] == "2026-08-01"
        assert captured["rows"][0]["ingested_at"]
        assert all(r["period_start"] != "2026-07-01" for r in captured["rows"])

    def test_fetch_orders_upsert_includes_ingested_at(self, monkeypatch):
        from datetime import date
        import src.amazon_sp.reports as reports
        from src.models.schema import SalesByState

        captured: dict = {"calls": []}

        def fake_upsert(table, rows, on_conflict=None):
            captured["calls"].append({
                "table": table,
                "rows": rows,
                "on_conflict": on_conflict,
            })
            return len(rows)

        rec = SalesByState(
            state_code="TX",
            channel="amazon",
            period_start=date(2026, 8, 1),
            period_end=date(2026, 8, 31),
            order_count=1,
            gross_sales=10.0,
            net_sales=10.0,
            source="amazon_spapi",
        )
        monkeypatch.setattr(reports, "_date_chunks", lambda s, e: [(s, e)])
        monkeypatch.setattr(reports, "request_and_download", lambda *a, **k: "x")
        daily = [{
            "state_code": "TX", "channel": "amazon",
            "sale_date": "2026-08-20", "order_count": 1,
            "gross_sales": 10.0, "net_sales": 10.0,
            "tax_collected": 0.0, "source": "amazon_spapi",
        }]
        monkeypatch.setattr(reports, "parse_orders_report", lambda _c: {
            "rows_total": 1, "rows_parsed": 1, "rows_skipped": 0,
            "ship_to_states": {"TX"}, "total_gross_sales": 10.0,
            "total_tax": 0.0, "warnings": [], "sales_records": [rec],
            "daily_records": daily,
            "unique_orders": 1, "_samples": [rec],
        })
        monkeypatch.setattr(reports, "fetch_dest_daily", lambda *a, **k: [
            {
                "state_code": "TX", "channel": "amazon",
                "sale_date": "2026-08-01", "order_count": 4,
                "gross_sales": 40.0, "net_sales": 40.0,
                "tax_collected": 0.0, "source": "amazon_spapi",
            },
        ])
        monkeypatch.setattr(reports, "upsert_rows", fake_upsert)
        monkeypatch.setattr(reports, "log_ingestion", lambda **k: None)
        monkeypatch.setattr(reports, "log_audit", lambda **k: None)

        result = reports.fetch_orders(date(2026, 8, 14), date(2026, 8, 21))
        assert result["rows_inserted"] == 1
        monthly = [c for c in captured["calls"] if c["table"] == "sales_by_state"]
        assert monthly
        assert monthly[0]["rows"][0]["ingested_at"]
        assert monthly[0]["rows"][0]["source"] == "amazon_spapi"
        assert monthly[0]["rows"][0]["gross_sales"] == 50.0
        assert monthly[0]["on_conflict"] == "state_code,channel,period_start,period_end"
        daily_writes = [c for c in captured["calls"] if c["table"] == "sales_by_state_daily"]
        assert daily_writes
        assert daily_writes[0]["rows"][0]["sale_date"] == "2026-08-20"

    def test_fetch_amazon_skus_upsert_includes_ingested_at(self, monkeypatch):
        from datetime import date
        import src.amazon_sp.reports as reports

        captured: dict = {}

        def fake_upsert(table, rows, on_conflict=None):
            captured["table"] = table
            captured["rows"] = rows
            return len(rows)

        monkeypatch.setattr(reports, "_date_chunks", lambda s, e: [(s, e)])
        monkeypatch.setattr(reports, "request_and_download", lambda *a, **k: "x")
        monkeypatch.setattr(reports, "parse_orders_by_sku", lambda _c: {
            "rows_total": 1, "rows_parsed": 1, "rows_skipped": 0,
            "warnings": [],
            "sku_rows": [{
                "channel": "amazon", "sku": "SKU-1", "asin": "B00",
                "product_title": "t", "state_code": "TX",
                "period_start": "2026-08-01", "period_end": "2026-08-31",
                "units": 1, "gross_sales": 10.0, "net_sales": 10.0,
                "order_count": 1, "source": "amazon_spapi",
            }],
            "unique_skus": 1,
        })
        monkeypatch.setattr(reports, "upsert_rows", fake_upsert)
        monkeypatch.setattr(reports, "log_ingestion", lambda **k: None)
        monkeypatch.setattr(reports, "log_audit", lambda **k: None)

        result = reports.fetch_amazon_skus(date(2026, 8, 14), date(2026, 8, 21))
        assert result["rows_inserted"] == 1
        assert captured["table"] == "sales_by_sku"
        assert captured["rows"][0]["ingested_at"]

    def test_fetch_amazon_skus_skips_range_past_orders_floor(self, monkeypatch):
        from datetime import date
        import src.amazon_sp.reports as reports
        import src.rules as rules

        def boom(*_a, **_k):
            raise AssertionError("must not request Amazon past the 2-year floor")

        monkeypatch.setattr(rules, "amazon_today", lambda now=None: date(2026, 8, 24))
        monkeypatch.setattr(reports, "request_and_download", boom)
        result = reports.fetch_amazon_skus(date(2024, 1, 1), date(2024, 7, 31))
        assert result["chunks"] == 0
        assert result["rows_inserted"] == 0
        assert result["warnings"]


# ── 4g. SUMMARY search-term date is a window label, not daily grain ──


class TestSearchTermSummaryDateStamp:
    """timeUnit=SUMMARY collapses each chunk to one row.

    Consumers (actions engine, search-term loop, brief, SQL) filter on `date`
    then SUM metrics — they do not require daily grain. Stamping chunk END
    makes max(date) a freshness proxy without extra Ads report calls. Do not
    switch search_term_chunk_days to 1 for this; that would multiply API load
    and change how many SUMMARY rows a lookback sums.
    """

    def _term_row(self, term="tallow balm"):
        return {
            "searchTerm": term, "campaignId": "camp-1", "campaignName": "SP",
            "adGroupId": "ag-1", "adGroupName": "AG", "keyword": "tallow",
            "keywordId": "kw-1", "matchType": "EXACT",
            "impressions": 100, "clicks": 10, "spend": 4.50,
            "sales14d": 12.00, "purchases14d": 1,
        }

    def test_summary_rows_use_chunk_end_not_start(self, monkeypatch):
        import src.amazon_ads.reports as reports
        from datetime import date

        written: list[dict] = []

        monkeypatch.setattr(reports, "_fetch_search_terms_chunk",
                            lambda cs, ce: [self._term_row()])
        monkeypatch.setattr(reports, "upsert_rows",
                            lambda t, rows, on_conflict=None: written.extend(rows) or len(rows))

        start, end = date(2026, 8, 15), date(2026, 8, 21)
        reports.fetch_search_terms(start, end, chunk_days=7)

        assert len(written) == 1
        assert written[0]["date"] == "2026-08-21"
        assert written[0]["date"] != "2026-08-15"
        assert written[0]["search_term"] == "tallow balm"
        # Metric math is the SUMMARY totals, not a per-day split.
        assert written[0]["spend"] == 4.50
        assert written[0]["sales_14d"] == 12.00
        assert written[0]["orders_14d"] == 1

    def test_each_chunk_is_labelled_with_its_own_end(self, monkeypatch):
        import src.amazon_ads.reports as reports
        from datetime import date

        written: list[dict] = []

        def fake_chunk(cs, ce):
            return [self._term_row(term=f"{cs.isoformat()}")]

        monkeypatch.setattr(reports, "_fetch_search_terms_chunk", fake_chunk)
        monkeypatch.setattr(reports, "upsert_rows",
                            lambda t, rows, on_conflict=None: written.extend(rows) or len(rows))

        reports.fetch_search_terms(date(2026, 8, 8), date(2026, 8, 21), chunk_days=7)
        dates = sorted(r["date"] for r in written)
        assert dates == ["2026-08-14", "2026-08-21"]

    def test_first_chunk_persists_when_later_chunk_fails(self, monkeypatch):
        """90d used to buffer every chunk then write once — a timeout after
        chunk 1 wrote zero rows. Each 7-day chunk must land immediately."""
        import src.amazon_ads.reports as reports
        from datetime import date

        written: list[dict] = []
        upsert_calls: list[str] = []

        def fake_chunk(cs, ce):
            if ce >= date(2026, 8, 21):
                raise TimeoutError("CLOSE_WAIT ghost lock")
            return [self._term_row(term="week-one")]

        def fake_upsert(table, rows, on_conflict=None):
            assert table == "ads_search_terms_daily"
            upsert_calls.append(on_conflict or "")
            written.extend(rows)
            return len(rows)

        monkeypatch.setattr(reports, "_fetch_search_terms_chunk", fake_chunk)
        monkeypatch.setattr(reports, "upsert_rows", fake_upsert)

        result = reports.fetch_search_terms(
            date(2026, 8, 8), date(2026, 8, 21), chunk_days=7)

        assert result["chunks"] == 2
        assert result["errors"]
        assert len(upsert_calls) == 1
        assert written[0]["search_term"] == "week-one"
        assert written[0]["date"] == "2026-08-14"
        assert result["inserted"] == 1
        assert not any(r["date"] == "2026-08-21" for r in written)

    def test_each_successful_chunk_upserts_immediately(self, monkeypatch):
        import src.amazon_ads.reports as reports
        from datetime import date

        upserts: list[list[str]] = []

        def fake_chunk(cs, ce):
            return [self._term_row(term=ce.isoformat())]

        def fake_upsert(table, rows, on_conflict=None):
            upserts.append([r["date"] for r in rows])
            return len(rows)

        monkeypatch.setattr(reports, "_fetch_search_terms_chunk", fake_chunk)
        monkeypatch.setattr(reports, "upsert_rows", fake_upsert)

        reports.fetch_search_terms(date(2026, 8, 8), date(2026, 8, 21), chunk_days=7)
        assert len(upserts) == 2
        assert upserts[0] == ["2026-08-14"]
        assert upserts[1] == ["2026-08-21"]

    def test_search_term_upsert_is_inside_the_chunk_loop(self):
        import inspect
        from src.amazon_ads.reports import fetch_search_terms
        src = inspect.getsource(fetch_search_terms)
        loop = src[src.index("for i, (cs, ce)"):src.index("return {")]
        after = src[src.index("return {"):]
        assert 'upsert_rows(' in loop
        assert 'ads_search_terms_daily' in loop
        assert 'upsert_rows(' not in after


class TestAdsSearchTermSlotStop:
    """425 / timeout must STOP remaining search-term chunks. No wait-loop."""

    def _term_row(self, term="tallow balm"):
        return {
            "searchTerm": term, "campaignId": "camp-1", "campaignName": "SP",
            "adGroupId": "ag-1", "adGroupName": "AG", "keyword": "tallow",
            "keywordId": "kw-1", "matchType": "EXACT",
            "impressions": 100, "clicks": 10, "spend": 4.50,
            "sales14d": 12.00, "purchases14d": 1,
        }

    def test_create_report_425_is_slot_busy(self, monkeypatch):
        import src.amazon_ads.client as client

        class Resp:
            status_code = 425
            text = "Too Early"

            def json(self):
                return {}

            def raise_for_status(self):
                raise AssertionError("425 must not fall through to raise_for_status")

        monkeypatch.setattr(client, "ads_headers", lambda: {})
        monkeypatch.setattr(client.httpx, "post", lambda *a, **k: Resp())
        with pytest.raises(client.AdsReportSlotBusy, match="425"):
            client.create_report({"configuration": {"reportTypeId": "spSearchTerm"}})

    def test_backoff_does_not_retry_slot_busy(self, monkeypatch):
        import src.amazon_ads.reports as reports
        from src.amazon_ads.client import AdsReportSlotBusy

        calls = {"n": 0}

        def boom(*a, **k):
            calls["n"] += 1
            raise AdsReportSlotBusy("HTTP 425")

        monkeypatch.setattr(reports, "fetch_report", boom)
        slept = []
        import time as time_mod
        monkeypatch.setattr(time_mod, "sleep", lambda s: slept.append(s))
        with pytest.raises(AdsReportSlotBusy):
            reports._fetch_report_with_backoff({"configuration": {}})
        assert calls["n"] == 1
        assert slept == []

    def test_fetch_report_cancels_on_timeout(self, monkeypatch):
        import src.amazon_ads.client as client

        cancelled = []
        monkeypatch.setattr(client, "create_report", lambda cfg: "rep-hung")
        monkeypatch.setattr(client, "poll_report",
                            lambda *a, **k: (_ for _ in ()).throw(TimeoutError("timed out")))
        monkeypatch.setattr(client, "cancel_report",
                            lambda rid: cancelled.append(rid) or True)
        with pytest.raises(TimeoutError):
            client.fetch_report({"configuration": {}})
        assert cancelled == ["rep-hung"]

    def test_search_terms_stop_on_425_do_not_continue(self, monkeypatch):
        import src.amazon_ads.reports as reports
        from src.amazon_ads.client import AdsReportSlotBusy
        from datetime import date

        written = []
        calls = []

        def fake_chunk(cs, ce):
            calls.append(ce)
            if len(calls) >= 2:
                raise AdsReportSlotBusy("HTTP 425")
            return [self._term_row()]

        monkeypatch.setattr(reports, "_fetch_search_terms_chunk", fake_chunk)
        monkeypatch.setattr(reports, "upsert_rows",
                            lambda t, rows, on_conflict=None: written.extend(rows) or len(rows))

        result = reports.fetch_search_terms(
            date(2026, 8, 1), date(2026, 8, 21), chunk_days=7)
        assert result["stopped"] == "slot_busy"
        assert len(calls) == 2  # third week never requested
        assert len(written) == 1
        assert written[0]["date"] == "2026-08-07"

    def test_skip_existing_skips_present_chunk_end(self, monkeypatch):
        import src.amazon_ads.reports as reports
        from datetime import date

        calls = []
        monkeypatch.setattr(reports, "_search_term_chunk_present",
                            lambda end: end == date(2026, 8, 14))
        monkeypatch.setattr(reports, "_fetch_search_terms_chunk",
                            lambda cs, ce: calls.append(ce) or [self._term_row()])
        monkeypatch.setattr(reports, "upsert_rows",
                            lambda t, rows, on_conflict=None: len(rows))

        result = reports.fetch_search_terms(
            date(2026, 8, 8), date(2026, 8, 21), chunk_days=7,
            skip_existing=True)
        assert calls == [date(2026, 8, 21)]
        assert result["chunks_skipped_existing"] == 1
        assert result["stopped"] is None

    def test_newest_first_requests_recent_week_first(self, monkeypatch):
        import src.amazon_ads.reports as reports
        from datetime import date

        calls = []
        monkeypatch.setattr(reports, "_fetch_search_terms_chunk",
                            lambda cs, ce: calls.append(ce) or [self._term_row()])
        monkeypatch.setattr(reports, "upsert_rows",
                            lambda t, rows, on_conflict=None: len(rows))

        reports.fetch_search_terms(
            date(2026, 8, 8), date(2026, 8, 21), chunk_days=7,
            newest_first=True)
        assert calls == [date(2026, 8, 21), date(2026, 8, 14)]

    def test_weekday_sync_still_7d_no_skip_existing(self):
        import inspect
        from src.main import _run_ads_search_terms_sync
        src = inspect.getsource(_run_ads_search_terms_sync)
        assert "days=7" in src
        assert "days=90" not in src
        assert "skip_existing_search_term_weeks" not in src

    def test_one_shot_cli_is_search_terms_only_and_stops(self):
        import inspect
        from src import main as main_mod
        src = inspect.getsource(main_mod)
        start = src.index("def ads_search_terms_backfill_cmd")
        body = src[start:src.index("def _ads_sync_outcome")]
        assert "search_terms_only=True" in body
        assert "skip_existing_search_term_weeks=True" in body
        assert "newest_first_search_terms=True" in body
        assert "AdsSyncBusy" in body
        assert "Do not retry in a loop" in body
        assert "cancel_report" in body
