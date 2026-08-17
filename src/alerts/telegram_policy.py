"""Telegram alert policy — actionable alerts only, no spam.

Centralizes all send/suppress decisions. Every Telegram message must pass
through should_send() before dispatch.

Policy:
  SEND:
    1. Filing deadline approaching (14d, 7d, 1d) or overdue — computed from
       last_filed_through, NOT from stale filing_calendar
    2. Economic threshold newly crossed AND is_registered=false
    3. Franchise/entity tax flag — CRITICAL or WARNING, open, max 1x/7d per state
  NEVER SEND:
    - Approaching / watch-only economic %
    - Physical nexus / FBA inventory bulk lists
    - Job success/failure, ingest complete, heartbeat
    - Alerts for registered states (except filing due + franchise open)
    - Duplicate payload within 24h
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Literal

from src.config import settings
from src.db import fetch_all, insert_rows

AlertType = Literal[
    "filing_due",
    "filing_overdue",
    "economic_crossed",
    "franchise_flag",
]

# ── Config (from .env with defaults) ─────────────────────

def _bool_env(key: str, default: bool) -> bool:
    val = getattr(settings, key, None)
    if val is None:
        return default
    if isinstance(val, bool):
        return val
    return str(val).lower() in ("true", "1", "yes")


FILING_ENABLED = True      # always on
ECON_CROSS_ENABLED = True   # always on
FRANCHISE_ENABLED = True    # always on
# These are NEVER-send categories:
APPROACHING_ENABLED = False
PHYSICAL_ENABLED = False
JOB_STATUS_ENABLED = False

ALERT_DAYS = [14, 7, 1]  # days before deadline to alert
FRANCHISE_COOLDOWN_DAYS = 7
DEDUPE_HOURS = 24


# ── Dedupe key ────────────────────────────────────────────

def dedupe_key(alert_type: str, state_code: str, period: str = "") -> str:
    return f"{alert_type}:{state_code}:{period}"


# ── Recently sent check ───────────────────────────────────

def _was_recently_sent(key: str, hours: int = DEDUPE_HOURS) -> bool:
    """Check if an alert with this key was sent within the last N hours."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    try:
        rows = fetch_all("alerts")
        for row in rows:
            if (row.get("dedupe_key") == key
                    and row.get("delivered")
                    and str(row.get("sent_at", "")) >= cutoff):
                return True
    except Exception:
        pass
    return False


# ── Filing deadline alerts ─────────────────────────────────

