"""Daily sales aggregation — upsert Shopify and Amazon order data
into the sales_daily table with correct timezone-aware day boundaries.

Shopify uses America/New_York for day boundaries.
Amazon uses America/Los_Angeles for day boundaries.

DAY BOUNDARIES — canonical, and deliberately NOT uniform:

  Amazon  -> America/Los_Angeles   (business rule 1, config/business_rules.json)
  Shopify -> America/New_York      (the store's own reporting timezone)

Amazon MUST stay Pacific. Seller Central buckets orders by Pacific day, and any
other timezone makes every reconciliation, the pulse-audit tool and the tax
figures disagree with Amazon's own reports. Moving Amazon to Eastern would shift
every day boundary by three hours and silently restate history.

The two channels therefore use different day definitions. That is a real,
documented asymmetry rather than an oversight: each channel is bucketed the way
its own source system reports it, so each column reconciles against its origin.
A single cross-channel timezone would make at least one of them unreconcilable.
"""
from __future__ import annotations

import csv
import io
import logging
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from src.channels import SHOPIFY, AMAZON
from src.db import upsert_rows, get_client
from src.rules import AMAZON_TZ, SHOPIFY_TZ, is_excluded_status

log = logging.getLogger(__name__)

TZ_SHOPIFY = SHOPIFY_TZ
TZ_AMAZON = AMAZON_TZ
NY = TZ_SHOPIFY
LA = TZ_AMAZON


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


def _to_tz_date(value: Any, tz: ZoneInfo) -> date | None:
    """Convert a datetime string/object to a date in the given timezone."""
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.astimezone(tz).date()
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return None
        try:
            dt = datetime.fromisoformat(value)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=tz)
            return dt.astimezone(tz).date()
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


# ── Auto-sync from SP-API / Shopify API ──────────────────


def _write_daily_guarded(rows: list[dict], job: str,
                         allow_decrease: bool = False) -> dict:
    """Upsert daily totals, refusing writes that would shrink a closed day.

    Every writer to sales_daily goes through here. The guard is the reason a
    partial pull can no longer silently replace a complete day; the provenance
    fields are the reason the next such incident is diagnosable at all — before
    this, `updated_at` had no trigger and never moved, so nothing recorded which
    job last touched a day.
    """
    from datetime import datetime, timezone

    from src.sales_guard import guard_rows

    if not rows:
        return {"rows_upserted": 0, "days": 0, "blocked": [], "reasons": []}

    days = sorted({str(r["sale_date"]) for r in rows})
    channels = sorted({str(r["channel"]) for r in rows})
    client = get_client()
    existing = (client.table("sales_daily").select("*")
                .gte("sale_date", days[0]).lte("sale_date", days[-1])
                .in_("channel", channels).execute().data) or []

    res = guard_rows(rows, existing, date.today(),
                     allow_decrease=allow_decrease, job=job)

    stamped = []
    for r in res.to_write:
        stamped.append({**r,
                        "written_by": job,
                        "last_written_at": datetime.now(timezone.utc).isoformat()})

    count = 0
    if stamped:
        try:
            count = upsert_rows("sales_daily", stamped, on_conflict="sale_date,channel")
        except Exception as e:
            # The provenance/completeness columns need
            # supabase/migration_sales_provenance.sql. Until it is run the guard
            # still works — only the audit trail is missing, which must not be
            # a reason to skip writing correct data.
            if "column" in str(e).lower():
                log.warning("sales_daily provenance columns missing — run "
                            "supabase/migration_sales_provenance.sql (guard still active)")
                plain = [{k: v for k, v in r.items()
                          if k not in ("written_by", "last_written_at", "is_complete")}
                         for r in res.to_write]
                count = upsert_rows("sales_daily", plain, on_conflict="sale_date,channel")
            else:
                raise

    for reason in res.reasons:
        log.warning("[%s] %s", job, reason)

    return {"rows_upserted": count, "days": len(res.to_write),
            "blocked": res.blocked_days, "reasons": res.reasons}


