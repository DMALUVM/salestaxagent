"""Business rules — single source of truth.

All parsers, sync engines, and tests read from config/business_rules.json
via this module.  No duplicate literals allowed in calling code.

Usage:
    from src.rules import AMAZON_TZ, is_excluded_status, ADS_MAX_CHUNK_DAYS
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "business_rules.json"


def _load() -> dict:
    with open(_CONFIG_PATH) as f:
        return json.load(f)


_RULES = _load()

# ── Amazon ────────────────────────────────────────────────
AMAZON_TZ_NAME: str = _RULES["amazon"]["timezone"]
AMAZON_TZ: ZoneInfo = ZoneInfo(AMAZON_TZ_NAME)
AMAZON_DATE_FIELD: str = _RULES["amazon"]["date_field"]
AMAZON_INCLUDE_STATUSES: frozenset[str] = frozenset(_RULES["amazon"]["include_statuses"])
AMAZON_EXCLUDE_STATUSES: frozenset[str] = frozenset(_RULES["amazon"]["exclude_statuses"])
AMAZON_PULSE_SOURCE: str = _RULES["amazon"]["pulse_source"]
AMAZON_PRICE_FIELD: str = _RULES["amazon"]["price_field"]

# ── Shopify ───────────────────────────────────────────────
SHOPIFY_TZ_NAME: str = _RULES["shopify"]["timezone"]
SHOPIFY_TZ: ZoneInfo = ZoneInfo(SHOPIFY_TZ_NAME)

# ── SP-API ────────────────────────────────────────────────
SPAPI_MAX_CHUNK_DAYS: int = _RULES["spapi"]["max_chunk_days"]
# GET_FLAT_FILE_ALL_ORDERS_* only retains purchase dates inside this
# calendar window. Older chunks come back DONE with 0 rows — not a
# parser bug, and not worth polling.
SPAPI_ORDERS_MAX_AGE_YEARS: int = int(
    _RULES["spapi"].get("orders_report_max_age_years", 2))
# Inventory ledger windows. This feed drives physical nexus, so it is pulled on
# a wider window than the orders report and re-pulled weekly — both upsert-only.
SPAPI_INVENTORY_LEDGER_DAYS: int = _RULES["spapi"].get("inventory_ledger_days", 14)
SPAPI_INVENTORY_BACKFILL_DAYS: int = _RULES["spapi"].get(
    "inventory_ledger_backfill_days", 90)

# ── Ads ───────────────────────────────────────────────────
ADS_MAX_REPORT_DAYS: int = _RULES["ads"]["max_report_days"]
ADS_MAX_CHUNK_DAYS: int = _RULES["ads"]["max_chunk_days"]
ADS_MANDATORY_CHUNKING: bool = _RULES["ads"]["mandatory_chunking"]
# Campaign reports default to 7-day chunks. A single 30-day SB/SD report on
# this account sits PENDING past the 900s cap; the same window in 7-day
# chunks completes. Still clamped to ADS_MAX_CHUNK_DAYS at request time.
ADS_CAMPAIGN_CHUNK_DAYS: int = int(_RULES["ads"].get("campaign_chunk_days", 7))
# SB/SD campaign reports chunk smaller than SP. A 7-day SB request that
# times out used to leave the whole window SP-only; 1-day chunks keep the
# days that already completed.
ADS_SB_SD_CHUNK_DAYS: int = int(_RULES["ads"].get("campaign_sb_sd_chunk_days", 1))
# Nightly SB/SD only pull this many closed days. Nightly SP uses the same
# 7-day window. Sunday backfill still covers the long SP window.
ADS_SB_SD_DAILY_DAYS: int = int(_RULES["ads"].get("campaign_sb_sd_daily_days", 7))
# Sunday backfill is 90d for SP. SB/SD stay short so 03:00 cannot still
# hold the process lock when the 05:00 daily jobs fire.
ADS_SB_SD_BACKFILL_DAYS: int = int(_RULES["ads"].get("campaign_sb_sd_backfill_days", 7))
# Search-term reports are far heavier than campaign reports; they are chunked
# smaller so a single request cannot sit past its poll timeout.
ADS_SEARCH_TERM_CHUNK_DAYS: int = _RULES["ads"]["search_term_chunk_days"]
ADS_SEARCH_TERM_TIMEOUT_SECONDS: int = _RULES["ads"]["search_term_timeout_seconds"]
# SB/SD campaign reports on this account sit PENDING past 300s on slow nights.
# SP keeps the Ads client default (1800s) and is not listed here.
ADS_CAMPAIGN_TIMEOUT_SB_SECONDS: int = int(
    _RULES["ads"].get("campaign_report_timeout_sb_seconds", 900))
ADS_CAMPAIGN_TIMEOUT_SD_SECONDS: int = int(
    _RULES["ads"].get("campaign_report_timeout_sd_seconds", 900))
ADS_SKU_ECONOMICS_MIN_DATE: date = date.fromisoformat(
    str(_RULES["ads"].get("sku_economics_min_date", "2024-09-01")))

# ── Agent scheduler ───────────────────────────────────────
# Every cron job in `python -m src.main run` fires on this zone, regardless of
# the machine's own timezone. Amazon *day boundaries* stay on AMAZON_TZ — this
# only decides when the jobs wake up.
AGENT_TZ_NAME: str = _RULES["agent"]["timezone"]
AGENT_TZ: ZoneInfo = ZoneInfo(AGENT_TZ_NAME)

# ── P&L ───────────────────────────────────────────────────
PNL_COGS_SOURCE: str = _RULES["pnl"]["cogs_source"]
PNL_CONTRIBUTION_FORMULA: str = _RULES["pnl"]["contribution_formula"]
PNL_FINANCES_LABEL: str = _RULES["pnl"]["finances_label"]
PNL_DEFAULT_REFERRAL_PCT: float = _RULES["pnl"]["default_referral_pct"]
PNL_DEFAULT_FBA_FEE_PER_UNIT: float = _RULES["pnl"]["default_fba_fee_per_unit"]


def agent_today(now: datetime | None = None) -> date:
    """Today's calendar date in AGENT_TZ (America/New_York).

    Filing due-date comparisons use this, not the machine clock and not
    Amazon's Pacific day boundary. A UTC date after 00:00 UTC / before
    20:00 Eastern is still "yesterday" in AGENT_TZ and would mark a
    return late a day early.
    """
    moment = now or datetime.now(AGENT_TZ)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=AGENT_TZ)
    return moment.astimezone(AGENT_TZ).date()


def amazon_today(now: datetime | None = None) -> date:
    """Today's calendar date in America/Los_Angeles.

    Python counterpart of dashboard/src/lib/as-of.ts `amazonToday`.
    A UTC `date.today()` after 00:00 UTC / before 17:00 Pacific is already
    tomorrow in LA and would pull or label the wrong Amazon day.
    """
    moment = now or datetime.now(AMAZON_TZ)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=AMAZON_TZ)
    return moment.astimezone(AMAZON_TZ).date()


def orders_report_floor(as_of: date | None = None) -> date:
    """Oldest purchase date SP-API All Orders will still return.

    Amazon drops GET_FLAT_FILE_ALL_ORDERS rows older than
    SPAPI_ORDERS_MAX_AGE_YEARS. From 2026-08-24 that floor is 2024-08-24.
    Jan–Jul 2024 is gone from the API; only an old Seller Central CSV
    can fill those months.
    """
    day = as_of if as_of is not None else amazon_today()
    try:
        return day.replace(year=day.year - SPAPI_ORDERS_MAX_AGE_YEARS)
    except ValueError:
        return day.replace(year=day.year - SPAPI_ORDERS_MAX_AGE_YEARS, day=28)


def clamp_orders_report_range(
    start: date,
    end: date,
    as_of: date | None = None,
) -> tuple[date | None, date, str | None]:
    """Drop or clamp a range that All Orders can no longer serve.

    Returns (start, end, warning). start is None when the whole window
    is older than the floor — callers must not request Amazon.
    """
    floor = orders_report_floor(as_of)
    if end < floor:
        return None, end, (
            f"SP-API All Orders only keeps ~{SPAPI_ORDERS_MAX_AGE_YEARS} years. "
            f"{start} to {end} is before {floor.isoformat()}. Amazon returns "
            "empty files. Drop an old All Orders CSV in incoming/amazon/ "
            "if you still have one."
        )
    if start < floor:
        return floor, end, (
            f"Clamped start {start} → {floor} "
            f"(SP-API All Orders {SPAPI_ORDERS_MAX_AGE_YEARS}-year floor)."
        )
    return start, end, None


def amazon_as_of(now: datetime | None = None) -> date:
    """Yesterday in the Amazon reporting timezone — the newest closed day.

    Python counterpart of dashboard/src/lib/as-of.ts. Today is always partial
    (sales still accruing, ads synced only through yesterday), so every window
    that claims to be N days ends here. Derived from AMAZON_TZ, never from the
    machine's clock or a UTC date: from 00:00 UTC — 17:00 Pacific — a UTC date
    is already tomorrow in LA terms and silently shortens the window.
    """
    return amazon_today(now) - timedelta(days=1)


def window_start(as_of: date, days: int) -> date:
    """Inclusive start of a `days`-long window ending on `as_of`."""
    return as_of - timedelta(days=days - 1)


def is_excluded_status(status: str) -> bool:
    """True if this Amazon order status should be excluded from ALL sales counts."""
    return status.strip().lower() in AMAZON_EXCLUDE_STATUSES


def is_included_status(status: str) -> bool:
    """True if this Amazon order status should be included in sales counts."""
    return status.strip().lower() in AMAZON_INCLUDE_STATUSES
