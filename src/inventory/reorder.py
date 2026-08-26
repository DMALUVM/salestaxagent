"""Shared inventory reorder math.

The inventory page and pallet planner must use the same formula:

    reorder = max(ceil((cover_target + lead) × V30) − on_hand, 0)

Cover target is 90 days when holiday_mode is on, otherwise
``target_cover_days``. On-hand follows the inventory-page include flags
(FBA + optional inbound / 3PL / AWD).
"""
from __future__ import annotations

import calendar
import math
from datetime import date, timedelta


HOLIDAY_COVER_DAYS = 90


def cover_target_days(settings: dict) -> int:
    """Match the inventory page: holiday_mode → 90, else target_cover_days."""
    if settings.get("holiday_mode"):
        return HOLIDAY_COVER_DAYS
    try:
        return int(settings.get("target_cover_days") or 60)
    except (TypeError, ValueError):
        return 60


def inventory_on_hand(
    fba: int,
    inbound: int,
    awd: int,
    tpl: int,
    settings: dict | None = None,
) -> int:
    """Owned units counted toward reorder, same flags as /inventory."""
    s = settings or {}
    n = int(fba or 0)
    if s.get("include_inbound", True):
        n += int(inbound or 0)
    if s.get("include_3pl", True):
        n += int(tpl or 0)
    if s.get("include_awd", True) is not False:
        n += int(awd or 0)
    return n


def effective_lead_days_for_reorder(
    *,
    measured_receive_days: float | None,
    measured_replenish_days: float | None,
    fba_optimized_receive_median: float | None,
    fba_receive_median: float | None,
    awd_replenish_median: float | None,
    receiving_days_normal: int,
    awd_to_fba_days: int,
    awd_on_hand: int,
    fba_on_hand: int,
    inbound: int,
) -> int:
    """Lead used in (target + lead) × V30. Zero measured values are treated as missing."""
    fba = (
        measured_receive_days
        if measured_receive_days and measured_receive_days > 0
        else None
    )
    if fba is None:
        fba = fba_optimized_receive_median if fba_optimized_receive_median and fba_optimized_receive_median > 0 else None
    if fba is None:
        fba = fba_receive_median if fba_receive_median and fba_receive_median > 0 else None
    if fba is None:
        fba = receiving_days_normal

    awd = (
        measured_replenish_days
        if measured_replenish_days and measured_replenish_days > 0
        else None
    )
    if awd is None:
        awd = awd_replenish_median if awd_replenish_median and awd_replenish_median > 0 else None
    if awd is None:
        awd = awd_to_fba_days

    fba_i = int(round(float(fba)))
    awd_i = int(round(float(awd)))
    if awd_on_hand > 0 and awd_on_hand >= fba_on_hand + inbound:
        return max(fba_i, awd_i)
    return fba_i


def reorder_qty(
    target_days: int,
    lead_days: int,
    daily_velocity: float,
    on_hand: int,
) -> int:
    """Units to produce/transfer to hit cover + lead at daily velocity."""
    if daily_velocity <= 0:
        return 0
    return max(math.ceil((target_days + lead_days) * daily_velocity) - on_hand, 0)


def amazon_inventory_reorder(
    *,
    fba: int,
    inbound: int,
    awd: int,
    tpl: int,
    daily_velocity: float,
    settings: dict,
    measured_receive_days: float | None = None,
    measured_replenish_days: float | None = None,
    fba_optimized_receive_median: float | None = None,
    fba_receive_median: float | None = None,
    awd_replenish_median: float | None = None,
) -> dict:
    """Full inventory-page Amazon reorder for one SKU."""
    target = cover_target_days(settings)
    on_hand = inventory_on_hand(fba, inbound, awd, tpl, settings)
    lead = effective_lead_days_for_reorder(
        measured_receive_days=measured_receive_days,
        measured_replenish_days=measured_replenish_days,
        fba_optimized_receive_median=fba_optimized_receive_median,
        fba_receive_median=fba_receive_median,
        awd_replenish_median=awd_replenish_median,
        receiving_days_normal=int(settings.get("receiving_days_normal") or 14),
        awd_to_fba_days=int(settings.get("awd_to_fba_days") or 14),
        awd_on_hand=int(awd or 0),
        fba_on_hand=int(fba or 0),
        inbound=int(inbound or 0),
    )
    return {
        "target_days": target,
        "lead_days": lead,
        "on_hand": on_hand,
        "reorder_qty": reorder_qty(target, lead, daily_velocity, on_hand),
    }


def manufacture_need(inventory_reorder: int, holiday_manufacture: int) -> int:
    """Produce at least the inventory-page reorder and the holiday gap."""
    return max(int(inventory_reorder or 0), int(holiday_manufacture or 0))


