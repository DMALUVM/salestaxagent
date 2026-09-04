"""Lip Balm Monthly Pallet Planner.

Computes how many pallets of mixed SKUs need to be produced and shipped
so that all Nov+Dec forecast demand is in Amazon (FBA) by a target date.

Also projects weekly FBA on-hand through the holiday season and flags
any week where forward cover drops below the 60-day service target.

Config defaults:
    pallet_max_units = 17,550  (65 × 270)
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
from src.inventory.sc_on_hand import parse_reserved_splits, raw_from_row, sc_on_hand_units
from src.rules import AMAZON_PULSE_SOURCE

LIP_BALM_SKUS = ["DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"]
ASSORTED_SKU = "DDPE0004Shop"

# Amazon pallet: 65 cases of 13×11×9 (270 units) = 17,550. Not 19,000.
# AWD "full pallet" cards use 17,550. Two full + one ≥50% partial is fine.
# Under half (~8,775) is merge-or-hold — never a ~1k leftover card.
AMAZON_CASES_PER_PALLET = 65
CARTONS_PER_BOX = 270
PALLET_MAX_UNITS = AMAZON_CASES_PER_PALLET * CARTONS_PER_BOX  # 17,550
PALLET_PARTIAL_MIN_RATIO = 0.5
# About 2 AWD pallets/month is the max. Not limited to 1.
AWD_CARDS_PER_MONTH_MAX = 2
AUGUST_HOP_LABEL = "Marpac→Tulsa"
AUGUST_HOP_DESTINATION = "marpac_tulsa"
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
# Nov–Jan sell-through and late-Sep FBA targets are separate lines.
# Do not add peak-60d or Feb tail onto sales — they overlap Nov–Jan.
# 5k Tulsa floor only when AWD is empty — off-FBA reserve can sit in AWD.
# Hard rule: never plan 0 AWD and 0 Tulsa at the same time.
TULSA_LIP_FLOOR_UNITS = 5_000
# FBA inbound placement fees if under 5 boxes. Two carton paths:
#   13×11×9 = 270 units → 5 boxes = 1,350 min, then +270
#   20×16×14 = 540 units (two 270s) → 5 boxes = 2,700 min, then +540
# Never recommend a 3PL→FBA SKU under the min for the carton in use.
# The usual allocator uses the 540-box path (2,700 min, then +540).
# Historical August 3PL→FBA is LOCKED_AUGUST_3PL_FBA_SEND (4,860 orange
# is legal 18×270). Sep 4 hops are LOCKED_SEPTEMBER_* and live on
# September. Do not "correct" 4,860 or 2,700 to a 540 multiple.
CARTON_13X11X9_UNITS = 270
CARTON_20X16X14_UNITS = 540
FBA_INBOUND_MIN_BOXES = 5
FBA_INBOUND_PREFERRED = CARTON_20X16X14_UNITS * FBA_INBOUND_MIN_BOXES  # 2,700
FBA_INBOUND_MIN_FEE_FREE = CARTON_13X11X9_UNITS * FBA_INBOUND_MIN_BOXES  # 1,350
FBA_INBOUND_STEP_AFTER = CARTON_20X16X14_UNITS
DEFAULT_INBOUND_CARTON_UNITS = CARTON_20X16X14_UNITS
# Historical August 3PL→FBA that already shipped in August (pre-Sep 4).
# Assorted 5,400 + orange 4,860 + peppermint 2,700. Lives on August.
# Do not put Sep 4 qty here.
LOCKED_AUGUST_3PL_FBA_SEND = {
    "DDPE0004Shop": 5_400,  # assorted — 20 boxes of 270
    "DDPE0003Shop": 4_860,  # orange — 18 boxes of 270
    "DDPE0002Shop": 2_700,  # peppermint — 10 boxes of 270
    "DDPE0001Shop": 0,      # unscented not in this send
}
LOCKED_AUGUST_3PL_FBA_TOTAL = 12_960
# Sep 4 small-parcel 3PL→FBA. Lives on SEPTEMBER, not August.
# Unscented 5,400 + assorted 2,700. Fee-safe on 270-unit / 13×11×9 boxes.
LOCKED_SEPTEMBER_3PL_FBA_SEND = {
    "DDPE0001Shop": 5_400,  # unscented — 20 boxes of 270
    "DDPE0004Shop": 2_700,  # assorted — 10 boxes of 270
    "DDPE0003Shop": 0,
    "DDPE0002Shop": 0,
}
LOCKED_SEPTEMBER_3PL_FBA_TOTAL = 8_100
# Sep 4 small-parcel 3PL→AWD orange. Lives on SEPTEMBER.
# PALLET_PARTIAL_MIN_RATIO / ≥50% AWD floor does NOT apply.
LOCKED_SEPTEMBER_3PL_AWD_SEND = {
    "DDPE0003Shop": 2_700,  # orange — 10 boxes of 270
    "DDPE0001Shop": 0,
    "DDPE0002Shop": 0,
    "DDPE0004Shop": 0,
}
LOCKED_SEPTEMBER_3PL_AWD_TOTAL = 2_700
SEPTEMBER_AWD_HOP_DESTINATION = "3pl_awd"
# Deprecated alias — Sep 4 3PL→FBA.
LOCKED_TONIGHT_3PL_FBA_SEND = LOCKED_SEPTEMBER_3PL_FBA_SEND
LOCKED_TONIGHT_3PL_FBA_TOTAL = LOCKED_SEPTEMBER_3PL_FBA_TOTAL
# Holt via Dave, in transit 2026-08-31. Marpac → Tulsa 3PL only.
# Not AWD. Not 3PL→FBA. Not the cancelled prior 12,960 lock.
# Do not feed this mix into sku_august FBA/AWD split or first-wave AWD.
LOCKED_AUGUST_MARPAC_TULSA_SEND = {
    "DDPE0001Shop": 6_480,  # unscented — 24 boxes of 270
    "DDPE0004Shop": 3_240,  # assorted — 12 boxes of 270
    "DDPE0003Shop": 3_240,  # orange — 12 boxes of 270
    "DDPE0002Shop": 0,      # peppermint not on this hop
}
LOCKED_AUGUST_MARPAC_TULSA_TOTAL = 12_960
LOCKED_AUGUST_MARPAC_TULSA_DATE = date(2026, 8, 31)
LOCKED_AUGUST_MONTH = "2026-08"
# Late-Sept / early-Oct FBA on-hand targets (Amazon's Sept mix). Not a
# locked production recipe. Cap is the family sum. Oct–Dec family cap
# falls with Amazon cubic; scale this mix — never recommend over cap.
SEPT_FBA_ON_HAND_TARGETS = {
    "DDPE0001Shop": 12_800,  # unscented
    "DDPE0002Shop": 8_300,   # peppermint
    "DDPE0003Shop": 16_700,  # orange
    "DDPE0004Shop": 17_800,  # assorted
}
SEPT_FBA_TARGET_CAP = 55_600
FAMILY_FBA_CAP_PEAK = 55_600  # Sep + Jan
FAMILY_FBA_CAP_OCT_DEC = 49_400
# Amazon optimistic high water — AWD is the holiday surge warehouse.
# Context only. Not leftover-after-FBA (~20k). Family 76,211 mid-Nov–late Jan.
# Do NOT use this as the near-term manufacture / month-card buy.
OPTIMISTIC_AWD_ON_HAND_TARGETS = {
    "DDPE0001Shop": 17_803,  # unscented
    "DDPE0002Shop": 10_590,  # peppermint
    "DDPE0003Shop": 22_827,  # orange
    "DDPE0004Shop": 24_991,  # assorted
}
OPTIMISTIC_AWD_TARGET_CAP = 76_211
# Locked first-wave AWD buy after FBA is maxed. New Marpac single-SKU → AWD.
# Not from Tulsa after tonight. Not the 76,211 optimistic high water.
FIRST_WAVE_AWD_TARGETS = {
    "DDPE0004Shop": 17_550,  # assorted — 1 full pallet
    "DDPE0003Shop": 17_550,  # orange — 1 full pallet
    "DDPE0001Shop": 17_550,  # unscented — 1 full pallet
    "DDPE0002Shop": 8_775,   # peppermint — half pallet at ≥50% / 8,775 floor
}
FIRST_WAVE_AWD_TARGET_CAP = 61_425
# Late September: assorted then orange (one SKU per pallet).
# Mid-October: unscented then peppermint. Not August for the second wave.
# August hops are Marpac→Tulsa + historical August 3PL→FBA only.
FIRST_WAVE_AWD_SHIP_ORDER = (
    "DDPE0004Shop",  # assorted
    "DDPE0003Shop",  # orange
    "DDPE0001Shop",  # unscented
    "DDPE0002Shop",  # peppermint
)
# Pin first-wave cards: Sept = assorted+orange, Oct = unscented+peppermint.
FIRST_WAVE_AWD_MONTH_BY_SKU = {
    "DDPE0004Shop": "2026-09",
    "DDPE0003Shop": "2026-09",
    "DDPE0001Shop": "2026-10",
    "DDPE0002Shop": "2026-10",
}
SEPT_FBA_NEED_IN_BY = date(2026, 10, 7)  # early Oct; late-Sept/early-Oct window
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
        "sept_fba_need_in_by": SEPT_FBA_NEED_IN_BY,
        "sept_fba_ship_by": last_ship_date(SEPT_FBA_NEED_IN_BY, recv_peak),
        "holiday_gate_last_3pl_fba": last_ship_date(AMAZON_IN_BY_DEFAULT, recv_peak),
        "tulsa_floor_units": TULSA_LIP_FLOOR_UNITS,
        "tulsa_cover_through": EARLY_FEB_COVER_THROUGH,
        "fba_receive_median": leadtime.get("fba_receive_median") if leadtime else None,
        "fba_receive_n": leadtime.get("fba_receive_n") if leadtime else 0,
        "awd_replenish_median": leadtime.get("awd_replenish_median") if leadtime else None,
        "awd_replenish_n": leadtime.get("awd_replenish_n") if leadtime else 0,
        "amazon_in_by": AMAZON_IN_BY_DEFAULT,
    }


def family_fba_cap_for_month(month: str | None = None) -> int:
    """Sep/Jan 55,600. Oct–Dec ~49,400. Never recommend FBA over the month cap."""
    if not month:
        return FAMILY_FBA_CAP_PEAK
    try:
        mo = int(str(month)[5:7])
    except (TypeError, ValueError):
        return FAMILY_FBA_CAP_PEAK
    if mo in (10, 11, 12):
        return FAMILY_FBA_CAP_OCT_DEC
    return FAMILY_FBA_CAP_PEAK


def scale_fba_caps(
    family_cap: int,
    mix: dict[str, int] | None = None,
    skus: list[str] | None = None,
) -> dict[str, int]:
    """Scale the Sept mix to a family FBA cap. Largest remainder; exact sum."""
    wanted = skus or LIP_BALM_SKUS
    weights = mix or SEPT_FBA_ON_HAND_TARGETS
    raw_w = [max(0, int(weights.get(sku, 0) or 0)) for sku in wanted]
    total_w = sum(raw_w)
    cap = max(0, int(family_cap))
    if total_w <= 0 or cap <= 0:
        return {sku: 0 for sku in wanted}
    exact = [cap * w / total_w for w in raw_w]
    rounded = [int(v) for v in exact]
    rem = cap - sum(rounded)
    order = sorted(
        range(len(wanted)),
        key=lambda i: (exact[i] - rounded[i], raw_w[i]),
        reverse=True,
    )
    i = 0
    while rem > 0 and order:
        rounded[order[i % len(order)]] += 1
        rem -= 1
        i += 1
    while rem < 0:
        richest = max(range(len(wanted)), key=lambda j: rounded[j])
        if rounded[richest] <= 0:
            break
        rounded[richest] -= 1
        rem += 1
    return {wanted[i]: rounded[i] for i in range(len(wanted))}


def fba_fill_gap(
    target: int,
    fba: int,
    inbound: int,
    august_to_fba: int = 0,
) -> int:
    """FBA hole vs the month cap. Not Manufacture — 3PL/August fill this first."""
    return max(
        0,
        int(target or 0)
        - max(0, int(fba or 0))
        - max(0, int(inbound or 0))
        - max(0, int(august_to_fba or 0)),
    )


def fba_manufacture_gap(
    target: int,
    fba: int,
    inbound: int,
    august: int = 0,
) -> int:
    """FBA-cap hole after SC on-hand + inbound + August-to-FBA.

    Display / mixed-track input only. Manufacture column is AWD surge,
    not this number. Inbound is not re-sent.
    """
    return fba_fill_gap(target, fba, inbound, august)


def split_august_to_piles(august: int, fba_gap: int) -> tuple[int, int]:
    """August offsets FBA fill first; leftover goes to AWD (reduces surge buy)."""
    aug = max(0, int(august or 0))
    gap = max(0, int(fba_gap or 0))
    to_fba = min(aug, gap)
    return to_fba, aug - to_fba


def awd_surge_need(
    target: int,
    awd_on_hand: int = 0,
    august_to_awd: int = 0,
) -> int:
    """Units still needed in AWD to hit an on-hand target.

    Optimistic 76,211 is display context, not the near-term buy.
    First-wave manufacture uses ``first_wave_awd_need`` (locked pallets,
    token AWD on-hand does not shrink them).
    """
    return max(
        0,
        int(target or 0)
        - max(0, int(awd_on_hand or 0))
        - max(0, int(august_to_awd or 0)),
    )


def first_wave_awd_need(
    target: int,
    august_to_awd: int = 0,
    tpl_to_awd: int = 0,
) -> int:
    """Locked first-wave Marpac → AWD buy.

    New single-SKU manufacture, not Tulsa after tonight. Token AWD
    on-hand (e.g. 540 peppermint) does not shrink a locked pallet or
    the 8,775 half-pallet floor. August leftover to AWD still reduces
    the buy.
    """
    return max(
        0,
        int(target or 0)
        - max(0, int(august_to_awd or 0))
        - max(0, int(tpl_to_awd or 0)),
    )


def first_wave_ship_skus(skus: list[str] | None = None) -> list[str]:
    """Assorted + orange first, then unscented + peppermint."""
    wanted = list(skus or LIP_BALM_SKUS)
    wanted_set = set(wanted)
    ordered = [sku for sku in FIRST_WAVE_AWD_SHIP_ORDER if sku in wanted_set]
    for sku in wanted:
        if sku not in ordered:
            ordered.append(sku)
    return ordered


def leftover_3pl_to_awd(
    transferable: dict[str, int],
    tpl_to_fba: dict[str, int],
    awd_need: dict[str, int],
) -> dict[str, int]:
    """Leftover hops to AWD only when live family AWD is already loaded (≥5k)."""
    out: dict[str, int] = {}
    for sku in transferable:
        leftover = max(
            0,
            int(transferable.get(sku, 0) or 0) - int(tpl_to_fba.get(sku, 0) or 0),
        )
        out[sku] = min(leftover, max(0, int(awd_need.get(sku, 0) or 0)))
    return out


def inbound_carton_min(carton_units: int = DEFAULT_INBOUND_CARTON_UNITS) -> int:
    """Placement-fee floor: 5 boxes of this carton."""
    return max(1, int(carton_units or DEFAULT_INBOUND_CARTON_UNITS)) * FBA_INBOUND_MIN_BOXES


def is_legal_inbound_qty(
    qty: int,
    carton_units: int = DEFAULT_INBOUND_CARTON_UNITS,
) -> bool:
    """Legal 3PL→FBA qty for the carton in use. 0, or ≥5 boxes, step = carton.

    540-box path: 2,700, 3,240, 3,780, … (allocator; not August 3PL→FBA today).
    270-box path: 1,350, 1,620, 1,890, … (4,860 = 18 × 270 is legal).
    Never recommend under the 5-box min for that carton.
    """
    q = int(qty or 0)
    if q == 0:
        return True
    step = max(1, int(carton_units or DEFAULT_INBOUND_CARTON_UNITS))
    return q >= inbound_carton_min(step) and q % step == 0


def fee_free_inbound_qty(
    available: int,
    gap: int,
    preferred: int = FBA_INBOUND_PREFERRED,
    min_send: int = FBA_INBOUND_MIN_FEE_FREE,
    step_after: int = FBA_INBOUND_STEP_AFTER,
    allow_partial: bool = False,
) -> int:
    """Usual send = largest 2,700 multiple ≤ min(available, gap).

    Hard rules: never send under 1,350; after 2,700 only 2,700+540n.
    If there is no 2,700 multiple, the SKU waits (August) unless
    allow_partial and cap ≥ 1,350. Allocator unscented waits.
    """
    cap = min(max(0, int(available or 0)), max(0, int(gap or 0)))
    preferred = max(1, int(preferred or FBA_INBOUND_PREFERRED))
    min_send = max(0, int(min_send or 0))
    qty = (cap // preferred) * preferred
    if qty >= preferred and is_legal_inbound_qty(qty, step_after):
        return qty
    if allow_partial and cap >= min_send > 0:
        return min_send if cap >= min_send else 0
    return 0


def allocate_3pl_fba_send(
    sku_3pl: dict[str, int],
    gaps: dict[str, int],
    *,
    floor: int = TULSA_LIP_FLOOR_UNITS,
    awd_loaded: bool = False,
    skus: list[str] | None = None,
    preferred: int = FBA_INBOUND_PREFERRED,
    min_send: int = FBA_INBOUND_MIN_FEE_FREE,
) -> dict:
    """Allocator 3PL→FBA: 2,700 multiples only. Do not empty Tulsa.

    Live AWD 540 is not loaded — keep ≥5k in Tulsa, leftover stays Tulsa
    (no peppermint→AWD). Drop 2,700 chunks if a send would breach the
    floor.     Never send a SKU under 1,350. The August 3PL→FBA card does not
    use this — see apply_locked_tonight_3pl_fba_send.
    """
    wanted = skus or list(sku_3pl.keys())
    on_hand = {sku: max(0, int(sku_3pl.get(sku, 0) or 0)) for sku in wanted}
    gap = {sku: max(0, int(gaps.get(sku, 0) or 0)) for sku in wanted}
    preferred = max(1, int(preferred or FBA_INBOUND_PREFERRED))
    send = {
        sku: fee_free_inbound_qty(on_hand[sku], gap[sku], preferred, min_send)
        for sku in wanted
    }
    floor_now = 0 if awd_loaded else max(0, int(floor or 0))
    hold = {sku: on_hand[sku] - send[sku] for sku in wanted}
    while not awd_loaded and sum(hold.values()) < floor_now:
        candidates = [sku for sku in wanted if send[sku] >= preferred]
        if not candidates:
            break
        victim = min(candidates, key=lambda s: (send[s], gap[s]))
        send[victim] -= preferred
        hold[victim] += preferred
    for sku in wanted:
        if 0 < send[sku] < min_send:
            hold[sku] += send[sku]
            send[sku] = 0
    hop = {sku: 0 for sku in wanted}
    if awd_loaded:
        hop = leftover_3pl_to_awd(on_hand, send, {sku: 10**9 for sku in wanted})
        hold = {sku: on_hand[sku] - send[sku] - hop[sku] for sku in wanted}
    return {
        "tpl_to_fba": send,
        "tulsa_hold": hold,
        "tpl_to_awd": hop,
        "floor": floor_now,
        "awd_loaded": awd_loaded,
        "send_total": sum(send.values()),
        "hold_total": sum(hold.values()),
        "hop_total": sum(hop.values()),
        "preferred": preferred,
        "min_send": min_send,
        "waits_on_august": {
            sku: send[sku] == 0 and gap[sku] > 0 and on_hand[sku] > 0
            for sku in wanted
        },
    }


def apply_locked_september_3pl_hops(
    sku_3pl: dict[str, int],
    gaps: dict[str, int] | None = None,
    *,
    skus: list[str] | None = None,
    awd_loaded: bool = False,
    floor: int = TULSA_LIP_FLOOR_UNITS,
) -> dict:
    """Sep 4 small-parcel hops: 3PL→FBA 8,100 + 3PL→AWD orange 2,700.

    Do not re-allocate. Do not round to a 540 multiple. The 2,700
    orange AWD hop is small parcel — no ≥50% AWD floor. Leftover
    Tulsa is display only.
    """
    wanted = skus or LIP_BALM_SKUS
    on_hand = {sku: max(0, int(sku_3pl.get(sku, 0) or 0)) for sku in wanted}
    gap = {sku: max(0, int((gaps or {}).get(sku, 0) or 0)) for sku in wanted}
    send = {
        sku: int(LOCKED_SEPTEMBER_3PL_FBA_SEND.get(sku, 0) or 0)
        for sku in wanted
    }
    hop = {
        sku: int(LOCKED_SEPTEMBER_3PL_AWD_SEND.get(sku, 0) or 0)
        for sku in wanted
    }
    hold = {sku: max(0, on_hand[sku] - send[sku] - hop[sku]) for sku in wanted}
    floor_now = 0 if awd_loaded else max(0, int(floor or 0))
    return {
        "tpl_to_fba": send,
        "tulsa_hold": hold,
        "tpl_to_awd": hop,
        "floor": floor_now,
        "awd_loaded": awd_loaded,
        "send_total": sum(send.values()),
        "hold_total": sum(hold.values()),
        "hop_total": sum(hop.values()),
        "preferred": FBA_INBOUND_PREFERRED,
        "min_send": FBA_INBOUND_MIN_FEE_FREE,
        "locked": True,
        "waits_on_august": {
            sku: send[sku] == 0 and gap[sku] > 0 and on_hand[sku] > 0
            for sku in wanted
        },
    }


def apply_locked_tonight_3pl_fba_send(
    sku_3pl: dict[str, int],
    gaps: dict[str, int] | None = None,
    *,
    skus: list[str] | None = None,
    awd_loaded: bool = False,
    floor: int = TULSA_LIP_FLOOR_UNITS,
) -> dict:
    """Deprecated alias for apply_locked_september_3pl_hops."""
    return apply_locked_september_3pl_hops(
        sku_3pl, gaps, skus=skus, awd_loaded=awd_loaded, floor=floor,
    )


def _locked_mix_from(send: dict[str, int], skus: list[str] | None = None) -> dict[str, int]:
    wanted = skus or LIP_BALM_SKUS
    return {
        sku: qty
        for sku in wanted
        if (qty := int(send.get(sku, 0) or 0)) > 0
    }


def locked_august_marpac_tulsa_mix(skus: list[str] | None = None) -> dict[str, int]:
    """Dave's August Marpac→Tulsa hop. Display lock only — not FBA/AWD.

    6,480 unscented + 3,240 assorted + 3,240 orange = 12,960.
    Peppermint is not on this hop. Do not split into FBA then AWD.
    """
    return _locked_mix_from(LOCKED_AUGUST_MARPAC_TULSA_SEND, skus)


def locked_august_3pl_fba_mix(skus: list[str] | None = None) -> dict[str, int]:
    """Historical August 3PL→FBA that shipped in August. Not Sep 4."""
    return _locked_mix_from(LOCKED_AUGUST_3PL_FBA_SEND, skus)


def locked_september_3pl_fba_mix(skus: list[str] | None = None) -> dict[str, int]:
    """Sep 4 3PL→FBA. September card only."""
    return _locked_mix_from(LOCKED_SEPTEMBER_3PL_FBA_SEND, skus)


def locked_september_3pl_awd_mix(skus: list[str] | None = None) -> dict[str, int]:
    """Sep 4 3PL→AWD orange small parcel. No ≥50% AWD floor."""
    return _locked_mix_from(LOCKED_SEPTEMBER_3PL_AWD_SEND, skus)


def remaining_wanted_cover(
    wanted_cover: int,
    fba_target: int,
    awd_on_hand: int = 0,
) -> int:
    """Legacy leftover-after-FBA. Do not use as the AWD surge target.

    AWD high water is OPTIMISTIC_AWD_ON_HAND_TARGETS (76,211), not
    wanted_cover minus the FBA cap.
    """
    return max(
        0,
        int(wanted_cover or 0) - int(fba_target or 0) - max(0, int(awd_on_hand or 0)),
    )


def sku_production_build(
    demand_row: dict,
    *,
    cover_days: int = 60,
    receive_days: int = 35,
    optimistic_units: int = 0,
    fba_target: int = 0,
) -> dict:
    """Unstacked per-SKU lines — do not add peak-60d onto Nov–Jan sales.

    Display / sku_build = Nov–Jan sell-through (YoY, or Assorted CF).
    wanted_cover = max(sell-through, optimistic) — stock-to-cover if it hits.
    Peak-60d and 35d pipeline are labeled context only; they overlap Nov–Jan
    and must not be summed into Manufacture. AWD surge uses the optimistic
    high-water targets (76,211), not leftover-after-FBA.
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
    wanted_cover = cover_fulfill
    target = max(0, int(fba_target or 0))
    awd_ammo = remaining_wanted_cover(wanted_cover, target)
    # Historical stacked sum — do not manufacture this.
    stacked_build = cover_fulfill + ending_cover + pipeline
    return {
        "demand": display_demand,
        "display_demand": display_demand,
        "sellthrough": display_demand,
        "cover_fulfill": cover_fulfill,
        "wanted_cover": wanted_cover,
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
        "gate_units": nov_dec,
        "refill_units": stock_to_cover + jan_units,
        "awd_ammo": awd_ammo,
        "fba_target": target,
        "sku_build": display_demand,
        "stacked_build": stacked_build,
        "unstacked": True,
    }


