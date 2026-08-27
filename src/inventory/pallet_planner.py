"""Lip Balm Monthly Pallet Planner.

Computes how many pallets of mixed SKUs need to be produced and shipped
so that all Nov+Dec forecast demand is in Amazon (FBA) by a target date.

Also projects weekly FBA on-hand through the holiday season and flags
any week where forward cover drops below the 60-day service target.

Config defaults:
  pallet_max_units = 19,000
  amazon_in_by = 2026-10-31
  scenario = correction_factor
  include_3pl_transfer = True  (3PL stock counts if transferred by target)
  include_awd = True
  cover_target_days = 60
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from collections import defaultdict

from src.channels import AMAZON, is_quarantined_source
from src.db import fetch_all
from src.inventory.holiday_surge import normalize_sku
from src.rules import AMAZON_PULSE_SOURCE

LIP_BALM_SKUS = ["DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"]
ASSORTED_SKU = "DDPE0004Shop"

# Marpac pallet: 19,000 cartons / 270 per 13×11×9 box.
# Two full + one ≥50% partial is fine. Under half is merge-or-hold, not a card.
PALLET_MAX_UNITS = 19_000
PALLET_PARTIAL_MIN_RATIO = 0.5
CARTONS_PER_BOX = 270
AMAZON_IN_BY_DEFAULT = date(2026, 10, 31)
DEFAULT_RECEIVING_DAYS = 18
# Pallet-planner YoY window: each SKU's own May–Jul Amazon sales_by_sku.
# Family 1.42× is context only — never a blended multiplier.
# Uncapped — not the replen planning_daily 1.40 cap.
YOY_WINDOW_MONTHS = (5, 6, 7)
DEMAND_METHOD = "sku_2025_same_month_x_sku_may_jul_yoy"
# Assorted holiday *display* uses workbook correction_factor (same Nov–Jan
# window as the holiday sheet). Optimistic is stock-to-cover, not display.
# Workbook January weeks may be dated onto 2026-01.
WORKBOOK_WINDOW_MONTHS = frozenset({"2026-11", "2026-12", "2026-01", "2027-01"})
# Production cards = demand + peak-60d + Tulsa floor + receive pipeline.
# Not holidayDemand sell-through alone. Family 3PL floor — not a per-SKU mix.
TULSA_LIP_FLOOR_UNITS = 5_000
PEAK_START_DEFAULT = date(2026, 10, 1)
PEAK_END_DEFAULT = date(2027, 1, 15)
EARLY_FEB_COVER_THROUGH = date(2027, 2, 14)
CHRISTMAS_2026 = date(2026, 12, 25)
DEC_DAYS = 31
JAN_DAYS = 31
ACTUAL_2025_SOURCE = (
    "forecast_weekly scenario=actual_2025 is the holiday workbook's weekly "
    "'2025 actual' column, dated onto 2026 week_start. It is not Amazon "
    "monthly sales_by_sku (and does not match Sep/Oct/Nov–Dec 2025 totals)."
)

DEFAULTS = {
    "pallet_max_units": PALLET_MAX_UNITS,
    "amazon_in_by": AMAZON_IN_BY_DEFAULT.isoformat(),
    "scenario": "sales_yoy",
    "include_3pl_transfer": True,
    "include_awd": True,
    "receiving_days": DEFAULT_RECEIVING_DAYS,
}


def _parse_period_start(value) -> date | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def is_amazon_pulse_row(row: dict) -> bool:
    """Amazon sales_by_sku pulse row — never quarantined tax sources."""
    channel = (row.get("channel") or "").strip().lower()
    source = (row.get("source") or "").strip().lower()
    if channel != AMAZON:
        return False
    if is_quarantined_source(source):
        return False
    return source in {AMAZON_PULSE_SOURCE, "amazon_spapi"}


def monthly_amazon_units(
    sales_rows: list[dict],
    skus: list[str] | None = None,
) -> dict[tuple[str, int, int], int]:
    """Sum Amazon pulse sales_by_sku across states. Key: (norm_sku, year, month)."""
    wanted = {normalize_sku(s) for s in (skus or LIP_BALM_SKUS)}
    totals: dict[tuple[str, int, int], int] = defaultdict(int)
    for r in sales_rows:
        if not is_amazon_pulse_row(r):
            continue
        key = normalize_sku(r.get("sku"))
        if key not in wanted:
            continue
        ps = _parse_period_start(r.get("period_start"))
        if not ps:
            continue
        totals[(key, ps.year, ps.month)] += int(r.get("units") or 0)
    return dict(totals)


def sku_yoy_may_jul(
    monthly: dict[tuple[str, int, int], int],
    sku: str,
    *,
    current_year: int = 2026,
    prior_year: int = 2025,
    months: tuple[int, ...] = YOY_WINDOW_MONTHS,
) -> dict:
    """That SKU's May–Jul Amazon units current / prior. Never a family blend.

    Same calculation for every SKU. Missing prior window → 1.0 (not family YoY).
    """
    key = normalize_sku(sku)
    prior = sum(monthly.get((key, prior_year, m), 0) for m in months)
    current = sum(monthly.get((key, current_year, m), 0) for m in months)
    yoy = (current / prior) if prior > 0 else 1.0
    return {
        "sku": sku,
        "yoy": yoy,
        "prior_units": prior,
        "current_units": current,
        "prior_year": prior_year,
        "current_year": current_year,
        "months": list(months),
        "method": "sku_may_jul_amazon_sales_by_sku",
    }


def family_yoy_may_jul(
    monthly: dict[tuple[str, int, int], int],
    skus: list[str] | None = None,
    *,
    current_year: int = 2026,
    prior_year: int = 2025,
    months: tuple[int, ...] = YOY_WINDOW_MONTHS,
) -> dict:
    """Context only — family May–Jul ratio. Do not apply as a SKU multiplier."""
    wanted = [normalize_sku(s) for s in (skus or LIP_BALM_SKUS)]
    prior = sum(monthly.get((k, prior_year, m), 0) for k in wanted for m in months)
    current = sum(monthly.get((k, current_year, m), 0) for k in wanted for m in months)
    yoy = (current / prior) if prior > 0 else 1.0
    return {
        "yoy": yoy,
        "prior_units": prior,
        "current_units": current,
        "prior_year": prior_year,
        "current_year": current_year,
        "months": list(months),
        "method": "family_may_jul_context_only",
        "applied_to_skus": False,
    }


def forecast_same_month(
    monthly: dict[tuple[str, int, int], int],
    sku: str,
    forecast_year: int,
    month: int,
    yoy: float,
) -> int:
    """2026 month = that SKU's 2025 same-month Amazon units × that SKU's YoY.

    Never raw 2025-as-2026. Never a family blended factor.
    """
    key = normalize_sku(sku)
    prior = monthly.get((key, forecast_year - 1, month), 0)
    return int(round(prior * yoy))


def holiday_demand_from_sales(
    monthly: dict[tuple[str, int, int], int],
    skus: list[str],
    *,
    holiday_year: int = 2026,
    include_jan: bool = True,
    current_year: int = 2026,
    prior_year: int = 2025,
) -> dict[str, dict]:
    """Same per-SKU calc: each 2026 month = 2025 same month × that SKU's YoY.

    Keeps each SKU's own 2025 MoM shape. Does not copy another SKU's YoY
    or December spike. Does not hardcode volumes or lock a mix.
    """
    out: dict[str, dict] = {}
    for sku in skus:
        yoy_info = sku_yoy_may_jul(
            monthly, sku, current_year=current_year, prior_year=prior_year,
        )
        yoy = yoy_info["yoy"]
        months_2026 = {
            m: forecast_same_month(monthly, sku, holiday_year, m, yoy)
            for m in (9, 10, 11, 12)
        }
        nov_dec_prior = (
            monthly.get((normalize_sku(sku), holiday_year - 1, 11), 0)
            + monthly.get((normalize_sku(sku), holiday_year - 1, 12), 0)
        )
        nov_dec = months_2026[11] + months_2026[12]
        jan_prior = monthly.get((normalize_sku(sku), holiday_year, 1), 0)
        jan = (
            forecast_same_month(monthly, sku, holiday_year + 1, 1, yoy)
            if include_jan else 0
        )
        out[sku] = {
            "nov_dec_prior": nov_dec_prior,
            "nov_dec_demand": nov_dec,
            "jan_prior": jan_prior,
            "jan_demand": jan,
            "holiday_demand": nov_dec + jan,
            "yoy": yoy,
            "yoy_method": yoy_info["method"],
            "display_method": DEMAND_METHOD,
            "months_2026": months_2026,
        }
    return out


def workbook_window_units(
    fc_rows: list[dict],
    sku: str,
    scenario: str,
    months: frozenset[str] | None = None,
) -> int:
    """Sum forecast_weekly for one SKU/scenario in the holiday-sheet window.

    Window matches the holiday sheet: Nov + Dec + Jan (2026-01 and 2027-01
    both accepted — workbook January weeks may be dated onto 2026).
    Never use optimistic totals as displayed demand.
    """
    wanted = months or WORKBOOK_WINDOW_MONTHS
    total = 0.0
    for r in fc_rows:
        if r.get("scenario") != scenario:
            continue
        if r.get("sku") != sku:
            continue
        ws = str(r.get("week_start", ""))[:7]
        if ws in wanted:
            total += float(r.get("units", 0) or 0)
    return int(round(total))


def apply_assorted_correction_display(
    demand: dict[str, dict],
    fc_rows: list[dict] | None,
) -> dict[str, dict]:
    """Assorted DDPE0004 only: scale Nov+Dec+Jan display to workbook CF.

    Keeps that SKU's own 2025 MoM shape. Other SKUs stay 2025 × own YoY.
    Missing CF → leave YoY (do not invent a number). Never land optimistic
    as the displayed forecast.
    """
    if not fc_rows or ASSORTED_SKU not in demand:
        return demand
    cf = workbook_window_units(fc_rows, ASSORTED_SKU, "correction_factor")
    row = demand[ASSORTED_SKU]
    current = int(row.get("holiday_demand", 0) or 0)
    if cf <= 0 or current <= 0:
        return demand
    scale = cf / current
    months = dict(row.get("months_2026") or {})
    nov = int(round(int(months.get(11, 0) or 0) * scale))
    dec = int(round(int(months.get(12, 0) or 0) * scale))
    jan = int(round(int(row.get("jan_demand", 0) or 0) * scale))
    # Nudge December so the holiday window lands on CF (not optimistic).
    dec += cf - (nov + dec + jan)
    months[11] = nov
    months[12] = dec
    out = dict(demand)
    out[ASSORTED_SKU] = {
        **row,
        "months_2026": months,
        "nov_dec_demand": nov + dec,
        "jan_demand": jan,
        "holiday_demand": nov + dec + jan,
        "display_method": "assorted_correction_factor_scaled",
        "correction_factor_units": cf,
        "yoy_holiday_before_cf": current,
    }
    return out


def cover_units_from_daily(daily: float, cover_days: int) -> int:
    """Days-of-supply units from a daily rate. Not a hardcoded recipe."""
    if daily <= 0 or cover_days <= 0:
        return 0
    return int(round(daily * cover_days))


def december_daily_rate(dec_units: int) -> float:
    """December 2026 daily = that SKU's Dec units / 31."""
    return max(int(dec_units), 0) / DEC_DAYS


