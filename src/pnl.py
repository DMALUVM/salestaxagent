"""Contribution P&L — daily operating net.

CONTRIBUTION FORMULA (the only one; stored, not derived at read time):

    contribution = gross_sales - referral_fees - fba_fees - ad_spend - cogs

This is an OPERATING measure on the Amazon order day (America/Los_Angeles).
Amazon's biweekly deposit is NOT the daily grain: a settlement covers a
two-week window on posted-date basis and lands twice a month, so using it per
day both mis-times revenue and makes daily margin unreadable. The payout is
still fetched and stored in `amazon_net_proceeds` as a *reconciliation check*
against the cash that actually arrives.

Sources (all existing; nothing new is invented):
  - sales_daily (amazon)        : gross sales by day
  - ads_campaigns_daily         : ad spend by day (same table/column /ppc sums)
  - orders report + sku_costs   : COGS = sum over SKUs of units x cogs_per_unit
  - Finances API (economics)    : settled fees + payout when available

Fee basis is recorded per day:
  settled   — actual Amazon fees from the Finances API for that posted date
  estimated — referral % of sales + per-unit FBA fee (Amazon has not settled yet)

Status:
  reconciled  — settlement data present for the day (payout + settled fees)
  preliminary — estimates only
"""
from __future__ import annotations

import json
import logging
import os
from collections import defaultdict
from datetime import date, timedelta

from src.db import fetch_all, get_client, upsert_rows
from src.rules import PNL_DEFAULT_REFERRAL_PCT, PNL_DEFAULT_FBA_FEE_PER_UNIT

log = logging.getLogger(__name__)

DEFAULT_REFERRAL_PCT = float(os.environ.get("DEFAULT_REFERRAL_PCT", str(PNL_DEFAULT_REFERRAL_PCT)))
DEFAULT_FBA_FEE_PER_UNIT = float(os.environ.get("DEFAULT_FBA_FEE_PER_UNIT", str(PNL_DEFAULT_FBA_FEE_PER_UNIT)))

#: SKU-grain row that carries ad spend which cannot be attributed to a SKU.
#: Campaign spend is campaign-level, so today that is all of it. The identity
#: sum(sku rows) + unallocated == account row therefore always holds.
UNALLOCATED_SKU = "__unallocated__"


def _ad_spend_by_day(start: date) -> dict[str, float]:
    """Ad spend per day from ads_campaigns_daily — the table /ppc sums.

    Paginated: ~150 campaign rows per day passes PostgREST's 1,000-row default
    within a week, and a truncated read would silently under-report spend.
    Never read back from pnl_daily: that self-read is what pinned ad spend to 0.
    """
    client = get_client()
    out: dict[str, float] = defaultdict(float)
    offset, page_size = 0, 1000
    while True:
        resp = (client.table("ads_campaigns_daily")
                .select("date,spend")
                .gte("date", start.isoformat())
                .order("date")
                .range(offset, offset + page_size - 1)
                .execute())
        page = resp.data or []
        for r in page:
            d = r.get("date")
            if d:
                out[d] += float(r.get("spend") or 0)
        if len(page) < page_size:
            break
        offset += page_size
    return dict(out)


def _sku_units_by_day(days: int) -> dict[str, dict[str, int]]:
    """{date: {sku: units}} from the Amazon orders report.

    Reuses the velocity engine's parser, so order-status and timezone rules
    (business rules 1 and 2) are applied in exactly one place.
    """
    try:
        from src.inventory.velocity import _fetch_amazon_sku_units
        by_sku = _fetch_amazon_sku_units(days=days)
    except Exception:
        log.exception("Could not load per-SKU units; COGS will be 0")
        return {}

    out: dict[str, dict[str, int]] = defaultdict(dict)
    for sku, per_day in by_sku.items():
        for d, units in per_day.items():
            if units:
                out[d.isoformat()][sku] = out[d.isoformat()].get(sku, 0) + int(units)
    return dict(out)


def _settled_by_day(days: int) -> dict[str, dict]:
    """{date: {payout, fees, units}} from the Finances API, or {} if unavailable.

    Posted-date basis — this is settlement data, used for the fee figure and as
    a cash reconciliation check. It never becomes the daily contribution grain.
    """
    try:
        from src.amazon_sp.economics import fetch_transactions, aggregate_daily
        end = date.today()
        start = end - timedelta(days=days)
        agg = aggregate_daily(fetch_transactions(start, end))
    except Exception:
        log.warning("Settlement data unavailable; using estimated fees", exc_info=True)
        return {}

    out: dict[str, dict] = {}
    for day, a in agg.items():
        out[day] = {
            "payout": round(a["payout"], 2),
            # aggregate_daily keeps fees negative (a charge); store positive.
            "fees": round(-a["amazon_fees"], 2),
            "units": a["units"],
            "refunds": round(a["refund_charges"], 2),
        }
    return out