def awd_covers_off_fba_reserve(
    sku_awd: dict[str, int] | None = None,
    awd_planned: dict[str, int] | None = None,
    min_units: int = TULSA_LIP_FLOOR_UNITS,
) -> bool:
    """True when live family AWD can replace the Tulsa reserve.

    Loaded = on-hand ≥ 5,000 lip units. Planned manufacture does not
    empty Tulsa tonight. A token balance (e.g. 540 peppermint) is not
    loaded — keep the 5k floor. awd_planned is ignored (compat only).
    """
    awd_oh = sum(max(int(v or 0), 0) for v in (sku_awd or {}).values())
    _ = awd_planned
    return awd_oh >= max(int(min_units or 0), 0)


def effective_tulsa_floor(
    sku_awd: dict[str, int] | None = None,
    awd_planned: dict[str, int] | None = None,
    floor: int = TULSA_LIP_FLOOR_UNITS,
) -> int:
    """Drop the 5k Tulsa floor when AWD is loaded (≥5k family).

    Off-FBA reserve can sit in AWD. A token AWD balance is not loaded.
    Keep 5k when we'd otherwise plan 0 AWD and 0 Tulsa.
    """
    if awd_covers_off_fba_reserve(sku_awd, awd_planned):
        return 0
    return max(0, int(floor or 0))


