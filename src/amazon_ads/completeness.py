"""Prior-day ads completeness for Iris Morning Brief CLEAR/HOLD.

Warehouse surface: ``ads_day_completeness``. Iris (and Dana) should read
this row — not chase CoS / job_runs / Telegram.

    select date, has_sp, has_sb, has_sd, status, reason, updated_at
    from ads_day_completeness
    where date = '<amazon_as_of>';

CLEAR = SP+SB+SD present for that closed Amazon day.
HOLD  = any product missing, or the 06:20 gate skipped because the ads
lease was still held. No polling; one heal shot when the lease is free.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date

log = logging.getLogger(__name__)

STATUS_CLEAR = "CLEAR"
STATUS_HOLD = "HOLD"
REQUIRED_PRODUCTS = ("SP", "SB", "SD")


@dataclass(frozen=True)
class DayCompleteness:
    date: date
    has_sp: bool
    has_sb: bool
    has_sd: bool
    status: str
    reason: str

    def to_row(self) -> dict:
        return {
            "date": self.date.isoformat(),
            "has_sp": self.has_sp,
            "has_sb": self.has_sb,
            "has_sd": self.has_sd,
            "status": self.status,
            "reason": self.reason,
        }

    def to_dict(self) -> dict:
        return self.to_row()

    def with_reason(self, reason: str) -> "DayCompleteness":
        return DayCompleteness(
            date=self.date,
            has_sp=self.has_sp,
            has_sb=self.has_sb,
            has_sd=self.has_sd,
            status=self.status,
            reason=reason,
        )


def completeness_from_types(
    as_of: date,
    types: set[str],
    *,
    reason: str | None = None,
) -> DayCompleteness:
    """CLEAR iff SP, SB, and SD all appear. HOLD otherwise."""
    present = {str(t).strip().upper() for t in types if t}
    has_sp = "SP" in present
    has_sb = "SB" in present
    has_sd = "SD" in present
    missing = [p for p in REQUIRED_PRODUCTS if p not in present]
    if not missing:
        return DayCompleteness(
            date=as_of,
            has_sp=True,
            has_sb=True,
            has_sd=True,
            status=STATUS_CLEAR,
            reason=reason or "prior-day SP+SB+SD present",
        )
    if reason is None:
        reason = (
            "no campaign rows for prior day"
            if not present
            else f"missing {','.join(missing)}"
        )
    return DayCompleteness(
        date=as_of,
        has_sp=has_sp,
        has_sb=has_sb,
        has_sd=has_sd,
        status=STATUS_HOLD,
        reason=reason,
    )


def load_day_types(as_of: date) -> set[str]:
    """Campaign types present on ``as_of`` in ads_campaigns_daily."""
    from src.db import get_client

    client = get_client()
    present: set[str] = set()
    day = as_of.isoformat()
    for product in REQUIRED_PRODUCTS:
        rows = (
            client.table("ads_campaigns_daily")
            .select("campaign_type")
            .eq("date", day)
            .eq("campaign_type", product)
            .limit(1)
            .execute()
            .data
        ) or []
        if rows:
            present.add(product)
    return present


def persist_day_completeness(snap: DayCompleteness) -> bool:
    """Upsert one completeness row. Soft-fail if the table is missing."""
    from src.db import upsert_rows

    try:
        upsert_rows(
            "ads_day_completeness", [snap.to_row()], on_conflict="date")
        return True
    except Exception as e:
        log.warning("ads_day_completeness persist failed: %s", e)
        return False


def refresh_day_completeness(
    as_of: date | None = None,
    *,
    reason: str | None = None,
    reason_prefix: str | None = None,
    types: set[str] | None = None,
) -> DayCompleteness:
    """Read warehouse types, classify, persist. ``types`` skips the DB read."""
    from src.rules import amazon_as_of

    day = as_of or amazon_as_of()
    present = types if types is not None else load_day_types(day)
    snap = completeness_from_types(day, present, reason=reason)
    if reason_prefix and snap.reason:
        snap = snap.with_reason(f"{reason_prefix}: {snap.reason}")
    persist_day_completeness(snap)
    return snap


def lease_is_free() -> bool:
    """True when no other process holds a live ads PID+heartbeat lease."""
    from src.amazon_ads.sync_lock import lease_is_live, read_lease

    return not lease_is_live(read_lease())


def run_prior_day_gate(
    *,
    as_of: date | None = None,
    load_types=None,
    lease_free=None,
    heal=None,
    sync_prior_day=None,
) -> dict:
    """06:20 one-shot: CLEAR if complete; heal if lease free; else HOLD.

    No polling, no after-lease wait. If the lease is held, write HOLD and
    return. Injectables are for tests.
    """
    from src.amazon_ads.heal import sync_missing_sb_sd
    from src.amazon_ads.reports import AdsSyncBusy
    from src.rules import amazon_as_of

    day = as_of or amazon_as_of()
    types_fn = load_types or load_day_types
    free_fn = lease_free or lease_is_free
    present = set(types_fn(day))
    snap = completeness_from_types(day, present)

    if snap.status == STATUS_CLEAR:
        persist_day_completeness(snap)
        return {"action": "clear", "completeness": snap.to_dict(), "healed": False}

    if not free_fn():
        snap = snap.with_reason(
            f"ads lease held; skipped heal — {snap.reason}")
        persist_day_completeness(snap)
        return {
            "action": "hold_lease_busy",
            "completeness": snap.to_dict(),
            "healed": False,
        }

    try:
        if "SP" in present:
            out = (heal or sync_missing_sb_sd)(lookback_days=1)
        else:
            out = (sync_prior_day or _sync_prior_day_campaigns)()
    except AdsSyncBusy as e:
        snap = snap.with_reason(
            f"ads lease held; skipped heal — {e}")
        persist_day_completeness(snap)
        return {
            "action": "hold_lease_busy",
            "completeness": snap.to_dict(),
            "healed": False,
            "error": str(e)[:200],
        }

    present = set(types_fn(day))
    snap = completeness_from_types(day, present)
    if snap.status == STATUS_HOLD:
        snap = snap.with_reason(f"heal ran; still {snap.reason}")
    persist_day_completeness(snap)
    return {
        "action": "healed" if (isinstance(out, dict) and out.get("healed"))
        else "heal_attempted",
        "completeness": snap.to_dict(),
        "healed": bool(isinstance(out, dict) and out.get("healed")),
        "heal": out if isinstance(out, dict) else {"result": out},
    }


def _sync_prior_day_campaigns() -> dict:
    """Single-shot prior-day SP+SB+SD when the day has no SP rows yet."""
    from src.amazon_ads.reports import sync_ads

    result = sync_ads(
        days=1, campaigns_only=True, campaign_chunk_days=1, sb_sd_days=1)
    return {"healed": True, "result": result, "reason": "empty prior day"}
