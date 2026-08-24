"""Paid-ads CSV freshness nudge.

The Shopify Paid Ads desk (`/paid-ads`) is fed by manual CSV exports, not an
API. Its staleness banner only exists once you open the page, which is exactly
when you no longer need reminding. This job reads the warehouse the dashboard
reads and pings Telegram when an export has gone quiet.

Read-only. Never writes to the paid_* tables.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta

from src.db import get_client

log = logging.getLogger(__name__)

# Matches STALE_AFTER_DAYS in dashboard/src/lib/paid-intel/window.ts.
STALE_AFTER_DAYS = 7

# Each source: (label, what to re-export, table, equality filters)
SOURCES: list[tuple[str, str, str, dict]] = [
    ("Google Ads", "Google Ads Daily (Campaign x Day)",
     "paid_campaign_daily", {"platform": "google"}),
    ("Meta Ads", "Ads Manager campaign export",
     "paid_campaign_daily", {"platform": "meta"}),
    ("GA4", "GA4 Explore (Free form)", "paid_ga_daily", {}),
    ("Search Console", "Queries.csv + Pages.csv + Chart.csv",
     "paid_search_query_daily", {"kind": "chart"}),
]


def _max_date(table: str, filters: dict) -> str | None:
    """Newest `date` in a table, or None when empty / table absent."""
    try:
        query = get_client().table(table).select("date")
        for key, value in filters.items():
            query = query.eq(key, value)
        result = (
            query.neq("date", "")
            .order("date", desc=True)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        return rows[0].get("date") if rows else None
    except Exception as e:
        log.warning("paid freshness: %s %s unreadable: %s", table, filters, str(e)[:200])
        return None


def _days_behind(iso_date: str, today: date) -> int | None:
    try:
        return (today - datetime.strptime(iso_date, "%Y-%m-%d").date()).days
    except ValueError:
        return None


def check_paid_ads_freshness(today: date | None = None) -> dict:
    """Return each source's age. Pure read — safe to call any time."""
    today = today or datetime.now().date()
    sources = []
    for label, file_hint, table, filters in SOURCES:
        newest = _max_date(table, filters)
        behind = _days_behind(newest, today) if newest else None
        sources.append({
            "label": label,
            "file": file_hint,
            "max_date": newest,
            "days_behind": behind,
            # A source that was never uploaded is not "stale" — it is absent,
            # and nagging about a channel the business does not run is noise.
            "stale": behind is not None and behind >= STALE_AFTER_DAYS,
            "missing": newest is None,
        })
    stale = [s for s in sources if s["stale"]]
    return {
        "today": today.isoformat(),
        "sources": sources,
        "stale": stale,
        "stale_count": len(stale),
    }


def build_message(result: dict) -> str | None:
    """Telegram body, or None when nothing needs uploading."""
    stale = result.get("stale") or []
    if not stale:
        return None
    lines = [
        "<b>Paid Ads data is stale</b>",
        "Upload a fresh export at /paid-ads — the intel below is dated.",
        "",
    ]
    for s in sorted(stale, key=lambda x: -(x["days_behind"] or 0)):
        lines.append(
            f"- {s['label']}: newest {s['max_date']} ({s['days_behind']}d old) "
            f"-> {s['file']}"
        )
    fresh = [
        s for s in result.get("sources", [])
        if not s["stale"] and not s["missing"]
    ]
    if fresh:
        lines.append("")
        lines.append(
            "Current: " + ", ".join(f"{s['label']} {s['max_date']}" for s in fresh)
        )
    return "\n".join(lines)


def run_paid_ads_freshness_check(today: date | None = None) -> dict:
    """Check freshness and alert once per week when something has gone quiet."""
    from src.db import job_finish, job_start

    run_id = job_start("paid_ads_freshness")
    try:
        result = check_paid_ads_freshness(today)
        message = build_message(result)
        if not message:
            newest = ", ".join(
                f"{s['label']} {s['max_date']}"
                for s in result["sources"] if s["max_date"]
            )
            print(f"[Paid Ads Freshness] All sources current ({newest})")
            job_finish(run_id, "success", "all current", {"stale": 0})
            return {**result, "sent": False}

        from src.alerts.telegram import send_telegram
        sent = send_telegram(message)
        print(f"[Paid Ads Freshness] {result['stale_count']} stale source(s), "
              f"telegram sent={sent.get('sent')}")
        job_finish(run_id, "success", f"{result['stale_count']} stale",
                   {"stale": result["stale_count"]})
        return {**result, "sent": bool(sent.get("sent"))}
    except Exception as e:
        print(f"[Paid Ads Freshness] error: {e}")
        job_finish(run_id, "failed", str(e)[:500])
        return {"error": str(e), "sent": False}
