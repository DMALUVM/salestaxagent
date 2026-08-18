"""Unit velocity + seasonality engine.

Computes per-SKU velocity from Amazon SP-API order items + Shopify line items.
Builds weekly seasonality multipliers from prior-year order history.

Multi-channel:
  - Amazon units from SP-API orders report (purchase-date, sku, quantity)
  - Shopify units from Shopify Admin API (line_items sku + quantity)
  - Combined into total velocity for matched SKUs
"""
from __future__ import annotations

import csv
import io
import logging
import math
from collections import defaultdict
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from src.db import upsert_rows, fetch_all

log = logging.getLogger(__name__)

LA = ZoneInfo("America/Los_Angeles")
NY = ZoneInfo("America/New_York")


# ---------------------------------------------------------------------------
# Amazon order-item units from SP-API report
# ---------------------------------------------------------------------------

def _fetch_amazon_sku_units(days: int = 400) -> dict[str, dict[date, int]]:
    """Fetch Amazon order items and return {sku: {date: units}}.

    Uses the same orders report as sales_daily but extracts per-SKU units.
    """
    from src.amazon_sp.client import request_and_download
    from src.amazon_sp.reports import (
        ORDERS_REPORT, _date_chunks, _detect_delimiter,
        _build_header_lookup, _get, _parse_money,
    )
    from src.sales_daily import _to_tz_date

    end = date.today()
    start = end - timedelta(days=days)

    sku_units: dict[str, dict[date, int]] = defaultdict(lambda: defaultdict(int))

    for c_start, c_end in _date_chunks(start, end):
        try:
            content = request_and_download(ORDERS_REPORT, c_start, c_end)
        except Exception as e:
            log.warning("Failed to fetch orders chunk %s: %s", c_start, e)
            continue

        first_line = content.split("\n", 1)[0]
        delimiter = _detect_delimiter(first_line)
        reader = csv.DictReader(io.StringIO(content), delimiter=delimiter, quotechar='"')
        if not reader.fieldnames:
            continue

        H = _build_header_lookup(reader.fieldnames)

        for row in reader:
            status = _get(row, H, "order-status").lower()
            if status == "cancelled":
                continue

            sku = _get(row, H, "sku", "seller-sku", "msku")
            if not sku:
                continue

            qty_str = _get(row, H, "quantity")
            try:
                qty = max(int(float(qty_str or "0")), 0)
            except (ValueError, TypeError):
                qty = 0
            if qty == 0:
                continue

            pd_str = _get(row, H, "purchase-date")
            sale_date = _to_tz_date(pd_str, LA)
            if not sale_date:
                continue

            sku_units[sku][sale_date] += qty

    return dict(sku_units)


# ---------------------------------------------------------------------------
# Shopify order-item units
# ---------------------------------------------------------------------------

def _fetch_shopify_sku_units(days: int = 400) -> dict[str, dict[date, int]]:
    """Fetch Shopify line items and return {sku: {date: units}}."""
    from src.config import settings
    if not settings.shopify_enabled:
        return {}

    import httpx
    from src.shopify_auth import auth_headers, auth_headers_with_retry
    from src.sales_daily import _to_tz_date

    since = date.today() - timedelta(days=days)
    base_url = f"https://{settings.shopify_shop_domain}/admin/api/2024-01/orders.json"
    headers = auth_headers()
    params = {
        "status": "any",
        "limit": 250,
        "fields": "id,created_at,line_items,financial_status",
        "created_at_min": since.isoformat() + "T00:00:00Z",
    }

    sku_units: dict[str, dict[date, int]] = defaultdict(lambda: defaultdict(int))
    url: str | None = base_url
    retried = False

    while url:
        resp = httpx.get(
            url, headers=headers,
            params=params if url == base_url else None,
            timeout=30,
        )
        if resp.status_code == 401 and not retried:
            new_h = auth_headers_with_retry(401)
            if new_h:
                headers = new_h
                retried = True
                continue
        if resp.status_code != 200:
            log.warning("Shopify orders error %d", resp.status_code)
            break

        data = resp.json()
        for order in data.get("orders", []):
            created = order.get("created_at", "")
            sale_date = _to_tz_date(created, NY)
            if not sale_date:
                continue
            for li in order.get("line_items", []):
                sku = (li.get("sku") or "").strip()
                if not sku:
                    continue
                qty = int(li.get("quantity", 0) or 0)
                if qty > 0:
                    sku_units[sku][sale_date] += qty

        link_header = resp.headers.get("link", "")
        url = None
        if 'rel="next"' in link_header:
            for part in link_header.split(","):
                if 'rel="next"' in part:
                    url = part.split("<")[1].split(">")[0]
                    break

    return dict(sku_units)


