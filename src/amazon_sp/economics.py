"""Amazon Finances API — settlement data and fee detail.

Uses SP-API Finances v2024-06-19 /transactions endpoint.

  amazon_payout = charges - Amazon fees - refunds - adjustments
    (the cash Amazon deposits, BEFORE seller COGS and ad spend)

Payout is a RECONCILIATION CHECK, not a daily margin. Amazon settles roughly
twice a month on a posted-date basis, so a deposit cannot express one day's
operating result. Daily contribution lives in src.pnl and is always:

  contribution = gross_sales - referral - fba - ad_spend - cogs

What this module contributes to that: settled Amazon fees per posted date
(better than the referral/FBA estimate) and the payout figure for cash
reconciliation.

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
    """Refresh the daily P&L, including Amazon settlement data.

    Settlement is a RECONCILIATION CHECK, not the daily grain: Amazon deposits
    roughly twice a month on a posted-date basis, so a payout cannot express a
    single day's operating margin. Daily contribution is owned by
    src.pnl.compute_pnl and is always:

        gross_sales - referral - fba - ad_spend - cogs

    This entry point exists so `economics-sync` keeps working; it delegates the
    write so pnl_daily has exactly one writer and no job can overwrite part of a
    row with stale values. The payout it fetches lands in `amazon_net_proceeds`
    for cash reconciliation.
    """
    from src.pnl import compute_pnl

    end = date.today()
    start = end - timedelta(days=days)
    log.info("Fetching financial transactions %s to %s", start, end)
    txns = fetch_transactions(start, end)
    daily = aggregate_daily(txns)

    result = compute_pnl(days=days)

    total_payout = sum(a["payout"] for a in daily.values())
    return {
        "transactions": len(txns),
        "days": result.get("days", 0),
        "inserted": result.get("inserted", 0),
        "total_payout": round(total_payout, 2),
        "total_sales": result.get("total_sales", 0),
        "total_fees": result.get("total_fees", 0),
        "total_ad_spend": result.get("total_ads", 0),
        "total_cogs": result.get("total_cogs", 0),
        "total_contribution": result.get("total_contribution", 0),
        "settled_days": result.get("settled_days", 0),
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
