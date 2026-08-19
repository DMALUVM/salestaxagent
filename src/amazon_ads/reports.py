"""Amazon Ads report definitions, fetchers, and Supabase upsert.

Uses Reporting v3 API with GZIP_JSON format.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from src.amazon_ads.client import fetch_report
from src.db import upsert_rows

log = logging.getLogger(__name__)


def _safe(v, default=0):
    try:
        return float(v) if v is not None else default
    except (ValueError, TypeError):
        return default


def _metrics(r: dict) -> dict:
    """Extract common metrics from a report row (v3 column names)."""
    spend = _safe(r.get("spend"))
    sales = _safe(r.get("sales14d") or r.get("sales"))
    orders = _safe(r.get("purchases14d") or r.get("unitsSoldClicks14d") or r.get("orders"))
    clicks = _safe(r.get("clicks"))
    impressions = _safe(r.get("impressions"))
    return {
        "spend": round(spend, 2),
        "sales_14d": round(sales, 2),
        "orders_14d": int(orders),
        "clicks": int(clicks),
        "impressions": int(impressions),
        "cpc": round(spend / clicks, 2) if clicks > 0 else 0,
        "acos": round(spend / sales * 100, 1) if sales > 0 else 0,
        "roas": round(sales / spend, 2) if spend > 0 else 0,
        "ctr": round(clicks / impressions * 100, 2) if impressions > 0 else 0,
        "cvr": round(orders / clicks * 100, 2) if clicks > 0 else 0,
    }


# ── Campaign daily ──

def fetch_campaigns_daily(start: date, end: date) -> dict:
    """Fetch SP campaign daily metrics."""
    config = {
        "reportDate": None,
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "configuration": {
            "adProduct": "SPONSORED_PRODUCTS",
            "groupBy": ["campaign"],
            "columns": [
                "date", "campaignName", "campaignId", "campaignStatus",
                "campaignBudgetAmount", "campaignBudgetType",
                "impressions", "clicks", "spend",
                "sales14d", "purchases14d",
            ],
            "reportTypeId": "spCampaigns",
            "timeUnit": "DAILY",
            "format": "GZIP_JSON",
        },
    }

    rows = fetch_report(config)
    parsed = []
    for r in rows:
        m = _metrics(r)
        parsed.append({
            "date": r.get("date", start.isoformat()),
            "campaign_id": str(r.get("campaignId", "")),
            "campaign_name": r.get("campaignName", ""),
            "campaign_type": "SP",
            "campaign_status": r.get("campaignStatus", ""),
            "budget": _safe(r.get("campaignBudgetAmount")),
            **m,
        })

    if parsed:
        inserted = upsert_rows("ads_campaigns_daily", parsed,
                               on_conflict="date,campaign_id")
    else:
        inserted = 0

    return {"rows": len(parsed), "inserted": inserted}


# ── Search terms daily ──

def fetch_search_terms(start: date, end: date) -> dict:
    """Fetch SP search term report. Max 31 days per call."""
    config = {
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "configuration": {
            "adProduct": "SPONSORED_PRODUCTS",
            "groupBy": ["searchTerm"],
            "columns": [
                "searchTerm",
                "campaignName", "campaignId",
                "adGroupName", "adGroupId",
                "keyword", "keywordId", "matchType",
                "impressions", "clicks", "spend",
                "sales14d", "purchases14d",
            ],
            "reportTypeId": "spSearchTerm",
            "timeUnit": "SUMMARY",
            "format": "GZIP_JSON",
        },
    }

    rows = fetch_report(config)
    parsed = []
    for r in rows:
        m = _metrics(r)
        parsed.append({
            "date": start.isoformat(),
            "search_term": r.get("searchTerm", ""),
            "campaign_id": str(r.get("campaignId", "")),
            "campaign_name": r.get("campaignName", ""),
            "ad_group_id": str(r.get("adGroupId", "")),
            "ad_group_name": r.get("adGroupName", ""),
            "keyword": r.get("keyword", ""),
            "keyword_id": str(r.get("keywordId", "")),
            "match_type": r.get("matchType", ""),
            **m,
        })

    if parsed:
        # Deduplicate on key
        seen = {}
        for p in parsed:
            key = (p["date"], p["search_term"], p["campaign_id"], p["ad_group_id"])
            seen[key] = p
        parsed = list(seen.values())
        inserted = upsert_rows("ads_search_terms_daily", parsed,
                               on_conflict="date,search_term,campaign_id,ad_group_id")
    else:
        inserted = 0

    return {"rows": len(parsed), "inserted": inserted}


# ── Full sync ──

def sync_ads(days: int = 14) -> dict:
    """Full ads sync: campaigns + search terms."""
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=days - 1)

    results = {}
    try:
        results["campaigns"] = fetch_campaigns_daily(start, end)
    except Exception as e:
        results["campaigns"] = {"error": str(e)[:200]}

    # Search terms: chunk to 31 days max
    try:
        results["search_terms"] = fetch_search_terms(start, end)
    except Exception as e:
        results["search_terms"] = {"error": str(e)[:200]}

    return results