def january_daily_rate(jan_units: int) -> float:
    """January prevailing daily = Jan 2026 × SKU May–Jul YoY / 31. Not 2.1×."""
    return max(int(jan_units), 0) / JAN_DAYS


def load_planner_policy(
    settings: dict | None = None,
    leadtime: dict | None = None,
) -> dict:
    """Cover + lead times from inventory_settings / inventory_leadtime_summary.

    Does not invent a second lead-time model. Holiday gate stays 2026-10-31.
    """
    from src.inventory.leadtime_effective import (
        effective_awd_to_fba_days,
        effective_fba_receive_days,
        load_leadtime_summary,
    )

    if settings is None:
        try:
            rows = fetch_all("inventory_settings")
            settings = rows[0] if rows else {}
        except Exception:
            settings = {}
    if leadtime is None:
        try:
            leadtime = load_leadtime_summary() or {}
        except Exception:
            leadtime = {}

    cover_days = int(settings.get("target_cover_days") or 60)
    recv_peak = int(settings.get("receiving_days_peak") or 35)
    recv_normal = int(settings.get("receiving_days_normal") or 28)
    awd_cfg = int(settings.get("awd_to_fba_days") or 14)
    peak_end_raw = settings.get("peak_end_date") or PEAK_END_DEFAULT.isoformat()
    peak_start_raw = settings.get("peak_start_date") or PEAK_START_DEFAULT.isoformat()
    try:
        peak_end = date.fromisoformat(str(peak_end_raw)[:10])
    except ValueError:
        peak_end = PEAK_END_DEFAULT
    try:
        peak_start = date.fromisoformat(str(peak_start_raw)[:10])
    except ValueError:
        peak_start = PEAK_START_DEFAULT

    # Q4 / early January (peak_start→peak_end) MUST use receiving_days_peak.
    # Measured FBA median (20, n=14) is context only — a Dec 26 3PL→FBA
    # ship is not sellable until ~Jan 30, after early-January cover.
    measured_fba = effective_fba_receive_days(
        None, settings, peak=True, account_summary=leadtime or None,
    )
    awd_days = effective_awd_to_fba_days(
        None, settings, account_summary=leadtime or None,
    )
    early_jan_ship = last_ship_date(peak_end, recv_peak)
    return {
        "target_cover_days": cover_days,
        "receiving_days_peak": recv_peak,
        "receiving_days_normal": recv_normal,
        "awd_to_fba_days": awd_cfg,
        "gate_receive_days": recv_peak,
        "refill_receive_days": recv_peak,
        "effective_awd_to_fba_days": int(awd_days),
        "measured_fba_receive_days": int(measured_fba),
        "peak_receive_overrides_measured": True,
        "peak_start_date": peak_start,
        "peak_end_date": peak_end,
        "early_jan_fba_ship_by": early_jan_ship,
        "tulsa_floor_units": TULSA_LIP_FLOOR_UNITS,
        "tulsa_cover_through": EARLY_FEB_COVER_THROUGH,
        "fba_receive_median": leadtime.get("fba_receive_median") if leadtime else None,
        "fba_receive_n": leadtime.get("fba_receive_n") if leadtime else 0,
        "awd_replenish_median": leadtime.get("awd_replenish_median") if leadtime else None,
        "awd_replenish_n": leadtime.get("awd_replenish_n") if leadtime else 0,
        "amazon_in_by": AMAZON_IN_BY_DEFAULT,
    }


def sku_production_build(
    demand_row: dict,
    *,
    cover_days: int = 60,
    receive_days: int = 35,
    optimistic_units: int = 0,
) -> dict:
    """Per-SKU production build: Nov+Dec+Jan + 60d cover + receive pipeline.

    Display demand is the holiday forecast (YoY, or Assorted CF). Optimistic
    is stock-to-cover — size the network to fulfill it if it hits. Peak-60d
    still uses *display* December daily. Pipeline uses Q4 peak receive (35).
    January = Jan 2026 × that SKU's May–Jul YoY (already on demand_row).
    Do not apply leftover-holiday 2.1× on top of Jan 2026.
    """
    months = demand_row.get("months_2026") or {}
    dec_units = int(months.get(12, 0) or 0)
    jan_units = int(demand_row.get("jan_demand", 0) or 0)
    nov_dec = int(demand_row.get("nov_dec_demand", 0) or 0)
    dec_daily = december_daily_rate(dec_units)
    jan_daily = january_daily_rate(jan_units)
    peak_cover = cover_units_from_daily(dec_daily, cover_days)
    jan_cover = cover_units_from_daily(jan_daily, cover_days)
    ending_cover = max(peak_cover, jan_cover)
    pipeline = cover_units_from_daily(dec_daily, receive_days)
    display_demand = nov_dec + jan_units
    cover_fulfill = max(display_demand, int(optimistic_units or 0))
    stock_to_cover = max(0, cover_fulfill - display_demand)
    gate_units = nov_dec + peak_cover + pipeline
    refill_units = jan_units + max(0, jan_cover - peak_cover) + stock_to_cover
    return {
        "demand": display_demand,
        "display_demand": display_demand,
        "cover_fulfill": cover_fulfill,
        "optimistic_units": int(optimistic_units or 0),
        "stock_to_cover": stock_to_cover,
        "nov_dec_demand": nov_dec,
        "jan_demand": jan_units,
        "dec_units": dec_units,
        "dec_daily": dec_daily,
        "jan_daily": jan_daily,
        "peak_cover": peak_cover,
        "jan_cover": jan_cover,
        "ending_cover": ending_cover,
        "pipeline": pipeline,
        "gate_units": gate_units,
        "refill_units": refill_units,
        "sku_build": cover_fulfill + ending_cover + pipeline,
    }


def family_tulsa_floor(
    sku_3pl: dict[str, int],
    floor: int = TULSA_LIP_FLOOR_UNITS,
) -> dict:
    """Keep ~5,000 lip balm units in Tulsa. Family floor, not a per-SKU mix."""
    on_hand = sum(max(int(v or 0), 0) for v in sku_3pl.values())
    transferable = max(0, on_hand - floor)
    top_up = max(0, floor - on_hand)
    return {
        "floor": floor,
        "on_hand": on_hand,
        "transferable": transferable,
        "top_up": top_up,
        "split_per_sku": False,
    }


