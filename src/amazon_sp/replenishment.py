"""Amazon Replenishment API (Subscribe & Save) client.

Uses SP-API v2022-11-07 Replenishment endpoints:
  - POST /sellingPartners/metrics/search — seller-level weekly aggregates
  - POST /offers/metrics/search — per-ASIN weekly metrics

Metrics: activeSubscriptions, shippedSubscriptionUnits,
totalSubscriptionsRevenue, revenuePenetration, notDeliveredDueToOOS,
lostRevenueDueToOOS, shareOfCouponSubscriptions.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone

import httpx

from src.amazon_sp.auth import get_access_token
from src.db import upsert_rows

log = logging.getLogger(__name__)

BASE_URL = "https://sellingpartnerapi-na.amazon.com"
REPLENISHMENT_PATH = "/replenishment/2022-11-07"
MARKETPLACE_ID = "ATVPDKIKX0DER"


def _headers() -> dict[str, str]:
    return {
        "x-amz-access-token": get_access_token(),
        "Content-Type": "application/json",
        "User-Agent": "SalesTaxAgent/1.0",
    }


def _week_boundaries(ref: date) -> list[tuple[str, str]]:
    """Generate Sun→Sat week boundaries for the 13 weeks ending before ref."""
    # Find the most recent Saturday before ref
    days_since_sat = (ref.weekday() + 2) % 7
    if days_since_sat == 0:
        days_since_sat = 7  # if ref is Saturday, go to prior week
    last_sat = ref - timedelta(days=days_since_sat)

    weeks: list[tuple[str, str]] = []
    for i in range(13):
        end_sat = last_sat - timedelta(weeks=i)
        start_sun = end_sat - timedelta(days=6)
        weeks.append((start_sun.isoformat(), end_sat.isoformat()))
    return list(reversed(weeks))


def fetch_seller_metrics(weeks: int = 13, dry_run: bool = False) -> dict:
    """Fetch seller-level SnS metrics for the last N weeks."""
    today = date.today()
    start = today - timedelta(weeks=weeks)

    body = {
        "timePeriodType": "PERFORMANCE",
        "timeInterval": {
            "startDate": start.isoformat(),
            "endDate": today.isoformat(),
        },
        "marketplaceId": MARKETPLACE_ID,
        "programTypes": ["SUBSCRIBE_AND_SAVE"],
        "aggregationFrequency": "WEEK",
    }

    resp = httpx.post(
        f"{BASE_URL}{REPLENISHMENT_PATH}/sellingPartners/metrics/search",
        headers=_headers(), json=body, timeout=20,
    )

    if resp.status_code == 403:
        raise PermissionError(
            "Replenishment API role required. In Seller Central → "
            "Apps → Manage apps → authorize the Replenishment role."
        )
    resp.raise_for_status()
    data = resp.json()

    rows: list[dict] = []
    for m in data.get("metrics", []):
        ti = m.get("timeInterval", {})
        if not ti.get("startDate"):
            continue
        # Skip lifetime-value rows (no activeSubscriptions)
        if "activeSubscriptions" not in m:
            continue
        rows.append({
            "week_start": ti["startDate"][:10],
            "week_end": ti["endDate"][:10],
            "active_subscriptions": int(m.get("activeSubscriptions", 0)),
            "shipped_units": int(m.get("shippedSubscriptionUnits", 0)),
            "total_revenue": float(m.get("totalSubscriptionsRevenue", 0)),
            "revenue_penetration": float(m.get("revenuePenetration", 0)),
            "not_delivered_oos": int(m.get("notDeliveredDueToOOS", 0)),
            "lost_revenue_oos": float(m.get("lostRevenueDueToOOS", 0)),
            "coupon_share": float(m.get("shareOfCouponSubscriptions", 0)),
            "currency": m.get("currencyCode", "USD"),
        })

    summary = {
        "weeks_fetched": len(rows),
        "latest_subs": rows[-1]["active_subscriptions"] if rows else 0,
        "dry_run": dry_run,
        "rows_inserted": 0,
    }

    if dry_run or not rows:
        summary["rows"] = rows
        return summary

    inserted = upsert_rows("sns_seller_metrics", rows, on_conflict="week_start")
    summary["rows_inserted"] = inserted
    return summary


def fetch_offer_metrics(dry_run: bool = False) -> dict:
    """Fetch per-ASIN SnS metrics for the most recent complete week."""
    today = date.today()
    days_since_sat = (today.weekday() + 2) % 7
    if days_since_sat == 0:
        days_since_sat = 7
    last_sat = today - timedelta(days=days_since_sat)
    last_sun = last_sat - timedelta(days=6)

    body = {
        "filters": {
            "timePeriodType": "PERFORMANCE",
            "timeInterval": {
                "startDate": last_sun.isoformat(),
                "endDate": last_sat.isoformat(),
            },
            "marketplaceId": MARKETPLACE_ID,
            "programTypes": ["SUBSCRIBE_AND_SAVE"],
            "aggregationFrequency": "WEEK",
        },
        "pagination": {"limit": 50, "offset": 0},
        "sort": {"order": "DESC", "key": "SHIPPED_SUBSCRIPTION_UNITS"},
    }

    resp = httpx.post(
        f"{BASE_URL}{REPLENISHMENT_PATH}/offers/metrics/search",
        headers=_headers(), json=body, timeout=20,
    )

    if resp.status_code == 403:
        raise PermissionError("Replenishment API role required.")
    resp.raise_for_status()
    data = resp.json()

    rows: list[dict] = []
    for o in data.get("offers", []):
        ti = o.get("timeInterval", {})
        rows.append({
            "asin": o.get("asin", ""),
            "sku": o.get("sku") or None,
            "week_start": ti.get("startDate", last_sun.isoformat())[:10],
            "week_end": ti.get("endDate", last_sat.isoformat())[:10],
            "active_subscriptions": int(o.get("activeSubscriptions", 0)),
            "shipped_units": int(o.get("shippedSubscriptionUnits", 0)),
            "total_revenue": float(o.get("totalSubscriptionsRevenue", 0)),
            "revenue_penetration": float(o.get("revenuePenetration", 0)),
            "not_delivered_oos": int(o.get("notDeliveredDueToOOS", 0)),
            "lost_revenue_oos": float(o.get("lostRevenueDueToOOS", 0)),
            "coupon_share": float(o.get("shareOfCouponSubscriptions", 0)),
            "currency": o.get("currencyCode", "USD"),
        })

    summary = {
        "offers_fetched": len(rows),
        "week": f"{last_sun.isoformat()} to {last_sat.isoformat()}",
        "dry_run": dry_run,
        "rows_inserted": 0,
    }

    if dry_run or not rows:
        summary["rows"] = rows
        return summary

    inserted = upsert_rows("sns_offer_metrics", rows, on_conflict="asin,week_start")
    summary["rows_inserted"] = inserted
    return summary