AMAZON_IN_BY = "2026-10-31"
HOLIDAY_SHIP_MONTHS = ("2026-09", "2026-10")


def _parse_iso(s: str) -> date:
    return date.fromisoformat(str(s)[:10])


def latest_ship_date(amazon_in_by: str, lead_days: int) -> date:
    return _parse_iso(amazon_in_by) - timedelta(days=max(int(lead_days), 0))


def ship_by_for_amazon_deadline(
    month: str,
    amazon_in_by: str = AMAZON_IN_BY,
    lead_days: int = 19,
    default_day: int = 20,
) -> str:
    """Ship early enough that receiving lead still hits amazon_in_by."""
    y, mo = (int(p) for p in month.split("-"))
    last_day = calendar.monthrange(y, mo)[1]
    nominal = date(y, mo, min(default_day, last_day))
    latest = latest_ship_date(amazon_in_by, lead_days)
    first = date(y, mo, 1)
    last = date(y, mo, last_day)
    pick = min(nominal, latest)
    if pick < first:
        pick = first
    if pick > last:
        pick = last
    return pick.isoformat()


def month_can_arrive_by(
    month: str,
    amazon_in_by: str = AMAZON_IN_BY,
    lead_days: int = 19,
) -> bool:
    y, mo = (int(p) for p in month.split("-"))
    return date(y, mo, 1) <= latest_ship_date(amazon_in_by, lead_days)


def holiday_inbound_months(
    months: list[str],
    amazon_in_by: str = AMAZON_IN_BY,
    lead_days: int = 19,
) -> list[str]:
    preferred = [
        m for m in months
        if m in HOLIDAY_SHIP_MONTHS and month_can_arrive_by(m, amazon_in_by, lead_days)
    ]
    if preferred:
        return preferred
    for m in reversed(months):
        if month_can_arrive_by(m, amazon_in_by, lead_days):
            return [m]
    return months[:1]


def allocate_monthly_units(
    skus: list[str],
    inventory_reorder: dict[str, int],
    holiday_manufacture: dict[str, int],
    months: list[str],
    *,
    amazon_in_by: str = AMAZON_IN_BY,
    lead_days: int = 19,
) -> list[dict[str, int]]:
    """Current month = inventory reorder. Holiday surplus → Sep/Oct only.

    Nov/Dec/Jan units must ship in months that can still arrive by
    ``amazon_in_by`` (end of October) given receiving lead time.
    """
    if not months:
        return []

    holiday_months = holiday_inbound_months(months, amazon_in_by, lead_days)
    mixes: list[dict[str, int]] = [dict() for _ in months]

    for sku in skus:
        reorder = int(inventory_reorder.get(sku, 0) or 0)
        holiday = int(holiday_manufacture.get(sku, 0) or 0)
        mfg = manufacture_need(reorder, holiday)
        floor = min(reorder, mfg)
        mixes[0][sku] = floor
        leftover = mfg - floor
        if leftover <= 0:
            continue
        for hi, month in enumerate(holiday_months):
            try:
                mi = months.index(month)
            except ValueError:
                continue
            last = hi == len(holiday_months) - 1
            alloc = leftover if last else min(
                round(leftover / (len(holiday_months) - hi)), leftover,
            )
            if alloc > 0:
                mixes[mi][sku] = mixes[mi].get(sku, 0) + alloc
                leftover -= alloc
        if leftover > 0:
            mixes[0][sku] = mixes[0].get(sku, 0) + leftover

    return [{sku: qty for sku, qty in mix.items() if qty > 0} for mix in mixes]


PALLET_MAX_UNITS = 19_000
HOLIDAY_DAYS_NOV_DEC = 61
HOLIDAY_DAYS_NOV_JAN = 92
CRITICAL_DOS_DAYS = 60


def planning_daily(vel: dict | None) -> float:
    """Trough-resistant daily rate (planning_u_30 / V90 / holiday prior)."""
    v = vel or {}
    v30 = float(v.get("total_u_30") or 0)
    v90 = float(v.get("total_u_90") or 0)
    plan = float(v.get("planning_u_30") or 0)
    holiday = float(v.get("holiday_prior_daily") or 0)
    summer = float(v.get("summer_prior_daily") or 0)
    surge = float(v.get("holiday_surge_mult") or 1)
    baseline = max(v30, v90, summer)
    if plan > 0:
        return max(plan, baseline)
    if surge > 1 and holiday > 0:
        yoy = min(1.40, max(0.75, baseline / summer)) if summer > 0.01 else 1.0
        return max(baseline, holiday * yoy)
    return max(baseline, v30)


def holiday_demand_with_planning(
    forecast_units: float,
    daily_planning: float,
    include_jan: bool = True,
) -> int:
    days = HOLIDAY_DAYS_NOV_JAN if include_jan else HOLIDAY_DAYS_NOV_DEC
    return max(round(float(forecast_units or 0)), round(float(daily_planning or 0) * days))