# ---------------------------------------------------------------------------
# SKU mapping (Amazon ↔ Shopify)
# ---------------------------------------------------------------------------

def _load_sku_map() -> tuple[dict[str, str], dict[str, str]]:
    """Returns (shopify_to_amazon, amazon_to_shopify) mappings.

    Primary: direct SKU match (seller SKU == Shopify variant SKU).
    Fallback: inventory_sku_map table.
    """
    s2a: dict[str, str] = {}
    a2s: dict[str, str] = {}

    try:
        maps = fetch_all("inventory_sku_map")
        for m in maps:
            a = m.get("amazon_sku", "")
            s = m.get("shopify_sku", "")
            if a and s:
                s2a[s] = a
                a2s[a] = s
    except Exception:
        pass  # table may not exist yet

    return s2a, a2s


# ---------------------------------------------------------------------------
# Velocity computation
# ---------------------------------------------------------------------------

def _units_per_day(date_units: dict[date, int], end: date, window: int) -> float:
    """Sum units in [end - window + 1, end] and divide by window."""
    start = end - timedelta(days=window - 1)
    total = sum(v for d, v in date_units.items() if start <= d <= end)
    return round(total / window, 2)


def compute_velocity(
    amazon_days: int = 400,
    shopify_days: int = 400,
    dry_run: bool = False,
) -> dict:
    """Compute per-SKU velocity and seasonality, upsert to sku_velocity + seasonality_weekly."""
    log.info("[Velocity] Fetching Amazon order items (%dd)...", amazon_days)
    amz_sku_units = _fetch_amazon_sku_units(days=amazon_days)
    log.info("[Velocity] Amazon: %d SKUs", len(amz_sku_units))

    log.info("[Velocity] Fetching Shopify line items (%dd)...", shopify_days)
    shop_sku_units = _fetch_shopify_sku_units(days=shopify_days)
    log.info("[Velocity] Shopify: %d SKUs", len(shop_sku_units))

    # SKU mapping
    s2a, a2s = _load_sku_map()

    # Merge: for each Amazon SKU, add Shopify units if SKU matches directly
    # or via the mapping table
    all_skus = set(amz_sku_units.keys())
    shopify_matched: set[str] = set()

    # Direct match: same SKU string
    for shop_sku in shop_sku_units:
        if shop_sku in amz_sku_units:
            shopify_matched.add(shop_sku)
        elif shop_sku in s2a:
            shopify_matched.add(shop_sku)
            all_skus.add(s2a[shop_sku])

    # Also include Shopify-only SKUs
    for shop_sku in shop_sku_units:
        if shop_sku not in shopify_matched:
            all_skus.add(shop_sku)

    today = date.today()
    # Use yesterday as the end date for velocity windows — today is
    # always incomplete (partial day) and would drag down the average.
    yesterday = today - timedelta(days=1)

    # Build seasonality first (account-level from Amazon total units)
    seasonality = _build_seasonality(amz_sku_units, shop_sku_units)

    # Current ISO week for seasonality multiplier
    current_week = today.isocalendar()[1]
    # Forward 4-week average multiplier for planning
    forward_mults = []
    for w_offset in range(8):
        wk = ((current_week - 1 + w_offset) % 53) + 1
        m = seasonality.get(wk, 1.0)
        forward_mults.append(m)
    avg_forward_mult = sum(forward_mults) / len(forward_mults) if forward_mults else 1.0

    # Get product names: restock (Amazon) then 3PL (Ship Sidekick) as fallback
    name_map: dict[str, str] = {}
    asin_map: dict[str, str] = {}
    try:
        for r in fetch_all("inventory_3pl_snapshots"):
            if r.get("product_name"):
                name_map[r["sku"]] = r["product_name"]
    except Exception:
        pass
    try:
        restock = fetch_all("inventory_restock")
        for r in restock:
            if r.get("product_name"):
                name_map[r["sku"]] = r["product_name"]  # Amazon overrides 3PL
            if r.get("asin"):
                asin_map[r["sku"]] = r["asin"]
    except Exception:
        pass

    velocity_rows = []
    for sku in sorted(all_skus):
        amz_dates = amz_sku_units.get(sku, {})
        # Find matching Shopify data
        shop_dates: dict[date, int] = {}
        if sku in shop_sku_units:
            shop_dates = shop_sku_units[sku]
        elif sku in a2s and a2s[sku] in shop_sku_units:
            shop_dates = shop_sku_units[a2s[sku]]

        # Combine for total
        combined: dict[date, int] = defaultdict(int)
        for d, u in amz_dates.items():
            combined[d] += u
        for d, u in shop_dates.items():
            combined[d] += u

        a7 = _units_per_day(amz_dates, yesterday, 7)
        a14 = _units_per_day(amz_dates, yesterday, 14)
        a30 = _units_per_day(amz_dates, yesterday, 30)
        a90 = _units_per_day(amz_dates, yesterday, 90)

        s7 = _units_per_day(shop_dates, yesterday, 7)
        s14 = _units_per_day(shop_dates, yesterday, 14)
        s30 = _units_per_day(shop_dates, yesterday, 30)
        s90 = _units_per_day(shop_dates, yesterday, 90)

        t7 = _units_per_day(combined, yesterday, 7)
        t14 = _units_per_day(combined, yesterday, 14)
        t30 = _units_per_day(combined, yesterday, 30)
        t90 = _units_per_day(combined, yesterday, 90)

        mult = avg_forward_mult
        seasonal_t30 = round(t30 * mult, 2)

        velocity_rows.append({
            "sku": sku,
            "asin": asin_map.get(sku),
            "product_name": name_map.get(sku),
            "as_of_date": today.isoformat(),
            "amazon_u_7": a7, "amazon_u_14": a14,
            "amazon_u_30": a30, "amazon_u_90": a90,
            "shopify_u_7": s7, "shopify_u_14": s14,
            "shopify_u_30": s30, "shopify_u_90": s90,
            "total_u_7": t7, "total_u_14": t14,
            "total_u_30": t30, "total_u_90": t90,
            "seasonality_mult": round(mult, 3),
            "seasonal_total_u_30": seasonal_t30,
        })

    result = {
        "skus": len(velocity_rows),
        "amazon_skus": len(amz_sku_units),
        "shopify_skus": len(shop_sku_units),
        "seasonality_weeks": len(seasonality),
        "avg_forward_mult": round(avg_forward_mult, 3),
        "dry_run": dry_run,
        "rows_inserted": 0,
    }

    if not dry_run and velocity_rows:
        result["rows_inserted"] = upsert_rows(
            "sku_velocity", velocity_rows, on_conflict="sku",
        )

    return result


