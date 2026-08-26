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
# Last pallet can land mid-to-late November so August does not need a
# second pallet (storage while velocity is still slow).
LAST_INBOUND_BY = "2026-11-25"
HOLIDAY_PRODUCTION_THROUGH = "2026-11"
HOLIDAY_SHIP_MONTHS = ("2026-09", "2026-10", "2026-11")
PALLET_MAX_UNITS = 19_000


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
    """Months that can still arrive by ``amazon_in_by``."""
    capable = [
        m for m in months if month_can_arrive_by(m, amazon_in_by, lead_days)
    ]
    if capable:
        return capable
    return months[:1]


def holiday_leftover_months(
    months: list[str],
    last_inbound_by: str = LAST_INBOUND_BY,
    lead_days: int = 19,
) -> list[str]:
    """Months that take holiday leftover after the current-month reorder.

    Skips month 0 when a later month can still land by ``last_inbound_by``
    so August does not open a second pallet for storage during slow
    velocity. November is eligible at 19–20d Recv (arrive ~mid-Nov).
    """
    capable = holiday_inbound_months(months, last_inbound_by, lead_days)
    if len(capable) > 1 and months and capable[0] == months[0]:
        return capable[1:]
    return capable


def holiday_production_months(
    today: date | None = None,
    through: str = HOLIDAY_PRODUCTION_THROUGH,
) -> list[str]:
    """Current month through the last inbound month (Nov 2026)."""
    start = today or date.today()
    cursor = start.replace(day=1)
    end_y, end_m = (int(p) for p in through.split("-"))
    end = date(end_y, end_m, 1)
    if cursor > end:
        return [start.strftime("%Y-%m")]
    months: list[str] = []
    while cursor <= end:
        months.append(cursor.strftime("%Y-%m"))
        if cursor.month == 12:
            cursor = cursor.replace(year=cursor.year + 1, month=1)
        else:
            cursor = cursor.replace(month=cursor.month + 1)
    return months


def inbound_deadline_for_month(
    month: str,
    lead_days: int = 19,
    majority_by: str = AMAZON_IN_BY,
    last_inbound_by: str = LAST_INBOUND_BY,
) -> str:
    """Oct 31 if this month can still hit it; otherwise the late-inbound date."""
    if month_can_arrive_by(month, majority_by, lead_days):
        return majority_by
    return last_inbound_by


def spill_over_pallet_cap(
    mixes: list[dict[str, int]],
    protected: dict[str, int],
    month_index: int = 0,
    pallet_max: int = PALLET_MAX_UNITS,
    max_pallets: int = 1,
) -> list[dict[str, int]]:
    """Move unprotected units off a month so it stays at ``max_pallets``.

    Inventory reorder on month 0 is never reduced. Excess holiday share
    goes to later months (round-robin).
    """
    if month_index >= len(mixes):
        return mixes
    cap = pallet_max * max_pallets
    total = sum(int(q or 0) for q in mixes[month_index].values())
    excess = total - cap
    later = list(range(month_index + 1, len(mixes)))
    if excess <= 0 or not later:
        return mixes
    skus = sorted(
        mixes[month_index].keys(),
        key=lambda s: max(
            0,
            int(mixes[month_index].get(s, 0) or 0)
            - int(protected.get(s, 0) or 0),
        ),
        reverse=True,
    )
    dest_i = 0
    for sku in skus:
        if excess <= 0:
            break
        have = int(mixes[month_index].get(sku, 0) or 0)
        keep = int(protected.get(sku, 0) or 0)
        take = min(max(0, have - keep), excess)
        if take <= 0:
            continue
        mixes[month_index][sku] = have - take
        if mixes[month_index][sku] <= 0:
            mixes[month_index].pop(sku, None)
        dest = later[dest_i % len(later)]
        mixes[dest][sku] = mixes[dest].get(sku, 0) + take
        dest_i += 1
        excess -= take
    return mixes


def fill_month_toward_pallet(
    mixes: list[dict[str, int]],
    priority: list[str],
    pallet_max: int = PALLET_MAX_UNITS,
    target_index: int = 0,
) -> list[dict[str, int]]:
    """Pull units from later months into the target month up to one pallet.

    Later months are drained last-first (October before September) so a
    trailing month can drop from two pallets to one. CRITICAL / highest
    reorder SKUs move first. Inventory reorder already sitting on month 0
    is never reduced.
    """
    if not mixes or target_index >= len(mixes):
        return mixes
    room = pallet_max - sum(int(q or 0) for q in mixes[target_index].values())
    if room <= 0:
        return mixes
    order = list(priority)
    for mix in mixes:
        for sku in mix:
            if sku not in order:
                order.append(sku)
    for mi in range(len(mixes) - 1, target_index, -1):
        if room <= 0:
            break
        for sku in order:
            have = int(mixes[mi].get(sku, 0) or 0)
            if have <= 0:
                continue
            take = min(have, room)
            mixes[mi][sku] = have - take
            if mixes[mi][sku] <= 0:
                mixes[mi].pop(sku, None)
            mixes[target_index][sku] = mixes[target_index].get(sku, 0) + take
            room -= take
            if room <= 0:
                break
    return mixes


