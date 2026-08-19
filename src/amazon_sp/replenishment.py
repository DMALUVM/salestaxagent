"""Amazon Replenishment API (Subscribe & Save) client.

Uses SP-API v2022-11-07 Replenishment endpoints:
  - POST /sellingPartners/metrics/search — seller-level weekly aggregates
  - POST /offers/metrics/search — per-ASIN weekly metrics (single week)
"""
from __future__ import annotations

import logging
from datetime import date, timedelta, timezone

import httpx

from src.amazon_sp.auth import get_access_token
from src.db import upsert_rows

log = logging.getLogger(__name__)

BASE_URL = "https://sellingpartnerapi-na.amazon.com"
REPLENISHMENT_PATH = "/replenishment/2022-11-07"
MARKETPLACE_ID = "ATVPDKIKX0DER"
MAX_WEEKS_PER_CALL = 52  # API seems to accept ~2 years but chunk to be safe


def _headers() -> dict[str, str]:
    return {
        "x-amz-access-token": get_access_token(),
        "Content-Type": "application/json",
        "User-Agent": "SalesTaxAgent/1.0",
    }


def _last_complete_saturday(ref: date) -> date:
    """Find the Saturday ending the most recent complete week before ref."""
    # weekday(): Mon=0 ... Sun=6.  Saturday=5.
    days_since_sat = (ref.weekday() + 2) % 7
    if days_since_sat == 0:
        days_since_sat = 7  # if today is Saturday, prior week
    return ref - timedelta(days=days_since_sat)


def _is_partial_week(week_start: str, week_end: str) -> bool:
    """True if the week span is less than 7 days (partial/current week)."""
    try:
        s = date.fromisoformat(week_start[:10])
        e = date.fromisoformat(week_end[:10])
        return (e - s).days < 6
    except (ValueError, TypeError):
        return False


def _parse_seller_row(m: dict) -> dict | None:
    """Parse one seller metrics row from API response."""
    ti = m.get("timeInterval", {})
    if not ti.get("startDate"):
        return None
    if "activeSubscriptions" not in m:
        return None  # lifetime-value row, skip

    ws = ti["startDate"][:10]
    we = ti["endDate"][:10]

    return {
        "week_start": ws,
        "week_end": we,
        "active_subscriptions": int(m.get("activeSubscriptions", 0)),
        "shipped_units": int(m.get("shippedSubscriptionUnits", 0)),
        "total_revenue": float(m.get("totalSubscriptionsRevenue", 0)),
        "revenue_penetration": float(m.get("revenuePenetration", 0)),
        "not_delivered_oos": int(m.get("notDeliveredDueToOOS", 0)),
        "lost_revenue_oos": float(m.get("lostRevenueDueToOOS", 0)),
        "coupon_share": float(m.get("shareOfCouponSubscriptions", 0)),
        "currency": m.get("currencyCode", "USD"),
    }


def fetch_seller_metrics(
    weeks: int | None = None,
    start_date: str | None = None,
    dry_run: bool = False,
) -> dict:
    """Fetch seller-level SnS metrics.

    Args:
        weeks: number of weeks back (default 13)
        start_date: ISO date to start from (overrides weeks)
        dry_run: don't write to DB
    """
    today = date.today()

    if start_date:
        start = date.fromisoformat(start_date)
    else:
        start = today - timedelta(weeks=weeks or 13)

    all_rows: list[dict] = []

    # Chunk into ≤52-week segments to avoid API limits
    cursor = start
    while cursor < today:
        chunk_end = min(cursor + timedelta(weeks=MAX_WEEKS_PER_CALL), today)

        body = {
            "timePeriodType": "PERFORMANCE",
            "timeInterval": {
                "startDate": cursor.isoformat(),
                "endDate": chunk_end.isoformat(),
            },
            "marketplaceId": MARKETPLACE_ID,
            "programTypes": ["SUBSCRIBE_AND_SAVE"],
            "aggregationFrequency": "WEEK",
        }

        resp = httpx.post(
            f"{BASE_URL}{REPLENISHMENT_PATH}/sellingPartners/metrics/search",
            headers=_headers(), json=body, timeout=30,
        )
        if resp.status_code == 403:
            raise PermissionError(
                "Replenishment API role required. In Seller Central → "
                "Apps → Manage apps → authorize the Replenishment role."
            )
        resp.raise_for_status()

        for m in resp.json().get("metrics", []):
            row = _parse_seller_row(m)
            if row:
                all_rows.append(row)

        cursor = chunk_end

    # Deduplicate on week_start (API chunks may overlap)
    seen: dict[str, dict] = {}
    for r in all_rows:
        seen[r["week_start"]] = r
    all_rows = sorted(seen.values(), key=lambda r: r["week_start"])

    # Find latest COMPLETE week (not partial) for the summary
    complete = [r for r in all_rows if not _is_partial_week(r["week_start"], r["week_end"])]
    latest = complete[-1] if complete else (all_rows[-1] if all_rows else None)

    summary = {
        "weeks_fetched": len(all_rows),
        "complete_weeks": len(complete),
        "latest_subs": latest["active_subscriptions"] if latest else 0,
        "latest_shipped": latest["shipped_units"] if latest else 0,
        "latest_revenue": latest["total_revenue"] if latest else 0,
        "latest_week": latest["week_start"] if latest else None,
        "dry_run": dry_run,
        "rows_inserted": 0,
    }

    if dry_run or not all_rows:
        return summary

    inserted = upsert_rows("sns_seller_metrics", all_rows, on_conflict="week_start")
    summary["rows_inserted"] = inserted
    return summary


def fetch_offer_metrics(dry_run: bool = False) -> dict:
    """Fetch per-ASIN SnS metrics for the most recent complete week."""
    last_sat = _last_complete_saturday(date.today())
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
        return summary

    inserted = upsert_rows("sns_offer_metrics", rows, on_conflict="asin,week_start")
    summary["rows_inserted"] = inserted
    return summary
