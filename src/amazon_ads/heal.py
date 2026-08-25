"""Detect and backfill missing Sponsored Brands / Display campaign days.

Nightly sync soft-fails SB/SD independently of SP. When a 7-day SB chunk times
out, the whole window can land as SP-only — which is exactly the ~6% spend gap
vs Seller Central. This module finds those gaps and re-pulls only SB/SD.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

log = logging.getLogger(__name__)

AD_PRODUCTS = ("SP", "SB", "SD")


def missing_product_days(
    rows: list[dict],
    *,
    as_of: date,
    lookback_days: int = 7,
    required: tuple[str, ...] = ("SB", "SD"),
) -> dict[str, list[date]]:
    """Return dates that have SP (or any spend) but lack a required product.

    A product is only required if it appears on *some* day in the window —
    accounts with no Display spend should not be flagged for missing SD.
    """
    start = as_of - timedelta(days=lookback_days - 1)
    by_date: dict[date, set[str]] = {}
    present_anywhere: set[str] = set()

    for r in rows:
        raw = r.get("date")
        if raw is None:
            continue
        d = date.fromisoformat(str(raw)[:10]) if not isinstance(raw, date) else raw
        if d < start or d > as_of:
            continue
        t = str(r.get("campaign_type") or "SP").strip().upper() or "SP"
        by_date.setdefault(d, set()).add(t)
        present_anywhere.add(t)

    needed = [p for p in required if p in present_anywhere]
    # If nothing in the window has SB/SD yet, require them when SP exists —
    # this account historically runs both; a fresh SP-only week is the bug.
    if not needed and any("SP" in types for types in by_date.values()):
        needed = list(required)

    missing: dict[str, list[date]] = {p: [] for p in needed}
    cursor = start
    while cursor <= as_of:
        types = by_date.get(cursor, set())
        if types:  # only flag days that have *some* campaign data
            for p in needed:
                if p not in types:
                    missing[p].append(cursor)
        cursor += timedelta(days=1)

    return {p: days for p, days in missing.items() if days}


def heal_window(missing: dict[str, list[date]]) -> tuple[date, date] | None:
    """Smallest inclusive date range covering all missing days."""
    days: list[date] = []
    for ds in missing.values():
        days.extend(ds)
    if not days:
        return None
    return min(days), max(days)


def sync_missing_sb_sd(
    *,
    lookback_days: int | None = None,
    chunk_days: int | None = None,
    on_progress=None,
) -> dict:
    """Find SP-only gaps in the lookback and re-pull SB/SD for that range."""
    from src.amazon_ads.reports import sync_ads
    from src.db import get_client
    from src.rules import (
        ADS_SB_SD_CHUNK_DAYS,
        ADS_SB_SD_DAILY_DAYS,
        amazon_as_of,
        window_start,
    )

    as_of = amazon_as_of()
    days = lookback_days or ADS_SB_SD_DAILY_DAYS
    start = window_start(as_of, days)
    chunk = chunk_days or ADS_SB_SD_CHUNK_DAYS

    client = get_client()
    rows: list[dict] = []
    offset = 0
    while True:
        page = (client.table("ads_campaigns_daily")
                .select("date,campaign_type")
                .gte("date", start.isoformat())
                .lte("date", as_of.isoformat())
                .range(offset, offset + 999)
                .execute().data) or []
        rows.extend(page)
        if len(page) < 1000:
            break
        offset += 1000

    missing = missing_product_days(
        rows, as_of=as_of, lookback_days=days, required=("SB", "SD"))
    window = heal_window(missing)
    if not window:
        return {
            "healed": False,
            "reason": "no gaps",
            "as_of": as_of.isoformat(),
            "lookback_days": days,
            "missing": {},
        }

    win_start, win_end = window
    # Always pull through as_of so a hole behind yesterday still lands under
    # the same end date sync_ads uses (amazon_as_of).
    span = (as_of - win_start).days + 1
    products = tuple(sorted(missing.keys()))
    say = on_progress or (lambda m: None)
    say(f"Ads heal: missing { {k: [d.isoformat() for d in v] for k, v in missing.items()} }")
    say(f"Ads heal: pulling {','.join(products)} for {win_start} → {as_of} "
        f"({span}d, {chunk}d chunks)")

    result = sync_ads(
        days=span,
        campaigns_only=True,
        ad_products=products,
        campaign_chunk_days=chunk,
        sb_sd_days=span,
        on_progress=on_progress,
    )
    return {
        "healed": True,
        "as_of": as_of.isoformat(),
        "lookback_days": days,
        "missing": {k: [d.isoformat() for d in v] for k, v in missing.items()},
        "window": {"start": win_start.isoformat(), "end": win_end.isoformat()},
        "products": list(products),
        "chunk_days": chunk,
        "result": result,
    }