def allocate_monthly_units(
    skus: list[str],
    inventory_reorder: dict[str, int],
    holiday_manufacture: dict[str, int],
    months: list[str],
    *,
    amazon_in_by: str = AMAZON_IN_BY,
    last_inbound_by: str = LAST_INBOUND_BY,
    lead_days: int = 19,
    priority: list[str] | None = None,
    fill_first_pallet: bool = False,
    max_first_pallets: int = 1,
) -> list[dict[str, int]]:
    """Current month = inventory reorder only when later months can land.

    Holiday leftover goes to Sep/Oct/Nov (anything that can still arrive
    by ``last_inbound_by``) so August stays at one pallet and does not
    sit in FBA storage while velocity is still slow. ``amazon_in_by`` is
    the majority deadline (Halloween). Optional freight-fill is off.
    """
    _ = amazon_in_by
    if not months:
        return []

    leftover_months = holiday_leftover_months(months, last_inbound_by, lead_days)
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
        for hi, month in enumerate(leftover_months):
            try:
                mi = months.index(month)
            except ValueError:
                continue
            last = hi == len(leftover_months) - 1
            alloc = leftover if last else min(
                round(leftover / (len(leftover_months) - hi)), leftover,
            )
            if alloc > 0:
                mixes[mi][sku] = mixes[mi].get(sku, 0) + alloc
                leftover -= alloc
        if leftover > 0:
            mixes[0][sku] = mixes[0].get(sku, 0) + leftover

    if max_first_pallets > 0:
        spill_over_pallet_cap(
            mixes, inventory_reorder, 0,
            pallet_max=PALLET_MAX_UNITS,
            max_pallets=max_first_pallets,
        )

    if fill_first_pallet:
        order = list(priority) if priority else sku_pack_priority(
            skus, {}, inventory_reorder,
        )
        fill_month_toward_pallet(mixes, order)

    return [{sku: qty for sku, qty in mix.items() if qty > 0} for mix in mixes]


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
# 2026-01 is a PROXY for January 2027 only when 2027-01 is missing.
HOLIDAY_DEMAND_MONTHS: tuple[tuple[str, str, int, tuple[str, ...]], ...] = (
    ("2026-11", "November 2026", 30, ("2026-11",)),
    ("2026-12", "December 2026", 31, ("2026-12",)),
    ("2027-01", "January 2027", 31, ("2027-01",)),
)
JANUARY_PROXY_MONTH = "2026-01"
HOLIDAY_FORECAST_SCENARIOS = (
    "correction_factor",
    "actual_2025",
    "optimistic",
)


def forecast_by_holiday_month(
    fc_rows: list[dict],
    sku: str,
    scenario: str,
    *,
    jan_proxy: bool = True,
) -> dict[str, int]:
    """Raw forecast_weekly units by Nov / Dec / Jan for one SKU.

    January 2026 weeks are a proxy for January 2027 only when no 2027-01
    rows exist. They are never mixed into November or December.
    """
    totals: dict[str, float] = {key: 0.0 for key, *_ in HOLIDAY_DEMAND_MONTHS}
    proxy_jan = 0.0
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
        elif month == JANUARY_PROXY_MONTH:
            proxy_jan += float(r.get("units", 0) or 0)
    if jan_proxy and totals.get("2027-01", 0) <= 0 and proxy_jan > 0:
        totals["2027-01"] = proxy_jan
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
            "planned": forecast,
        })
        forecast_total += forecast
    planned_total = holiday_demand_with_planning(
        forecast_total, daily_planning, include_jan,
    )
    leftover = planned_total - forecast_total
    if leftover > 0 and months:
        # Missing January (or a trough month) gets the 92-day floor residual
        # so Nov+Dec+Jan always sum to the manufacture input.
        months[-1]["planned"] = months[-1]["forecast"] + leftover
    return {
        "months": months,
        "forecast_total": forecast_total,
        "planned_total": planned_total,
        "floor_total": round(float(daily_planning or 0) * (
            HOLIDAY_DAYS_NOV_JAN if include_jan else HOLIDAY_DAYS_NOV_DEC
        )),
        "jan_is_proxy": bool(
            include_jan and any(
                m["month"] == "2027-01" and m["forecast"] > 0 for m in months
            )
        ),
    }


def holiday_demand_covering_projections(
    fc_rows: list[dict],
    sku: str,
    daily_planning: float,
) -> dict:
    """Do-not-underbuild holiday demand across every forecast scenario.

    Per month: max(scenario forecasts, planning floor for that month).
    Planned total is the sum of those months, at least planning × 92.
    """
    by_scenario: dict[str, dict[str, int]] = {}
    best: dict[str, int] = {key: 0 for key, *_ in HOLIDAY_DEMAND_MONTHS}
    for scenario in HOLIDAY_FORECAST_SCENARIOS:
        fc = forecast_by_holiday_month(fc_rows, sku, scenario)
        by_scenario[scenario] = fc
        for key in best:
            best[key] = max(best[key], int(fc.get(key, 0) or 0))

    months: list[dict] = []
    planned_total = 0
    forecast_total = 0
    for key, label, days, _aliases in HOLIDAY_DEMAND_MONTHS:
        forecast = best[key]
        floor = round(float(daily_planning or 0) * days)
        planned = max(forecast, floor)
        months.append({
            "month": key,
            "label": label,
            "days": days,
            "forecast": forecast,
            "floor": floor,
            "planned": planned,
        })
        planned_total += planned
        forecast_total += forecast
    floor_total = round(float(daily_planning or 0) * HOLIDAY_DAYS_NOV_JAN)
    planned_total = max(planned_total, floor_total)
    return {
        "months": months,
        "forecast_total": forecast_total,
        "planned_total": planned_total,
        "floor_total": floor_total,
        "by_scenario": by_scenario,
        "covers_scenarios": list(HOLIDAY_FORECAST_SCENARIOS),
        "jan_is_proxy": any(
            (by_scenario.get(sc, {}).get("2027-01") or 0) > 0
            for sc in HOLIDAY_FORECAST_SCENARIOS
        ),
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