def tulsa_after_christmas_outbound(
    sku_3pl: dict[str, int],
    early_jan_fba_from_tulsa: int,
    floor: int = TULSA_LIP_FLOOR_UNITS,
    cover_through: date | None = None,
) -> dict:
    """Keep the 5k family floor AFTER Dec 3PL→FBA outbounds, through early Feb.

    Do not plan a Dec 26 empty warehouse. Transfer only excess above the
    floor. Nov/Dec pallets may sit at Tulsa as ammo; the early-Jan FBA
    slice must leave in December (ship-by = peak_end − 35).
    """
    info = family_tulsa_floor(sku_3pl, floor)
    need = max(int(early_jan_fba_from_tulsa or 0), 0)
    outbound = min(need, info["transferable"])
    after = info["on_hand"] - outbound
    return {
        **info,
        "early_jan_fba_from_tulsa": need,
        "outbound": outbound,
        "after_outbound": after,
        "needed_before_outbound": need + floor,
        "meets_floor_after_outbound": after >= floor,
        "cover_through": (cover_through or EARLY_FEB_COVER_THROUGH).isoformat(),
        "do_not_drain_to_zero": True,
    }


def transferable_3pl_by_sku(
    sku_3pl: dict[str, int],
    floor: int = TULSA_LIP_FLOOR_UNITS,
) -> dict[str, int]:
    """3PL that may offset FBA. Excess above the family floor, unlocked shares."""
    info = family_tulsa_floor(sku_3pl, floor)
    leftover = info["transferable"]
    if leftover <= 0:
        return {sku: 0 for sku in sku_3pl}
    total = info["on_hand"] or 1
    out: dict[str, int] = {}
    for sku, qty in sku_3pl.items():
        share = max(int(qty or 0), 0) / total
        alloc = min(int(round(leftover * share)), leftover)
        out[sku] = alloc
        leftover -= alloc
    if leftover > 0:
        # Remainder on the SKU with the most 3PL — indicative, not a locked mix
        richest = max(sku_3pl, key=lambda s: sku_3pl[s])
        out[richest] = out.get(richest, 0) + leftover
    return out


def production_horizon_months(
    today: date,
    amazon_in_by: date,
    gate_receive_days: int,
    peak_end: date | None = None,
    refill_receive_days: int | None = None,
) -> list[dict]:
    """Aug/Sep = gate at 35d. Oct/Nov/Dec = post-Christmas ammo, not late inbound.

    October cannot make the 10/31 gate once receive is 35 days
    (last ship = 2026-09-26). Nov/Dec pallets may sit at Tulsa; the
    early-Jan FBA slice must leave Tulsa in December.
    """
    peak_end = peak_end or PEAK_END_DEFAULT
    refill_recv = int(refill_receive_days or gate_receive_days)
    out: list[dict] = []
    cursor = today.replace(day=1)
    end = peak_end.replace(day=1)
    while cursor <= end:
        month = cursor.strftime("%Y-%m")
        is_gate = month_can_make_gate(month, amazon_in_by, gate_receive_days)
        is_ammo = (
            cursor.year == amazon_in_by.year
            and cursor.month in (10, 11, 12)
            and not is_gate
        )
        if is_gate:
            out.append({
                "month": month,
                "role": "gate",
                "receive_days": int(gate_receive_days),
                "need_in_fba": amazon_in_by.isoformat(),
                "label": "in_fba_by_gate",
            })
        elif is_ammo:
            out.append({
                "month": month,
                "role": "refill",
                "receive_days": refill_recv,
                "need_in_fba": peak_end.isoformat(),
                "label": "post_christmas_ammo",
            })
        if cursor.month == 12:
            cursor = cursor.replace(year=cursor.year + 1, month=1)
        else:
            cursor = cursor.replace(month=cursor.month + 1)
    return out


def pallet_partial_min_units(pallet_max: int = PALLET_MAX_UNITS) -> int:
    """Smallest leftover that may render as its own (partial) pallet card."""
    return int(math.ceil(max(int(pallet_max), 0) * PALLET_PARTIAL_MIN_RATIO))


def pallet_fill(units: int, pallet_max: int = PALLET_MAX_UNITS) -> dict:
    """Full pallets plus an optional ≥50% partial. Under half is held, not a card.

    Two full + one partial is fine. Do not require even 19,000 cards.
    A leftover like 4,276 (23%) is merge-or-hold — never its own pallet.
    """
    units = max(0, int(units))
    pallet_max = int(pallet_max)
    full = units // pallet_max if pallet_max > 0 else 0
    leftover = units % pallet_max if pallet_max > 0 else units
    partial_min = pallet_partial_min_units(pallet_max) if pallet_max > 0 else 0
    leftover_pct = (leftover / pallet_max) if pallet_max > 0 else 0.0
    has_partial = leftover >= partial_min > 0
    partial_units = leftover if has_partial else 0
    held_units = 0 if has_partial else leftover
    pallet_cards = full + (1 if has_partial else 0)
    return {
        "units": units,
        "full_pallets": full,
        "leftover_units": leftover,
        "leftover_pct": leftover_pct,
        "fill_pct": leftover_pct,
        "partial_min_units": partial_min,
        "has_partial": has_partial,
        "partial_units": partial_units,
        "held_units": held_units,
        "pallet_cards": pallet_cards,
        "is_pallet_card": pallet_cards > 0,
        "merge_or_hold": (not has_partial) and leftover > 0,
    }


def pallet_card_sizes(
    fill: dict,
    pallet_max: int = PALLET_MAX_UNITS,
) -> list[int]:
    """Card sizes to emit: N full, then one partial if leftover ≥50%."""
    sizes = [int(pallet_max)] * int(fill.get("full_pallets") or 0)
    if fill.get("has_partial") and int(fill.get("partial_units") or 0) > 0:
        sizes.append(int(fill["partial_units"]))
    return sizes


def allocate_pallet_cards(
    remaining_gaps: dict[str, int],
    skus: list[str],
    pallet_max: int = PALLET_MAX_UNITS,
) -> tuple[list[dict], dict[str, int], dict]:
    """Build pallet cards from SKU gaps. Mix is indicative, not locked."""
    remaining = {sku: max(int(remaining_gaps.get(sku, 0) or 0), 0) for sku in skus}
    fill = pallet_fill(sum(remaining.values()), pallet_max)
    pallets: list[dict] = []
    for i, size in enumerate(pallet_card_sizes(fill, pallet_max), start=1):
        total_remaining = sum(remaining.values())
        if total_remaining <= 0:
            break
        mix: dict[str, int] = {}
        for sku in skus:
            if remaining[sku] <= 0:
                continue
            share = remaining[sku] / total_remaining
            alloc = min(int(round(size * share)), remaining[sku])
            if alloc > 0:
                mix[sku] = alloc
                remaining[sku] -= alloc
        pallets.append({
            "pallet_num": i,
            "mix": mix,
            "total_units": sum(mix.values()),
            "locked": False,
            "partial": size < pallet_max,
        })
    leftover_mix = {sku: qty for sku, qty in remaining.items() if qty > 0}
    return pallets, leftover_mix, fill


def last_ship_date(
    amazon_in_by: date,
    receiving_days: int = DEFAULT_RECEIVING_DAYS,
) -> date:
    return amazon_in_by - timedelta(days=max(int(receiving_days), 0))


def sellable_date(ship_by: date, receiving_days: int) -> date:
    """3PL→FBA / inbound becomes sellable this many days after ship."""
    return ship_by + timedelta(days=max(int(receiving_days), 0))


def early_jan_fba_ship_by(
    peak_end: date | None = None,
    receiving_days: int = 35,
) -> date:
    """Last day a 3PL→FBA ship can still be sellable by peak_end.

    peak_end 2027-01-15 − 35 = 2026-12-11 (before Christmas).
    A Dec 26 ship is sellable ~Jan 30 — too late for early January.
    """
    return last_ship_date(peak_end or PEAK_END_DEFAULT, receiving_days)


def ship_too_late_for_early_jan(
    ship_by: date,
    receiving_days: int = 35,
    peak_end: date | None = None,
) -> bool:
    return sellable_date(ship_by, receiving_days) > (peak_end or PEAK_END_DEFAULT)


def in_amazon_date(
    ship_by: date,
    receiving_days: int,
    amazon_in_by: date,
    *,
    clamp: bool = True,
) -> date:
    """Arrival. Gate waves clamp to 2026-10-31. Refill waves do not."""
    arrive = ship_by + timedelta(days=max(int(receiving_days), 0))
    if not clamp:
        return arrive
    return min(arrive, amazon_in_by)


def month_can_make_gate(
    month: str,
    amazon_in_by: date,
    receiving_days: int = DEFAULT_RECEIVING_DAYS,
) -> bool:
    """True if any day in this month can still arrive by amazon_in_by."""
    y, mo = month.split("-")
    start = date(int(y), int(mo), 1)
    return start <= last_ship_date(amazon_in_by, receiving_days)


