"""Daily sales aggregation — upsert Shopify and Amazon order data
into the sales_daily table with correct timezone-aware day boundaries.

Shopify uses America/New_York for day boundaries.
Amazon uses America/Los_Angeles for day boundaries.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from src.channels import SHOPIFY, AMAZON
from src.db import upsert_rows, get_client


TZ_SHOPIFY = ZoneInfo("America/New_York")
TZ_AMAZON = ZoneInfo("America/Los_Angeles")


# ── Helpers ────────────────────────────────────────────────


def _to_ny_date(value: Any) -> date | None:
    """Convert a datetime string or object to a date in America/New_York.

    Handles ISO strings (with or without timezone), datetime objects,
    and date objects.  Returns None if the value cannot be parsed.
    """
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.astimezone(TZ_SHOPIFY).date()
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return None
        try:
            dt = datetime.fromisoformat(value)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=TZ_SHOPIFY)
            return dt.astimezone(TZ_SHOPIFY).date()
        except (ValueError, TypeError):
            pass
        # Try date-only string
        try:
            return date.fromisoformat(value[:10])
        except (ValueError, TypeError):
            return None
    return None


def _to_la_date(value: Any) -> date | None:
    """Convert a datetime string or object to a date in America/Los_Angeles."""
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.astimezone(TZ_AMAZON).date()
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return None
        try:
            dt = datetime.fromisoformat(value)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=TZ_AMAZON)
            return dt.astimezone(TZ_AMAZON).date()
        except (ValueError, TypeError):
            pass
        try:
            return date.fromisoformat(value[:10])
        except (ValueError, TypeError):
            return None
    return None


def _safe_float(val: Any) -> float:
    """Coerce a value to float, defaulting to 0.0."""
    if val is None:
        return 0.0
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


# ── Shopify ────────────────────────────────────────────────


def upsert_shopify_daily(orders: list[dict]) -> dict:
    """Aggregate Shopify orders by (sale_date, state_code) and upsert
    into the sales_daily table.

    Each order should have at minimum:
        - created_at or processed_at: datetime string
        - billing_address.province_code or shipping_address.province_code: state
        - total_price: dollar amount
        - total_tax: tax amount

    Returns:
        dict with {rows_upserted, days, states}
    """
    if not orders:
        return {"rows_upserted": 0, "days": 0, "states": 0}

    # Aggregate by (sale_date, state_code)
    agg: dict[tuple[str, str], dict] = {}

    for order in orders:
        dt_str = order.get("processed_at") or order.get("created_at")
        sale_date = _to_ny_date(dt_str)
        if sale_date is None:
            continue

        # Extract state code
        addr = order.get("shipping_address") or order.get("billing_address") or {}
        state_code = (addr.get("province_code") or "").strip().upper()
        if not state_code or len(state_code) != 2:
            continue

        key = (sale_date.isoformat(), state_code)
        if key not in agg:
            agg[key] = {
                "sale_date": sale_date.isoformat(),
                "state_code": state_code,
                "channel": SHOPIFY,
                "order_count": 0,
                "gross_sales": 0.0,
                "tax_collected": 0.0,
                "refund_amount": 0.0,
            }

        bucket = agg[key]
        bucket["order_count"] += 1
        bucket["gross_sales"] += _safe_float(order.get("total_price"))
        bucket["tax_collected"] += _safe_float(order.get("total_tax"))

        # Check for refunds
        for refund in order.get("refunds", []):
            for txn in refund.get("transactions", []):
                bucket["refund_amount"] += _safe_float(txn.get("amount"))

    rows = list(agg.values())
    # Round floats
    for r in rows:
        r["gross_sales"] = round(r["gross_sales"], 2)
        r["tax_collected"] = round(r["tax_collected"], 2)
        r["refund_amount"] = round(r["refund_amount"], 2)
        r["net_sales"] = round(r["gross_sales"] - r["refund_amount"], 2)

    count = upsert_rows("sales_daily", rows, on_conflict="sale_date,state_code,channel")

    unique_days = {r["sale_date"] for r in rows}
    unique_states = {r["state_code"] for r in rows}

    return {
        "rows_upserted": count,
        "days": len(unique_days),
        "states": len(unique_states),
    }


# ── Amazon ─────────────────────────────────────────────────


def upsert_amazon_daily_from_tsv(content: str) -> dict:
    """Parse an Amazon settlement/sales TSV and upsert daily totals
    into sales_daily.

    Amazon day boundaries use America/Los_Angeles timezone.

    The TSV should have a header row.  Expected columns (by name):
        - date/time or purchase-date: datetime
        - ship-state or recipient-state: state code
        - item-price or principal: dollar amount
        - item-tax or tax: tax amount

    Returns:
        dict with {rows_upserted, days, states, lines_skipped}
    """
    if not content or not content.strip():
        return {"rows_upserted": 0, "days": 0, "states": 0, "lines_skipped": 0}

    lines = content.strip().split("\n")
    if len(lines) < 2:
        return {"rows_upserted": 0, "days": 0, "states": 0, "lines_skipped": 0}

    headers = [h.strip().lower() for h in lines[0].split("\t")]

    # Find relevant column indices
    def _col(candidates: list[str]) -> int | None:
        for c in candidates:
            if c in headers:
                return headers.index(c)
        return None

    date_col = _col(["date/time", "purchase-date", "posted-date", "date"])
    state_col = _col(["ship-state", "recipient-state", "state", "ship-to-state"])
    price_col = _col(["item-price", "principal", "product-sales", "total-price"])
    tax_col = _col(["item-tax", "tax", "product-sales-tax", "tax-amount"])

    if date_col is None or state_col is None or price_col is None:
        return {"rows_upserted": 0, "days": 0, "states": 0, "lines_skipped": len(lines) - 1}

    agg: dict[tuple[str, str], dict] = {}
    skipped = 0

    for line in lines[1:]:
        fields = line.split("\t")
        if len(fields) <= max(date_col, state_col, price_col):
            skipped += 1
            continue

        sale_date = _to_la_date(fields[date_col].strip())
        if sale_date is None:
            skipped += 1
            continue

        state_code = fields[state_col].strip().upper()
        if not state_code or len(state_code) != 2:
            skipped += 1
            continue

        price = _safe_float(fields[price_col].strip())
        tax = _safe_float(fields[tax_col].strip()) if tax_col is not None and tax_col < len(fields) else 0.0

        key = (sale_date.isoformat(), state_code)
        if key not in agg:
            agg[key] = {
                "sale_date": sale_date.isoformat(),
                "state_code": state_code,
                "channel": AMAZON,
                "order_count": 0,
                "gross_sales": 0.0,
                "tax_collected": 0.0,
                "refund_amount": 0.0,
            }

        bucket = agg[key]
        bucket["order_count"] += 1
        bucket["gross_sales"] += price
        bucket["tax_collected"] += tax

    rows = list(agg.values())
    for r in rows:
        r["gross_sales"] = round(r["gross_sales"], 2)
        r["tax_collected"] = round(r["tax_collected"], 2)
        r["refund_amount"] = round(r["refund_amount"], 2)
        r["net_sales"] = round(r["gross_sales"] - r["refund_amount"], 2)

    count = upsert_rows("sales_daily", rows, on_conflict="sale_date,state_code,channel")

    unique_days = {r["sale_date"] for r in rows}
    unique_states = {r["state_code"] for r in rows}

    return {
        "rows_upserted": count,
        "days": len(unique_days),
        "states": len(unique_states),
        "lines_skipped": skipped,
    }


# ── Query helper ──────────────────────────────────────────


def fetch_daily(start: date, end: date) -> list[dict]:
    """Fetch sales_daily rows for a date range (inclusive).

    Returns rows sorted by sale_date ascending.
    """
    client = get_client()
    all_rows: list[dict] = []
    page_size = 1000
    offset = 0

    while True:
        result = (
            client.table("sales_daily")
            .select("*")
            .gte("sale_date", start.isoformat())
            .lte("sale_date", end.isoformat())
            .order("sale_date")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        page = result.data or []
        all_rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size

    return all_rows
