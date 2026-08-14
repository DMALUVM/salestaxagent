from __future__ import annotations

import httpx

from src.config import settings
from src.db import insert_rows


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


def send_nexus_alert(state_code: str, nexus_type: str, details: str) -> dict:
    emoji = {"physical": "📦", "economic": "💰", "franchise": "🏛️"}.get(nexus_type, "⚠️")
    message = (
        f"{emoji} <b>New {nexus_type.title()} Nexus Alert — {state_code}</b>\n\n"
        f"{details}\n\n"
        f"<i>Action required: Review with your CPA. This system does not file returns.</i>"
    )
    result = send_telegram(message)

    insert_rows("alerts", [{
        "alert_type": f"nexus_{nexus_type}",
        "channel": "telegram",
        "subject": f"New {nexus_type} nexus: {state_code}",
        "body": message,
        "state_code": state_code,
        "severity": "critical" if nexus_type == "franchise" else "warning",
        "delivered": result.get("sent", False),
        "error_message": result.get("error"),
    }])

    return result


def send_deadline_alert(state_code: str, period_label: str, due_date: str,
                        days_until: int) -> dict:
    if days_until <= 0:
        emoji = "🚨"
        urgency = "OVERDUE" if days_until < 0 else "DUE TODAY"
    elif days_until <= 3:
        emoji = "⏰"
        urgency = f"Due in {days_until} days"
    else:
        emoji = "📅"
        urgency = f"Due in {days_until} days"

    message = (
        f"{emoji} <b>Filing Deadline — {state_code} ({period_label})</b>\n\n"
        f"<b>{urgency}</b>\n"
        f"Due date: {due_date}\n\n"
        f"<i>Mark complete after filing: python -m src.main complete --state {state_code} --period {period_label}</i>"
    )
    return send_telegram(message)


def send_threshold_alert(state_code: str, progress_pct: float, amount: float,
                         threshold: float) -> dict:
    if progress_pct >= 100:
        emoji = "🚨"
        status = "EXCEEDED"
    elif progress_pct >= 80:
        emoji = "⚠️"
        status = "APPROACHING"
    else:
        emoji = "📊"
        status = "MONITORING"

    message = (
        f"{emoji} <b>Economic Nexus {status} — {state_code}</b>\n\n"
        f"Progress: ${amount:,.2f} / ${threshold:,.0f} ({progress_pct:.0f}%)\n\n"
        f"<i>Review with CPA if approaching or exceeded.</i>"
    )
    return send_telegram(message)


def send_test_alert() -> dict:
    message = (
        "✅ <b>Sales Tax Agent — Test Alert</b>\n\n"
        "Telegram notifications are working correctly.\n"
        "You will receive alerts for:\n"
        "• New physical nexus (FBA inventory in new states)\n"
        "• Economic nexus threshold crossings\n"
        "• Franchise tax flags (CA, TX, etc.)\n"
        "• Upcoming filing deadlines"
    )
    return send_telegram(message)