def ship_by_for_month(
    month: str,
    amazon_in_by: date,
    receiving_days: int = DEFAULT_RECEIVING_DAYS,
    *,
    role: str = "gate",
    need_in_fba: date | None = None,
) -> str:
    y, mo = month.split("-")
    yi, mi = int(y), int(mo)
    if mi == 12:
        last_day = date(yi + 1, 1, 1) - timedelta(days=1)
    else:
        last_day = date(yi, mi + 1, 1) - timedelta(days=1)
    preferred = date(yi, mi, min(20, last_day.day))
    start = date(yi, mi, 1)
    if role == "refill":
        # Oct/Nov/Dec ammo may sit at Tulsa. December FBA slice must
        # leave by peak_end − receive (before Christmas at 35d).
        ship = min(preferred, last_day)
        if need_in_fba and mi == 12:
            ship = min(ship, last_ship_date(need_in_fba, receiving_days))
        return ship.isoformat()
    last_ship = last_ship_date(amazon_in_by, receiving_days)
    ship = min(preferred, last_ship, last_day)
    if ship < start:
        ship = start
    return ship.isoformat()


def production_months_before_gate(
    today: date,
    amazon_in_by: date,
    receiving_days: int = DEFAULT_RECEIVING_DAYS,
    n: int = 3,
) -> list[str]:
    """Rolling months that can still land in Amazon by the holiday gate."""
    months = _month_list(today, n + 3)
    feasible = [m for m in months if month_can_make_gate(m, amazon_in_by, receiving_days)]
    return feasible[:n]


def fba_cover_units(snap: dict) -> int:
    """Cover uses FBA fulfillable only."""
    return int(snap.get("fulfillable", 0) or 0)


def inbound_in_transit(snap: dict) -> int:
    """Already moving to FBA — count as supply, do not send again."""
    return sum(
        int(snap.get(k, 0) or 0)
        for k in ("inbound_working", "inbound_shipped", "inbound_receiving")
    )


def latest_row_per_sku(
    rows: list[dict],
    stamp_key: str = "pulled_at",
) -> dict[str, dict]:
    """Latest row per SKU (not latest pull-batch cohort)."""
    best: dict[str, dict] = {}
    for r in rows:
        sku = r.get("sku")
        if not sku:
            continue
        key = normalize_sku(sku)
        prev = best.get(key)
        stamp = str(r.get(stamp_key) or "")
        if prev is None or stamp >= str(prev.get(stamp_key) or ""):
            best[key] = r
    return best


def _load_amazon_lip_sales(skus: list[str]) -> list[dict]:
    try:
        rows = fetch_all("sales_by_sku")
    except Exception:
        return []
    wanted = {normalize_sku(s) for s in skus}
    return [
        r for r in rows
        if is_amazon_pulse_row(r) and normalize_sku(r.get("sku")) in wanted
    ]


def build_pallet_plan(
    pallet_max: int = 19_000,
    amazon_in_by: str = "2026-10-31",
    scenario: str = "correction_factor",
    include_3pl: bool = True,
    include_awd: bool = True,
    skus: list[str] | None = None,
) -> dict:
    """Build a pallet plan for the lip balm SKUs.

    Returns dict with per-SKU analysis, pallet breakdown, and summary.
    """
    target_skus = skus or LIP_BALM_SKUS
    target_date = date.fromisoformat(amazon_in_by)
    today = date.today()
    policy = load_planner_policy()
    receiving_days = int(policy["gate_receive_days"])

    # Load data
    snaps = {normalize_sku(r.get("sku")): r for r in fetch_all("inventory_snapshots")}
    awds = {normalize_sku(r.get("sku")): r for r in fetch_all("inventory_awd")}
    tpls: dict[str, dict] = {}
    try:
        tpls = latest_row_per_sku(fetch_all("inventory_3pl_snapshots"))
    except Exception:
        pass

    fc_rows: list[dict] = []
    try:
        fc_rows = fetch_all("forecast_weekly")
    except Exception:
        fc_rows = []

    monthly = monthly_amazon_units(_load_amazon_lip_sales(target_skus), target_skus)
    family_ctx = family_yoy_may_jul(monthly, target_skus)
    sales_demand = apply_assorted_correction_display(
        holiday_demand_from_sales(monthly, target_skus, include_jan=True),
        fc_rows,
    )
    yoy_by_sku = {sku: sku_yoy_may_jul(monthly, sku) for sku in target_skus}
    optimistic_by_sku = {
        sku: workbook_window_units(fc_rows, sku, "optimistic") for sku in target_skus
    }

    sku_3pl = {
        sku: int(tpls.get(normalize_sku(sku), {}).get("available", 0) or 0)
        if include_3pl else 0
        for sku in target_skus
    }
    tulsa = family_tulsa_floor(sku_3pl, policy["tulsa_floor_units"])
    tpl_xfer = transferable_3pl_by_sku(sku_3pl, policy["tulsa_floor_units"])
    tulsa_xmas = tulsa_after_christmas_outbound(
        sku_3pl, tulsa["transferable"], policy["tulsa_floor_units"],
        cover_through=policy.get("tulsa_cover_through"),
    )

    # Per-SKU analysis — production target, not sell-through alone
    sku_plans: list[dict] = []
    total_gap = 0

    for sku in target_skus:
        s = snaps.get(normalize_sku(sku), {})
        fba = fba_cover_units(s)
        inbound = inbound_in_transit(s)
        awd_oh = int(awds.get(normalize_sku(sku), {}).get("awd_on_hand", 0) or 0) if include_awd else 0
        tpl_oh = sku_3pl[sku]
        xfer = tpl_xfer.get(sku, 0)

        amazon_supply = fba + inbound + awd_oh + xfer

        d = sales_demand.get(sku, {})
        build = sku_production_build(
            d,
            cover_days=policy["target_cover_days"],
            receive_days=policy["gate_receive_days"],
            optimistic_units=optimistic_by_sku.get(sku, 0),
        )
        nov_dec_demand = build["nov_dec_demand"]
        jan_demand = build["jan_demand"]
        target_units = build["sku_build"]

        gap = max(target_units - amazon_supply, 0)
        total_gap += gap

        sku_plans.append({
            "sku": sku,
            "nov_dec_demand": nov_dec_demand,
            "nov_dec_prior": int(d.get("nov_dec_prior", 0)),
            "jan_demand": jan_demand,
            "display_demand": build["display_demand"],
            "cover_fulfill": build["cover_fulfill"],
            "stock_to_cover": build["stock_to_cover"],
            "peak_cover": build["peak_cover"],
            "jan_cover": build["jan_cover"],
            "ending_cover": build["ending_cover"],
            "pipeline": build["pipeline"],
            "production_target": target_units,
            "yoy": float(d.get("yoy", 1.0)),
            "yoy_method": d.get("yoy_method"),
            "display_method": d.get("display_method"),
            "months_2026": d.get("months_2026"),
            "fba": fba,
            "inbound": inbound,
            "awd": awd_oh,
            "tpl": tpl_oh,
            "tpl_transferable": xfer,
            "amazon_supply": amazon_supply,
            "covered": min(amazon_supply, target_units),
            "gap": gap,
        })
    total_gap += tulsa["top_up"]

    # Full pallets + optional ≥50% partial. Under half is held, not a card.
    remaining_gaps = {p["sku"]: p["gap"] for p in sku_plans}
    pallets, leftover_mix, fill = allocate_pallet_cards(
        remaining_gaps, target_skus, pallet_max,
    )
    num_pallets = fill["pallet_cards"]

    horizon = production_horizon_months(
        today, target_date, receiving_days,
        peak_end=policy["peak_end_date"],
        refill_receive_days=policy["refill_receive_days"],
    )
    months_available = [h["month"] for h in horizon]
    gate_months = [h["month"] for h in horizon if h["role"] == "gate"]
    refill_months = [h["month"] for h in horizon if h["role"] == "refill"]

    monthly_pallets: dict[str, list[dict]] = defaultdict(list)
    n_gate = max(len(gate_months), 1)
    for i, p in enumerate(pallets):
        if i < n_gate and gate_months:
            month = gate_months[min(i, len(gate_months) - 1)]
        elif refill_months:
            month = refill_months[min(max(i - n_gate, 0), len(refill_months) - 1)]
        else:
            month = months_available[min(i, len(months_available) - 1)] if months_available else "ASAP"
        monthly_pallets[month].append(p)

    return {
        "config": {
            "pallet_max_units": pallet_max,
            "amazon_in_by": amazon_in_by,
            "scenario": "sales_yoy",
            "demand_method": DEMAND_METHOD,
            "yoy_by_sku": {s: round(i["yoy"], 4) for s, i in yoy_by_sku.items()},
            "family_yoy_context_only": round(family_ctx["yoy"], 4),
            "include_3pl_transfer": include_3pl,
            "include_awd": include_awd,
            "cover": "fba_fulfillable_only",
            "cover_target_days": policy["target_cover_days"],
            "tulsa_floor_units": tulsa["floor"],
            "tulsa_3pl": tulsa,
            "tulsa_after_christmas_outbound": tulsa_xmas,
            "lead_times": {
                "gate_receive_days": policy["gate_receive_days"],
                "refill_receive_days": policy["refill_receive_days"],
                "receiving_days_peak": policy["receiving_days_peak"],
                "receiving_days_normal": policy["receiving_days_normal"],
                "awd_to_fba_days": policy["awd_to_fba_days"],
                "fba_receive_median": policy["fba_receive_median"],
                "fba_receive_n": policy["fba_receive_n"],
                "awd_replenish_median": policy["awd_replenish_median"],
                "awd_replenish_n": policy["awd_replenish_n"],
                "peak_receive_overrides_measured": True,
                "early_jan_fba_ship_by": policy["early_jan_fba_ship_by"].isoformat(),
            },
            "actual_2025_source": ACTUAL_2025_SOURCE,
        },
        "sku_plans": sku_plans,
        "total_nov_dec_demand": sum(p["nov_dec_demand"] for p in sku_plans),
        "total_amazon_supply": sum(p["amazon_supply"] for p in sku_plans),
        "total_gap": total_gap,
        "num_pallets": num_pallets,
        "leftover_units": fill["held_units"],
        "leftover_mix": leftover_mix,
        "has_partial": fill["has_partial"],
        "partial_units": fill["partial_units"],
        "held_units": fill["held_units"],
        "pallets": pallets,
        "monthly_schedule": dict(monthly_pallets),
        "months": months_available,
        "horizon": horizon,
        "gate_months": gate_months,
        "refill_months": refill_months,
        "units_still_short": sum(leftover_mix.values()) + tulsa["top_up"],
        "yoy_by_sku": yoy_by_sku,
        "family_yoy_context_only": family_ctx,
        "tulsa_3pl": tulsa,
        "tulsa_after_christmas_outbound": tulsa_xmas,
        "optimistic_by_sku": optimistic_by_sku,
    }


