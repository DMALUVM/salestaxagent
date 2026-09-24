"""Shopify daily contribution — sibling path to Amazon compute_pnl.

Writes pnl_daily rows with channel='shopify', grain='account'. Amazon rows
are never touched. Formula (stored in meta; the dashboard read path applies
the same outbound and ad adjustment so a stale row is not left on $5.50):

    contribution = merchandise + shipping_charged − est_outbound_ship − cogs − ad_spend

  merchandise       — subtotal − refunds, floored at 0 (same as shopify_metrics)
  shipping_charged  — shopify_orders.shipping_price (shipping_lines or residual)
  est_outbound_ship — 3PL DTC fit from Apr–Jun 2026 tpl_cost_detail invoices
                      (Mar partial and Aug order-fee qty excluded from the fit):
                        $2.00 order fee + $6.00 postage + $0.30 packaging
                        + $0.50 per pick (≈ per unit on this catalog)
                      = 8.30 + 0.50 × units_in_order
                      Flat $9.90/order when that day's units are unknown.
                      Storage and account management are not in this estimate.
  ad_spend          — google_ads_daily.spend + meta_ads_daily.spend for the
                      day. A missing day is $0, not an invented fill. Never
                      Amazon ads_campaigns_daily.
  cogs              — that day's share of the month's sales_by_sku (shopify)
                      × sku_costs.cogs_per_unit. Missing SKUs contribute $0
                      (sku_costs only; never inferred).

shopify_orders does not store line-item quantity. When the month has
sales_by_sku Shopify units, the day's units are that month's units times
the day's merchandise share — the same allocation as COGS. Summed across
the month that is order_count × 8.30 + 0.50 × month units.

SKU-grain daily rows are not written: shopify_orders has no stored line items,
and sales_by_sku is monthly. Account-day is the natural grain.

Timezone: order_date is already America/New_York (shopify.timezone).
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import date, timedelta

from src.db import fetch_all, get_client, upsert_rows
from src.rules import (
    SHOPIFY_OUTBOUND_FIXED_PER_ORDER,
    SHOPIFY_OUTBOUND_FLAT_FALLBACK,
    SHOPIFY_OUTBOUND_PER_UNIT,
    agent_today,
)
from src.shopify_metrics import is_countable, revenue_of
from src.sku_normalize import normalize_sku

log = logging.getLogger(__name__)

CHANNEL = "shopify"
FORMULA = "merchandise + shipping_charged - est_outbound_ship - cogs - ad_spend"
# Cite: Apr–Jun 2026 tpl_cost_detail. $2 order fee + $6 postage + $0.30 pack
# + $0.50/pick. Storage and account management are excluded on purpose.
OUTBOUND_NOTE = (
    "3PL DTC fit Apr–Jun 2026 (tpl_cost_detail): "
    "est_outbound_ship = 8.30 + 0.50 × units_in_order "
    "($2.00 order fee + $6.00 postage + $0.30 packaging + $0.50 per unit). "
    "Flat $9.90/order when units are unknown. "
    "Storage and account management are excluded."
)
AD_SPEND_NOTE = (
    "google_ads_daily + meta_ads_daily for this America/New_York day. "
    "A day with no row is $0 — do not fill sparse Google history "
    "(table starts 2026-09-13). Not Amazon ads_campaigns_daily."
)


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _shipping_charged(row: dict) -> float:
    if row.get("shipping_price") is not None:
        return max(0.0, _num(row.get("shipping_price")))
    return max(
        0.0,
        _num(row.get("total_price"))
        - _num(row.get("subtotal_price"))
        - _num(row.get("total_tax")),
    )


def monthly_shopify_cogs(
    sku_rows: list[dict],
    costs: dict[str, float],
) -> tuple[dict[str, dict], set[str]]:
    """{YYYY-MM: {cogs, units, sales}} from sales_by_sku channel=shopify.

    Only sku_costs entries count. Unknown SKUs are listed, not priced.
    """
    monthly: dict[str, dict] = defaultdict(lambda: {"cogs": 0.0, "units": 0, "sales": 0.0})
    missing: set[str] = set()
    for r in sku_rows:
        if (r.get("channel") or "").lower() != CHANNEL:
            continue
        ym = str(r.get("period_start") or "")[:7]
        if len(ym) != 7:
            continue
        sku = normalize_sku(r.get("sku"))
        if sku == "UNKNOWN":
            continue
        units = int(r.get("units") or 0)
        sales = _num(r.get("gross_sales"))
        monthly[ym]["units"] += units
        monthly[ym]["sales"] += sales
        unit_cost = costs.get(sku)
        if unit_cost is None:
            missing.add(sku)
            continue
        monthly[ym]["cogs"] += units * unit_cost
    out = {k: {"cogs": round(v["cogs"], 2), "units": v["units"],
               "sales": round(v["sales"], 2)} for k, v in monthly.items()}
    return out, missing


def estimate_outbound_ship(
    order_count: int,
    units: int | None,
    *,
    units_known: bool,
) -> tuple[float, str]:
    """Per-day 3PL outbound. See OUTBOUND_NOTE.

    units_known uses the month's sales_by_sku units allocated onto the day.
    Unknown units (no Shopify sales_by_sku that month) use the flat fallback.
    Does not invent a unit count.
    """
    n = int(order_count or 0)
    if n <= 0:
        return 0.0, "none"
    if not units_known:
        return round(n * SHOPIFY_OUTBOUND_FLAT_FALLBACK, 2), "tpl_flat_fallback"
    u = int(units or 0)
    amount = n * SHOPIFY_OUTBOUND_FIXED_PER_ORDER + SHOPIFY_OUTBOUND_PER_UNIT * u
    return round(amount, 2), "tpl_apr_jun_2026"


def aggregate_shopify_days(
    orders: list[dict],
    monthly_cogs: dict[str, dict],
    *,
    start: str | None = None,
    ad_spend_by_day: dict[str, float] | None = None,
) -> list[dict]:
    """Pure: orders + monthly COGS + optional Google/Meta spend → pnl_daily dicts.

    Testable without a store or database. ad_spend_by_day keys that are
    absent count as $0. Amazon campaign spend is not an input.
    """
    by_day: dict[str, dict] = defaultdict(lambda: {
        "merchandise": 0.0,
        "shipping_charged": 0.0,
        "orders": 0,
        "sub_orders": 0,
        "provisional": 0,
    })
    for row in orders:
        if not is_countable(row):
            continue
        d = str(row.get("order_date") or "")[:10]
        if len(d) != 10:
            continue
        if start and d < start:
            continue
        bucket = by_day[d]
        bucket["merchandise"] += revenue_of(row)
        bucket["shipping_charged"] += _shipping_charged(row)
        bucket["orders"] += 1
        if row.get("is_subscription"):
            bucket["sub_orders"] += 1
        if (row.get("shipping_source") or "") == "provisional_residual":
            bucket["provisional"] += 1

    month_merch: dict[str, float] = defaultdict(float)
    for d, b in by_day.items():
        month_merch[d[:7]] += b["merchandise"]

    rows: list[dict] = []
    for d in sorted(by_day):
        b = by_day[d]
        merch = round(b["merchandise"], 2)
        ship_in = round(b["shipping_charged"], 2)
        n = int(b["orders"])
        ym = d[:7]
        m_cogs = monthly_cogs.get(ym) or {}
        denom = month_merch.get(ym) or 0.0
        has_month = ym in monthly_cogs
        if denom > 0 and has_month:
            units = int(round(float(m_cogs.get("units") or 0) * (merch / denom)))
            units_known = True
        else:
            units = 0
            units_known = False
        if denom > 0 and m_cogs.get("cogs"):
            cogs = round(float(m_cogs["cogs"]) * (merch / denom), 2)
            cogs_basis = "sales_by_sku_month_allocated"
        else:
            cogs = 0.0
            cogs_basis = "missing_sales_by_sku" if not m_cogs.get("cogs") else "zero_merchandise"

        outbound, outbound_basis = estimate_outbound_ship(
            n, units, units_known=units_known)
        # Missing google/meta days are absent from the map and count as $0.
        ads = round(float((ad_spend_by_day or {}).get(d, 0.0)), 2)
        sales = round(merch + ship_in, 2)
        contribution = round(sales - outbound - cogs - ads, 2)
        per_order = round(outbound / n, 2) if n else None
        rows.append({
            "date": d,
            "grain": "account",
            "sku": "",
            "channel": CHANNEL,
            "gross_sales": sales,
            "units": units,
            "ad_spend": ads,
            "est_referral_fees": 0,
            "est_fba_fees": outbound,
            "est_cogs": cogs,
            "est_contribution": contribution,
            "amazon_net_proceeds": None,
            "net_after_ads": contribution,
            "status": "preliminary",
            "meta": json.dumps({
                "formula": FORMULA,
                "channel": CHANNEL,
                "merchandise": merch,
                "shipping_charged": ship_in,
                "est_outbound_ship": outbound,
                "outbound_per_order": per_order,
                "outbound_fixed_per_order": SHOPIFY_OUTBOUND_FIXED_PER_ORDER,
                "outbound_per_unit": SHOPIFY_OUTBOUND_PER_UNIT,
                "outbound_flat_fallback_per_order": SHOPIFY_OUTBOUND_FLAT_FALLBACK,
                "outbound_basis": outbound_basis,
                "outbound_units_known": units_known,
                "cogs_basis": cogs_basis,
                "order_count": n,
                "subscription_orders": int(b["sub_orders"]),
                "one_time_orders": n - int(b["sub_orders"]),
                "provisional_shipping_orders": int(b["provisional"]),
                "ad_spend": ads,
                "ad_spend_sources": ["google_ads_daily", "meta_ads_daily"],
                "fees_basis": "estimated",
                "note": (
                    "est_fba_fees holds estimated outbound ship cost "
                    "(not FBA). ad_spend is Google + Meta, not Amazon PPC. "
                    "Amazon P&L is a separate channel row."
                ),
                "outbound_note": OUTBOUND_NOTE,
                "ad_spend_note": AD_SPEND_NOTE,
            }),
        })
    return rows


def _load_orders_since(start: date) -> list[dict]:
    """shopify_orders on/after start. Paginated. Missing table → []."""
    client = get_client()
    rows: list[dict] = []
    off = 0
    cols = (
        "order_id,order_date,subtotal_price,total_price,total_tax,"
        "shipping_price,is_subscription,shipping_source,refunded_amount,"
        "cancelled_at,is_test"
    )
    while True:
        q = (client.table("shopify_orders")
             .select(cols)
             .gte("order_date", start.isoformat())
             .order("order_date").order("order_id")
             .range(off, off + 999))
        page = q.execute().data or []
        rows.extend(page)
        if len(page) < 1000:
            break
        off += 1000
    return rows


def compute_shopify_pnl(days: int = 30) -> dict:
    """Compute and upsert Shopify account-grain contribution.

    Never writes channel='amazon'. Missing shopify_orders / new columns
    returns a skipped summary so Amazon P&L is not blocked.
    """
    today = agent_today()
    start = today - timedelta(days=days)
    start_iso = start.isoformat()

    try:
        orders = _load_orders_since(start)
    except Exception as e:
        msg = str(e)
        log.warning("Shopify P&L skipped (orders unread): %s", msg[:200])
        return {"rows": 0, "inserted": 0, "error": msg[:300], "skipped": True}

    try:
        costs = {
            normalize_sku(r.get("sku")): float(r.get("cogs_per_unit") or 0)
            for r in fetch_all("sku_costs")
            if r.get("sku")
        }
    except Exception:
        costs = {}

    try:
        sku_rows = fetch_all("sales_by_sku", filters={"channel": CHANNEL})
    except Exception:
        sku_rows = []

    monthly, missing = monthly_shopify_cogs(sku_rows, costs)
    ad_spend_by_day = _load_shopify_ad_spend(start_iso)
    account_rows = aggregate_shopify_days(
        orders, monthly, start=start_iso, ad_spend_by_day=ad_spend_by_day,
    )

    written_dates = {r["date"] for r in account_rows}
    try:
        client = get_client()
        existing = (client.table("pnl_daily").select("date")
                    .eq("channel", CHANNEL).eq("grain", "account")
                    .gte("date", start_iso).lte("date", today.isoformat())
                    .execute().data) or []
        for r in existing:
            d = r.get("date")
            if d and d not in written_dates:
                (client.table("pnl_daily").delete()
                 .eq("date", d).eq("channel", CHANNEL).eq("grain", "account")
                 .execute())
    except Exception:
        log.warning("Shopify P&L: could not prune stale days", exc_info=True)

    inserted = 0
    if account_rows:
        inserted = upsert_rows(
            "pnl_daily", account_rows, on_conflict="date,grain,sku,channel")

    total_sales = sum(r["gross_sales"] for r in account_rows)
    total_ship = sum(json.loads(r["meta"]).get("shipping_charged") or 0
                     for r in account_rows)
    total_out = sum(r["est_fba_fees"] for r in account_rows)
    total_cogs = sum(r["est_cogs"] for r in account_rows)
    total_contrib = sum(r["est_contribution"] for r in account_rows)
    total_ads = sum(r["ad_spend"] for r in account_rows)
    provisional = sum(json.loads(r["meta"]).get("provisional_shipping_orders") or 0
                      for r in account_rows)

    return {
        "rows": len(account_rows),
        "inserted": inserted,
        "days": len(account_rows),
        "total_sales": round(total_sales, 2),
        "total_shipping_charged": round(total_ship, 2),
        "total_outbound_est": round(total_out, 2),
        "total_cogs": round(total_cogs, 2),
        "total_ad_spend": round(total_ads, 2),
        "total_contribution": round(total_contrib, 2),
        "outbound_fixed_per_order": SHOPIFY_OUTBOUND_FIXED_PER_ORDER,
        "outbound_per_unit": SHOPIFY_OUTBOUND_PER_UNIT,
        "outbound_flat_fallback_per_order": SHOPIFY_OUTBOUND_FLAT_FALLBACK,
        "missing_cost_skus": sorted(missing),
        "provisional_shipping_orders": provisional,
        "formula": FORMULA,
        "skipped": False,
    }


def _load_shopify_ad_spend(start_iso: str) -> dict[str, float]:
    """Sum Google + Meta spend by metric_date. Missing tables or days are $0.

    Does not read ads_campaigns_daily. Does not invent spend for dates
    that have no row (Google history starts 2026-09-13).
    """
    totals: dict[str, float] = defaultdict(float)
    for table in ("google_ads_daily", "meta_ads_daily"):
        try:
            fetched = fetch_all(table)
        except Exception:
            log.warning("Shopify P&L: %s unread; that source counts as $0", table)
            continue
        for r in fetched:
            d = str(r.get("metric_date") or "")[:10]
            if len(d) != 10 or d < start_iso:
                continue
            totals[d] += _num(r.get("spend"))
    return {d: round(v, 2) for d, v in totals.items()}
