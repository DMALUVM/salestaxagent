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

    def test_spapi_chunk_size_within_limit(self):
        from src.rules import SPAPI_MAX_CHUNK_DAYS
        assert SPAPI_MAX_CHUNK_DAYS <= 31

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
            assert span <= SPAPI_MAX_CHUNK_DAYS + 1, (
                f"Chunk {cs}→{ce} spans {span} days"
            )


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
