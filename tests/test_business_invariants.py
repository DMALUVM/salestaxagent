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

    def test_ads_sb_sd_scheduled_windows_are_one_chunk(self):
        """Scheduled SB/SD must stay inside a single 7-day chunk.

        2026-08-24: five SB/SD chunks × 900s PENDING pinned campaigns for
        3.9h; placements/search terms then waited 180 minutes and paged.
        """
        ads = self.cfg["ads"]
        assert ads["campaign_sb_sd_daily_days"] == 7
        assert ads["campaign_sb_sd_backfill_days"] == 7
        assert ads["campaign_sb_sd_daily_days"] <= ads["campaign_chunk_days"]
        assert ads["campaign_sb_sd_backfill_days"] <= ads["campaign_chunk_days"]

    def test_spapi_chunk_limit(self):
        assert self.cfg["spapi"]["max_chunk_days"] <= 31

    def test_pnl_contribution_formula(self):
        assert "cogs" in self.cfg["pnl"]["contribution_formula"]
        assert "ad_spend" in self.cfg["pnl"]["contribution_formula"]


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
            ADS_CAMPAIGN_CHUNK_DAYS,
            ADS_SB_SD_BACKFILL_DAYS,
            ADS_SB_SD_DAILY_DAYS,
        )
        assert ADS_SB_SD_DAILY_DAYS == 7
        assert ADS_SB_SD_BACKFILL_DAYS == 7
        assert ADS_SB_SD_DAILY_DAYS <= ADS_CAMPAIGN_CHUNK_DAYS
        assert ADS_SB_SD_BACKFILL_DAYS <= ADS_CAMPAIGN_CHUNK_DAYS

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
                            lambda s, e, chunk_days=None: called.append("search_terms") or {"rows": 1})

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
                            lambda s, e, chunk_days=None: called.append("search_terms") or {"rows": 1})

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
        assert len(sb) == 1 and len(sd) == 1
        assert sb[0][1] == date(2026, 8, 30)
        assert (sb[0][1] - sb[0][0]).days + 1 <= 7
        assert (sd[0][1] - sd[0][0]).days + 1 <= 7
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

        assert _is_transient_report_error(TimeoutError("timed out after 900s"))
        assert _is_transient_report_error(RuntimeError("429 Too Many Requests"))
        assert _is_transient_report_error(RuntimeError("425 Too Early"))
        assert _is_transient_report_error(httpx.ConnectError("connection reset"))
        assert not _is_transient_report_error(RuntimeError("400 bad column"))
        assert not _is_transient_report_error(PermissionError("Ads API auth failed (401)"))

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
        assert "sb_sd_days" in src
        assert "ADS_SB_SD_DAILY_DAYS" in src
        assert "_run_ads_placements_sync" in src
        assert "_run_ads_search_terms_sync" in src
        assert 'status == "skipped"' in src

    def test_sunday_backfill_caps_sb_sd(self):
        import inspect
        from src.main import _run_ads_campaigns_backfill
        src = inspect.getsource(_run_ads_campaigns_backfill)
        assert "sb_sd_days" in src
        assert "ADS_SB_SD_BACKFILL_DAYS" in src

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


# ── 4f. SP-API order upsert stamps ingested_at ─────────────────


class TestSpapiOrderFreshness:
    """Re-upserted monthly sales_by_state rows must refresh ingested_at."""

    def test_stamp_sets_iso_utc(self):
        from datetime import datetime, timezone
        from src.amazon_sp.reports import _stamp_ingested_at

        now = datetime(2026, 8, 22, 17, 52, tzinfo=timezone.utc)
        rows = [{"state_code": "TX", "source": "amazon_spapi"}]
        _stamp_ingested_at(rows, now=now)
        assert rows[0]["ingested_at"] == now.isoformat()

    def test_fetch_orders_upsert_includes_ingested_at(self, monkeypatch):
        from datetime import date
        import src.amazon_sp.reports as reports
        from src.models.schema import SalesByState

        captured: dict = {}

        def fake_upsert(table, rows, on_conflict=None):
            captured["table"] = table
            captured["rows"] = rows
            captured["on_conflict"] = on_conflict
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
        monkeypatch.setattr(reports, "parse_orders_report", lambda _c: {
            "rows_total": 1, "rows_parsed": 1, "rows_skipped": 0,
            "ship_to_states": {"TX"}, "total_gross_sales": 10.0,
            "total_tax": 0.0, "warnings": [], "sales_records": [rec],
            "unique_orders": 1, "_samples": [rec],
        })
        monkeypatch.setattr(reports, "upsert_rows", fake_upsert)
        monkeypatch.setattr(reports, "log_ingestion", lambda **k: None)
        monkeypatch.setattr(reports, "log_audit", lambda **k: None)

        result = reports.fetch_orders(date(2026, 8, 14), date(2026, 8, 21))
        assert result["rows_inserted"] == 1
        assert captured["table"] == "sales_by_state"
        assert captured["rows"][0]["ingested_at"]
        assert captured["rows"][0]["source"] == "amazon_spapi"

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
