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
# Inventory ledger windows. This feed drives physical nexus, so it is pulled on
# a wider window than the orders report and re-pulled weekly — both upsert-only.
SPAPI_INVENTORY_LEDGER_DAYS: int = _RULES["spapi"].get("inventory_ledger_days", 14)
SPAPI_INVENTORY_BACKFILL_DAYS: int = _RULES["spapi"].get(
    "inventory_ledger_backfill_days", 90)

# ── Ads ───────────────────────────────────────────────────
ADS_MAX_REPORT_DAYS: int = _RULES["ads"]["max_report_days"]
ADS_MAX_CHUNK_DAYS: int = _RULES["ads"]["max_chunk_days"]
ADS_MANDATORY_CHUNKING: bool = _RULES["ads"]["mandatory_chunking"]
# Search-term reports are far heavier than campaign reports; they are chunked
# smaller so a single request cannot sit past its poll timeout.
ADS_SEARCH_TERM_CHUNK_DAYS: int = _RULES["ads"]["search_term_chunk_days"]
ADS_SEARCH_TERM_TIMEOUT_SECONDS: int = _RULES["ads"]["search_term_timeout_seconds"]

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


def amazon_as_of(now: datetime | None = None) -> date:
    """Yesterday in the Amazon reporting timezone — the newest closed day.

    Python counterpart of dashboard/src/lib/as-of.ts. Today is always partial
    (sales still accruing, ads synced only through yesterday), so every window
    that claims to be N days ends here. Derived from AMAZON_TZ, never from the
    machine's clock or a UTC date: from 00:00 UTC — 17:00 Pacific — a UTC date
    is already tomorrow in LA terms and silently shortens the window.
    """
    moment = now or datetime.now(AMAZON_TZ)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=AMAZON_TZ)
    return moment.astimezone(AMAZON_TZ).date() - timedelta(days=1)


def window_start(as_of: date, days: int) -> date:
    """Inclusive start of a `days`-long window ending on `as_of`."""
    return as_of - timedelta(days=days - 1)


def is_excluded_status(status: str) -> bool:
    """True if this Amazon order status should be excluded from ALL sales counts."""
    return status.strip().lower() in AMAZON_EXCLUDE_STATUSES


def is_included_status(status: str) -> bool:
    """True if this Amazon order status should be included in sales counts."""
    return status.strip().lower() in AMAZON_INCLUDE_STATUSES
