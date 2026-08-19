"""Amazon Finances API — payout and contribution computation.

Uses SP-API Finances v2024-06-19 /transactions endpoint.

Key distinction:
  amazon_payout = charges - Amazon fees - refunds - adjustments
    (what Amazon pays the seller BEFORE seller COGS)
  contribution = amazon_payout - COGS - ad_spend
    (seller's true margin after all costs)

Date basis: postedDate from the Finances API (settlement date,
may lag 1-3 days behind order/shipment date).
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, timedelta

import httpx

from src.amazon_sp.auth import get_access_token
from src.db import upsert_rows, fetch_all

log = logging.getLogger(__name__)

BASE_URL = "https://sellingpartnerapi-na.amazon.com"
FINANCES_PATH = "/finances/2024-06-19/transactions"

# Transaction types that affect payout
PAYOUT_TYPES = {"Shipment", "Refund", "Adjustment", "ServiceFee",
                "FBAInventoryReimbursement"}


def _headers() -> dict[str, str]:
    return {
        "x-amz-access-token": get_access_token(),
        "User-Agent": "SalesTaxAgent/1.0",
    }


def fetch_transactions(start: date, end: date) -> list[dict]:
    """Fetch all financial transactions from start date forward."""
    all_txns: list[dict] = []
    next_token: str | None = None
    params: dict[str, str] = {
        "postedAfter": f"{start.isoformat()}T00:00:00Z",
    }

    for _ in range(100):
        if next_token:
            params["nextToken"] = next_token

        resp = httpx.get(f"{BASE_URL}{FINANCES_PATH}",
                         headers=_headers(), params=params, timeout=20)
        resp.raise_for_status()
        payload = resp.json().get("payload", {})
        txns = payload.get("transactions", [])
        all_txns.extend(txns)

        next_token = payload.get("nextToken")
        if not next_token or not txns:
            break

    # Filter to date range (API returns from start forward)
    end_iso = end.isoformat()
    return [t for t in all_txns
            if t.get("postedDate", "")[:10] <= end_iso]


def aggregate_daily(transactions: list[dict]) -> dict[str, dict]:
    """Aggregate transactions to daily payout components.

    Returns {date: {product_charges, amazon_fees, refund_charges,
                    other_amounts, payout, units}}.
    """
    daily: dict[str, dict] = defaultdict(
        lambda: {"product_charges": 0, "amazon_fees": 0,
                 "refund_charges": 0, "other_amounts": 0,
                 "payout": 0, "units": 0}
    )

    for t in transactions:
        ttype = t.get("transactionType", "")
        if ttype not in PAYOUT_TYPES:
            continue

        posted = t.get("postedDate", "")
        if not posted:
            continue
        day = posted[:10]

        total = float(t.get("totalAmount", {}).get("currencyAmount", 0))
        daily[day]["payout"] += total

        for item in t.get("items", []):
            if ttype == "Shipment":
                daily[day]["units"] += 1
            for b in item.get("breakdowns", []):
                bt = b.get("breakdownType", "")
                amt = float(b.get("breakdownAmount", {}).get("currencyAmount", 0))
                if bt == "ProductCharges":
                    if ttype == "Refund":
                        daily[day]["refund_charges"] += amt  # negative
                    else:
                        daily[day]["product_charges"] += amt
                elif bt == "AmazonFees":
                    daily[day]["amazon_fees"] += amt  # negative for charges, positive for refund fee returns

        # Transactions without items (ServiceFee, etc.) still affect payout via total
        if not t.get("items"):
            daily[day]["other_amounts"] += total

    return dict(daily)


def sync_economics(days: int = 30) -> dict:
    """Fetch Amazon financial transactions and compute daily payout + contribution.

    Formula:
      amazon_payout = sum(transaction totals) for Shipment + Refund + Adjustment + ServiceFee
      contribution = amazon_payout - COGS - ad_spend
    """
    end = date.today()
    start = end - timedelta(days=days)

    log.info("Fetching financial transactions %s to %s", start, end)
    txns = fetch_transactions(start, end)
    daily = aggregate_daily(txns)

    if not daily:
        return {"transactions": len(txns), "days": 0, "inserted": 0}

    # Load ad spend
    try:
        pnl_rows = fetch_all("pnl_daily")
        ad_by_date = {r["date"]: float(r.get("ad_spend", 0) or 0)
                      for r in pnl_rows if r.get("grain") == "account"}
    except Exception:
        ad_by_date = {}

    # Load ad spend from ads_campaigns_daily if pnl doesn't have it
    if not ad_by_date:
        try:
            ads_rows = fetch_all("ads_campaigns_daily")
            for r in ads_rows:
                d = r.get("date", "")
                ad_by_date[d] = ad_by_date.get(d, 0) + float(r.get("spend", 0) or 0)
        except Exception:
            pass

    # Load COGS
    try:
        costs = {r["sku"]: float(r.get("cogs_per_unit", 0) or 0)
                 for r in fetch_all("sku_costs")}
        avg_cogs = sum(costs.values()) / len(costs) if costs else 0
    except Exception:
        avg_cogs = 0

    rows = []
    for day, agg in sorted(daily.items()):
        payout = round(agg["payout"], 2)
        ads = ad_by_date.get(day, 0)
        units = agg["units"]
        cogs = round(units * avg_cogs, 2)
        gross = round(agg["product_charges"], 2)
        fees = round(-agg["amazon_fees"], 2)  # make positive for display
        refunds = round(agg["refund_charges"], 2)
        contribution = round(payout - ads - cogs, 2)

        rows.append({
            "date": day,
            "grain": "account",
            "sku": "",
            "channel": "amazon",
            "gross_sales": gross,
            "units": units,
            "ad_spend": ads,
            "est_referral_fees": fees,  # combined Amazon fees (referral + FBA)
            "est_fba_fees": 0,          # included in est_referral_fees
            "est_cogs": cogs,
            "est_contribution": contribution,
            "amazon_net_proceeds": payout,  # amazon_payout before COGS
            "net_after_ads": contribution,  # payout - COGS - ads
            "status": "reconciled",
            "meta": f'{{"refunds":{refunds},"other":{round(agg["other_amounts"],2)}}}',
        })

    inserted = upsert_rows("pnl_daily", rows,
                           on_conflict="date,grain,sku,channel")

    total_payout = sum(r["amazon_net_proceeds"] for r in rows)
    total_ads = sum(r["ad_spend"] for r in rows)
    total_cogs = sum(r["est_cogs"] for r in rows)
    total_contribution = sum(r["net_after_ads"] for r in rows)

    return {
        "transactions": len(txns),
        "days": len(rows),
        "inserted": inserted,
        "total_payout": round(total_payout, 2),
        "total_ad_spend": round(total_ads, 2),
        "total_cogs": round(total_cogs, 2),
        "total_contribution": round(total_contribution, 2),
    }


def validate_day(target_date: str) -> dict:
    """Print detailed breakdown for a single day for Seller Central comparison."""
    d = date.fromisoformat(target_date)
    txns = fetch_transactions(d, d)

    from collections import Counter
    types = Counter(t.get("transactionType") for t in txns)

    total_product = 0
    total_fees = 0
    total_refund = 0
    total_other = 0
    total_payout = 0
    units = 0

    for t in txns:
        ttype = t.get("transactionType", "")
        total_amt = float(t.get("totalAmount", {}).get("currencyAmount", 0))
        if ttype in PAYOUT_TYPES:
            total_payout += total_amt

        for item in t.get("items", []):
            if ttype == "Shipment":
                units += 1
            for b in item.get("breakdowns", []):
                bt = b.get("breakdownType", "")
                amt = float(b.get("breakdownAmount", {}).get("currencyAmount", 0))
                if bt == "ProductCharges":
                    if ttype == "Refund":
                        total_refund += amt
                    else:
                        total_product += amt
                elif bt == "AmazonFees":
                    total_fees += amt

        if not t.get("items") and ttype in PAYOUT_TYPES:
            total_other += total_amt

    return {
        "date": target_date,
        "date_basis": "postedDate (settlement date, may lag order date 1-3 days)",
        "transaction_types": dict(types),
        "units_shipped": units,
        "product_charges": round(total_product, 2),
        "refund_charges": round(total_refund, 2),
        "amazon_fees": round(total_fees, 2),
        "amazon_fees_display": round(-total_fees, 2),
        "other_adjustments": round(total_other, 2),
        "amazon_payout": round(total_payout, 2),
        "formula": "payout = product_charges + refund_charges + amazon_fees + other_adjustments",
        "compare_to": "Seller Central → Payments → Date Range Report (use posted date, not order date)",
    }
