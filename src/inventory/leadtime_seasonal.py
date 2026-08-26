"""Seasonal inbound lead times — late Q3/Q4 delays, learning from monthly history.

Amazon AWD list data currently starts Feb 2026 (replen) / Apr 2026 (inbound).
The only Dec-2025 inbound row is a 230-day stale shipment and is dropped.
Until we have the same month last year, calendar priors cover Sep–Jan.
Each calibrate persists monthly p75 so next year those months use measured ratios.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from statistics import median
from typing import Any

log = logging.getLogger(__name__)

LEAD_MIN_DAYS = 4
LEAD_MAX_DAYS = 45
LOOKAHEAD_DAYS = 30
MIN_MONTH_N = 3

# Late Q3 / Q4 receiving runs long (AWD check-in + AWD→FBA).
# Jan 1–15 still carries post-holiday FC congestion; after the 15th it drops.
CALENDAR_PRIORS: dict[int, float] = {
    1: 1.15,
    2: 1.00,
    3: 1.00,
    4: 1.00,
    5: 1.00,
    6: 1.00,
    7: 1.00,
    8: 1.10,
    9: 1.25,
    10: 1.35,
    11: 1.50,
    12: 1.55,
}

OFFPEAK_MONTHS = frozenset({2, 3, 4, 5, 6, 7})

_SNAPSHOT_CACHE: tuple[str, dict] | None = None


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def day_span(start: Any, end: Any) -> int | None:
    a = _parse_dt(start)
    b = _parse_dt(end)
    if a is None or b is None or b < a:
        return None
    return int(round((b - a).total_seconds() / 86_400))


def percentile_inclusive(vals: list[int], p: float) -> int | None:
    nums = sorted(n for n in vals if LEAD_MIN_DAYS <= n <= LEAD_MAX_DAYS)
    if not nums:
        return None
    idx = min(len(nums) - 1, int((len(nums) - 1) * p))
    return int(nums[idx])


def calendar_prior(d: date) -> float:
    if d.month == 1 and d.day > 15:
        return 1.0
    return CALENDAR_PRIORS.get(d.month, 1.0)


def apply_factor(base: int | None, factor: float, cap: int | None = None) -> int | None:
    if base is None or base <= 0:
        return None
    days = max(1, int(round(base * factor)))
    if cap is not None and cap > 0:
        days = min(days, cap)
    return days


def window_label(factor: float) -> str:
    if factor <= 1.02:
        return "off-peak"
    if factor < 1.30:
        return "ramp"
    return "peak"


def _clean_spans(
    rows: list[dict],
    start_key: str,
    end_key: str,
    status_key: str,
    ok_status: str,
    months: frozenset[int] | None = None,
) -> list[tuple[date, int]]:
    out: list[tuple[date, int]] = []
    for r in rows:
        if (r.get(status_key) or "").upper() != ok_status:
            continue
        start = _parse_dt(r.get(start_key))
        days = day_span(r.get(start_key), r.get(end_key))
        if start is None or days is None:
            continue
        if months is not None and start.month not in months:
            continue
        if LEAD_MIN_DAYS <= days <= LEAD_MAX_DAYS:
            out.append((start.date(), days))
    return out


def monthly_stats_from_rows(
    inbound_rows: list[dict],
    replen_rows: list[dict],
) -> list[dict]:
    by_month: dict[str, dict[str, list[int]]] = {}
    for created, days in _clean_spans(
        inbound_rows, "created_at", "closed_at", "shipment_status", "CLOSED",
    ):
        key = created.strftime("%Y-%m")
        by_month.setdefault(key, {"inbound": [], "replen": []})["inbound"].append(days)
    for created, days in _clean_spans(
        replen_rows, "created_at", "completed_at", "order_status", "SUCCESS",
    ):
        key = created.strftime("%Y-%m")
        by_month.setdefault(key, {"inbound": [], "replen": []})["replen"].append(days)

    rows: list[dict] = []
    for ym in sorted(by_month):
        inbound = by_month[ym]["inbound"]
        replen = by_month[ym]["replen"]
        in_p50 = int(median(inbound)) if inbound else None
        in_p75 = percentile_inclusive(inbound, 0.75)
        rep_p50 = int(median(replen)) if replen else None
        rep_p75 = percentile_inclusive(replen, 0.75)
        recv = (in_p75 + rep_p75) if in_p75 is not None and rep_p75 is not None else in_p75 or rep_p75
        rows.append({
            "year_month": ym,
            "inbound_p50": in_p50,
            "inbound_p75": in_p75,
            "inbound_n": len(inbound),
            "replenish_p50": rep_p50,
            "replenish_p75": rep_p75,
            "replenish_n": len(replen),
            "recv_p75": recv,
        })
    return rows


def persist_monthly_stats(
    inbound_rows: list[dict] | None = None,
    replen_rows: list[dict] | None = None,
) -> list[dict]:
    """Write inventory_leadtime_monthly. Best-effort if the table is missing."""
    try:
        from src.db import fetch_all, upsert_rows
        if inbound_rows is None:
            inbound_rows = fetch_all("inventory_awd_inbound_shipments")
        if replen_rows is None:
            replen_rows = fetch_all("inventory_awd_replenishments")
    except Exception as e:
        log.warning("leadtime monthly load skipped: %s", e)
        return []

    rows = monthly_stats_from_rows(inbound_rows, replen_rows)
    if not rows:
        return []
    try:
        from src.db import upsert_rows
        upsert_rows("inventory_leadtime_monthly", rows, on_conflict="year_month")
    except Exception as e:
        log.warning("leadtime monthly persist skipped: %s", e)
    return rows


def load_monthly_history() -> list[dict]:
    try:
        from src.db import fetch_all
        rows = fetch_all("inventory_leadtime_monthly")
    except Exception:
        return []
    rows.sort(key=lambda r: r.get("year_month") or "")
    return rows


def _int(val: Any, default: int | None = None) -> int | None:
    if val is None:
        return default
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def offpeak_baseline(monthly: list[dict], observed_recv: int | None) -> int | None:
    vals = [
        _int(r.get("recv_p75"))
        for r in monthly
        if r.get("year_month") and int(str(r["year_month"])[5:7]) in OFFPEAK_MONTHS
        and (int(r.get("inbound_n") or 0) + int(r.get("replenish_n") or 0)) >= MIN_MONTH_N
        and _int(r.get("recv_p75"))
    ]
    vals = [v for v in vals if v]
    if vals:
        return int(median(vals))
    return observed_recv


def month_factor(
    d: date,
    monthly: list[dict],
    offpeak_recv: int | None,
) -> float:
    """Blend calendar prior with same-month history (this year or last year)."""
    prior = calendar_prior(d)
    if not monthly or not offpeak_recv or offpeak_recv <= 0:
        return prior

    by_ym = {str(r.get("year_month")): r for r in monthly if r.get("year_month")}
    this_ym = d.strftime("%Y-%m")
    last_ym = f"{d.year - 1}-{d.month:02d}"
    row = None
    weight_scale = 1.0
    if last_ym in by_ym and int(by_ym[last_ym].get("inbound_n") or 0) + int(
        by_ym[last_ym].get("replenish_n") or 0
    ) >= MIN_MONTH_N and by_ym[last_ym].get("recv_p75"):
        row = by_ym[last_ym]
        weight_scale = 1.0
    elif this_ym in by_ym and int(by_ym[this_ym].get("inbound_n") or 0) + int(
        by_ym[this_ym].get("replenish_n") or 0
    ) >= MIN_MONTH_N and by_ym[this_ym].get("recv_p75"):
        row = by_ym[this_ym]
        # In-progress month — don't overweight a partial sample.
        weight_scale = 0.5

    if row is None:
        return prior
    measured = float(row["recv_p75"]) / offpeak_recv
    if measured < 0.7 or measured > 2.5:
        return prior
    n_months = sum(1 for r in monthly if r.get("recv_p75"))
    w = min(0.8, n_months / 12) * weight_scale
    return (1.0 - w) * prior + w * measured


def lookahead_factor(
    today: date,
    monthly: list[dict],
    offpeak_recv: int | None,
    lookahead_days: int = LOOKAHEAD_DAYS,
) -> float:
    """Max month-factor from today through the inbound planning window."""
    best = month_factor(today, monthly, offpeak_recv)
    for offset in (15, 30, lookahead_days):
        best = max(best, month_factor(today + timedelta(days=offset), monthly, offpeak_recv))
    return round(best, 3)


def observed_from_rows(
    inbound_rows: list[dict],
    replen_rows: list[dict],
    months: frozenset[int] | None = None,
) -> dict[str, int | None]:
    inbound = [d for _, d in _clean_spans(
        inbound_rows, "created_at", "closed_at", "shipment_status", "CLOSED", months,
    )]
    replen = [d for _, d in _clean_spans(
        replen_rows, "created_at", "completed_at", "order_status", "SUCCESS", months,
    )]
    in_p75 = percentile_inclusive(inbound, 0.75)
    rep_p75 = percentile_inclusive(replen, 0.75)
    recv = (in_p75 + rep_p75) if in_p75 is not None and rep_p75 is not None else in_p75 or rep_p75
    return {
        "inbound_days": in_p75,
        "awd_to_fba_days": rep_p75,
        "receive_days": recv,
        "inbound_n": len(inbound),
        "replen_n": len(replen),
    }


def _recv_cap(settings: dict | None) -> int | None:
    if not settings:
        return 35
    return _int(settings.get("receiving_days_peak"), 35)


def build_seasonal_snapshot(
    settings: dict | None = None,
    today: date | None = None,
    inbound_rows: list[dict] | None = None,
    replen_rows: list[dict] | None = None,
    monthly: list[dict] | None = None,
) -> dict:
    """Observed p75 + seasonal planning leads. Safe with empty/missing DB."""
    today = today or date.today()
    settings = settings or {}

    if inbound_rows is None or replen_rows is None:
        try:
            from src.db import fetch_all
            if inbound_rows is None:
                inbound_rows = fetch_all("inventory_awd_inbound_shipments")
            if replen_rows is None:
                replen_rows = fetch_all("inventory_awd_replenishments")
        except Exception:
            inbound_rows = inbound_rows or []
            replen_rows = replen_rows or []

    if monthly is None:
        monthly = monthly_stats_from_rows(inbound_rows, replen_rows)
        stored = load_monthly_history()
        if stored:
            live = {r["year_month"]: r for r in monthly}
            for r in stored:
                live.setdefault(r["year_month"], r)
            monthly = [live[k] for k in sorted(live)]

    observed = observed_from_rows(inbound_rows, replen_rows)
    offpeak = observed_from_rows(inbound_rows, replen_rows, OFFPEAK_MONTHS)
    offpeak_recv = offpeak.get("receive_days") or offpeak_baseline(monthly, observed.get("receive_days"))
    offpeak_awd = offpeak.get("awd_to_fba_days") or observed.get("awd_to_fba_days")

    factor = lookahead_factor(today, monthly, offpeak_recv)
    cap = _recv_cap(settings)
    obs_recv = observed.get("receive_days")
    obs_awd = observed.get("awd_to_fba_days")
    base_recv = offpeak_recv or obs_recv
    base_awd = offpeak_awd or obs_awd

    plan_recv = apply_factor(base_recv, factor, cap)
    plan_awd = apply_factor(base_awd, factor, None)
    if plan_recv is not None and obs_recv is not None:
        plan_recv = max(plan_recv, obs_recv)
    if plan_awd is not None and obs_awd is not None:
        plan_awd = max(plan_awd, obs_awd)

    yms = [r["year_month"] for r in monthly if r.get("year_month")]
    yoy = any(
        r.get("year_month", "").startswith(str(today.year - 1))
        and int(str(r.get("year_month"))[5:7]) >= 9
        and r.get("recv_p75")
        for r in monthly
    )

    return {
        "as_of": today.isoformat(),
        "observed_receive_days": obs_recv,
        "observed_inbound_days": observed.get("inbound_days"),
        "observed_awd_to_fba_days": obs_awd,
        "observed_inbound_n": observed.get("inbound_n") or 0,
        "observed_replen_n": observed.get("replen_n") or 0,
        "offpeak_receive_days": offpeak_recv,
        "offpeak_awd_to_fba_days": offpeak_awd,
        "planning_receive_days": plan_recv,
        "planning_awd_to_fba_days": plan_awd,
        "factor": factor,
        "window": window_label(factor),
        "lookahead_days": LOOKAHEAD_DAYS,
        "history_months": len(yms),
        "history_span": f"{yms[0]} to {yms[-1]}" if yms else None,
        "yoy_available": yoy,
        "monthly": monthly,
        "note": (
            "Same-month last year is in the blend."
            if yoy
            else "No usable last-year Q4 yet (Dec 2025 inbound was a 230d stale row). "
            "Late Q3/Q4 uses calendar priors until those months fill in."
        ),
    }


def cached_seasonal_snapshot(
    settings: dict | None = None,
    today: date | None = None,
) -> dict:
    global _SNAPSHOT_CACHE
    today = today or date.today()
    key = today.isoformat()
    if _SNAPSHOT_CACHE and _SNAPSHOT_CACHE[0] == key:
        return _SNAPSHOT_CACHE[1]
    snap = build_seasonal_snapshot(settings=settings, today=today)
    _SNAPSHOT_CACHE = (key, snap)
    return snap


def planning_receive_days(
    base: int,
    settings: dict | None = None,
    today: date | None = None,
    on_date: date | None = None,
) -> int:
    """Scale a measured/configured receive days by the seasonal factor."""
    settings = settings or {}
    today = today or date.today()
    snap = cached_seasonal_snapshot(settings, today)
    monthly = snap.get("monthly") or []
    offpeak = snap.get("offpeak_receive_days")
    if on_date is not None:
        factor = month_factor(on_date, monthly, offpeak)
    else:
        factor = float(snap.get("factor") or 1.0)
    planned = apply_factor(base, factor, _recv_cap(settings))
    if planned is None:
        return base
    return max(base, planned)


def planning_awd_to_fba_days(
    base: int,
    settings: dict | None = None,
    today: date | None = None,
    on_date: date | None = None,
) -> int:
    settings = settings or {}
    today = today or date.today()
    snap = cached_seasonal_snapshot(settings, today)
    monthly = snap.get("monthly") or []
    offpeak = snap.get("offpeak_receive_days")
    if on_date is not None:
        factor = month_factor(on_date, monthly, offpeak)
    else:
        factor = float(snap.get("factor") or 1.0)
    planned = apply_factor(base, factor, None)
    if planned is None:
        return base
    return max(base, planned)
