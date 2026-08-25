"""Telegram alert policy — controls when alerts fire.

Provides de-duplication, next-due computation, and a policy runner
that decides which alerts to send vs suppress based on recent history.
"""
from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta
from typing import Any

from src.db import fetch_all, insert_rows, get_client
from src.alerts.telegram import send_telegram


# ── De-duplication ─────────────────────────────────────────


def dedupe_key(alert_type: str, scope: str, date_str: str) -> str:
    """Create a deterministic unique key for an alert.

    Args:
        alert_type: e.g. "threshold_crossed", "filing_due", "digest"
        scope: e.g. a state code or "all"
        date_str: ISO date string for the reference day

    Returns:
        A hex digest string suitable for storage / comparison.
    """
    raw = f"{alert_type}:{scope}:{date_str}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _was_recently_sent(key: str, hours: int = 20) -> bool:
    """Check the alerts table for a recent send with the same dedupe key.

    Looks for rows created within the last `hours` hours whose
    subject contains the dedupe key and that were successfully delivered.
    """
    client = get_client()
    cutoff = (datetime.utcnow() - timedelta(hours=hours)).isoformat()

    result = (
        client.table("alerts")
        .select("id")
        .gte("created_at", cutoff)
        .eq("delivered", True)
        .like("subject", f"%{key}%")
        .limit(1)
        .execute()
    )
    return bool(result.data)


# ── Next-due computation ──────────────────────────────────


def compute_next_due(
    last_filed_through: str | None,
    frequency: str | None,
    due_day: int = 20,
) -> dict | None:
    """Compute the next filing due date from last_filed_through + frequency.

    Returns:
        dict with {due_date, days_until, period_label} or None if inputs
        are insufficient.
    """
    if not last_filed_through or not frequency:
        return None

    try:
        ft = date.fromisoformat(last_filed_through)
    except (ValueError, TypeError):
        return None

    start = ft + timedelta(days=1)
    y, m = start.year, start.month

    freq = frequency.lower().replace("-", "_")

    if freq == "monthly":
        if m == 12:
            pe = date(y + 1, 1, 1) - timedelta(days=1)
        else:
            pe = date(y, m + 1, 1) - timedelta(days=1)
    elif freq == "quarterly":
        q_end = ((m - 1) // 3 + 1) * 3
        if q_end == 12:
            pe = date(y + 1, 1, 1) - timedelta(days=1)
        else:
            pe = date(y, q_end + 1, 1) - timedelta(days=1)
    elif freq in ("semi_annual", "semi-annual"):
        pe = date(y, 6, 30) if m <= 6 else date(y, 12, 31)
    elif freq in ("annual", "casual"):
        pe = date(y, 12, 31)
    else:
        if m == 12:
            pe = date(y + 1, 1, 1) - timedelta(days=1)
        else:
            pe = date(y, m + 1, 1) - timedelta(days=1)

    due_month = pe.month + 1
    due_year = pe.year
    if due_month > 12:
        due_month = 1
        due_year += 1
    clamped_day = min(due_day, 28)
    due = date(due_year, due_month, clamped_day)

    days_until = (due - date.today()).days
    period_label = pe.strftime("%b %Y")

    return {
        "due_date": due.isoformat(),
        "days_until": days_until,
        "period_label": period_label,
    }


# ── Policy runner ─────────────────────────────────────────


def run_policy_alerts(
    newly_crossed_unreg: list[str],
    econ_details: dict[str, dict] | None = None,
) -> dict:
    """Send filtered alerts based on policy rules.

    Args:
        newly_crossed_unreg: state codes that newly crossed their economic
            nexus threshold AND are not yet registered.
        econ_details: optional dict mapping state_code to
            {amount, threshold, trigger} for threshold-crossed messages.

    Returns:
        dict with {sent: list[str], suppressed: list[str]}
    """
    econ_details = econ_details or {}
    today_str = date.today().isoformat()

    sent: list[str] = []
    suppressed: list[str] = []

    # ── Threshold-crossed alerts (one per state) ──
    for sc in newly_crossed_unreg:
        key = dedupe_key("threshold_crossed", sc, today_str)
        if _was_recently_sent(key):
            suppressed.append(sc)
            continue

        detail = econ_details.get(sc, {})
        amount = float(detail.get("amount", 0))
        threshold = float(detail.get("threshold", 100_000))
        trigger = detail.get(
            "trigger",
            f"Sales ${amount:,.0f} >= ${threshold:,.0f}",
        )

        pct = (amount / threshold * 100) if threshold else 0
        message = (
            f"<b>THRESHOLD CROSSED -- {sc}</b>\n\n"
            f"{trigger}\n"
            f"Progress: ${amount:,.0f} / ${threshold:,.0f} ({pct:.0f}%)\n\n"
            f"<b>Action:</b> Register for sales tax in {sc}. "
            f"Consult CPA for effective date and filing obligations.\n\n"
            f"<code>key:{key}</code>"
        )
        result = send_telegram(message)

        insert_rows("alerts", [{
            "alert_type": "threshold_crossed",
            "channel": "telegram",
            "subject": f"Threshold crossed: {sc} key:{key}",
            "body": message,
            "state_code": sc,
            "severity": "critical",
            "delivered": result.get("sent", False),
            "error_message": result.get("error"),
        }])

        if result.get("sent"):
            sent.append(sc)
        else:
            suppressed.append(sc)

    # ── Filing-due alerts for registered states ──
    nexus_rows = fetch_all("nexus_status")
    for n in nexus_rows:
        is_reg = n.get("is_registered")
        if is_reg is not True and is_reg != "true" and is_reg != 1:
            continue
        freq = n.get("assigned_frequency")
        lft = n.get("last_filed_through")
        sc = n.get("state_code", "")
        if not freq or not lft:
            continue

        due_info = compute_next_due(lft, freq, 20)
        if not due_info:
            continue

        days_until = due_info["days_until"]
        # Alert at 14 days and 7 days before due
        if days_until not in (14, 7):
            continue

        key = dedupe_key("filing_due", sc, today_str)
        if _was_recently_sent(key):
            suppressed.append(f"{sc}_filing")
            continue

        message = (
            f"<b>Filing Due -- {sc}</b>\n\n"
            f"Period: {due_info['period_label']}\n"
            f"Due: {due_info['due_date']} ({days_until} days)\n\n"
            f"<code>key:{key}</code>"
        )
        result = send_telegram(message)

        insert_rows("alerts", [{
            "alert_type": "filing_due",
            "channel": "telegram",
            "subject": f"Filing due: {sc} key:{key}",
            "body": message,
            "state_code": sc,
            "severity": "warning",
            "delivered": result.get("sent", False),
            "error_message": result.get("error"),
        }])

        if result.get("sent"):
            sent.append(f"{sc}_filing")
        else:
            suppressed.append(f"{sc}_filing")

    return {"sent": sent, "suppressed": suppressed}