def compute_pnl(days: int = 30, with_skus: bool = True,
                fee_basis: str = "estimate") -> dict:
    """Compute and store daily contribution for the last `days` days.

    Single writer for pnl_daily: sales, ads, COGS and fees are all resolved
    here, so no other job can overwrite part of a row with stale values.

    fee_basis:
      "estimate" (default) — referral % of sales + per-unit FBA fee. Derived
        from the same orders-report basis as gross_sales and COGS, so the day's
        arithmetic is internally consistent.
      "settled" — actual Amazon fees from the Finances API for that posted date.
        CAUTION: settlement is posted-date and, on this account, its product
        charges run about 2x the orders-report sales for the same day, so
        settled fees against orders-report sales read ~80% and drive
        contribution negative. Only use once those two bases are reconciled.

    Either way the settled fees, payout and product charges are recorded in the
    row's meta so the gap stays visible instead of silently picked.
    """
    if fee_basis not in ("estimate", "settled"):
        raise ValueError("fee_basis must be 'estimate' or 'settled'")
    today = date.today()
    start = today - timedelta(days=days)
    start_iso = start.isoformat()

    # ── Gross sales by day (Amazon channel) ──
    try:
        sales_rows = fetch_all("sales_daily")
    except Exception:
        log.exception("Could not read sales_daily")
        sales_rows = []

    daily_sales: dict[str, float] = defaultdict(float)
    daily_orders: dict[str, int] = defaultdict(int)
    for r in sales_rows:
        if r.get("channel") != "amazon":
            continue
        d = r.get("sale_date", "")
        if not d or d < start_iso:
            continue
        daily_sales[d] += float(r.get("gross_sales") or 0)
        daily_orders[d] += int(r.get("order_count") or 0)

    # ── Ad spend, COGS inputs, settlement ──
    daily_ads = _ad_spend_by_day(start)
    sku_units = _sku_units_by_day(days) if with_skus else {}
    settled = _settled_by_day(days)

    try:
        costs = {r["sku"]: float(r.get("cogs_per_unit") or 0) for r in fetch_all("sku_costs")}
    except Exception:
        costs = {}
    has_cogs = bool(costs)

    # Fallback unit cost for SKUs sold but not priced, so COGS is never silently
    # understated by ignoring them.
    avg_cogs = (sum(costs.values()) / len(costs)) if costs else 0.0

    # Every day that any source knows about — sales, ads, or units.
    all_dates = sorted(set(daily_sales) | set(daily_ads) | set(sku_units))

    account_rows: list[dict] = []
    sku_rows: list[dict] = []
    missing_cost_skus: set[str] = set()

    for d in all_dates:
        sales = round(daily_sales.get(d, 0.0), 2)
        ads = round(daily_ads.get(d, 0.0), 2)
        units_by_sku = sku_units.get(d, {})
        units = sum(units_by_sku.values())
        if not units:
            # No per-SKU units (e.g. orders report unavailable): fall back to
            # the order-count estimate the previous implementation used.
            units = round(daily_orders.get(d, 0) * 1.3)

        # ── COGS: sum over SKUs of units x unit cost ──
        cogs = 0.0
        for sku, u in units_by_sku.items():
            unit_cost = costs.get(sku)
            if unit_cost is None:
                missing_cost_skus.add(sku)
                unit_cost = avg_cogs
            cogs += u * unit_cost
        if not units_by_sku and has_cogs:
            cogs = units * avg_cogs
        cogs = round(cogs, 2)

        # ── Fees ──
        s = settled.get(d)
        if fee_basis == "settled" and s and s["fees"]:
            referral = s["fees"]      # combined Amazon fees (referral + FBA + other)
            fba = 0.0
            fees_basis = "settled"
        else:
            referral = round(sales * DEFAULT_REFERRAL_PCT, 2)
            fba = round(units * DEFAULT_FBA_FEE_PER_UNIT, 2)
            fees_basis = "estimated"

        contribution = round(sales - referral - fba - ads - cogs, 2)

        account_rows.append({
            "date": d,
            "grain": "account",
            "sku": "",
            "channel": "amazon",
            "gross_sales": sales,
            "units": units,
            "ad_spend": ads,
            "est_referral_fees": referral,
            "est_fba_fees": fba,
            "est_cogs": cogs,
            "est_contribution": contribution,
            # Settlement is a reconciliation check, never the daily grain.
            "amazon_net_proceeds": s["payout"] if s else None,
            "net_after_ads": contribution,
            "status": "reconciled" if s else "preliminary",
            "meta": json.dumps({
                "formula": "gross_sales - referral - fba - ad_spend - cogs",
                "fees_basis": fees_basis,
                "cogs_basis": "sku_units_x_sku_costs" if units_by_sku else "estimated_units",
                # Settlement, recorded for cash reconciliation only. It is
                # posted-date basis and does not tie to the order-date sales
                # above — see the fee_basis note in compute_pnl.
                "settled_payout": s["payout"] if s else None,
                "settled_fees": s["fees"] if s else None,
                "settled_refunds": s["refunds"] if s else None,
            }),
        })

        if not with_skus:
            continue

        # ── SKU grain: same formula, fees estimated per SKU ──
        # Ad spend is campaign-level and not attributable to a SKU, so it all
        # lands in the unallocated bucket; sum(sku) + unallocated == account.
        for sku, u in sorted(units_by_sku.items()):
            unit_cost = costs.get(sku, avg_cogs)
            sku_cogs = round(u * unit_cost, 2)
            sku_sales = round(sales * (u / units), 2) if units else 0.0
            sku_referral = round(sku_sales * DEFAULT_REFERRAL_PCT, 2)
            sku_fba = round(u * DEFAULT_FBA_FEE_PER_UNIT, 2)
            sku_rows.append({
                "date": d, "grain": "sku", "sku": sku, "channel": "amazon",
                "gross_sales": sku_sales, "units": u, "ad_spend": 0,
                "est_referral_fees": sku_referral, "est_fba_fees": sku_fba,
                "est_cogs": sku_cogs,
                "est_contribution": round(sku_sales - sku_referral - sku_fba - sku_cogs, 2),
                "amazon_net_proceeds": None,
                "net_after_ads": round(sku_sales - sku_referral - sku_fba - sku_cogs, 2),
                "status": "preliminary",
                "meta": json.dumps({"fees_basis": "estimated",
                                    "sales_basis": "unit_share_of_account_day"}),
            })

        if ads:
            sku_rows.append({
                "date": d, "grain": "sku", "sku": UNALLOCATED_SKU, "channel": "amazon",
                "gross_sales": 0, "units": 0, "ad_spend": ads,
                "est_referral_fees": 0, "est_fba_fees": 0, "est_cogs": 0,
                "est_contribution": round(-ads, 2),
                "amazon_net_proceeds": None, "net_after_ads": round(-ads, 2),
                "status": "preliminary",
                "meta": json.dumps({"note": "campaign-level ad spend, not attributable to a SKU"}),
            })

    if not account_rows:
        return {"rows": 0, "inserted": 0, "days": 0}

    inserted = upsert_rows("pnl_daily", account_rows, on_conflict="date,grain,sku,channel")
    sku_inserted = 0
    if sku_rows:
        for i in range(0, len(sku_rows), 500):
            sku_inserted += upsert_rows("pnl_daily", sku_rows[i:i + 500],
                                        on_conflict="date,grain,sku,channel")

    total_sales = sum(r["gross_sales"] for r in account_rows)
    total_ads = sum(r["ad_spend"] for r in account_rows)
    total_cogs = sum(r["est_cogs"] for r in account_rows)
    total_fees = sum(r["est_referral_fees"] + r["est_fba_fees"] for r in account_rows)
    total_contribution = sum(r["est_contribution"] for r in account_rows)
    # Fee basis actually used — distinct from `status`, which only says whether
    # settlement data exists for the day's cash reconciliation.
    settled_fee_days = sum(1 for r in account_rows
                           if json.loads(r["meta"]).get("fees_basis") == "settled")
    reconciled_days = sum(1 for r in account_rows if r["status"] == "reconciled")

    if missing_cost_skus:
        log.warning("No sku_costs entry for %d SKUs; used average unit cost: %s",
                    len(missing_cost_skus), sorted(missing_cost_skus)[:8])

    return {
        "rows": len(account_rows),
        "sku_rows": sku_inserted,
        "inserted": inserted,
        "days": len(all_dates),
        "total_sales": round(total_sales, 2),
        "total_fees": round(total_fees, 2),
        "total_ads": round(total_ads, 2),
        "total_cogs": round(total_cogs, 2),
        "total_contribution": round(total_contribution, 2),
        "settled_days": settled_fee_days,
        "estimated_days": len(account_rows) - settled_fee_days,
        "reconciled_days": reconciled_days,
        "fee_basis": fee_basis,
        "has_cogs": has_cogs,
        "missing_cost_skus": sorted(missing_cost_skus),
        "referral_pct": DEFAULT_REFERRAL_PCT,
        "fba_per_unit": DEFAULT_FBA_FEE_PER_UNIT,
    }