# ---------------------------------------------------------------------------
# FBA Cover Projection — 60-day forward cover policy
# ---------------------------------------------------------------------------

VEL_WEIGHTS = (0.50, 0.30, 0.20)  # V7 / V30 / V90


def _blended_daily_velocity(
    vel_row: dict,
    weights: tuple[float, ...] = VEL_WEIGHTS,
) -> float:
    """Blended daily velocity from V7/V30/V90 with renormalization.

    NOTE: sku_velocity fields (total_u_7, total_u_30, total_u_90) are
    ALREADY units-per-day (computed by _units_per_day = total / window).
    Do NOT divide by 7/30/90 again.

    Returns 0 only when no velocity window has data.
    """
    windows = [
        (float(vel_row.get("total_u_7", 0) or 0), weights[0]),
        (float(vel_row.get("total_u_30", 0) or 0), weights[1]),
        (float(vel_row.get("total_u_90", 0) or 0), weights[2]),
    ]
    valid = [(rate, w) for rate, w in windows if rate > 0]
    if not valid:
        return 0.0
    w_sum = sum(w for _, w in valid)
    return sum(rate * w / w_sum for rate, w in valid)


def _build_weekly_demand(
    fc_rows: list[dict],
    vel_rows: list[dict],
    target_skus: list[str],
    scenario: str,
    weeks: list[date],
) -> dict[str, dict[str, float]]:
    """Build per-SKU weekly demand lookup.

    Uses forecast_weekly where available; falls back to blended
    velocity (50% V7 + 30% V30 + 20% V90) × 7 for non-forecast weeks.
    """
    # Forecast: {sku: {week_start_iso: units}}
    fc_map: dict[str, dict[str, float]] = defaultdict(dict)
    for r in fc_rows:
        if r.get("scenario") != scenario:
            continue
        sku = r.get("sku")
        if sku not in target_skus:
            continue
        ws = str(r.get("week_start", ""))[:10]
        fc_map[sku][ws] = float(r.get("units", 0) or 0)

    # Blended velocity fallback
    vel_daily: dict[str, float] = {}
    for v in vel_rows:
        sku = v.get("sku")
        if sku in target_skus:
            vel_daily[sku] = _blended_daily_velocity(v)

    # For each week, find demand: check forecast ±3 days, else velocity
    demand: dict[str, dict[str, float]] = defaultdict(dict)
    for sku in target_skus:
        fc = fc_map.get(sku, {})
        vd = vel_daily.get(sku, 0)
        for w in weeks:
            w_iso = w.isoformat()
            # Try exact or nearby forecast match (forecast may start Sat)
            found = None
            for offset in range(0, 4):
                alt = (w + timedelta(days=offset)).isoformat()
                if alt in fc:
                    found = fc[alt]
                    break
                alt = (w - timedelta(days=offset)).isoformat()
                if alt in fc:
                    found = fc[alt]
                    break
            demand[sku][w_iso] = found if found is not None else vd * 7
    return dict(demand)


def build_fba_cover_projection(
    cover_target_days: int = 60,
    scenario: str = "correction_factor",
    include_3pl: bool = True,
    include_awd: bool = True,
    inbound_arrive_week: int = 1,
    awd_transfer_week: int = 2,
    tpl_transfer_week: int = 3,
    skus: list[str] | None = None,
) -> dict:
    """Project weekly FBA on-hand and flag weeks below cover target.

    Walks week-by-week from today through Dec 2026.  For each SKU:
      - Starts from current FBA on-hand
      - Adds receipts (inbound arriving, AWD/3PL transfers to FBA)
      - Subtracts weekly forecast demand (velocity fallback for gaps)
      - Computes forward cover = on-hand / avg daily demand over next 60 days
      - Flags weeks where cover < cover_target_days

    Returns per-SKU weekly projections and alert list.
    """
    target_skus = skus or LIP_BALM_SKUS
    today = date.today()

    # Load data
    snaps = {r["sku"]: r for r in fetch_all("inventory_snapshots")}
    awds = {r["sku"]: r for r in fetch_all("inventory_awd")}
    tpls: dict[str, dict] = {}
    try:
        tpls = latest_row_per_sku(fetch_all("inventory_3pl_snapshots"))
        tpls = {r["sku"]: r for r in tpls.values()}
    except Exception:
        pass
    fc_rows = fetch_all("forecast_weekly")
    vel_rows: list[dict] = []
    try:
        vel_rows = fetch_all("sku_velocity")
    except Exception:
        pass

    # Build weeks: snap to Monday, walk through end of Dec 2026
    start_monday = today - timedelta(days=today.weekday())
    end_date = date(2026, 12, 28)
    weeks: list[date] = []
    cursor = start_monday
    while cursor <= end_date:
        weeks.append(cursor)
        cursor += timedelta(days=7)

    if not weeks:
        return {"cover_target_days": cover_target_days, "sku_projections": [], "alerts": []}

    # Weekly demand per SKU
    demand_map = _build_weekly_demand(fc_rows, vel_rows, target_skus, scenario, weeks)

    sku_projections: list[dict] = []
    alerts: list[dict] = []

    for sku in target_skus:
        s = snaps.get(sku, {})
        fba_now = fba_cover_units(s)
        inbound_now = inbound_in_transit(s)
        awd_now = int(awds.get(sku, {}).get("awd_on_hand", 0) or 0) if include_awd else 0
        tpl_now = int(tpls.get(sku, {}).get("available", 0) or 0) if include_3pl else 0

        # Schedule receipts into FBA by week index
        receipts: dict[int, int] = defaultdict(int)
        if inbound_now > 0:
            receipts[min(inbound_arrive_week, len(weeks) - 1)] += inbound_now
        if awd_now > 0:
            receipts[min(awd_transfer_week, len(weeks) - 1)] += awd_now
        if tpl_now > 0:
            receipts[min(tpl_transfer_week, len(weeks) - 1)] += tpl_now

        # Walk weeks
        fba = fba_now
        week_data: list[dict] = []

        for wi, w in enumerate(weeks):
            w_iso = w.isoformat()
            receipt = receipts.get(wi, 0)
            fba += receipt

            wk_demand = demand_map.get(sku, {}).get(w_iso, 0)
            fba = max(fba - wk_demand, 0)

            # Forward cover: avg daily demand over next ~60 days (9 weeks)
            forward_units = 0.0
            forward_weeks = 0
            for fi in range(wi, min(wi + 9, len(weeks))):
                fi_iso = weeks[fi].isoformat()
                forward_units += demand_map.get(sku, {}).get(fi_iso, 0)
                forward_weeks += 1

            if forward_units > 0 and forward_weeks > 0:
                daily_rate = forward_units / (forward_weeks * 7)
                cover_days = fba / daily_rate if daily_rate > 0 else 999
            else:
                daily_rate = 0
                cover_days = 999

            flagged = cover_days < cover_target_days and cover_days < 999

            week_data.append({
                "week": w_iso,
                "fba": round(fba),
                "demand": round(wk_demand),
                "receipt": receipt,
                "daily_rate": round(daily_rate, 1),
                "cover_days": round(cover_days) if cover_days < 999 else None,
                "flagged": flagged,
            })

            if flagged:
                alerts.append({
                    "sku": sku,
                    "week": w_iso,
                    "cover_days": round(cover_days),
                    "fba": round(fba),
                    "daily_rate": round(daily_rate, 1),
                })

        sku_projections.append({
            "sku": sku,
            "fba_start": fba_now,
            "inbound": inbound_now,
            "awd": awd_now,
            "tpl": tpl_now,
            "weeks": week_data,
        })

    return {
        "cover_target_days": cover_target_days,
        "scenario": scenario,
        "week_dates": [w.isoformat() for w in weeks],
        "sku_projections": sku_projections,
        "alerts": alerts,
        "total_flagged_weeks": len(alerts),
    }


