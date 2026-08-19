"""Amazon Ads report definitions, fetchers, and Supabase upsert.

Uses Reporting v3 API with GZIP_JSON format.
All requests chunked to ≤30 days (API max is 31).
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

from src.amazon_ads.client import fetch_report, SEARCH_TERM_TIMEOUT
from src.db import upsert_rows
from src.rules import ADS_MAX_CHUNK_DAYS

log = logging.getLogger(__name__)

MAX_CHUNK_DAYS = ADS_MAX_CHUNK_DAYS


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


def _date_chunks(start: date, end: date) -> list[tuple[date, date]]:
    """Split a date range into ≤MAX_CHUNK_DAYS chunks."""
    chunks = []
    cursor = start
    while cursor <= end:
        chunk_end = min(cursor + timedelta(days=MAX_CHUNK_DAYS - 1), end)
        chunks.append((cursor, chunk_end))
        cursor = chunk_end + timedelta(days=1)
    return chunks


# ── Campaign daily (single chunk) ──

def _fetch_campaigns_chunk(start: date, end: date) -> list[dict]:
    """Fetch SP campaign daily metrics for a ≤30-day range."""
    config = {
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
    return fetch_report(config)


def _fetch_search_terms_chunk(start: date, end: date) -> list[dict]:
    """Fetch SP search term report for a ≤30-day range.

    Uses SEARCH_TERM_TIMEOUT (90 min) — these reports are much larger
    than campaign reports and routinely exceed 30 minutes.
    """
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
    return fetch_report(config, timeout=SEARCH_TERM_TIMEOUT)


# ── Chunked fetchers ──

def fetch_campaigns_daily(start: date, end: date) -> dict:
    """Fetch SP campaign daily metrics, auto-chunked to ≤30 days."""
    chunks = _date_chunks(start, end)
    all_parsed: list[dict] = []
    errors: list[str] = []

    for i, (cs, ce) in enumerate(chunks, 1):
        log.info("Campaigns chunk %d/%d: %s → %s", i, len(chunks), cs, ce)
        try:
            rows = _fetch_campaigns_chunk(cs, ce)
            for r in rows:
                m = _metrics(r)
                all_parsed.append({
                    "date": r.get("date", cs.isoformat()),
                    "campaign_id": str(r.get("campaignId", "")),
                    "campaign_name": r.get("campaignName", ""),
                    "campaign_type": "SP",
                    "campaign_status": r.get("campaignStatus", ""),
                    "budget": _safe(r.get("campaignBudgetAmount")),
                    **m,
                })
        except Exception as e:
            msg = f"Chunk {i} ({cs}→{ce}): {str(e)[:120]}"
            log.warning("Campaign %s", msg)
            errors.append(msg)

    inserted = 0
    if all_parsed:
        inserted = upsert_rows("ads_campaigns_daily", all_parsed,
                               on_conflict="date,campaign_id")

    total_spend = sum(r["spend"] for r in all_parsed)
    return {
        "rows": len(all_parsed), "inserted": inserted, "chunks": len(chunks),
        "errors": errors, "total_spend": round(total_spend, 2),
        "date_min": all_parsed[0]["date"] if all_parsed else None,
        "date_max": all_parsed[-1]["date"] if all_parsed else None,
    }


def fetch_search_terms(start: date, end: date) -> dict:
    """Fetch SP search term report, auto-chunked to ≤30 days.

    Retries each failed chunk once before recording the error.
    """
    chunks = _date_chunks(start, end)
    all_parsed: list[dict] = []
    errors: list[str] = []

    for i, (cs, ce) in enumerate(chunks, 1):
        log.info("Search terms chunk %d/%d: %s → %s", i, len(chunks), cs, ce)
        rows = None
        last_err = None
        for attempt in range(2):  # try + retry once
            try:
                rows = _fetch_search_terms_chunk(cs, ce)
                break
            except Exception as e:
                last_err = e
                if attempt == 0:
                    log.warning("Search terms chunk %d failed (attempt 1), retrying: %s",
                                i, str(e)[:120])

        if rows is None:
            msg = f"Chunk {i} ({cs}→{ce}): {str(last_err)[:120]}"
            log.warning("Search terms %s (gave up after retry)", msg)
            errors.append(msg)
            continue

        for r in rows:
            m = _metrics(r)
            all_parsed.append({
                "date": cs.isoformat(),
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

    inserted = 0
    if all_parsed:
        # Deduplicate on key
        seen: dict[tuple, dict] = {}
        for p in all_parsed:
            key = (p["date"], p["search_term"], p["campaign_id"], p["ad_group_id"])
            seen[key] = p
        deduped = list(seen.values())
        inserted = upsert_rows("ads_search_terms_daily", deduped,
                               on_conflict="date,search_term,campaign_id,ad_group_id")

    return {
        "rows": len(all_parsed), "inserted": inserted, "chunks": len(chunks),
        "errors": errors,
    }


# ── Full sync ──

def sync_ads(days: int = 14) -> dict:
    """Full ads sync: campaigns + search terms, auto-chunked.

    All ranges chunked to ≤30 days per API call.
    Safe to call with --days 90 or higher.
    """
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=days - 1)

    results: dict = {"start": start.isoformat(), "end": end.isoformat()}

    log.info("Ads sync: %s → %s (%d days)", start, end, days)

    try:
        results["campaigns"] = fetch_campaigns_daily(start, end)
    except Exception as e:
        results["campaigns"] = {"error": str(e)[:200]}

    try:
        results["search_terms"] = fetch_search_terms(start, end)
    except Exception as e:
        results["search_terms"] = {"error": str(e)[:200]}

    return results