# ---------------------------------------------------------------------------
# Seasonality
# ---------------------------------------------------------------------------

def _build_seasonality(
    amz_sku_units: dict[str, dict[date, int]],
    shop_sku_units: dict[str, dict[date, int]],
) -> dict[int, float]:
    """Build account-level weekly seasonality multipliers.

    Returns {iso_week: multiplier} where multiplier = week_avg / baseline_avg.
    Baseline = full-year weekly average excluding top 4 peak weeks.
    """
    # Aggregate all units by ISO week across all SKUs
    weekly_units: dict[tuple[int, int], int] = defaultdict(int)  # (year, week) -> units

    for sku_dates in list(amz_sku_units.values()) + list(shop_sku_units.values()):
        for d, units in sku_dates.items():
            yr, wk, _ = d.isocalendar()
            weekly_units[(yr, wk)] += units

    if not weekly_units:
        return {}

    # Group by week number (across years) for averaging
    week_totals: dict[int, list[int]] = defaultdict(list)
    for (yr, wk), units in weekly_units.items():
        week_totals[wk].append(units)

    # Average per week
    week_avg: dict[int, float] = {
        wk: sum(vals) / len(vals) for wk, vals in week_totals.items()
    }

    # Baseline: average of all weeks excluding top 4 (to not inflate baseline with peaks)
    sorted_avgs = sorted(week_avg.values())
    if len(sorted_avgs) > 4:
        baseline_vals = sorted_avgs[:-4]
    else:
        baseline_vals = sorted_avgs
    baseline = sum(baseline_vals) / len(baseline_vals) if baseline_vals else 1.0

    multipliers: dict[int, float] = {}
    seasonality_rows = []

    for wk, avg in week_avg.items():
        mult = round(avg / baseline, 3) if baseline > 0 else 1.0
        multipliers[wk] = mult
        seasonality_rows.append({
            "year": 0,  # 0 = account-level average
            "week": wk,
            "sku": "_account_",
            "multiplier": mult,
            "units_actual": round(avg, 1),
            "baseline_units": round(baseline, 1),
        })

    # Also store per-year data for the most recent full year
    years = set(yr for yr, _ in weekly_units.keys())
    for yr in sorted(years):
        yr_weeks = {wk: u for (y, wk), u in weekly_units.items() if y == yr}
        for wk, units in yr_weeks.items():
            mult = round(units / baseline, 3) if baseline > 0 else 1.0
            seasonality_rows.append({
                "year": yr,
                "week": wk,
                "sku": "_account_",
                "multiplier": mult,
                "units_actual": float(units),
                "baseline_units": round(baseline, 1),
            })

    try:
        upsert_rows("seasonality_weekly", seasonality_rows,
                     on_conflict="year,week,sku")
    except Exception as e:
        log.warning("Failed to upsert seasonality: %s", e)

    return multipliers