def family_tulsa_floor(
    sku_3pl: dict[str, int],
    floor: int = TULSA_LIP_FLOOR_UNITS,
    sku_awd: dict[str, int] | None = None,
    awd_planned: dict[str, int] | None = None,
) -> dict:
    """Family Tulsa reserve. 5k unless AWD ≥5k family can replace it.

    Loaded AWD (on-hand ≥ reserve) drops floor and top_up. Token AWD
    and planned surge do not. Never plan 0 AWD and 0 Tulsa.
    """
    awd_loaded = awd_covers_off_fba_reserve(sku_awd, awd_planned)
    effective = effective_tulsa_floor(sku_awd, awd_planned, floor)
    on_hand = sum(max(int(v or 0), 0) for v in sku_3pl.values())
    transferable = max(0, on_hand - effective)
    top_up = 0 if awd_loaded else max(0, effective - on_hand)
    return {
        "floor": effective,
        "configured_floor": max(0, int(floor or 0)),
        "awd_loaded": awd_loaded,
        "on_hand": on_hand,
        "transferable": transferable,
        "top_up": top_up,
        "split_per_sku": False,
        "never_zero_both": True,
    }


def tulsa_after_christmas_outbound(
    sku_3pl: dict[str, int],
    early_jan_fba_from_tulsa: int,
    floor: int = TULSA_LIP_FLOOR_UNITS,
    cover_through: date | None = None,
    sku_awd: dict[str, int] | None = None,
    awd_planned: dict[str, int] | None = None,
) -> dict:
    """Keep Tulsa only when AWD does not already cover off-FBA reserve.

    When AWD is loaded, Tulsa may drain to 0. When AWD is empty, keep
    the 5k family floor after Dec 3PL→FBA outbounds — never 0+0.
    """
    info = family_tulsa_floor(
        sku_3pl, floor, sku_awd=sku_awd, awd_planned=awd_planned,
    )
    need = max(int(early_jan_fba_from_tulsa or 0), 0)
    outbound = min(need, info["transferable"])
    after = info["on_hand"] - outbound
    return {
        **info,
        "early_jan_fba_from_tulsa": need,
        "outbound": outbound,
        "after_outbound": after,
        "needed_before_outbound": need + info["floor"],
        "meets_floor_after_outbound": after >= info["floor"],
        "cover_through": (cover_through or EARLY_FEB_COVER_THROUGH).isoformat(),
        "do_not_drain_to_zero": not info["awd_loaded"],
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

    Two full + one partial is fine. Do not require even 17,550 cards.
    A leftover like 1,000 or 4,276 is merge-or-hold — never its own pallet.
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


def holiday_gate_last_3pl_fba(receiving_days: int = 35) -> date:
    """Last 3PL→FBA ship that can still make the 2026-10-31 holiday gate."""
    return last_ship_date(AMAZON_IN_BY_DEFAULT, receiving_days)


def sept_fba_ship_by(receiving_days: int = 35) -> date:
    """Leave Tulsa by ~early Sep so 35d peak receive checks in late Sep/early Oct."""
    return last_ship_date(SEPT_FBA_NEED_IN_BY, receiving_days)


def sept_fba_gaps(
    sku_fba: dict[str, int],
    sku_inbound: dict[str, int],
    targets: dict[str, int] | None = None,
    skus: list[str] | None = None,
) -> dict[str, dict]:
    """Per-SKU FBA on-hand gap vs Sept targets.

    Supply = Seller Central on-hand (fulfillable + FC transfer) + inbound
    already in transit. Unfulfillable is out. Inbound is not sent again.
    Targets are on-hand goals, not a locked mix recipe.
    """
    wanted = skus or LIP_BALM_SKUS
    tgt = targets or SEPT_FBA_ON_HAND_TARGETS
    out: dict[str, dict] = {}
    for sku in wanted:
        fba = max(int(sku_fba.get(sku, 0) or 0), 0)
        inbound = max(int(sku_inbound.get(sku, 0) or 0), 0)
        target = int(tgt.get(sku, 0) or 0)
        supply = fba + inbound
        out[sku] = {
            "target": target,
            "fba": fba,
            "inbound": inbound,
            "fba_plus_inbound": supply,
            "gap": max(0, target - supply),
        }
    return out


def sept_3pl_to_fba(
    sku_3pl: dict[str, int],
    gaps: dict[str, dict] | dict[str, int],
    floor: int = TULSA_LIP_FLOOR_UNITS,
) -> dict[str, int]:
    """3PL→FBA toward Sept FBA gaps. Excess above the effective Tulsa floor.

    Floor is 0 when AWD is loaded. Caps each SKU at its remaining FBA
    gap (inbound already counted). Unlocked shares — not a locked mix.
    """
    xfer = transferable_3pl_by_sku(sku_3pl, floor)
    rec: dict[str, int] = {}
    for sku in sku_3pl:
        raw = gaps.get(sku, 0)
        gap = int(raw.get("gap", 0) if isinstance(raw, dict) else raw or 0)
        rec[sku] = min(max(int(xfer.get(sku, 0) or 0), 0), max(gap, 0))
    return rec


def allocate_single_sku_awd_pallets(
    remainder: dict[str, int],
    skus: list[str],
    pallet_max: int = PALLET_MAX_UNITS,
) -> list[dict]:
    """Single-SKU pallets straight to AWD. No pallet-count limit. One SKU per card.

    ≥50% partial still applies; under-half leftover is held, not a card.
    """
    cards: list[dict] = []
    n = 0
    for sku in skus:
        qty = max(int(remainder.get(sku, 0) or 0), 0)
        fill = pallet_fill(qty, pallet_max)
        for size in pallet_card_sizes(fill, pallet_max):
            n += 1
            cards.append({
                "pallet_num": n,
                "sku": sku,
                "mix": {sku: size},
                "total_units": size,
                "locked": False,
                "partial": size < pallet_max,
                "destination": "awd",
                "single_sku": True,
            })
    return cards


def build_september_plan(
    sku_fba: dict[str, int],
    sku_inbound: dict[str, int],
    sku_3pl: dict[str, int],
    sku_wanted_cover: dict[str, int] | None = None,
    sku_august: dict[str, int] | None = None,
    sku_awd: dict[str, int] | None = None,
    *,
    receive_days: int = 35,
    tulsa_floor: int = TULSA_LIP_FLOOR_UNITS,
    targets: dict[str, int] | None = None,
    sku_awd_targets: dict[str, int] | None = None,
    family_fba_cap: int | None = None,
    month: str | None = None,
    skus: list[str] | None = None,
    pallet_max: int = PALLET_MAX_UNITS,
) -> dict:
    """Two piles: mixed Marpac → Tulsa → FBA to the month cap, then AWD.

    Track 1 — Mixed pallets fill the month FBA cap after SC on-hand +
    inbound + Tulsa + August. That remainder is not the Manufacture column.
    Track 2 — Near-term new Marpac is the locked first-wave single-SKU
    AWD buy (61,425), not optimistic 76,211. Optimistic high water stays
    as context. Tulsa is a hop: after FBA is full, leftover transferable
    3PL goes to AWD only when AWD is already loaded. Never plan 0 AWD
    and 0 Tulsa. August Marpac→Tulsa is a locked Tulsa-only hop
    (not fed into this FBA/AWD split). Do not empty Tulsa after tonight.
    """
    wanted = skus or LIP_BALM_SKUS
    cap = int(family_fba_cap if family_fba_cap is not None else family_fba_cap_for_month(month))
    tgt = targets or scale_fba_caps(cap, SEPT_FBA_ON_HAND_TARGETS, wanted)
    use_first_wave = sku_awd_targets is None
    if sku_awd_targets is not None:
        awd_tgt = {sku: max(0, int(sku_awd_targets.get(sku, 0) or 0)) for sku in wanted}
    else:
        awd_tgt = {
            sku: max(0, int(FIRST_WAVE_AWD_TARGETS.get(sku, 0) or 0))
            for sku in wanted
        }
    sku_wanted_cover = sku_wanted_cover or {}
    sku_august = sku_august or {}
    sku_awd = sku_awd or {}
    gaps = sept_fba_gaps(sku_fba, sku_inbound, tgt, wanted)
    sku_august_out: dict[str, int] = {}
    august_to_fba: dict[str, int] = {}
    august_to_awd: dict[str, int] = {}
    sku_gap_after_aug: dict[str, int] = {}
    for sku in wanted:
        august = max(0, int(sku_august.get(sku, 0) or 0))
        sku_august_out[sku] = august
        to_fba, to_awd = split_august_to_piles(august, int(gaps[sku]["gap"]))
        august_to_fba[sku] = to_fba
        august_to_awd[sku] = to_awd
        sku_gap_after_aug[sku] = max(0, int(gaps[sku]["gap"]) - to_fba)
    if use_first_wave:
        # Locked first-wave buy. Token AWD on-hand does not shrink pallets.
        awd_need_before_tpl = {
            sku: first_wave_awd_need(int(awd_tgt.get(sku, 0) or 0), august_to_awd[sku])
            for sku in wanted
        }
    else:
        awd_need_before_tpl = {
            sku: awd_surge_need(
                int(awd_tgt.get(sku, 0) or 0),
                int(sku_awd.get(sku, 0) or 0),
                august_to_awd[sku],
            )
            for sku in wanted
        }
    sku_3pl_wanted = {sku: sku_3pl.get(sku, 0) for sku in wanted}
    awd_loaded_now = awd_covers_off_fba_reserve(sku_awd)
    send_plan = apply_locked_september_3pl_hops(
        sku_3pl_wanted,
        sku_gap_after_aug,
        floor=tulsa_floor,
        awd_loaded=awd_loaded_now,
        skus=wanted,
    )
    floor_now = int(send_plan["floor"])
    tpl_rec = send_plan["tpl_to_fba"]
    tpl_awd = send_plan["tpl_to_awd"]
    tulsa_hold = send_plan["tulsa_hold"]
    fba_still_short = {
        sku: max(0, sku_gap_after_aug[sku] - int(tpl_rec.get(sku, 0) or 0))
        for sku in wanted
    }
    # Remaining FBA hole waits on Dave's August mixed pallet — do not bake
    # a mixed Marpac mix. After August, new Marpac is single-SKU AWD only.
    mixed_need = {sku: 0 for sku in wanted}
    # Sep 4 3PL→AWD is existing Tulsa stock, not a cut to first-wave Marpac pallets.
    sku_manufacture = {
        sku: max(0, awd_need_before_tpl[sku])
        for sku in wanted
    }
    mixed_cards, mixed_held, mixed_fill = allocate_pallet_cards(
        mixed_need, wanted, pallet_max,
    )
    awd_cards = allocate_single_sku_awd_pallets(
        sku_manufacture, first_wave_ship_skus(wanted), pallet_max,
    )
    for card in awd_cards:
        card["track"] = "single_sku_awd"
        card["destination"] = "awd"
        card["single_sku"] = True
        card["first_wave"] = bool(use_first_wave)
        card["aim_end_of_september"] = bool(
            use_first_wave and card.get("sku") in FIRST_WAVE_AWD_SHIP_ORDER[:2]
        )
    fba_after_send = {
        sku: int(gaps[sku]["fba_plus_inbound"])
        + int(tpl_rec.get(sku, 0) or 0)
        + august_to_fba[sku]
        for sku in wanted
    }
    tulsa = family_tulsa_floor(
        sku_3pl_wanted,
        tulsa_floor,
        sku_awd=sku_awd,
    )
    tulsa["hold"] = tulsa_hold
    tulsa["hold_total"] = sum(tulsa_hold.values())
    tulsa["after_send"] = sum(tulsa_hold.values())
    ship_by = sept_fba_ship_by(receive_days)
    gate_last = holiday_gate_last_3pl_fba(receive_days)
    return {
        "targets": {sku: int(tgt.get(sku, 0) or 0) for sku in wanted},
        "target_cap": cap,
        "awd_targets": awd_tgt,
        "awd_target_cap": sum(awd_tgt.values()),
        "first_wave_awd_targets": {
            sku: int(FIRST_WAVE_AWD_TARGETS.get(sku, 0) or 0) for sku in wanted
        },
        "first_wave_awd_cap": FIRST_WAVE_AWD_TARGET_CAP,
        "first_wave_ship_order": list(first_wave_ship_skus(wanted)),
        "near_term_awd_is_first_wave": bool(use_first_wave),
        "optimistic_awd_targets": {
            sku: int(OPTIMISTIC_AWD_ON_HAND_TARGETS.get(sku, 0) or 0) for sku in wanted
        },
        "optimistic_awd_target_cap": OPTIMISTIC_AWD_TARGET_CAP,
        "need_in_fba": SEPT_FBA_NEED_IN_BY.isoformat(),
        "ship_by": ship_by.isoformat(),
        "receive_days": receive_days,
        "holiday_gate_last_3pl_fba": gate_last.isoformat(),
        "tulsa_floor_units": floor_now,
        "tulsa_floor_configured": tulsa_floor,
        "tulsa": tulsa,
        "awd_loaded": awd_loaded_now,
        "tulsa_hold": tulsa_hold,
        "gaps": gaps,
        "sku_august": sku_august_out,
        "august_to_fba": august_to_fba,
        "august_to_awd": august_to_awd,
        "august_tbd": all(qty <= 0 for qty in sku_august_out.values()),
        "sku_manufacture": sku_manufacture,
        "sku_gap_after_aug": sku_gap_after_aug,
        "fba_still_short": fba_still_short,
        "manufacture_into_fba": mixed_need,
        "tpl_to_fba": tpl_rec,
        "tpl_to_awd": tpl_awd,
        "fba_after_send": fba_after_send,
        "mixed_need": mixed_need,
        "mixed_pallets": mixed_cards,
        "mixed_held": mixed_held,
        "mixed_fill": mixed_fill,
        "awd_need": sku_manufacture,
        "awd_need_before_tpl": awd_need_before_tpl,
        "awd_pallets": awd_cards,
        "first_action": {
            "tpl_to_fba": tpl_rec,
            "tpl_to_fba_total": sum(tpl_rec.values()),
            "tpl_to_awd": tpl_awd,
            "tpl_to_awd_total": sum(tpl_awd.values()),
            "tulsa_hold": tulsa_hold,
            "tulsa_hold_total": sum(tulsa_hold.values()),
            "fba_after_send": fba_after_send,
            "fba_after_send_total": sum(fba_after_send.values()),
            "fba_still_short": fba_still_short,
            "fba_still_short_total": sum(fba_still_short.values()),
            "inbound_preferred": FBA_INBOUND_PREFERRED,
            "inbound_min": FBA_INBOUND_MIN_FEE_FREE,
            "sku_waits_on_august": send_plan["waits_on_august"],
            "waits_on_august": all(qty <= 0 for qty in sku_august_out.values()),
            "august_is_mixed": True,
            "august_hop": AUGUST_HOP_LABEL,
            "after_august_single_sku_awd": True,
        },
        "path": "mixed_fba_cap_then_single_sku_awd_surge",
        "two_tracks": True,
        "mix_locked": False,
        "unstacked": True,
    }


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


def fba_cover_units(
    snap: dict,
    restock: dict | None = None,
    planning: dict | None = None,
) -> int:
    """Cover / cap uses Seller Central on-hand, not API fulfillable.

    FBA = fulfillable + restock FC transfer. Unfulfillable stays out.
    Shares src.inventory.sc_on_hand with the inventory table.
    """
    splits = parse_reserved_splits(raw_from_row(restock), raw_from_row(planning))
    return sc_on_hand_units(int(snap.get("fulfillable", 0) or 0), splits)


def _latest_restock_planning() -> tuple[dict[str, dict], dict[str, dict]]:
    restock: dict[str, dict] = {}
    planning: dict[str, dict] = {}
    try:
        restock = latest_row_per_sku(fetch_all("inventory_restock"))
    except Exception:
        pass
    try:
        planning = latest_row_per_sku(fetch_all("inventory_planning"))
    except Exception:
        pass
    return restock, planning


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
    pallet_max: int = PALLET_MAX_UNITS,
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
    restock_rows, planning_rows = _latest_restock_planning()
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
    sku_awd_oh = {
        sku: int(awds.get(normalize_sku(sku), {}).get("awd_on_hand", 0) or 0)
        if include_awd else 0
        for sku in target_skus
    }

    # Per-SKU analysis — unstacked: sell-through vs late-Sep FBA target.
    sku_plans: list[dict] = []
    total_gap = 0

    for sku in target_skus:
        key = normalize_sku(sku)
        s = snaps.get(key, {})
        fba = fba_cover_units(s, restock_rows.get(key), planning_rows.get(key))
        inbound = inbound_in_transit(s)
        awd_oh = sku_awd_oh[sku]
        tpl_oh = sku_3pl[sku]
        xfer = 0

        amazon_supply = fba + inbound + awd_oh + xfer

        d = sales_demand.get(sku, {})
        fba_tgt = int(SEPT_FBA_ON_HAND_TARGETS.get(sku, 0) or 0)
        build = sku_production_build(
            d,
            cover_days=policy["target_cover_days"],
            receive_days=policy["gate_receive_days"],
            optimistic_units=optimistic_by_sku.get(sku, 0),
            fba_target=fba_tgt,
        )
        nov_dec_demand = build["nov_dec_demand"]
        jan_demand = build["jan_demand"]
        sellthrough = build["sellthrough"]
        gap = fba_manufacture_gap(fba_tgt, fba, inbound)
        total_gap += gap

        sku_plans.append({
            "sku": sku,
            "nov_dec_demand": nov_dec_demand,
            "nov_dec_prior": int(d.get("nov_dec_prior", 0)),
            "jan_demand": jan_demand,
            "display_demand": build["display_demand"],
            "sellthrough": sellthrough,
            "cover_fulfill": build["cover_fulfill"],
            "wanted_cover": build["wanted_cover"],
            "stock_to_cover": build["stock_to_cover"],
            "peak_cover": build["peak_cover"],
            "jan_cover": build["jan_cover"],
            "ending_cover": build["ending_cover"],
            "pipeline": build["pipeline"],
            "fba_target": fba_tgt,
            "production_target": fba_tgt,
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
            "covered": min(fba + inbound, fba_tgt),
            "gap": gap,
        })

    sept = build_september_plan(
        {p["sku"]: p["fba"] for p in sku_plans},
        {p["sku"]: p["inbound"] for p in sku_plans},
        sku_3pl,
        {p["sku"]: p["wanted_cover"] for p in sku_plans},
        sku_awd=sku_awd_oh,
        receive_days=int(policy["gate_receive_days"]),
        tulsa_floor=int(policy["tulsa_floor_units"]),
        pallet_max=pallet_max,
    )
    tulsa = sept["tulsa"]
    tpl_xfer = sept["tpl_to_fba"]
    for p in sku_plans:
        p["tpl_transferable"] = int(tpl_xfer.get(p["sku"], 0) or 0)
        p["amazon_supply"] = p["fba"] + p["inbound"] + p["awd"] + p["tpl_transferable"]
    tulsa_xmas = tulsa_after_christmas_outbound(
        sku_3pl, tulsa["transferable"], policy["tulsa_floor_units"],
        cover_through=policy.get("tulsa_cover_through"),
        sku_awd=sku_awd_oh,
        awd_planned=sept["awd_need"],
    )

    # Mixed Tulsa→FBA cards from the FBA-target gap (not stacked cover).
    remaining_gaps = dict(sept["mixed_need"])
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
            "cover": "fba_sc_on_hand",
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
        "units_still_short": sum(leftover_mix.values()),
        "yoy_by_sku": yoy_by_sku,
        "family_yoy_context_only": family_ctx,
        "tulsa_3pl": tulsa,
        "tulsa_after_christmas_outbound": tulsa_xmas,
        "optimistic_by_sku": optimistic_by_sku,
        "september": sept,
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
    restock_rows, planning_rows = _latest_restock_planning()
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
        fba_now = fba_cover_units(
            s, restock_rows.get(normalize_sku(sku)), planning_rows.get(normalize_sku(sku)),
        )
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


# Sept–Dec AWD schedule. `_month_entries` used to skip September
# (gate month, < 2026-10) and dump manufacture into Oct–Dec only.
AWD_SCHEDULE_MONTHS = ("2026-09", "2026-10", "2026-11", "2026-12")


def hop_label(destination: str, *, awaiting_august: bool = False) -> str:
    """Visible hop on a month card. August: Marpac→Tulsa and/or 3PL→FBA."""
    if destination == "3pl_fba":
        return "3PL→FBA"
    if destination == SEPTEMBER_AWD_HOP_DESTINATION:
        return "3PL→AWD"
    if destination == "awd":
        return "single-SKU AWD"
    if destination == AUGUST_HOP_DESTINATION or awaiting_august:
        return AUGUST_HOP_LABEL
    if destination == "fba_then_awd":
        return "remaining FBA then AWD"
    return ""


def _awd_card_ship_rank(card: dict) -> tuple[int, bool, int]:
    sku = str(card.get("sku") or "")
    if not sku:
        mix = card.get("mix") or {}
        sku = next(iter(mix), "")
    try:
        rank = FIRST_WAVE_AWD_SHIP_ORDER.index(sku)
    except ValueError:
        rank = 99
    return (rank, bool(card.get("partial")), -int(card.get("total_units") or 0))


def assign_awd_cards_to_months(
    cards: list[dict],
    production_months: list[str],
) -> dict[str, list[dict]]:
    """Up to two legal single-SKU AWD cards per Sep–Dec month.

    Pin first-wave cards: late September = assorted then orange,
    mid-October = unscented then peppermint. Never August for the
    second wave. About 2/month is the max. Under-half leftovers
    are never cards.
    """
    months = [m for m in AWD_SCHEDULE_MONTHS if m in production_months]
    if not months:
        months = [
            m for m in production_months
            if not str(m).endswith("-08") and str(m)[5:7] >= "09"
        ]
    months = [m for m in months if not str(m).endswith("-08")]
    ordered = sorted(cards, key=_awd_card_ship_rank)
    out: dict[str, list[dict]] = {m: [] for m in months}
    leftover: list[dict] = []
    for card in ordered:
        sku = str(card.get("sku") or "")
        if not sku:
            mix = card.get("mix") or {}
            sku = next(iter(mix), "")
        pinned = FIRST_WAVE_AWD_MONTH_BY_SKU.get(sku)
        if pinned and pinned in out and len(out[pinned]) < AWD_CARDS_PER_MONTH_MAX:
            out[pinned].append(card)
        else:
            leftover.append(card)
    i = 0
    for month in months:
        while i < len(leftover) and len(out[month]) < AWD_CARDS_PER_MONTH_MAX:
            out[month].append(leftover[i])
            i += 1
    extras_month = months[-1] if months else None
    if extras_month and i < len(leftover):
        out[extras_month].extend(leftover[i:])
    return out


def build_month_view_entries(
    production_months: list[str],
    horizon_by_month: dict[str, dict],
    sept: dict,
    *,
    sku_august: dict[str, int] | None = None,
    target_skus: list[str] | None = None,
    pallet_max: int = PALLET_MAX_UNITS,
    amazon_in_by: date | None = None,
    peak_end: date | None = None,
    committed: set[str] | None = None,
    today: date | None = None,
) -> list[dict]:
    """Rebuild Aug–Dec cards. Do not skip September.

    August = locked Marpac→Tulsa 12,960 in transit 2026-08-31
    (Tulsa 3PL only) AND historical August 3PL→FBA 12,960.
    September = Sep 4 small-parcel hops (3PL→FBA 8,100 + 3PL→AWD
    orange 2,700) plus first-wave AWD (assorted + orange).
    October = unscented then peppermint first-wave AWD (mid-Oct).
    Not a zero Sept. Keep August on the board after Sep 1 so the
    in-transit hop still shows.
    """
    wanted = target_skus or LIP_BALM_SKUS
    amazon_in_by = amazon_in_by or AMAZON_IN_BY_DEFAULT
    peak_end = peak_end or PEAK_END_DEFAULT
    committed = committed or set()
    today = today or date.today()
    production_months = list(production_months)
    if LOCKED_AUGUST_MONTH not in production_months:
        production_months = [LOCKED_AUGUST_MONTH, *production_months]
    # sku_august used to drive TBD inputs. The Marpac→Tulsa hop is now a
    # display lock and must not offset first-wave AWD.
    _ = sku_august or sept.get("sku_august") or {}
    mixed_need = {
        sku: max(0, int((sept.get("mixed_need") or {}).get(sku, 0) or 0))
        for sku in wanted
    }
    awd_cards = list(sept.get("awd_pallets") or [])
    if not awd_cards:
        mfg = {
            sku: max(0, int((sept.get("sku_manufacture") or {}).get(sku, 0) or 0))
            for sku in wanted
        }
        awd_cards = allocate_single_sku_awd_pallets(
            mfg, first_wave_ship_skus(wanted), pallet_max,
        )
    awd_by_month = assign_awd_cards_to_months(awd_cards, production_months)

    def _dates(month: str, destination: str) -> tuple[str, int, str, date, object]:
        h = horizon_by_month.get(month) or {}
        recv = int(h.get("receive_days") or 35)
        if destination == AUGUST_HOP_DESTINATION:
            role = "gate"
            ship_by = LOCKED_AUGUST_MARPAC_TULSA_DATE.isoformat()
            arrive = LOCKED_AUGUST_MARPAC_TULSA_DATE
        elif destination in {"3pl_fba", SEPTEMBER_AWD_HOP_DESTINATION}:
            role = "gate"
            ship_by = sept.get("ship_by") or sept_fba_ship_by(recv).isoformat()
            arrive = in_amazon_date(
                date.fromisoformat(str(ship_by)[:10]), recv,
                SEPT_FBA_NEED_IN_BY, clamp=True,
            )
        elif destination == "awd":
            role = "refill"
            ship_by = ship_by_for_month(
                month, amazon_in_by, recv, role="refill", need_in_fba=peak_end,
            )
            arrive = in_amazon_date(
                date.fromisoformat(ship_by), recv, peak_end, clamp=False,
            )
        else:
            role = str(h.get("role") or "gate")
            ship_by = ship_by_for_month(
                month, amazon_in_by, recv, role=role,
                need_in_fba=peak_end if role == "refill" else None,
            )
            latest = amazon_in_by if role == "gate" else peak_end
            arrive = in_amazon_date(
                date.fromisoformat(ship_by), recv, latest,
                clamp=(role == "gate"),
            )
        return role, recv, ship_by, arrive, h

    def _entry(
        month: str,
        mix: dict[str, int],
        destination: str,
        *,
        single_sku: bool,
        track: str,
        next_hop: bool = False,
        awaiting_august: bool = False,
    ) -> dict:
        role, _recv, ship_by, arrive, h = _dates(month, destination)
        cleaned = {sku: int(qty) for sku, qty in mix.items() if int(qty or 0) > 0}
        total = sum(cleaned.values())
        fill = pallet_fill(total, pallet_max)
        if destination in {"3pl_fba", SEPTEMBER_AWD_HOP_DESTINATION}:
            # Warehouse send / small parcel, not a Marpac pallet card.
            # 3PL→AWD 2,700 skips the ≥50% AWD floor.
            pallets = 1 if total > 0 else 0
            is_card = total > 0
            has_partial = False
            full = 0
            partial_units = 0
            held = 0
        else:
            pallets = fill["pallet_cards"]
            is_card = fill["is_pallet_card"]
            has_partial = fill["has_partial"]
            full = fill["full_pallets"]
            partial_units = fill["partial_units"]
            held = fill["held_units"]
        return {
            "month": month,
            "month_label": _month_label(month),
            "role": role,
            "status": "FIRM" if month in committed else "INDICATIVE",
            "pallets": pallets,
            "full_pallets": full,
            "leftover_units": fill["leftover_units"],
            "held_units": held,
            "partial_units": partial_units,
            "has_partial": has_partial,
            "fill_pct": fill["fill_pct"],
            "is_pallet_card": is_card,
            "awaiting_august_totals": awaiting_august,
            "units": total,
            "mix": cleaned,
            "mix_locked": destination == AUGUST_HOP_DESTINATION and total > 0,
            "in_transit": destination == AUGUST_HOP_DESTINATION and total > 0,
            "available_date": (
                LOCKED_AUGUST_MARPAC_TULSA_DATE.isoformat()
                if destination == AUGUST_HOP_DESTINATION
                else None
            ),
            "destination": destination,
            "hop_label": hop_label(destination, awaiting_august=awaiting_august),
            "single_sku": single_sku,
            "track": track,
            "next_hop": next_hop,
            "remaining_fba_then_awd": destination in {"awd", "fba_then_awd"}
            and month.endswith("-09"),
            "ship_by": ship_by,
            "in_amazon": arrive.isoformat(),
            "need_in_fba": h.get("need_in_fba"),
            "late_inbound": False,
        }

    entries: list[dict] = []
    for month in production_months:
        if month.endswith("-08"):
            # Locked Holt/Dave Marpac→Tulsa. Do not invent, do not use TBD
            # inputs, and do not offset first-wave AWD via sku_august.
            mix = locked_august_marpac_tulsa_mix(wanted)
            entries.append(_entry(
                month, mix, AUGUST_HOP_DESTINATION,
                single_sku=False, track="mixed_august",
                awaiting_august=False,
            ))
            # Historical August 3PL→FBA — not Sep 4, not NEXT HOP.
            august_fba = locked_august_3pl_fba_mix(wanted)
            if sum(august_fba.values()) > 0:
                entries.append(_entry(
                    month, august_fba, "3pl_fba",
                    single_sku=False, track="3pl_fba", next_hop=False,
                ))
            continue

        if month.endswith("-09"):
            sept_fba = locked_september_3pl_fba_mix(wanted)
            if sum(sept_fba.values()) > 0:
                entries.append(_entry(
                    month, sept_fba, "3pl_fba",
                    single_sku=False, track="3pl_fba", next_hop=True,
                ))
            sept_awd_hop = locked_september_3pl_awd_mix(wanted)
            if sum(sept_awd_hop.values()) > 0:
                entries.append(_entry(
                    month, sept_awd_hop, SEPTEMBER_AWD_HOP_DESTINATION,
                    single_sku=True, track="3pl_awd", next_hop=True,
                ))
            mixed = {sku: qty for sku, qty in mixed_need.items() if qty > 0}
            if mixed:
                entries.append(_entry(
                    month, mixed, "fba_then_awd",
                    single_sku=False, track="remaining_fba",
                ))
            for card in awd_by_month.get(month, []):
                entries.append(_entry(
                    month, dict(card.get("mix") or {}), "awd",
                    single_sku=True, track="single_sku_awd",
                ))
            if not any(e["month"] == month and e["units"] > 0 for e in entries):
                entries.append(_entry(
                    month, {}, "awd",
                    single_sku=True, track="single_sku_awd",
                ))
            continue

        # Oct / Nov / Dec — single-SKU AWD cards must appear.
        month_cards = awd_by_month.get(month, [])
        if month_cards:
            for card in month_cards:
                entries.append(_entry(
                    month, dict(card.get("mix") or {}), "awd",
                    single_sku=True, track="single_sku_awd",
                ))
        else:
            entries.append(_entry(
                month, {}, "awd",
                single_sku=True, track="single_sku_awd",
            ))
    return entries


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
    pallet_max: int = PALLET_MAX_UNITS,
    month_weights: tuple[float, ...] = (0.25, 0.35, 0.40),
    include_jan: bool = True,
    tpl_offsets_production: bool = False,
    committed_months: list[str] | None = None,
    skus: list[str] | None = None,
) -> dict:
    """Build rolling production schedule that can still make the Amazon gate.

    Two tracks: mixed Marpac → Tulsa → FBA only to the month cap, then
    first-wave single-SKU AWD (61,425). Optimistic 76,211 is context,
    not the near-term buy. Manufacture column is the first-wave AWD
    buy, not the FBA hole. Tulsa is a hop. August Marpac→Tulsa is locked.
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
    restock_rows, planning_rows = _latest_restock_planning()
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
        key = normalize_sku(sku)
        s = snaps.get(key, {})
        inv[sku] = {
            "fba": fba_cover_units(s, restock_rows.get(key), planning_rows.get(key)),
            "inbound": inbound_in_transit(s),
            "awd": int(awds_data.get(normalize_sku(sku), {}).get("awd_on_hand", 0) or 0),
            "tpl": int(tpls_data.get(normalize_sku(sku), {}).get("available", 0) or 0),
        }

    sku_3pl = {sku: inv[sku]["tpl"] for sku in target_skus}
    sku_awd_oh = {sku: inv[sku]["awd"] for sku in target_skus}
    builds = {
        sku: sku_production_build(
            sales_demand.get(sku, {}),
            cover_days=policy["target_cover_days"],
            receive_days=policy["gate_receive_days"],
            optimistic_units=optimistic_by_sku.get(sku, 0),
            fba_target=int(SEPT_FBA_ON_HAND_TARGETS.get(sku, 0) or 0),
        )
        for sku in target_skus
    }
    sku_august = {sku: 0 for sku in target_skus}
    sept = build_september_plan(
        {sku: inv[sku]["fba"] for sku in target_skus},
        {sku: inv[sku]["inbound"] for sku in target_skus},
        sku_3pl,
        {sku: builds[sku]["wanted_cover"] for sku in target_skus},
        sku_august,
        {sku: inv[sku]["awd"] for sku in target_skus},
        receive_days=int(policy["gate_receive_days"]),
        tulsa_floor=int(policy["tulsa_floor_units"]),
        pallet_max=pallet_max,
    )
    tulsa = sept["tulsa"]
    tulsa_xmas = tulsa_after_christmas_outbound(
        sku_3pl, tulsa["transferable"], policy["tulsa_floor_units"],
        cover_through=policy.get("tulsa_cover_through"),
        sku_awd=sku_awd_oh,
        awd_planned=sept["awd_need"],
    )

    def _summaries_from_demand(demand_by_sku: dict[str, int], *, use_fba_target: bool) -> list[dict]:
        rows: list[dict] = []
        for sku in target_skus:
            i = inv[sku]
            sellthrough = int(demand_by_sku.get(sku, 0))
            fba_tgt = int(SEPT_FBA_ON_HAND_TARGETS.get(sku, 0) or 0) if use_fba_target else sellthrough
            august = int(sku_august.get(sku, 0) or 0)
            manufacture = int(sept["sku_manufacture"].get(sku, 0) or 0)
            rows.append({
                "sku": sku,
                "label": SKU_LABEL_MAP.get(sku, sku),
                "holiday_demand": sellthrough,
                "sellthrough": sellthrough,
                "fba_target": fba_tgt,
                "production_target": fba_tgt,
                "awd_target": int(sept["awd_targets"].get(sku, 0) or 0),
                "august": august,
                "august_tbd": august <= 0,
                "peak_cover": builds[sku]["peak_cover"],
                "jan_cover": builds[sku]["jan_cover"],
                "pipeline": builds[sku]["pipeline"],
                "wanted_cover": builds[sku]["wanted_cover"],
                "awd_overflow": manufacture,
                "mixed_tulsa": 0,
                "gate_units": 0,
                "refill_units": manufacture,
                "fba": i["fba"],
                "inbound": i["inbound"],
                "awd": i["awd"],
                "tpl": i["tpl"],
                "transfer": int(sept["tpl_to_fba"].get(sku, 0) or 0),
                "transfer_awd": int(sept["tpl_to_awd"].get(sku, 0) or 0),
                "fba_still_short": int(sept["fba_still_short"].get(sku, 0) or 0),
                "manufacture": manufacture,
            })
        return rows

    def _month_entries(sku_summaries: list[dict]) -> list[dict]:
        # sku_summaries manufacture is the AWD surge (same as sept).
        _ = sku_summaries
        return build_month_view_entries(
            production_months,
            horizon_by_month,
            sept,
            sku_august=sku_august,
            target_skus=target_skus,
            pallet_max=pallet_max,
            amazon_in_by=amazon_in_by,
            peak_end=policy["peak_end_date"],
            committed=committed,
            today=today,
        )

    sales_by_sku_demand = {
        sku: int(d["holiday_demand"]) for sku, d in sales_demand.items()
    }
    workbook_2025 = _holiday_demand_by_sku(
        fc_rows, target_skus, "actual_2025", include_jan,
    )

    all_sku_summaries = {
        "sales_yoy": _summaries_from_demand(sales_by_sku_demand, use_fba_target=True),
        "actual_2025": _summaries_from_demand(workbook_2025, use_fba_target=False),
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
        xfer = sept["tpl_to_fba"].get(sku, 0)
        if xfer > 0:
            transfers.append({
                "sku": sku,
                "label": SKU_LABEL_MAP.get(sku, sku),
                "source": "3PL",
                "units": xfer,
                "timing": (
                    f"FIRST ACTION: August 3PL→FBA 12,960 by {sept['ship_by']} "
                    f"(inbound already in transit not sent again). "
                    + (
                        "Family AWD ≥5k — no Tulsa floor. "
                        if sept.get("awd_loaded")
                        else f"AWD below 5k reserve — keep Tulsa floor {policy['tulsa_floor_units']:,} "
                        "(do not plan 0 AWD and 0 Tulsa). "
                    )
                    + "August Marpac→Tulsa 12,960 is in transit 2026-08-31 (Tulsa 3PL only)."
                ),
            })
        hop = sept["tpl_to_awd"].get(sku, 0)
        if hop > 0:
            transfers.append({
                "sku": sku,
                "label": SKU_LABEL_MAP.get(sku, sku),
                "source": "3PL→AWD",
                "units": hop,
                "timing": (
                    "Leftover Tulsa hops to single-SKU AWD after FBA is full "
                    "(Tulsa is a hop, not the holiday pile)."
                ),
            })

    return {
        "generated": today.isoformat(),
        "amazon_in_by": amazon_in_by.isoformat(),
        "pallet_max": pallet_max,
        "cover_target_days": policy["target_cover_days"],
        "cover": "fba_sc_on_hand",
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
            "sept_fba_ship_by": sept["ship_by"],
            "holiday_gate_last_3pl_fba": sept["holiday_gate_last_3pl_fba"],
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
            "(not leftover-holiday 2.1×). Nov–Jan sell-through and late-Sep FBA "
            "targets are separate — do not add peak-60d or Feb onto sales. "
            "Two piles: FBA at month cap + first-wave AWD 61,425 "
            "(assorted + orange, then unscented + peppermint). "
            "Optimistic 76,211 is context, not the near-term buy. "
            "First action is August 3PL→FBA 12,960 (not a September card, "
            "not a 40k Manufacture). Do not empty Tulsa after this send. "
            "August Marpac→Tulsa 12,960 is locked in transit 2026-08-31 "
            "(Tulsa 3PL only — not AWD, not 3PL→FBA). After "
            "August, new Marpac is single-SKU AWD. Manufacture is the "
            "first-wave AWD buy, not the FBA hole. Drop the 5k Tulsa floor "
            "when family AWD on-hand is ≥5,000. Token AWD (e.g. 540) is "
            "not loaded. Never plan 0 AWD and 0 Tulsa. "
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
        "september": sept,
    }


def format_manufacturer_csv(headsup: dict) -> str:
    """Format manufacturer heads-up as CSV."""
    lines: list[str] = []

    # SKU summary section
    lines.append("Section,SKU,SKU_Label,NovJan_Sellthrough,FBA_Target,FBA,"
                 "Inbound,AWD,TPL,August,Transfer,Mixed_Tulsa,AWD_Overflow,"
                 "Manufacture,Scenario")
    for scenario, key in [("sales_yoy", "sku_summary"),
                          ("actual_2025", "sku_summary_sensitivity")]:
        for s in headsup[key]:
            lines.append(
                f"SKU_Summary,{s['sku']},{s['label']},"
                f"{s.get('sellthrough', s['holiday_demand'])},"
                f"{s.get('fba_target', s.get('production_target', 0))},"
                f"{s['fba']},{s['inbound']},{s['awd']},{s['tpl']},"
                f"{s.get('august', 0)},{s['transfer']},"
                f"{s.get('mixed_tulsa', 0)},{s.get('awd_overflow', 0)},"
                f"{s['manufacture']},{scenario}"
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
    a("Nov–Jan sell-through and late-Sep FBA targets are separate lines.")
    a("Do not add peak-60d or Feb tail onto sales — they overlap Nov–Jan.")
    a("Holiday pile = FBA-at-cap + AWD. Tulsa is a hop, not the holiday pile.")
    a("FIRST ACTION: August 3PL→FBA 12,960 (inbound already counted).")
    a("Do not empty Tulsa after this send. August Marpac→Tulsa 12,960 is in transit 2026-08-31 (Tulsa 3PL only).")
    a("First-wave AWD buy is 61,425 (assorted + orange, then unscented + peppermint).")
    a("Optimistic 76,211 is context — not the near-term manufacture/buy.")
    a("Manufacture = first-wave AWD, not the FBA hole. Marpac→Tulsa lock is display-only.")
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
    a("FBA cover: Seller Central on-hand (fulfillable + FC transfer) · inbound already in transit (do not re-send)")
    a(f"Aug/Sep waves in Amazon FBA by: {headsup['amazon_in_by']}")
    a("Oct/Nov/Dec new Marpac is single-SKU AWD — not mixed, not a Tulsa holiday pile.")
    a("Early-Jan FBA refill leaves AWD (or Tulsa hop) in December (peak-end − 35d).")
    tpl_note = (
        "3PL fills FBA first; Manufacture is first-wave AWD 61,425, not 76,211"
    )
    tulsa = headsup.get("tulsa_3pl") or {}
    if tulsa:
        if tulsa.get("awd_loaded"):
            a("Tulsa floor: 0 — family AWD ≥5k; off-FBA reserve sits in AWD "
              f"(on hand {tulsa.get('on_hand', 0):,}; transferable {tulsa.get('transferable', 0):,}).")
        else:
            a(f"Tulsa 3PL floor: {tulsa.get('floor', TULSA_LIP_FLOOR_UNITS):,} lip family "
              f"(AWD below 5k reserve — do not plan 0 AWD and 0 Tulsa; "
              f"on hand {tulsa.get('on_hand', 0):,}; transferable {tulsa.get('transferable', 0):,})")
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
        dest = entry.get("destination") or ""
        dest_note = {
            "3pl_fba": "3PL→FBA",
            SEPTEMBER_AWD_HOP_DESTINATION: "3PL→AWD small parcel",
            "awd": "single-SKU AWD",
            "fba_then_awd": "remaining FBA then AWD",
            "mixed_tulsa_fba": AUGUST_HOP_LABEL,
            AUGUST_HOP_DESTINATION: AUGUST_HOP_LABEL,
        }.get(dest, role_note)
        a(f"  {entry['month_label']}  —  {entry['status']}  ({dest_note})")
        if entry["units"] == 0:
            if entry.get("awaiting_august_totals"):
                a("    August mixed pallet is TBD — do not invent a mix.")
            else:
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
                    tag = "locked" if entry.get("mix_locked") else "indicative"
                    a(f"      {SKU_LABEL_MAP.get(sku, sku)}: {qty:,}  [{tag}]")
            if entry.get("in_transit"):
                a(f"    In transit: {entry.get('available_date') or entry['ship_by']}")
            else:
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
