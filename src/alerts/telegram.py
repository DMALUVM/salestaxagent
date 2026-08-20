"""Telegram alert module.

Default behavior: ONE summary message per analysis run.
Exception: dedicated single-state message when a state NEWLY crosses
its economic nexus threshold (was under, now over on this run).
"""
from __future__ import annotations

import logging

import httpx

from src.config import settings
from src.db import insert_rows

log = logging.getLogger(__name__)


# ── Low-level sender ────────────────────────────────────────

def send_telegram(message: str, parse_mode: str = "HTML") -> dict:
    if not settings.telegram_enabled:
        return {"sent": False, "error": "Telegram not configured"}

    url = f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage"
    payload = {
        "chat_id": settings.telegram_chat_id,
        "text": message,
        "parse_mode": parse_mode,
    }

    try:
        resp = httpx.post(url, json=payload, timeout=15)
        success = resp.status_code == 200
        error = None if success else resp.text[:500]
    except Exception as e:
        success = False
        error = str(e)

    insert_rows("alerts", [{
        "alert_type": "telegram",
        "channel": "telegram",
        "subject": message[:100],
        "body": message,
        "severity": "info",
        "delivered": success,
        "error_message": error,
    }])

    return {"sent": success, "error": error}


# ── Threshold-cross dedicated alert (exception) ────────────

def send_threshold_crossed(
    state_code: str,
    amount: float,
    threshold: float,
    trigger: str,
) -> dict:
    """Dedicated single-state alert when a state NEWLY crosses its
    economic nexus threshold on this analysis run.

    Args:
        trigger: human description e.g. "sales $215,446 >= $100,000"
    """
    pct = (amount / threshold * 100) if threshold else 0
    message = (
        f"🚨 <b>THRESHOLD CROSSED — {state_code}</b>\n\n"
        f"{trigger}\n"
        f"Progress: ${amount:,.0f} / ${threshold:,.0f} ({pct:.0f}%)\n\n"
        f"<b>Action:</b> Register for sales tax in {state_code}. "
        f"Consult CPA for effective date and filing obligations."
    )
    result = send_telegram(message)

    insert_rows("alerts", [{
        "alert_type": "threshold_crossed",
        "channel": "telegram",
        "subject": f"Threshold crossed: {state_code}",
        "body": message,
        "state_code": state_code,
        "severity": "critical",
        "delivered": result.get("sent", False),
        "error_message": result.get("error"),
    }])

    return result


# ── Daily summary (single message) ─────────────────────────

def send_daily_summary(
    phys_nexus_count: int,
    new_phys_states: list[str],
    econ_exceeded: list[str],
    econ_approaching: list[str],
    newly_crossed: list[str],
    critical_flags: list[dict],
    warning_flags: list[dict],
    overdue_count: int,
    upcoming_deadlines: list[dict],
    action_needed: int,
) -> dict:
    """Send a single consolidated Telegram summary after analysis.

    Sections come from src/alerts/digest_sections.py, which is registration-
    aware: a state the user already registered in is reported as monitoring,
    never as a "go register" nudge, and filing lines are gated on the same
    eligibility rules as the dashboard chips.

    The legacy arguments are still accepted so existing callers keep working,
    but the counts are recomputed from the tables rather than trusted — the
    old `action_needed` counted every unregistered nexus state and the old
    overdue count came from a source that ignored last_filed_through.
    """
    from datetime import date as _date

    from src.alerts.digest_sections import build_sections, render_sections
    from src.db import fetch_all

    parts: list[str] = []
    parts.append("<b>📊 Sales Tax Agent — Daily Summary</b>")

    today = _date.today()
    try:
        entity_view = None
        try:
            from src.compliance.entity_obligations import current_view
            entity_view = current_view(today)
        except Exception as e:
            log.warning("Entity obligations unavailable: %s", str(e)[:200])

        sections = build_sections(
            fetch_all("nexus_status"),
            fetch_all("filing_calendar"),
            fetch_all("franchise_tax_flags"),
            today,
            econ_approaching=econ_approaching,
            entity_view=entity_view,
        )
        body = render_sections(sections, today)
        action_needed = len(sections.action_needed_states)
        overdue_count = len(sections.overdue)
    except Exception as e:  # never let a summary failure break the run
        log.warning("Digest sections failed, falling back to counts: %s", str(e)[:200])
        body = [f"📦 Physical nexus: {phys_nexus_count} states"]
        if action_needed:
            body.append(f"\n⚡ <b>Action needed: {action_needed}</b>")

    # A newly crossed threshold is genuinely new information — keep it loud,
    # above the standing picture.
    if new_phys_states:
        parts.append(f"🆕 <b>New physical nexus:</b> {', '.join(new_phys_states)}")
    if newly_crossed:
        parts.append(f"🚨 <b>Newly crossed threshold:</b> {', '.join(newly_crossed)}")

    parts.extend(body)

    # ── Footer
    parts.append("\n<i>Monitoring aid — not tax advice.</i>")

    message = "\n".join(parts)
    result = send_telegram(message)

    insert_rows("alerts", [{
        "alert_type": "daily_summary",
        "channel": "telegram",
        "subject": f"Daily summary: {phys_nexus_count} phys, {len(econ_exceeded)} econ exceeded",
        "body": message,
        "severity": "info",
        "delivered": result.get("sent", False),
        "error_message": result.get("error"),
    }])

    return result


# ── Test alert ──────────────────────────────────────────────

def send_test_alert() -> dict:
    message = (
        "✅ <b>Sales Tax Agent — Test Alert</b>\n\n"
        "Telegram notifications are working correctly.\n"
        "You will receive:\n"
        "• Daily summary (one message per analysis run)\n"
        "• Dedicated alert when a state newly crosses its threshold\n"
        "• Error alerts if data sync fails"
    )
    return send_telegram(message)


# ── Legacy wrappers (kept for backward compat) ──────────────

def send_nexus_alert(state_code: str, nexus_type: str, details: str) -> dict:
    """Legacy: only used for error paths now."""
    emoji = {"physical": "📦", "economic": "💰", "franchise": "🏛️"}.get(nexus_type, "⚠️")
    message = (
        f"{emoji} <b>New {nexus_type.title()} Nexus — {state_code}</b>\n\n"
        f"{details}\n\n"
        f"<i>Review with your CPA.</i>"
    )
    return send_telegram(message)


def send_threshold_alert(state_code: str, progress_pct: float, amount: float,
                         threshold: float) -> dict:
    """Legacy: replaced by send_threshold_crossed for new crossings."""
    return send_threshold_crossed(state_code, amount, threshold,
                                  f"${amount:,.0f} >= ${threshold:,.0f} ({progress_pct:.0f}%)")


def send_deadline_alert(state_code: str, period_label: str, due_date: str,
                        days_until: int) -> dict:
    """Legacy: deadlines are now included in the daily summary."""
    return {"sent": False, "error": "Deadlines are now in daily summary"}