# Canonical holiday sell-through months the Sep/Oct pallets cover.
# January aliases include 2026-01 so leftover forecast keys still roll in.
HOLIDAY_DEMAND_MONTHS: tuple[tuple[str, str, int, tuple[str, ...]], ...] = (
    ("2026-11", "November 2026", 30, ("2026-11",)),
    ("2026-12", "December 2026", 31, ("2026-12",)),
    ("2027-01", "January 2027", 31, ("2027-01", "2026-01")),
)


def forecast_by_holiday_month(
    fc_rows: list[dict],
    sku: str,
    scenario: str,
) -> dict[str, int]:
    """Raw forecast_weekly units by Nov / Dec / Jan for one SKU."""
    totals: dict[str, float] = {key: 0.0 for key, *_ in HOLIDAY_DEMAND_MONTHS}
    alias_to_key: dict[str, str] = {}
    for key, _label, _days, aliases in HOLIDAY_DEMAND_MONTHS:
        for alias in aliases:
            alias_to_key[alias] = key
    for r in fc_rows:
        if r.get("sku") != sku or r.get("scenario") != scenario:
            continue
        month = str(r.get("week_start", ""))[:7]
        key = alias_to_key.get(month)
        if key:
            totals[key] += float(r.get("units", 0) or 0)
    return {k: round(v) for k, v in totals.items()}


def holiday_month_plan(
    forecast_by_month: dict[str, int],
    daily_planning: float,
    include_jan: bool = True,
) -> dict:
    """Per-month forecast + planning floor, plus the combined planned total.

    Manufacture still uses ``holiday_demand_with_planning`` on the 92-day
    total. Monthly floors are visibility so a trough month is obvious.
    """
    months: list[dict] = []
    forecast_total = 0
    specs = HOLIDAY_DEMAND_MONTHS if include_jan else HOLIDAY_DEMAND_MONTHS[:2]
    for key, label, days, _aliases in specs:
        forecast = int(forecast_by_month.get(key, 0) or 0)
        floor = round(float(daily_planning or 0) * days)
        months.append({
            "month": key,
            "label": label,
            "days": days,
            "forecast": forecast,
            "floor": floor,
            "planned": max(forecast, floor),
        })
        forecast_total += forecast
    planned_total = holiday_demand_with_planning(
        forecast_total, daily_planning, include_jan,
    )
    return {
        "months": months,
        "forecast_total": forecast_total,
        "planned_total": planned_total,
        "floor_total": round(float(daily_planning or 0) * (
            HOLIDAY_DAYS_NOV_JAN if include_jan else HOLIDAY_DAYS_NOV_DEC
        )),
    }


def days_of_supply(fba: int, daily_velocity: float) -> int:
    if daily_velocity <= 0.001:
        return 9999 if fba > 0 else 0
    return round(fba / daily_velocity)


def inventory_flag(dos: int, daily_velocity: float) -> str:
    if daily_velocity > 0.001 and dos < CRITICAL_DOS_DAYS:
        return "CRITICAL"
    return "OK"


def sku_pack_priority(
    skus: list[str],
    flags: dict[str, str],
    reorders: dict[str, int],
) -> list[str]:
    return sorted(
        skus,
        key=lambda s: (0 if flags.get(s) == "CRITICAL" else 1, -(reorders.get(s, 0) or 0)),
    )


def month_pallet_fill_pct(
    units: int,
    pallet_count: int,
    pallet_max: int = PALLET_MAX_UNITS,
) -> int:
    slots = max(pallet_count, 1) * pallet_max
    if units <= 0:
        return 0
    return round(100 * units / slots)


def pack_pallets(
    mix: dict[str, int],
    priority: list[str],
    pallet_max: int = PALLET_MAX_UNITS,
) -> list[dict]:
    """Split a month mix into 19k-carton pallets. CRITICAL / high reorder first."""
    remaining = {sku: int(qty) for sku, qty in mix.items() if int(qty or 0) > 0}
    order = list(priority)
    for sku in remaining:
        if sku not in order:
            order.append(sku)

    pallets: list[dict] = []
    while any(q > 0 for q in remaining.values()):
        room = pallet_max
        pallet_mix: dict[str, int] = {}
        for sku in order:
            qty = remaining.get(sku, 0)
            if qty <= 0 or room <= 0:
                continue
            take = min(qty, room)
            pallet_mix[sku] = take
            remaining[sku] = qty - take
            room -= take
        units = sum(pallet_mix.values())
        if units <= 0:
            break
        pallets.append({
            "pallet_num": len(pallets) + 1,
            "mix": pallet_mix,
            "total_units": units,
        })
    return pallets