def compute_next_due(
    filed_through: str | None,
    frequency: str | None,
    due_day: int = 20,
) -> dict | None:
    """Same logic as dashboard computeNextDue — Python version."""
    if not filed_through or not frequency:
        return None

    ft = date.fromisoformat(filed_through)
    start = ft + timedelta(days=1)
    y, m = start.year, start.month
    freq = frequency.lower().replace("-", "_")

    if freq == "monthly":
        import calendar
        period_end = date(y, m, calendar.monthrange(y, m)[1])
    elif freq == "quarterly":
        q_end_month = ((m - 1) // 3) * 3 + 3
        import calendar
        period_end = date(y, q_end_month, calendar.monthrange(y, q_end_month)[1])
    elif freq in ("semi_annual", "semi-annual"):
        period_end = date(y, 6, 30) if m <= 6 else date(y, 12, 31)
    elif freq == "annual":
        period_end = date(y, 12, 31)
    else:
        import calendar
        period_end = date(y, m, calendar.monthrange(y, m)[1])

    due_month = period_end.month + 1
    due_year = period_end.year
    if due_month > 12:
        due_month = 1
        due_year += 1
    due_date = date(due_year, due_month, min(due_day, 28))

    return {
        "period_end": period_end,
        "due_date": due_date,
        "days_until": (due_date - date.today()).days,
    }


def build_filing_alerts() -> list[dict]:
    """Build filing alerts from nexus_status (not filing_calendar)."""
    nexus = fetch_all("nexus_status")
    from src.config import load_state_rules
    rules = load_state_rules().get("states", {})

    alerts = []
    for n in nexus:
        if not n.get("is_registered"):
            continue
        sc = n["state_code"]
        ft = n.get("last_filed_through")
        freq = n.get("assigned_frequency")
        due_day = rules.get(sc, {}).get("typical_due_day", 20)

        nd = compute_next_due(ft, freq, due_day)
        if not nd:
            continue

        days = nd["days_until"]
        due_str = nd["due_date"].isoformat()
        pe_str = nd["period_end"].isoformat()

        if days < 0:
            # Overdue
            alerts.append({
                "type": "filing_overdue",
                "state_code": sc,
                "period": pe_str,
                "due_date": due_str,
                "days": days,
                "message": f"🚨 <b>OVERDUE</b> — {sc} filing for period ending {pe_str}\n"
                           f"Due: {due_str} ({abs(days)} days ago)\n"
                           f"Frequency: {freq}",
            })
        elif days in ALERT_DAYS or (days <= max(ALERT_DAYS) and days in ALERT_DAYS):
            alerts.append({
                "type": "filing_due",
                "state_code": sc,
                "period": pe_str,
                "due_date": due_str,
                "days": days,
                "message": f"📅 <b>Filing due in {days}d</b> — {sc}\n"
                           f"Period ending: {pe_str}\n"
                           f"Due: {due_str} · {freq}",
            })

    return alerts


# ── Economic threshold alerts ──────────────────────────────

def build_economic_alerts(newly_crossed_unreg: list[str], details: dict) -> list[dict]:
    """Build alerts for states that newly crossed AND are NOT registered."""
    alerts = []
    for sc in newly_crossed_unreg:
        d = details.get(sc, {})
        amt = d.get("threshold_amount", 0)
        cfg = d.get("threshold_amount_cfg", 100000)
        alerts.append({
            "type": "economic_crossed",
            "state_code": sc,
            "period": "",
            "message": f"🚨 <b>THRESHOLD CROSSED — {sc}</b>\n\n"
                       f"Counted sales: ${amt:,.0f} / ${cfg:,.0f}\n"
                       f"State is NOT registered.\n\n"
                       f"<b>Action:</b> Consult CPA about {sc} registration.",
        })
    return alerts


# ── Franchise flag alerts ──────────────────────────────────

def build_franchise_alerts() -> list[dict]:
    """Build alerts for open critical/warning franchise flags (max 1x/7d)."""
    flags = fetch_all("franchise_tax_flags", {"status": "open"})
    alerts = []
    for f in flags:
        sev = f.get("severity", "")
        if sev not in ("critical", "warning"):
            continue
        sc = f.get("state_code", "?")
        key = dedupe_key("franchise_flag", sc)
        if _was_recently_sent(key, hours=FRANCHISE_COOLDOWN_DAYS * 24):
            continue
        icon = "🚨" if sev == "critical" else "⚠️"
        desc = (f.get("description") or "")[:150]
        alerts.append({
            "type": "franchise_flag",
            "state_code": sc,
            "period": "",
            "message": f"{icon} <b>{sc} — {f.get('flag_type', 'entity tax')}</b>\n"
                       f"{desc}\n\n"
                       f"<i>Review with CPA. Status: open.</i>",
        })
    return alerts


# ── Policy gate ────────────────────────────────────────────

def should_send(alert: dict) -> bool:
    """Returns True if this alert passes all policy filters."""
    atype = alert.get("type", "")

    # Category gate
    if atype in ("filing_due", "filing_overdue") and not FILING_ENABLED:
        return False
    if atype == "economic_crossed" and not ECON_CROSS_ENABLED:
        return False
    if atype == "franchise_flag" and not FRANCHISE_ENABLED:
        return False

    # Dedupe
    key = dedupe_key(atype, alert.get("state_code", ""), alert.get("period", ""))
    if _was_recently_sent(key, DEDUPE_HOURS):
        return False

    return True


# ── Send + log ─────────────────────────────────────────────

def send_alert(alert: dict) -> dict:
    """Send a single alert via Telegram with policy check and dedupe logging."""
    from src.alerts.telegram import send_telegram

    if not should_send(alert):
        return {"sent": False, "reason": "suppressed by policy"}

    result = send_telegram(alert["message"])
    key = dedupe_key(alert["type"], alert.get("state_code", ""), alert.get("period", ""))

    # Log with dedupe key for future suppression
    try:
        insert_rows("alerts", [{
            "alert_type": alert["type"],
            "channel": "telegram",
            "state_code": alert.get("state_code"),
            "subject": alert["message"][:100],
            "body": alert["message"],
            "severity": "critical" if "OVERDUE" in alert["message"] or "CROSSED" in alert["message"] else "warning",
            "delivered": result.get("sent", False),
            "error_message": result.get("error"),
            "dedupe_key": key,
        }])
    except Exception:
        # dedupe_key column might not exist — non-fatal
        insert_rows("alerts", [{
            "alert_type": alert["type"],
            "channel": "telegram",
            "state_code": alert.get("state_code"),
            "subject": alert["message"][:100],
            "body": alert["message"],
            "severity": "critical" if alert["type"] in ("filing_overdue", "economic_crossed") else "warning",
            "delivered": result.get("sent", False),
            "error_message": result.get("error"),
        }])

    return result


# ── Orchestrator: run all policy-filtered alerts ───────────

def run_policy_alerts(
    newly_crossed_unreg: list[str] | None = None,
    econ_details: dict | None = None,
) -> dict:
    """Collect all actionable alerts, filter by policy, send.

    Returns summary dict of what was sent/suppressed.
    """
    all_alerts = []

    # Filing
    all_alerts.extend(build_filing_alerts())

    # Economic (only if caller provides newly-crossed data)
    if newly_crossed_unreg:
        all_alerts.extend(
            build_economic_alerts(newly_crossed_unreg, econ_details or {})
        )

    # Franchise
    all_alerts.extend(build_franchise_alerts())

    sent = 0
    suppressed = 0
    for alert in all_alerts:
        if should_send(alert):
            result = send_alert(alert)
            if result.get("sent"):
                sent += 1
            else:
                suppressed += 1
        else:
            suppressed += 1

    return {
        "total": len(all_alerts),
        "sent": sent,
        "suppressed": suppressed,
        "alerts": [
            {"type": a["type"], "state": a.get("state_code", ""), "would_send": should_send(a)}
            for a in all_alerts
        ],
    }