# ---------------------------------------------------------------------------
# Manufacturer Heads-Up — rolling 3-month production schedule
# ---------------------------------------------------------------------------

SKU_LABEL_MAP: dict[str, str] = {
    "DDPE0001Shop": "Unscented 3pk",
    "DDPE0002Shop": "Peppermint 3pk",
    "DDPE0003Shop": "Sweet Orange 3pk",
    "DDPE0004Shop": "Assorted 3pk",
}

SKU_SHORT_MAP: dict[str, str] = {
    "DDPE0001Shop": "Unscented",
    "DDPE0002Shop": "Peppermint",
    "DDPE0003Shop": "Sweet Orange",
    "DDPE0004Shop": "Assorted",
}


def _month_label(m: str) -> str:
    """'2026-08' → 'August 2026'."""
    import calendar
    y, mo = m.split("-")
    return f"{calendar.month_name[int(mo)]} {y}"


def _month_list(start: date, n: int) -> list[str]:
    months: list[str] = []
    cursor = start.replace(day=1)
    for _ in range(n):
        months.append(cursor.strftime("%Y-%m"))
        if cursor.month == 12:
            cursor = cursor.replace(year=cursor.year + 1, month=1)
        else:
            cursor = cursor.replace(month=cursor.month + 1)
    return months


def _holiday_demand_by_sku(
    fc_rows: list[dict],
    target_skus: list[str],
    scenario: str,
    include_jan: bool = True,
    velocities: dict | None = None,
    **kwargs,
) -> dict[str, int]:
    """Sum Nov + Dec (+ optional Jan) forecast_weekly per SKU.

    Used by inbound-wave shortfall math. ``velocities`` is accepted for
    call-site compatibility and is not applied here (Holt owns replen).
    Pallet-planner holiday demand uses ``holiday_demand_from_sales`` instead.
    """
    _ = velocities, kwargs
    totals: dict[str, float] = {s: 0 for s in target_skus}
    holiday_months = {"2026-11", "2026-12"}
    if include_jan:
        holiday_months |= {"2026-01", "2027-01"}
    for r in fc_rows:
        if r.get("scenario") != scenario:
            continue
        sku = r.get("sku")
        if sku not in target_skus:
            continue
        ws = str(r.get("week_start", ""))[:7]
        if ws in holiday_months:
            totals[sku] += float(r.get("units", 0) or 0)
    return {s: round(v) for s, v in totals.items()}


