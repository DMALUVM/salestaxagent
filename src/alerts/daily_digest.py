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


def _compute_next_due(
    last_filed_through: str | None,
    frequency: str | None,
    due_day: int,
) -> dict | None:
    """Lightweight next-due computation mirroring the dashboard helper."""
    if not last_filed_through or not frequency:
        return None

    from datetime import date as _date

    try:
        ft = _date.fromisoformat(last_filed_through)
    except (ValueError, TypeError):
        return None

    start = ft + timedelta(days=1)
    y, m = start.year, start.month

    freq = frequency.lower().replace("-", "_")

    if freq == "monthly":
        # End of that calendar month
        if m == 12:
            pe = _date(y + 1, 1, 1) - timedelta(days=1)
        else:
            pe = _date(y, m + 1, 1) - timedelta(days=1)
    elif freq == "quarterly":
        q_end_month = ((m - 1) // 3 + 1) * 3
        if q_end_month == 12:
            pe = _date(y + 1, 1, 1) - timedelta(days=1)
        else:
            pe = _date(y, q_end_month + 1, 1) - timedelta(days=1)
    elif freq in ("semi_annual", "semi-annual"):
        pe = _date(y, 6, 30) if m <= 6 else _date(y, 12, 31)
    elif freq == "annual":
        pe = _date(y, 12, 31)
    else:
        # fallback to monthly
        if m == 12:
            pe = _date(y + 1, 1, 1) - timedelta(days=1)
        else:
            pe = _date(y, m + 1, 1) - timedelta(days=1)

    # Due date = due_day of the month after period end
    due_month = pe.month + 1
    due_year = pe.year
    if due_month > 12:
        due_month = 1
        due_year += 1
    clamped_day = min(due_day, 28)
    due = _date(due_year, due_month, clamped_day)

    days_until = (due - date.today()).days
    period_label = f"{pe.strftime('%b %Y')}"

    return {
        "due_date": due.isoformat(),
        "days_until": days_until,
        "period_label": period_label,
    }


# ── Core ───────────────────────────────────────────────────


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

    # ── Next filings for registered states ──
    nexus_rows = fetch_all("nexus_status")
    filing_lines: list[str] = []

    for n in nexus_rows:
        is_reg = n.get("is_registered")
        if is_reg is not True and is_reg != "true" and is_reg != 1:
            continue
        freq = n.get("assigned_frequency")
        lft = n.get("last_filed_through")
        if not freq or not lft:
            continue
        due_info = _compute_next_due(lft, freq, 20)
        if due_info and due_info["days_until"] <= 45:
            sc = n.get("state_code", "??")
            filing_lines.append(
                f"  {sc}: {due_info['period_label']} due {due_info['due_date']} "
                f"({due_info['days_until']}d)"
            )

    filing_lines.sort()

    # ── Build message ──
    parts: list[str] = []
    parts.append(f"<b>Daily Digest -- {month_label}</b>")
    parts.append("")
    parts.append(f"MTD Shopify: ${shopify_mtd:,.2f}")
    parts.append(f"MTD Amazon:  ${amazon_mtd:,.2f}")
    parts.append(f"MTD Total:   ${total_mtd:,.2f}")

    if filing_lines:
        parts.append("")
        parts.append("<b>Upcoming Filings:</b>")
        parts.extend(filing_lines)

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
