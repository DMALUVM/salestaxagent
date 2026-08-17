"""Sales daily aggregation — real calendar-day totals for digest.

Aggregates Shopify and Amazon order data into the sales_daily table
with one row per (sale_date, channel).  All dates are in America/New_York.

Writers:
  upsert_shopify_daily(orders)   — from Shopify API response
  upsert_amazon_daily(content)   — from SP-API orders report TSV

Both are idempotent (upsert on PK sale_date + channel).
"""
from __future__ import annotations

import csv
import io
from collections import defaultdict
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from src.channels import SHOPIFY, AMAZON
from src.db import upsert_rows

NY = ZoneInfo("America/New_York")
# Amazon Seller Central uses Pacific Time for day boundaries
LA = ZoneInfo("America/Los_Angeles")

_TABLE_VERIFIED = False


def _ensure_table() -> bool:
    """Check that sales_daily exists. Returns True if available."""
    global _TABLE_VERIFIED
    if _TABLE_VERIFIED:
        return True
    try:
        from src.db import get_client
        client = get_client()
        client.table("sales_daily").select("sale_date").limit(1).execute()
        _TABLE_VERIFIED = True
        return True
    except Exception as e:
        if "PGRST205" in str(e) or "could not find" in str(e).lower():
            return False
        # Other errors (network, auth) — assume table exists
        _TABLE_VERIFIED = True
        return True


# ---------------------------------------------------------------------------
# Shopify daily writer
# ---------------------------------------------------------------------------

def upsert_shopify_daily(orders: list[dict]) -> dict:
    """Aggregate Shopify API orders into sales_daily rows.

    Args:
        orders: list of Shopify order dicts (from REST API response).

    Returns dict with days_written, total_sales, order_count.
    """
    if not _ensure_table():
        raise RuntimeError(
            "sales_daily table not found. Run the migration SQL from "
            "supabase/migration_sales_daily.sql in the Supabase SQL Editor."
        )
    daily: dict[date, dict] = defaultdict(lambda: {
        "gross_sales": 0.0, "order_count": 0,
    })

    for order in orders:
        addr = order.get("shipping_address") or {}
        country = addr.get("country_code", "")
        if country and country != "US":
            continue

        created = order.get("created_at", "")
        if not created:
            continue

        sale_date = _to_ny_date(created)
        if not sale_date:
            continue

        daily[sale_date]["order_count"] += 1
        daily[sale_date]["gross_sales"] += float(
            order.get("subtotal_price", 0) or 0
        )

    rows = [
        {
            "sale_date": d.isoformat(),
            "channel": SHOPIFY,
            "gross_sales": round(agg["gross_sales"], 2),
            "order_count": agg["order_count"],
            "source": "shopify_api",
        }
        for d, agg in sorted(daily.items())
    ]

    if rows:
        upsert_rows("sales_daily", rows, on_conflict="sale_date,channel")

    return {
        "days_written": len(rows),
        "total_sales": round(sum(r["gross_sales"] for r in rows), 2),
        "order_count": sum(r["order_count"] for r in rows),
    }


# ---------------------------------------------------------------------------
# Amazon daily writer
# ---------------------------------------------------------------------------

def upsert_amazon_daily_from_tsv(content: str) -> dict:
    """Parse SP-API orders report TSV and aggregate into sales_daily rows.

    Reuses the same report format as reports.parse_orders_report() but
    aggregates by day instead of month.

    Args:
        content: raw TSV string from the SP-API orders report.

    Returns dict with days_written, total_sales, order_count.
    """
    if not _ensure_table():
        raise RuntimeError(
            "sales_daily table not found. Run the migration SQL from "
            "supabase/migration_sales_daily.sql in the Supabase SQL Editor."
        )

    from src.amazon_sp.reports import (
        _detect_delimiter, _build_header_lookup, _get,
        _normalize_state, _parse_date as _parse_dt, _parse_money,
    )

    first_line = content.split("\n", 1)[0]
    delimiter = _detect_delimiter(first_line)
    reader = csv.DictReader(
        io.StringIO(content), delimiter=delimiter, quotechar='"',
    )
    if not reader.fieldnames:
        return {"days_written": 0, "total_sales": 0, "order_count": 0}

    H = _build_header_lookup(reader.fieldnames)

    daily: dict[date, dict] = defaultdict(lambda: {
        "gross_sales": 0.0, "order_ids": set(),
    })

    for row in reader:
        order_id = _get(row, H, "amazon-order-id")
        status = _get(row, H, "order-status").lower()

        # Match Seller Central "Ordered Product Sales" definition:
        # item-price, purchase-date in Pacific time, excl. cancelled only.
        # Pending orders are real sales not yet shipped — SC counts them.
        # No country/state filter — SC counts all US-marketplace orders.
        if not order_id or status == "cancelled":
            continue

        price_str = _get(row, H, "item-price")
        if not price_str:
            continue

        purchase_date_str = _get(row, H, "purchase-date")
        if not purchase_date_str:
            continue

        # Seller Central buckets by Pacific Time (Amazon HQ)
        sale_date = _to_tz_date(purchase_date_str, LA)
        if not sale_date:
            continue

        price = _parse_money(price_str)
        daily[sale_date]["order_ids"].add(order_id)
        daily[sale_date]["gross_sales"] += price

    rows = [
        {
            "sale_date": d.isoformat(),
            "channel": AMAZON,
            "gross_sales": round(agg["gross_sales"], 2),
            "order_count": len(agg["order_ids"]),
            "source": "amazon_spapi",
        }
        for d, agg in sorted(daily.items())
    ]

    if rows:
        upsert_rows("sales_daily", rows, on_conflict="sale_date,channel")

    return {
        "days_written": len(rows),
        "total_sales": round(sum(r["gross_sales"] for r in rows), 2),
        "order_count": sum(r["order_count"] for r in rows),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _to_tz_date(value: str, tz: ZoneInfo) -> date | None:
    """Parse a datetime string and convert to a date in the given timezone."""
    if not value:
        return None
    v = value.strip()

    # Try fromisoformat first (handles most SP-API / Shopify formats)
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=ZoneInfo("UTC"))
        return dt.astimezone(tz).date()
    except (ValueError, TypeError):
        pass

    # Fallback: common strptime patterns
    for fmt in (
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ):
        try:
            dt = datetime.strptime(v[:min(len(v), 25)], fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=ZoneInfo("UTC"))
            return dt.astimezone(tz).date()
        except (ValueError, IndexError):
            continue

    # Last resort: just the date portion
    try:
        return date.fromisoformat(v[:10])
    except (ValueError, IndexError):
        return None


def _to_ny_date(value: str) -> date | None:
    """Parse a datetime string and convert to America/New_York date."""
    return _to_tz_date(value, NY)


def fetch_daily(start: date, end: date) -> list[dict]:
    """Fetch sales_daily rows for a date range."""
    from src.db import get_client
    client = get_client()
    result = (
        client.table("sales_daily")
        .select("*")
        .gte("sale_date", start.isoformat())
        .lte("sale_date", end.isoformat())
        .order("sale_date")
        .execute()
    )
    return result.data or []