def sync_amazon_daily(days: int = 7) -> dict:
    """Fetch Amazon SP-API orders report and aggregate into sales_daily.

    Uses the same orders report as velocity.  Includes ALL non-cancelled
    orders (Pending, Unshipped, Shipped, etc.) with purchase-date in
    America/Los_Angeles timezone — matching Seller Central day boundaries.

    Aggregates to one row per (sale_date, channel) since sales_daily
    has columns: sale_date, channel, gross_sales, order_count, source.
    """
    from src.amazon_sp.client import request_and_download
    from src.amazon_sp.reports import (
        ORDERS_REPORT, _date_chunks, _detect_delimiter,
        _build_header_lookup, _get, _parse_money,
    )

    end = date.today()
    start = end - timedelta(days=days)

    # Track unique order IDs per day to avoid double-counting line items
    day_orders: dict[str, set[str]] = defaultdict(set)
    day_gross: dict[str, float] = defaultdict(float)

    for c_start, c_end in _date_chunks(start, end):
        try:
            content = request_and_download(ORDERS_REPORT, c_start, c_end)
        except Exception as e:
            log.warning("sync_amazon_daily: chunk %s failed: %s", c_start, e)
            continue

        first_line = content.split("\n", 1)[0]
        delimiter = _detect_delimiter(first_line)
        reader = csv.DictReader(io.StringIO(content), delimiter=delimiter, quotechar='"')
        if not reader.fieldnames:
            continue

        H = _build_header_lookup(reader.fieldnames)

        for row in reader:
            status = _get(row, H, "order-status")
            if is_excluded_status(status):
                continue  # skip cancelled, include pending/shipped/etc.

            pd_str = _get(row, H, "purchase-date")
            sale_date = _to_tz_date(pd_str, LA)
            if not sale_date:
                continue

            price = _parse_money(_get(row, H, "item-price"))
            order_id = _get(row, H, "amazon-order-id", "order-id")

            ds = sale_date.isoformat()
            day_gross[ds] += price
            if order_id:
                day_orders[ds].add(order_id)

    # ── Drop the partial leading day ────────────────────────────
    # The orders report is bounded in UTC, but purchase dates are bucketed into
    # America/Los_Angeles days (business rule 1). UTC midnight on `start` is
    # 17:00 the PREVIOUS LA day, so the report always carries the last ~7 hours
    # of the day before the window — which then upserts a partial value over a
    # complete one and never gets revisited.
    #
    # Observed 2026-08-20 with days=7 (window 08-13 → 08-20): 68 orders, all in
    # UTC hours 00-06, bucketed to LA 2026-08-12 and overwrote the true
    # $3,133.84 with $1,049.28 — a third of the day. That is the short bar on
    # the Overview 30-day chart.
    start_iso = start.isoformat()
    partial_leading = {ds: day_gross[ds] for ds in day_gross if ds < start_iso}
    for ds in partial_leading:
        log.info("sync_amazon_daily: dropping partial leading day %s "
                 "($%.2f from %d order(s) that fall before the window start in LA)",
                 ds, partial_leading[ds], len(day_orders.get(ds, set())))

    rows = []
    for ds in sorted(day_gross):
        if ds < start_iso:
            continue  # only partially covered by this window — never write it
        rows.append({
            "sale_date": ds,
            "channel": AMAZON,
            "gross_sales": round(day_gross[ds], 2),
            "order_count": len(day_orders.get(ds, set())),
            "source": "amazon_spapi",
        })

    if not rows:
        return {"rows_upserted": 0, "days": 0, "total_gross": 0,
                "dropped_partial_days": sorted(partial_leading)}

    written = _write_daily_guarded(rows, job="sync_amazon_daily")
    total_gross = sum(r["gross_sales"] for r in rows)

    return {
        "rows_upserted": written["rows_upserted"],
        "days": written["days"],
        "total_gross": round(total_gross, 2),
        "blocked_days": written["blocked"],
        "guard_reasons": written["reasons"],
        "dropped_partial_days": sorted(partial_leading),
    }


def sync_shopify_daily(days: int = 7) -> dict:
    """Fetch Shopify orders via API and aggregate into sales_daily.

    Uses America/New_York timezone for day boundaries.
    Aggregates to one row per (sale_date, channel).
    """
    from src.config import settings
    if not settings.shopify_enabled:
        return {"rows_upserted": 0, "days": 0, "error": "Shopify not configured"}

    import httpx
    from src.shopify_auth import auth_headers

    since = date.today() - timedelta(days=days)
    base_url = f"https://{settings.shopify_shop_domain}/admin/api/2024-01/orders.json"
    headers = auth_headers()
    params = {
        "status": "any",
        "created_at_min": since.isoformat() + "T00:00:00",
        "limit": "250",
        "fields": "id,created_at,processed_at,total_price,financial_status",
    }

    orders: list[dict] = []
    url: str | None = base_url

    while url:
        resp = httpx.get(url, headers=headers, params=params if url == base_url else None, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        orders.extend(data.get("orders", []))
        link = resp.headers.get("link", "")
        url = None
        if 'rel="next"' in link:
            for part in link.split(","):
                if 'rel="next"' in part:
                    url = part.split("<")[1].split(">")[0]
                    break

    # Aggregate to day level
    day_gross: dict[str, float] = defaultdict(float)
    day_orders: dict[str, int] = defaultdict(int)

    for order in orders:
        dt_str = order.get("processed_at") or order.get("created_at")
        sale_date = _to_tz_date(dt_str, NY)
        if not sale_date:
            continue
        ds = sale_date.isoformat()
        day_gross[ds] += _safe_float(order.get("total_price"))
        day_orders[ds] += 1

    rows = []
    for ds in sorted(day_gross):
        rows.append({
            "sale_date": ds,
            "channel": SHOPIFY,
            "gross_sales": round(day_gross[ds], 2),
            "order_count": day_orders[ds],
            "source": "shopify_api",
        })

    if not rows:
        return {"rows_upserted": 0, "days": 0}

    written = _write_daily_guarded(rows, job="sync_shopify_daily")
    return {"rows_upserted": written["rows_upserted"], "days": written["days"],
            "blocked_days": written["blocked"], "guard_reasons": written["reasons"]}
