"""Morning daily digest — MTD sales totals by channel + next filing info.

Designed to run once per day via scheduler.  Reads sales_by_state and
nexus_status, computes month-to-date totals, and sends a Telegram
message with the summary.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Optional

from src.channels import SHOPIFY, AMAZON, normalize_channel
from src.db import fetch_all
from src.alerts.telegram import send_telegram


# ── Helpers ────────────────────────────────────────────────


def _month_start(ref: date) -> str:
    """Return ISO date string for the first day of the month."""
    return ref.replace(day=1).isoformat()


# NOTE: _compute_next_due() was removed here. It derived a synthetic "next
# due" from last_filed_through + frequency, which was a second source of truth
# alongside filing_calendar. It disagreed with the dashboard and reported any
# state with an old last_filed_through as permanently OVERDUE. Filing lines now
# come from src/alerts/digest_sections.py, which uses the same eligibility
# rules as the dashboard chips and the filing-audit CLI.


def build_digest_message(ref_date: date | None = None) -> str | None:
    """Build an HTML digest message with MTD sales and next filing info.

    Returns None if there is no data to report.
    """
    ref = ref_date or date.today()
    month_start = _month_start(ref)
    month_label = ref.strftime("%B %Y")

    # ── MTD sales by channel ──
    sales_rows = fetch_all("sales_by_state")
    shopify_mtd = 0.0
    amazon_mtd = 0.0

    for row in sales_rows:
        period_end = row.get("period_end", "")
        # Include rows whose period overlaps the current month
        if period_end < month_start:
            continue
        channel = normalize_channel(row.get("channel", ""))
        gross = float(row.get("gross_sales", 0) or 0)
        if channel == SHOPIFY:
            shopify_mtd += gross
        elif channel == AMAZON:
            amazon_mtd += gross

    total_mtd = shopify_mtd + amazon_mtd

    if total_mtd == 0 and not sales_rows:
        return None

    # ── Filings, nexus and flags ──
    # These used to be derived here from last_filed_through + frequency
    # arithmetic, a second source of truth that disagreed with both the
    # dashboard and filing_calendar. It also produced permanent OVERDUE for
    # any state whose last_filed_through was old. Now the digest renders the
    # same registration-gated sections everything else uses.
    from src.alerts.digest_sections import build_sections, render_sections

    parts: list[str] = []
    parts.append(f"<b>Daily Digest -- {month_label}</b>")
    parts.append("")
    parts.append(f"MTD Shopify: ${shopify_mtd:,.2f}")
    parts.append(f"MTD Amazon:  ${amazon_mtd:,.2f}")
    parts.append(f"MTD Total:   ${total_mtd:,.2f}")

    try:
        sections = build_sections(
            fetch_all("nexus_status"),
            fetch_all("filing_calendar"),
            fetch_all("franchise_tax_flags"),
            ref,
        )
        parts.extend(render_sections(sections, ref))
    except Exception:
        # A digest that loses its compliance section is still worth sending
        # for the MTD numbers; a digest that raises is not sent at all.
        pass

    # Stale sync warning
    try:
        logs = fetch_all("ingestion_log")
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        shopify_ok = any(
            l.get("status") == "success" and "shopify" in (l.get("file_type") or "")
            and (now - datetime.fromisoformat(l["ingested_at"].replace("Z", "+00:00"))).total_seconds() < 36 * 3600
            for l in logs
        )
        spapi_ok = any(
            l.get("status") == "success" and "amazon" in (l.get("file_type") or "")
            and (now - datetime.fromisoformat(l["ingested_at"].replace("Z", "+00:00"))).total_seconds() < 36 * 3600
            for l in logs
        )
        stale = []
        if not shopify_ok:
            stale.append("Shopify")
        if not spapi_ok:
            stale.append("SP-API")
        if stale:
            parts.append("")
            parts.append(f"⚠️ Data stale: {', '.join(stale)} sync >36h ago")
    except Exception:
        pass

    # Failed job_runs in last 24h — one line per job that is STILL broken.
    # Listing every fail row meant a single incident appeared several times and
    # failures a later run had already recovered kept being reported, which is
    # how the list stopped being read.
    try:
        from datetime import datetime as _dt, timezone as _tz, timedelta as _td
        from src.alerts.job_health import current_failures, render_failures

        since = (_dt.now(_tz.utc) - _td(hours=24)).isoformat()
        parts.extend(render_failures(current_failures(fetch_all("job_runs"), since)))
    except Exception:
        pass

    parts.append("")
    parts.append(f"<i>{ref.isoformat()} -- monitoring aid, not tax advice.</i>")

    return "\n".join(parts)


def send_digest(dry_run: bool = False) -> dict:
    """Build and send the daily digest via Telegram.

    Args:
        dry_run: If True, build the message but do not send it.

    Returns:
        dict with keys: sent (bool), message (str|None), error (str|None)
    """
    message = build_digest_message()

    if message is None:
        return {"sent": False, "message": None, "error": "No data for digest"}

    if dry_run:
        return {"sent": False, "message": message, "error": None}

    result = send_telegram(message)
    return {
        "sent": result.get("sent", False),
        "message": message,
        "error": result.get("error"),
    }
