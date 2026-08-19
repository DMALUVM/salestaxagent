"""Net Proceeds / Contribution P&L computation.

Estimates daily contribution: sales - referral - FBA - COGS - ad_spend.

Fee defaults (overridable via config or sku_costs table):
  Referral: 15% of gross sales (Amazon category average)
  FBA: $3.50/unit default (small standard items)
  COGS: from sku_costs table; 0 if unknown (flagged)

Status:
  preliminary — estimated fees, may adjust when Amazon settles
  reconciled  — when amazon_net_proceeds available from economics report
"""
from __future__ import annotations

import logging
import os
from collections import defaultdict
from datetime import date, timedelta

from src.db import fetch_all, upsert_rows

log = logging.getLogger(__name__)

DEFAULT_REFERRAL_PCT = float(os.environ.get("DEFAULT_REFERRAL_PCT", "0.15"))
DEFAULT_FBA_FEE_PER_UNIT = float(os.environ.get("DEFAULT_FBA_FEE_PER_UNIT", "3.50"))


def compute_pnl(days: int = 30) -> dict:
    """Compute daily P&L from existing sales + ads data.

    Sources:
      - sales_daily (amazon channel): gross sales by day
      - ads_campaigns_daily: ad spend by day
      - sku_costs: COGS per unit
      - sku_velocity / sales_by_sku: units per day (for COGS calc)
    """
    today = date.today()
    start = today - timedelta(days=days)

    # Load sales daily (amazon only for now)
    try:
        sales_rows = fetch_all("sales_daily")
    except Exception:
        sales_rows = []

    daily_sales: dict[str, float] = defaultdict(float)
    daily_orders: dict[str, int] = defaultdict(int)
    for r in sales_rows:
        if r.get("channel") != "amazon":
            continue
        d = r.get("sale_date", "")
        if d < start.isoformat():
            continue
        daily_sales[d] += float(r.get("gross_sales", 0) or 0)
        daily_orders[d] += int(r.get("order_count", 0) or 0)

    # Load ads spend by day
    try:
        ads_rows = fetch_all("ads_campaigns_daily")
    except Exception:
        ads_rows = []

    daily_ads: dict[str, float] = defaultdict(float)
    for r in ads_rows:
        d = r.get("date", "")
        if d < start.isoformat():
            continue
        daily_ads[d] += float(r.get("spend", 0) or 0)

    # Load COGS
    try:
        costs = {r["sku"]: float(r.get("cogs_per_unit", 0) or 0) for r in fetch_all("sku_costs")}
    except Exception:
        costs = {}

    # Estimate daily units from velocity (for COGS calc at account level)
    try:
        vel_rows = fetch_all("sku_velocity")
        daily_units = sum(float(v.get("total_u_30", 0) or 0) for v in vel_rows
                          if v.get("sku") and float(v.get("total_u_30", 0) or 0) > 0)
    except Exception:
        daily_units = 0

    avg_cogs = 0.0
    if costs:
        avg_cogs = sum(costs.values()) / len(costs)

    # Load existing reconciled dates — don't overwrite with estimates
    reconciled_dates: set[str] = set()
    try:
        existing = fetch_all("pnl_daily")
        reconciled_dates = {r["date"] for r in existing
                           if r.get("grain") == "account" and r.get("status") == "reconciled"}
    except Exception:
        pass

    # Build daily P&L rows (preliminary only — skip reconciled)
    pnl_rows: list[dict] = []
    all_dates = sorted(set(list(daily_sales.keys()) + list(daily_ads.keys())))

    has_cogs = bool(costs)
    skipped_reconciled = 0

    for d in all_dates:
        if d in reconciled_dates:
            skipped_reconciled += 1
            continue
        sales = daily_sales.get(d, 0)
        ads = daily_ads.get(d, 0)
        orders = daily_orders.get(d, 0)

        # Estimate units from orders (rough: avg ~1.3 units/order for this business)
        est_units = round(orders * 1.3) if orders > 0 else round(daily_units)

        referral = round(sales * DEFAULT_REFERRAL_PCT, 2)
        fba_fees = round(est_units * DEFAULT_FBA_FEE_PER_UNIT, 2)
        cogs = round(est_units * avg_cogs, 2) if has_cogs else 0

        contribution = round(sales - referral - fba_fees - cogs - ads, 2)
        net_after_ads = contribution  # until amazon_net_proceeds available

        pnl_rows.append({
            "date": d,
            "grain": "account",
            "sku": "",
            "channel": "amazon",
            "gross_sales": round(sales, 2),
            "units": est_units,
            "ad_spend": round(ads, 2),
            "est_referral_fees": referral,
            "est_fba_fees": fba_fees,
            "est_cogs": cogs,
            "est_contribution": contribution,
            "net_after_ads": net_after_ads,
            "status": "preliminary",
        })

    if not pnl_rows:
        return {"rows": 0, "inserted": 0, "days": 0}

    inserted = upsert_rows("pnl_daily", pnl_rows,
                           on_conflict="date,grain,sku,channel")

    # Summary
    total_sales = sum(r["gross_sales"] for r in pnl_rows)
    total_ads = sum(r["ad_spend"] for r in pnl_rows)
    total_contribution = sum(r["est_contribution"] for r in pnl_rows)

    return {
        "rows": len(pnl_rows),
        "inserted": inserted,
        "days": len(all_dates),
        "total_sales": round(total_sales, 2),
        "total_ads": round(total_ads, 2),
        "total_contribution": round(total_contribution, 2),
        "has_cogs": has_cogs,
        "referral_pct": DEFAULT_REFERRAL_PCT,
        "fba_per_unit": DEFAULT_FBA_FEE_PER_UNIT,
    }
