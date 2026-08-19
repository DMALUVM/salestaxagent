"""Amazon Finances API — net proceeds per transaction.

Uses SP-API Finances v2024-06-19 /transactions endpoint.
Each Shipment transaction has item-level breakdowns:
  ProductCharges (gross sales), AmazonFees (referral+FBA), Tax, total (net proceeds).

Aggregates to daily net proceeds and upserts pnl_daily.amazon_net_proceeds.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

import httpx

from src.amazon_sp.auth import get_access_token
from src.db import upsert_rows

log = logging.getLogger(__name__)

BASE_URL = "https://sellingpartnerapi-na.amazon.com"
FINANCES_PATH = "/finances/2024-06-19/transactions"
PAGE_SIZE = 500


def _headers() -> dict[str, str]:
    return {
        "x-amz-access-token": get_access_token(),
        "User-Agent": "SalesTaxAgent/1.0",
    }


def fetch_transactions(start: date, end: date) -> list[dict]:
    """Fetch all financial transactions in date range."""
    all_txns: list[dict] = []
    next_token: str | None = None

    params: dict[str, str] = {
        "postedAfter": f"{start.isoformat()}T00:00:00Z",
    }

    for _ in range(50):  # max pages
        if next_token:
            params["nextToken"] = next_token

        resp = httpx.get(
            f"{BASE_URL}{FINANCES_PATH}",
            headers=_headers(),
            params=params,
            timeout=20,
        )
        resp.raise_for_status()
        data = resp.json()
        payload = data.get("payload", {})
        txns = payload.get("transactions", [])
        all_txns.extend(txns)

        next_token = payload.get("nextToken")
        if not next_token or not txns:
            break

    return all_txns


def aggregate_daily_net(transactions: list[dict]) -> dict[str, dict]:
    """Aggregate transactions to daily net proceeds.

    Returns {date_iso: {net_proceeds, product_charges, amazon_fees, units}}.
    Only includes Shipment transactions (not Refund, Adjustment, etc.).
    """
    daily: dict[str, dict] = defaultdict(
        lambda: {"net_proceeds": 0, "product_charges": 0, "amazon_fees": 0, "units": 0}
    )

    for t in transactions:
        if t.get("transactionType") not in ("Shipment",):
            continue

        posted = t.get("postedDate", "")
        if not posted:
            continue
        day = posted[:10]  # ISO date

        total = t.get("totalAmount", {}).get("currencyAmount", 0)
        daily[day]["net_proceeds"] += float(total)

        for item in t.get("items", []):
            daily[day]["units"] += 1
            for b in item.get("breakdowns", []):
                bt = b.get("breakdownType", "")
                amt = float(b.get("breakdownAmount", {}).get("currencyAmount", 0))
                if bt == "ProductCharges":
                    daily[day]["product_charges"] += amt
                elif bt == "AmazonFees":
                    daily[day]["amazon_fees"] += amt

    return dict(daily)


def sync_economics(days: int = 30) -> dict:
    """Fetch Amazon financial transactions and update pnl_daily.

    Sets amazon_net_proceeds and status='reconciled' for days with data.
    """
    end = date.today()
    start = end - timedelta(days=days)

    log.info("Fetching financial transactions %s to %s", start, end)
    txns = fetch_transactions(start, end)
    daily = aggregate_daily_net(txns)

    if not daily:
        return {"transactions": len(txns), "days": 0, "inserted": 0}

    # Load ad spend + COGS for net_after_ads
    from src.db import fetch_all
    try:
        pnl_rows = fetch_all("pnl_daily")
        ad_by_date = {r["date"]: float(r.get("ad_spend", 0) or 0)
                      for r in pnl_rows if r.get("grain") == "account"}
    except Exception:
        ad_by_date = {}

    # Load COGS per unit
    try:
        costs = {r["sku"]: float(r.get("cogs_per_unit", 0) or 0)
                 for r in fetch_all("sku_costs")}
        avg_cogs = sum(costs.values()) / len(costs) if costs else 0
    except Exception:
        avg_cogs = 0

    rows = []
    for day, agg in sorted(daily.items()):
        net = round(agg["net_proceeds"], 2)  # Amazon net = sales - referral - FBA
        ads = ad_by_date.get(day, 0)
        units = agg["units"]
        cogs = round(units * avg_cogs, 2)
        # net_after_ads = Amazon net proceeds - ad spend - COGS
        net_after = round(net - ads - cogs, 2)
        rows.append({
            "date": day,
            "grain": "account",
            "sku": "",
            "channel": "amazon",
            "gross_sales": round(agg["product_charges"], 2),
            "units": units,
            "ad_spend": ads,
            "est_referral_fees": round(-agg["amazon_fees"], 2),  # fees are negative in API
            "est_fba_fees": 0,  # included in amazon_fees total
            "est_cogs": cogs,
            "est_contribution": net_after,
            "amazon_net_proceeds": net,
            "net_after_ads": net_after,
            "status": "reconciled",
        })

    inserted = upsert_rows("pnl_daily", rows,
                           on_conflict="date,grain,sku,channel")

    total_net = sum(r["amazon_net_proceeds"] for r in rows)
    total_ads = sum(r["ad_spend"] for r in rows)

    return {
        "transactions": len(txns),
        "days": len(rows),
        "inserted": inserted,
        "total_net_proceeds": round(total_net, 2),
        "total_ad_spend": round(total_ads, 2),
        "net_after_ads": round(total_net - total_ads, 2),
    }