def build_manufacturer_headsup(
    pallet_max: int = 19_000,
    month_weights: tuple[float, ...] = (0.25, 0.35, 0.40),
    include_jan: bool = True,
    tpl_offsets_production: bool = False,
    committed_months: list[str] | None = None,
    skus: list[str] | None = None,
) -> dict:
    """Build rolling production schedule that can still make the Amazon gate.

    Primary demand is Amazon sales_by_sku × each SKU's own May–Jul YoY,
    through January (Jan 2026 × that YoY — not leftover-holiday 2.1×).
    Production cards = demand + peak-60d cover + Tulsa floor + pipeline.

    Sep/Oct must be in FBA by 2026-10-31. Nov/Dec refill January cover
    and the Tulsa floor — they are not late inbound.

    Mix stays unlocked (indicative shares only). Two full + one ≥50%
    partial is fine. Under half a pallet is merge-or-hold, not a card.
    Dave sends hard August totals later.
    """
    target_skus = skus or LIP_BALM_SKUS
    today = date.today()
    committed = set(committed_months or [])
    amazon_in_by = date.fromisoformat(DEFAULTS["amazon_in_by"])
    policy = load_planner_policy()
    receiving_days = int(policy["gate_receive_days"])
    horizon = production_horizon_months(
        today, amazon_in_by, receiving_days,
        peak_end=policy["peak_end_date"],
        refill_receive_days=policy["refill_receive_days"],
    )
    production_months = [h["month"] for h in horizon]
    horizon_by_month = {h["month"]: h for h in horizon}

    snaps = {
        normalize_sku(r.get("sku")): r for r in fetch_all("inventory_snapshots")
    }
    awds_data = {
        normalize_sku(r.get("sku")): r for r in fetch_all("inventory_awd")
    }
    tpls_data: dict[str, dict] = {}
    try:
        tpls_data = latest_row_per_sku(fetch_all("inventory_3pl_snapshots"))
    except Exception:
        pass
    fc_rows = fetch_all("forecast_weekly")

    monthly = monthly_amazon_units(_load_amazon_lip_sales(target_skus), target_skus)
    family_ctx = family_yoy_may_jul(monthly, target_skus)
    sales_demand = apply_assorted_correction_display(
        holiday_demand_from_sales(
            monthly, target_skus, include_jan=include_jan,
        ),
        fc_rows,
    )
    yoy_by_sku = {sku: sku_yoy_may_jul(monthly, sku) for sku in target_skus}
    optimistic_by_sku = {
        sku: workbook_window_units(fc_rows, sku, "optimistic") for sku in target_skus
    }

    inv: dict[str, dict[str, int]] = {}
    for sku in target_skus:
        s = snaps.get(normalize_sku(sku), {})
        inv[sku] = {
            "fba": fba_cover_units(s),
            "inbound": inbound_in_transit(s),
            "awd": int(awds_data.get(normalize_sku(sku), {}).get("awd_on_hand", 0) or 0),
            "tpl": int(tpls_data.get(normalize_sku(sku), {}).get("available", 0) or 0),
        }

    sku_3pl = {sku: inv[sku]["tpl"] for sku in target_skus}
    tulsa = family_tulsa_floor(sku_3pl, policy["tulsa_floor_units"])
    tpl_xfer = transferable_3pl_by_sku(sku_3pl, policy["tulsa_floor_units"])
    tulsa_xmas = tulsa_after_christmas_outbound(
        sku_3pl, tulsa["transferable"], policy["tulsa_floor_units"],
        cover_through=policy.get("tulsa_cover_through"),
    )
    builds = {
        sku: sku_production_build(
            sales_demand.get(sku, {}),
            cover_days=policy["target_cover_days"],
            receive_days=policy["gate_receive_days"],
            optimistic_units=optimistic_by_sku.get(sku, 0),
        )
        for sku in target_skus
    }

    def _summaries_from_demand(demand_by_sku: dict[str, int], *, use_build: bool) -> list[dict]:
        rows: list[dict] = []
        for sku in target_skus:
            i = inv[sku]
            if use_build:
                demand = int(builds[sku]["sku_build"])
            else:
                demand = int(demand_by_sku.get(sku, 0))
            deductions = i["fba"] + i["inbound"] + i["awd"]
            if tpl_offsets_production:
                deductions += tpl_xfer.get(sku, 0)
            rows.append({
                "sku": sku,
                "label": SKU_LABEL_MAP.get(sku, sku),
                "holiday_demand": int(demand_by_sku.get(sku, 0)),
                "production_target": demand if use_build else int(demand_by_sku.get(sku, 0)),
                "peak_cover": builds[sku]["peak_cover"] if use_build else 0,
                "jan_cover": builds[sku]["jan_cover"] if use_build else 0,
                "pipeline": builds[sku]["pipeline"] if use_build else 0,
                "gate_units": builds[sku]["gate_units"] if use_build else 0,
                "refill_units": builds[sku]["refill_units"] if use_build else 0,
                "fba": i["fba"],
                "inbound": i["inbound"],
                "awd": i["awd"],
                "tpl": i["tpl"],
                "transfer": tpl_xfer.get(sku, 0) + i["awd"],
                "manufacture": max(0, demand - deductions),
            })
        if use_build and tulsa["top_up"] > 0:
            rows[-1]["manufacture"] += tulsa["top_up"]
            rows[-1]["refill_units"] += tulsa["top_up"]
        return rows

    def _month_entries(sku_summaries: list[dict]) -> list[dict]:
        gate_months = [h["month"] for h in horizon if h["role"] == "gate"]
        refill_months = [h["month"] for h in horizon if h["role"] == "refill"]
        remaining_gate = {s["sku"]: int(s.get("gate_units") or 0) for s in sku_summaries}
        remaining_refill = {s["sku"]: int(s.get("refill_units") or 0) for s in sku_summaries}
        # Scale gate/refill remaining to manufacture (supply already deducted)
        mfg = {s["sku"]: s["manufacture"] for s in sku_summaries}
        for sku in target_skus:
            g, r = remaining_gate[sku], remaining_refill[sku]
            total = g + r
            if total <= 0:
                remaining_gate[sku] = 0
                remaining_refill[sku] = mfg[sku]
                continue
            remaining_gate[sku] = min(int(round(mfg[sku] * g / total)), mfg[sku])
            remaining_refill[sku] = mfg[sku] - remaining_gate[sku]

        entries: list[dict] = []
        for month in production_months:
            h = horizon_by_month[month]
            role = h["role"]
            recv = int(h["receive_days"])
            pool = remaining_gate if role == "gate" else remaining_refill
            role_months = gate_months if role == "gate" else refill_months
            mi = role_months.index(month) if month in role_months else 0
            last_in_role = mi == len(role_months) - 1
            w = month_weights[mi] if mi < len(month_weights) else (1 / max(len(role_months), 1))
            w_sum = sum(month_weights[mi:len(role_months)]) if role == "gate" else max(
                len(role_months) - mi, 1)

            mix: dict[str, int] = {}
            for sku in target_skus:
                if pool[sku] <= 0:
                    continue
                if last_in_role:
                    alloc = pool[sku]
                else:
                    alloc = min(round(pool[sku] * w / max(w_sum, 0.01)), pool[sku])
                if alloc > 0:
                    mix[sku] = alloc
                    pool[sku] -= alloc

            total = sum(mix.values())
            fill = pallet_fill(total, pallet_max)
            ship_by = ship_by_for_month(
                month, amazon_in_by, recv, role=role,
                need_in_fba=policy["peak_end_date"] if role == "refill" else None,
            )
            latest = (
                amazon_in_by if role == "gate"
                else policy["peak_end_date"]
            )
            arrive = in_amazon_date(
                date.fromisoformat(ship_by), recv, latest,
                clamp=(role == "gate"),
            )
            is_current_month = month == today.strftime("%Y-%m")
            entries.append({
                "month": month,
                "month_label": _month_label(month),
                "role": role,
                "status": "FIRM" if month in committed else "INDICATIVE",
                "pallets": fill["pallet_cards"],
                "full_pallets": fill["full_pallets"],
                "leftover_units": fill["leftover_units"],
                "held_units": fill["held_units"],
                "partial_units": fill["partial_units"],
                "has_partial": fill["has_partial"],
                "fill_pct": fill["fill_pct"],
                "is_pallet_card": fill["is_pallet_card"],
                "awaiting_august_totals": is_current_month and today.month == 8,
                "units": total,
                "mix": mix,
                "mix_locked": False,
                "ship_by": ship_by,
                "in_amazon": arrive.isoformat(),
                "need_in_fba": h.get("need_in_fba"),
                "late_inbound": False,
            })
        return entries

    sales_by_sku_demand = {
        sku: int(d["holiday_demand"]) for sku, d in sales_demand.items()
    }
    workbook_2025 = _holiday_demand_by_sku(
        fc_rows, target_skus, "actual_2025", include_jan,
    )

    all_sku_summaries = {
        "sales_yoy": _summaries_from_demand(sales_by_sku_demand, use_build=True),
        "actual_2025": _summaries_from_demand(workbook_2025, use_build=False),
    }
    scenarios_out = {
        "sales_yoy": {
            "entries": _month_entries(all_sku_summaries["sales_yoy"]),
            "total_units": 0,
            "total_pallets": 0,
        },
        "actual_2025": {
            "entries": _month_entries(all_sku_summaries["actual_2025"]),
            "total_units": 0,
            "total_pallets": 0,
        },
    }
    for key in scenarios_out:
        entries = scenarios_out[key]["entries"]
        scenarios_out[key]["total_units"] = sum(e["units"] for e in entries)
        scenarios_out[key]["total_pallets"] = sum(e["pallets"] for e in entries)

    # Transfer recommendations (scenario-independent)
    transfers: list[dict] = []
    for sku in target_skus:
        i = inv[sku]
        if i["awd"] > 0:
            transfers.append({
                "sku": sku,
                "label": SKU_LABEL_MAP.get(sku, sku),
                "source": "AWD",
                "units": i["awd"],
                "timing": "Transfer to FBA immediately (Amazon internal, ~2 weeks)",
            })
        xfer = tpl_xfer.get(sku, 0)
        if xfer > 0:
            transfers.append({
                "sku": sku,
                "label": SKU_LABEL_MAP.get(sku, sku),
                "source": "3PL",
                "units": xfer,
                "timing": (
                    f"Ship excess above Tulsa floor ({policy['tulsa_floor_units']:,} "
                    "lip family) to FBA by "
                    f"{policy['early_jan_fba_ship_by'].isoformat()} "
                    "(peak-end − 35d) — keep 5k after outbound through early Feb; "
                    "do not drain 3PL to 0"
                ),
            })

    return {
        "generated": today.isoformat(),
        "amazon_in_by": amazon_in_by.isoformat(),
        "pallet_max": pallet_max,
        "cover_target_days": policy["target_cover_days"],
        "cover": "fba_fulfillable_only",
        "include_jan": include_jan,
        "tpl_offsets_production": tpl_offsets_production,
        "months": production_months,
        "horizon": horizon,
        "gate_months": [h["month"] for h in horizon if h["role"] == "gate"],
        "refill_months": [h["month"] for h in horizon if h["role"] == "refill"],
        "tulsa_3pl": tulsa,
        "tulsa_after_christmas_outbound": tulsa_xmas,
        "lead_times": {
            "gate_receive_days": policy["gate_receive_days"],
            "refill_receive_days": policy["refill_receive_days"],
            "receiving_days_peak": policy["receiving_days_peak"],
            "receiving_days_normal": policy["receiving_days_normal"],
            "awd_to_fba_days": policy["awd_to_fba_days"],
            "fba_receive_median": policy["fba_receive_median"],
            "fba_receive_n": policy["fba_receive_n"],
            "awd_replenish_median": policy["awd_replenish_median"],
            "awd_replenish_n": policy["awd_replenish_n"],
            "peak_receive_overrides_measured": True,
            "early_jan_fba_ship_by": policy["early_jan_fba_ship_by"].isoformat(),
        },
        "month_weights": list(month_weights),
        "yoy": family_ctx,
        "demand_method": DEMAND_METHOD,
        "demand_source": "sales_by_sku amazon+amazon_spapi × sku_own_may_jul_yoy",
        "demand_note": (
            "Each SKU: 2026 month = that SKU’s 2025 same-month Amazon units × "
            "that SKU’s own May–Jul YoY. Assorted holiday display scales to "
            "workbook correction_factor (same Nov–Jan window); optimistic is "
            "stock-to-cover, not the forecast. January uses Jan 2026 × that YoY "
            "(not leftover-holiday 2.1×). Production = cover-fulfill + peak-60d + "
            "Tulsa floor + 35d receive pipeline. Aug/Sep in FBA by 2026-10-31; "
            "Oct/Nov/Dec sit at Tulsa as ammo — early-Jan FBA must leave in "
            "December (peak-end − 35d). Keep 5k Tulsa after those outbounds. "
            "Family 1.42× is context only."
        ),
        "yoy_by_sku": {k: round(v["yoy"], 4) for k, v in yoy_by_sku.items()},
        "family_yoy_context": family_ctx,
        "primary": scenarios_out["sales_yoy"],
        "sensitivity": scenarios_out["actual_2025"],
        "primary_scenario": "sales_yoy",
        "sensitivity_scenario": "actual_2025",
        "actual_2025_source": ACTUAL_2025_SOURCE,
        "sku_summary": all_sku_summaries["sales_yoy"],
        "sku_summary_sensitivity": all_sku_summaries["actual_2025"],
        "transfers": transfers,
        "skus": target_skus,
    }


def format_manufacturer_csv(headsup: dict) -> str:
    """Format manufacturer heads-up as CSV."""
    lines: list[str] = []

    # SKU summary section
    lines.append("Section,SKU,SKU_Label,Cover_Target,FBA,Inbound,AWD,TPL,"
                 "Transfer,Manufacture,Scenario")
    for scenario, key in [("sales_yoy", "sku_summary"),
                          ("actual_2025", "sku_summary_sensitivity")]:
        for s in headsup[key]:
            cover = s.get("production_target", s["holiday_demand"])
            lines.append(
                f"SKU_Summary,{s['sku']},{s['label']},{cover},"
                f"{s['fba']},{s['inbound']},{s['awd']},{s['tpl']},"
                f"{s['transfer']},{s['manufacture']},{scenario}"
            )

    # Monthly production
    lines.append("")
    lines.append("Section,Month,Month_Label,Status,SKU,SKU_Label,Units,"
                 "Pallets,Ship_By,Scenario")
    for sc_key, sc_label in [("primary", "sales_yoy"),
                             ("sensitivity", "actual_2025")]:
        for entry in headsup[sc_key]["entries"]:
            if not entry["mix"]:
                lines.append(
                    f"Monthly,{entry['month']},{entry['month_label']},"
                    f"{entry['status']},,,0,0,{entry['ship_by']},{sc_label}"
                )
            for sku, qty in entry["mix"].items():
                lines.append(
                    f"Monthly,{entry['month']},{entry['month_label']},"
                    f"{entry['status']},{sku},{SKU_LABEL_MAP.get(sku, sku)},"
                    f"{qty},{entry['pallets']},{entry['ship_by']},{sc_label}"
                )

    # Transfers
    lines.append("")
    lines.append("Section,SKU,SKU_Label,Source,Units,Timing")
    for t in headsup["transfers"]:
        lines.append(
            f"Transfer,{t['sku']},{t['label']},{t['source']},"
            f"{t['units']},{t['timing']}"
        )
    return "\n".join(lines) + "\n"


