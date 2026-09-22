"""Paid-ads / GSC freshness nudge.

Google / Meta / GA4 CSV age still uses the Monday /paid-ads upload path.
Search Console prefers official API tables (`gsc_query_daily` /
`gsc_page_daily` from daily `gsc-sync`). Stale/fail only — never an
all-good Telegram.

Read-only. Never writes warehouse rows.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta

from src.db import get_client

log = logging.getLogger(__name__)

# Matches STALE_AFTER_DAYS in dashboard/src/lib/paid-intel/window.ts.
STALE_AFTER_DAYS = 7

# GSC final data lags ~2 days. Fault when max(metric_date) is more than
# this many calendar days behind the America/New_York prior day.
GSC_STALE_BEHIND_PRIOR_DAY = 4
GSC_API_FILE = "gsc-sync → gsc_query_daily + gsc_page_daily"

# CSV sources only. Search Console is resolved separately (API first).
SOURCES: list[tuple[str, str, str, dict]] = [
    ("Google Ads", "Google Ads Daily (Campaign x Day)",
     "paid_campaign_daily", {"platform": "google"}),
    ("Meta Ads", "Ads Manager campaign export",
     "paid_campaign_daily", {"platform": "meta"}),
    ("GA4", "GA4 Explore (Free form)", "paid_ga_daily", {}),
]


def _max_date(table: str, filters: dict | None = None,
              date_col: str = "date") -> str | None:
    """Newest date column in a table, or None when empty / table absent."""
    try:
        query = get_client().table(table).select(date_col)
        for key, value in (filters or {}).items():
            query = query.eq(key, value)
        result = (
            query.neq(date_col, "")
            .order(date_col, desc=True)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        if not rows:
            return None
        raw = rows[0].get(date_col)
        return str(raw)[:10] if raw else None
    except Exception as e:
        log.warning("paid freshness: %s %s unreadable: %s", table, filters, str(e)[:200])
        return None


def _days_behind(iso_date: str, today: date) -> int | None:
    try:
        return (today - datetime.strptime(iso_date, "%Y-%m-%d").date()).days
    except ValueError:
        return None


def gsc_stale_vs_prior(max_date: str | None, prior: date) -> bool:
    """True when API max(metric_date) is >4 calendar days behind prior NY day."""
    if not max_date:
        return False
    behind = _days_behind(max_date, prior)
    return behind is not None and behind > GSC_STALE_BEHIND_PRIOR_DAY


def _newer(*dates: str | None) -> str | None:
    present = [d for d in dates if d]
    return max(present) if present else None


def gsc_freshness_source(today: date, *,
                         api_max: str | None,
                         csv_max: str | None) -> dict:
    """Prefer gsc_*_daily. CSV chart is fallback only when API has no dates."""
    prior_day = today - timedelta(days=1)
    if api_max:
        behind = _days_behind(api_max, today)
        return {
            "label": "Search Console",
            "file": GSC_API_FILE,
            "max_date": api_max,
            "days_behind": behind,
            "stale": gsc_stale_vs_prior(api_max, prior_day),
            "missing": False,
            "origin": "api",
        }
    behind = _days_behind(csv_max, today) if csv_max else None
    return {
        "label": "Search Console",
        "file": "Queries.csv + Pages.csv + Chart.csv",
        "max_date": csv_max,
        "days_behind": behind,
        "stale": behind is not None and behind >= STALE_AFTER_DAYS,
        "missing": csv_max is None,
        "origin": "csv",
    }


def check_paid_ads_freshness(today: date | None = None) -> dict:
    """Return each source's age. Pure read — safe to call any time."""
    from src.rules import agent_today

    today = today or agent_today()
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
            "origin": "csv",
        })
    api_max = _newer(
        _max_date("gsc_query_daily", date_col="metric_date"),
        _max_date("gsc_page_daily", date_col="metric_date"),
    )
    csv_max = _max_date("paid_search_query_daily", {"kind": "chart"})
    sources.append(gsc_freshness_source(today, api_max=api_max, csv_max=csv_max))
    stale = [s for s in sources if s["stale"]]
    return {
        "today": today.isoformat(),
        "sources": sources,
        "stale": stale,
        "stale_count": len(stale),
    }


def build_message(result: dict) -> str | None:
    """Telegram body, or None when nothing needs a fault ping."""
    stale = result.get("stale") or []
    if not stale:
        return None
    api_stale = [s for s in stale if s.get("origin") == "api"]
    csv_stale = [s for s in stale if s.get("origin") != "api"]
    if api_stale and not csv_stale:
        lines = [
            "<b>Search Console data is stale</b>",
            "gsc-sync / gsc_*_daily is behind expected lag. Not an all-good ping.",
            "",
        ]
    elif api_stale:
        lines = [
            "<b>Paid Ads data is stale</b>",
            "Upload a fresh export at /paid-ads, or check Mini gsc-sync if Search Console is listed.",
            "",
        ]
    else:
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
        sent = send_telegram(message, topic="paid_ads_freshness")
        print(f"[Paid Ads Freshness] {result['stale_count']} stale source(s), "
              f"telegram sent={sent.get('sent')}")
        job_finish(run_id, "success", f"{result['stale_count']} stale",
                   {"stale": result["stale_count"]})
        return {**result, "sent": bool(sent.get("sent"))}
    except Exception as e:
        print(f"[Paid Ads Freshness] error: {e}")
        job_finish(run_id, "failed", str(e)[:500])
        return {"error": str(e), "sent": False}
