"""Cheap GNO export-due ping — P0 or 48h review only.

Reuses send_telegram + the alerts table for 20h de-dupe. Never fires on the
optional morning digest. Observe only — no Amazon writes, no wait-loops.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from src.rules import (
    GNO_AUTO_LOOSE_BUDGET,
    GNO_EXPORT_REVIEW_LEAD_HOURS,
    GNO_KEEP_ALIVE,
    GNO_NEXT_REVIEW_AT,
)

log = logging.getLogger(__name__)

GNO_EXPORT_TABLE = "gno_export_state"
ALERT_TYPE = "gno_export_due"
DEDUPE_HOURS = 20


def normalize_name(name: str | None) -> str:
    return " ".join(str(name or "").split()).strip().lower()


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def review_due(
    now: datetime,
    next_review_at: str,
    last_export_at: datetime | None,
    lead_hours: int = GNO_EXPORT_REVIEW_LEAD_HOURS,
) -> bool:
    review = parse_iso(next_review_at)
    if review is None:
        return False
    if now.tzinfo is None:
        now = now.replace(tzinfo=review.tzinfo)
    else:
        now = now.astimezone(review.tzinfo)
    if last_export_at is not None and last_export_at.tzinfo is None:
        last_export_at = last_export_at.replace(tzinfo=review.tzinfo)
    elif last_export_at is not None:
        last_export_at = last_export_at.astimezone(review.tzinfo)
    window = review - timedelta(hours=lead_hours)
    if now < window:
        return False
    if last_export_at is None:
        return True
    return last_export_at < window


def p0_key(code: str, campaign_name: str, search_term: str = "") -> str:
    return f"{code}|{normalize_name(campaign_name)}|{normalize_name(search_term)}"


def cheap_p0s_from_campaigns(
    rows: list[dict[str, Any]],
    keep_alive: tuple[str, ...] = GNO_KEEP_ALIVE,
    auto_loose_name: str | None = None,
    auto_loose_budget: float = GNO_AUTO_LOOSE_BUDGET,
) -> list[dict[str, str]]:
    """Explicit not-enabled / Auto Loose budget only.

    KEEP-ALIVE missing from a short spend lookback is not a P0 — Ads omits
    $0 days. Matches dashboard keeperMissingPriority (always P2).
    """
    latest: dict[str, dict[str, Any]] = {}
    for r in rows:
        key = normalize_name(r.get("campaign_name"))
        if not key:
            continue
        prev = latest.get(key)
        if prev is None or str(r.get("date") or "") > str(prev.get("date") or ""):
            latest[key] = r

    auto_name = auto_loose_name or (keep_alive[0] if keep_alive else "")
    out: list[dict[str, str]] = []
    for name in keep_alive:
        row = latest.get(normalize_name(name))
        if row is None:
            continue
        status = str(row.get("campaign_status") or "").strip().lower()
        if status and status not in ("enabled", "enable"):
            out.append({"code": "KEEPER_NOT_ENABLED", "campaign_name": name, "search_term": ""})
        if normalize_name(name) == normalize_name(auto_name):
            budget = row.get("budget")
            if budget is not None:
                try:
                    if float(budget) != float(auto_loose_budget):
                        out.append({
                            "code": "AUTO_LOOSE_BUDGET",
                            "campaign_name": name,
                            "search_term": "",
                        })
                except (TypeError, ValueError):
                    pass
    return out


def unacked_p0s(
    p0s: list[dict[str, str]],
    acked_keys: list[str] | None,
) -> list[dict[str, str]]:
    acked = set(acked_keys or [])
    return [
        p for p in p0s
        if p0_key(p["code"], p["campaign_name"], p.get("search_term", "")) not in acked
    ]


def ping_reasons(
    *,
    now: datetime,
    next_review_at: str,
    last_export_at: datetime | None,
    p0s: list[dict[str, str]],
    acked_p0_keys: list[str] | None,
) -> list[str]:
    reasons: list[str] = []
    if unacked_p0s(p0s, acked_p0_keys):
        reasons.append("P0")
    if review_due(now, next_review_at, last_export_at):
        reasons.append("REVIEW")
    return reasons


def _was_recently_sent(key: str, hours: int = DEDUPE_HOURS) -> bool:
    from src.db import get_client

    cutoff = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    try:
        result = (
            get_client()
            .table("alerts")
            .select("id")
            .gte("sent_at", cutoff)
            .like("subject", f"%{key}%")
            .limit(1)
            .execute()
        )
        return bool(result.data)
    except Exception as e:
        log.debug("gno alert dedupe read failed: %s", e)
        return False


def _load_export_state() -> dict[str, Any]:
    from src.db import get_client

    try:
        r = (
            get_client()
            .table(GNO_EXPORT_TABLE)
            .select("last_export_at,acked_p0_keys")
            .eq("id", "default")
            .limit(1)
            .execute()
        )
        return (r.data or [{}])[0] if r.data else {}
    except Exception as e:
        if "gno_export_state" in str(e):
            return {}
        log.debug("gno_export_state read failed: %s", e)
        return {}


def _load_recent_campaigns() -> list[dict[str, Any]]:
    from src.db import get_client
    from src.rules import amazon_today

    start = (amazon_today() - timedelta(days=4)).isoformat()
    try:
        r = (
            get_client()
            .table("ads_campaigns_daily")
            .select("date,campaign_name,campaign_status,budget")
            .gte("date", start)
            .order("date", desc=True)
            .limit(2000)
            .execute()
        )
        return list(r.data or [])
    except Exception as e:
        log.debug("gno cheap P0 campaign read failed: %s", e)
        return []


def maybe_send_gno_export_alert(now: datetime | None = None) -> dict[str, Any]:
    """One-liner on P0 or review-due. Silent otherwise. Never waits."""
    from src.alerts.telegram import send_telegram
    from src.config import settings

    moment = now or datetime.now(timezone.utc)
    state = _load_export_state()
    last_export = parse_iso(state.get("last_export_at"))
    acked = state.get("acked_p0_keys") or []
    if not isinstance(acked, list):
        acked = []
    p0s = cheap_p0s_from_campaigns(_load_recent_campaigns())
    reasons = ping_reasons(
        now=moment,
        next_review_at=GNO_NEXT_REVIEW_AT,
        last_export_at=last_export,
        p0s=p0s,
        acked_p0_keys=[str(x) for x in acked],
    )
    if not reasons:
        return {"sent": False, "reasons": [], "suppressed": "quiet"}

    primary = "P0" if "P0" in reasons else "REVIEW"
    day = moment.date().isoformat()
    key = f"gno-export:{primary}:{day}"
    if _was_recently_sent(key):
        return {"sent": False, "reasons": reasons, "suppressed": "deduped"}

    if primary == "P0":
        codes = sorted({p["code"] for p in unacked_p0s(p0s, [str(x) for x in acked])})
        message = (
            f"GNO pack due — P0 {', '.join(codes) or 'open'}. "
            f"Export /ppc/gno. Observe only.\nkey:{key}"
        )
    else:
        message = (
            f"GNO pack due — 48h review {GNO_NEXT_REVIEW_AT}. "
            f"Export /ppc/gno even if quiet. Observe only.\nkey:{key}"
        )

    if not settings.telegram_enabled:
        return {"sent": False, "reasons": reasons, "suppressed": "telegram_off", "key": key}

    result = send_telegram(message, parse_mode="")
    return {
        "sent": bool(result.get("sent")),
        "reasons": reasons,
        "key": key,
        "error": result.get("error"),
    }