def format_manufacturer_sheet(headsup: dict) -> str:
    """Format printable manufacturer planning sheet."""
    L: list[str] = []
    a = L.append

    a("=" * 65)
    a("TALLOWBOURN")
    a("MANUFACTURER PLANNING SHEET")
    a("Lip Balm 3pk · Holiday Production Schedule")
    a(f"Generated: {headsup['generated']}")
    a("=" * 65)

    a("")
    a("SKU REFERENCE:")
    for sku, label in SKU_LABEL_MAP.items():
        a(f"  {sku}  =  {label}")

    a("")
    yoy = headsup.get("yoy") or {}
    a("Cover target = Nov–Jan sales + peak 60d FBA + Feb tail "
      "(not Nov–Jan sell-through alone)")
    yoy_by_sku = headsup.get("yoy_by_sku") or {}
    if yoy_by_sku:
        parts = ", ".join(
            f"{SKU_SHORT_MAP.get(s, s)} {v:.2f}×" for s, v in yoy_by_sku.items()
        )
        a(f"Per-SKU YoY: {parts}")
    if yoy:
        a(f"Family YoY (context only, not applied): {yoy.get('yoy', 1):.3f}×  "
          f"({yoy.get('current_year')} / {yoy.get('prior_year')} May–Jul)")
    a(f"Pallet capacity: {headsup['pallet_max']:,} cartons "
      f"({CARTONS_PER_BOX} per 13×11×9 box)")
    a("Fill: two full + one ≥50% partial is fine. Under half is merge-or-hold, not a card.")
    a(f"FBA cover: fulfillable only · inbound already in transit (do not re-send)")
    a(f"Aug/Sep waves in Amazon FBA by: {headsup['amazon_in_by']}")
    a("Oct/Nov/Dec pallets sit at Tulsa as post-Christmas ammo — not late inbound.")
    a("Early-Jan FBA must leave Tulsa in December (peak-end − 35d); Dec 26 is too late.")
    tpl_note = "3PL OFFSETS production" if headsup.get("tpl_offsets_production") \
        else "3PL shown as transfer only (does NOT reduce manufacture)"
    tulsa = headsup.get("tulsa_3pl") or {}
    if tulsa:
        a(f"Tulsa 3PL floor: {tulsa.get('floor', TULSA_LIP_FLOOR_UNITS):,} lip family "
          f"(on hand {tulsa.get('on_hand', 0):,}; transferable {tulsa.get('transferable', 0):,})")
    a(f"3PL policy: {tpl_note}")
    lt = headsup.get("lead_times") or {}
    if lt:
        a(f"Lead times: Q4/early-Jan receive {lt.get('gate_receive_days')}d "
          f"(receiving_days_peak={lt.get('receiving_days_peak')}; "
          f"measured FBA median {lt.get('fba_receive_median')}d "
          f"n={lt.get('fba_receive_n')} is context only)")
        if lt.get("early_jan_fba_ship_by"):
            a(f"Early-Jan FBA ship-by: {lt.get('early_jan_fba_ship_by')}")

    # ── Per-SKU summary ──
    a("")
    a("-" * 65)
    a("PER-SKU SUMMARY (sales_yoy)")
    a("-" * 65)
    a(f"  {'SKU':<14} {'Cover':>8} {'FBA':>7} {'Inb':>6} {'AWD':>6}"
      f" {'3PL':>7} {'Xfer':>7} {'Mfg':>8}")
    a(f"  {'-'*63}")
    for s in headsup["sku_summary"]:
        cover = s.get("production_target", s["holiday_demand"])
        a(f"  {SKU_SHORT_MAP.get(s['sku'], s['sku']):<14}"
          f" {cover:>8,} {s['fba']:>7,} {s['inbound']:>6,}"
          f" {s['awd']:>6,} {s['tpl']:>7,} {s['transfer']:>7,}"
          f" {s['manufacture']:>8,}")
    total_demand = sum(
        s.get("production_target", s["holiday_demand"])
        for s in headsup["sku_summary"]
    )
    total_mfg = sum(s["manufacture"] for s in headsup["sku_summary"])
    total_xfer = sum(s["transfer"] for s in headsup["sku_summary"])
    a(f"  {'-'*63}")
    a(f"  {'TOTAL':<14} {total_demand:>8,} {'':>7} {'':>6} {'':>6}"
      f" {'':>7} {total_xfer:>7,} {total_mfg:>8,}")

    # ── Production schedule ──
    a("")
    a("-" * 65)
    pct = "/".join(f"{int(w*100)}%" for w in headsup["month_weights"])
    a(f"PRODUCTION SCHEDULE — sales_yoy ({pct} split, mix unlocked)")
    a("-" * 65)

    for entry in headsup["primary"]["entries"]:
        a("")
        role = entry.get("role") or "gate"
        role_note = (
            "in FBA by gate" if role == "gate"
            else "post-Christmas ammo · early-Jan FBA leaves Tulsa in December"
        )
        a(f"  {entry['month_label']}  —  {entry['status']}  ({role_note})")
        if entry["units"] == 0:
            a("    No production needed this month.")
        else:
            if entry.get("has_partial"):
                a(f"    {entry.get('full_pallets', 0)} full + 1 partial "
                  f"({entry.get('partial_units', 0):,} ≥50%)  "
                  f"({entry['units']:,} units)")
            elif entry.get("is_pallet_card"):
                a(f"    Full pallets: {entry.get('full_pallets', entry['pallets'])}  "
                  f"({entry['units']:,} units)")
                held = int(entry.get("held_units") or 0)
                if held:
                    a(f"    Held leftover (under half, not a pallet): {held:,}")
            else:
                a(f"    Held leftover (under half, not a pallet): {entry['units']:,} units "
                  f"({entry.get('fill_pct', 0):.0%} of {headsup['pallet_max']:,})")
            for sku in headsup["skus"]:
                qty = entry["mix"].get(sku, 0)
                if qty > 0:
                    a(f"      {SKU_LABEL_MAP.get(sku, sku)}: {qty:,}  [indicative]")
            a(f"    Ship by: {entry['ship_by']}  ·  in Amazon by {entry.get('in_amazon', headsup['amazon_in_by'])}")
            if entry.get("awaiting_august_totals"):
                a("    August mix unlocked — waiting on Dave's hard totals.")

    p = headsup["primary"]
    a("")
    a(f"  TOTAL: {p['total_units']:,} units across"
      f" {p['total_pallets']} pallet(s)")

    # ── Transfers ──
    if headsup["transfers"]:
        a("")
        a("-" * 65)
        a("TRANSFERS TO FBA (existing warehouse stock)")
        a("-" * 65)
        for t in headsup["transfers"]:
            a(f"  {t['source']:<5} {SKU_SHORT_MAP.get(t['sku'], t['sku']):<14}"
              f" {t['units']:>7,} units")
            a(f"        {t['timing']}")

    # ── Sensitivity ──
    a("")
    a("-" * 65)
    a("SENSITIVITY: actual_2025 (forecast workbook weekly — not Amazon monthly sales)")
    a(f"  {headsup.get('actual_2025_source', ACTUAL_2025_SOURCE)}")
    a("-" * 65)
    a(f"  {'SKU':<14} {'Cover':>8} {'Mfg':>8}")
    a(f"  {'-'*32}")
    for s in headsup["sku_summary_sensitivity"]:
        a(f"  {SKU_SHORT_MAP.get(s['sku'], s['sku']):<14}"
          f" {s['holiday_demand']:>8,} {s['manufacture']:>8,}")
    sens_mfg = sum(s["manufacture"] for s in headsup["sku_summary_sensitivity"])
    a(f"  {'-'*32}")
    a(f"  {'TOTAL':<14} {'':>8} {sens_mfg:>8,}")
    a("")
    for entry in headsup["sensitivity"]["entries"]:
        if entry["units"] > 0:
            mix_str = ", ".join(
                f"{SKU_SHORT_MAP.get(s, s)} {q:,}"
                for s, q in entry["mix"].items()
            )
            a(f"  {entry['month_label']}: {entry['units']:,} units"
              f" ({entry['pallets']}p) — {mix_str}")
        else:
            a(f"  {entry['month_label']}: no production needed")
    s_out = headsup["sensitivity"]
    a(f"  TOTAL: {s_out['total_units']:,} units across"
      f" {s_out['total_pallets']} pallet(s)")

    # ── Notes ──
    a("")
    a("-" * 65)
    a("NOTES:")
    a("  - FIRM months represent committed production volumes.")
    a("    INDICATIVE months are forecasts and may change.")
    a("  - Manufacture volumes assume 3PL stock is transferred")
    a("    to FBA separately (see Transfers section).")
    a("  - This is a planning aid, not a purchase order.")
    a("-" * 65)
    a("")
    return "\n".join(L)
