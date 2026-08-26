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
from datetime import date, timedelta
from collections import defaultdict

from src.db import fetch_all
from src.inventory.reorder import (
    AMAZON_IN_BY,
    PALLET_MAX_UNITS,
    allocate_monthly_units,
    amazon_inventory_reorder,
    days_of_supply,
    forecast_by_holiday_month,
    holiday_demand_covering_projections,
    holiday_month_plan,
    inventory_flag,
    manufacture_need,
    month_pallet_fill_pct,
    pack_pallets,
    planning_daily,
    ship_by_for_amazon_deadline,
    sku_pack_priority,
)

LIP_BALM_SKUS = ["DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"]

DEFAULTS = {
    "pallet_max_units": 19_000,
    "amazon_in_by": "2026-10-31",
    "scenario": "correction_factor",
    "include_3pl_transfer": True,
    "include_awd": True,
}


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

    # Load data
    snaps = {r["sku"]: r for r in fetch_all("inventory_snapshots")}
    awds = {r["sku"]: r for r in fetch_all("inventory_awd")}
    tpls: dict[str, dict] = {}
    try:
        tpls = {r["sku"]: r for r in fetch_all("inventory_3pl_snapshots")}
    except Exception:
        pass

    fc_rows = fetch_all("forecast_weekly")

    # Per-SKU analysis
    sku_plans: list[dict] = []
    total_gap = 0

    for sku in target_skus:
        s = snaps.get(sku, {})
        fba = sum(int(s.get(k, 0) or 0) for k in
                  ["fulfillable", "reserved", "researching", "unfulfillable"])
        inbound = sum(int(s.get(k, 0) or 0) for k in
                      ["inbound_working", "inbound_shipped", "inbound_receiving"])
        awd_oh = int(awds.get(sku, {}).get("awd_on_hand", 0) or 0) if include_awd else 0
        tpl_oh = int(tpls.get(sku, {}).get("available", 0) or 0) if include_3pl else 0

        # Amazon supply by target date
        amazon_supply = fba + inbound + awd_oh + tpl_oh

        # Nov + Dec demand from forecast
        nov_dec_demand = 0.0
        jan_demand = 0.0
        for r in fc_rows:
            if r.get("sku") != sku or r.get("scenario") != scenario:
                continue
            ws = str(r.get("week_start", ""))
            units = float(r.get("units", 0) or 0)
            if ws[:7] in ("2026-11", "2026-12"):
                nov_dec_demand += units
            elif ws[:7] == "2027-01" or ws[:7] == "2026-01":
                jan_demand += units

        gap = max(math.ceil(nov_dec_demand) - amazon_supply, 0)
        total_gap += gap

        sku_plans.append({
            "sku": sku,
            "nov_dec_demand": round(nov_dec_demand),
            "jan_demand": round(jan_demand),
            "fba": fba,
            "inbound": inbound,
            "awd": awd_oh,
            "tpl": tpl_oh,
            "amazon_supply": amazon_supply,
            "covered": min(amazon_supply, round(nov_dec_demand)),
            "gap": gap,
        })

    # Pallet allocation
    num_pallets = math.ceil(total_gap / pallet_max) if total_gap > 0 else 0

    pallets: list[dict] = []
    remaining_gaps = {p["sku"]: p["gap"] for p in sku_plans}

    for i in range(num_pallets):
        total_remaining = sum(remaining_gaps.values())
        if total_remaining <= 0:
            break

        pallet_units = min(pallet_max, total_remaining)
        mix: dict[str, int] = {}

        for sku in target_skus:
            if remaining_gaps[sku] <= 0:
                continue
            # Allocate proportional to remaining gap share
            share = remaining_gaps[sku] / total_remaining
            alloc = min(round(pallet_units * share), remaining_gaps[sku])
            if alloc > 0:
                mix[sku] = alloc
                remaining_gaps[sku] -= alloc

        pallets.append({
            "pallet_num": i + 1,
            "mix": mix,
            "total_units": sum(mix.values()),
        })

    # Monthly production schedule (spread across months until target)
    months_available = []
    cursor_month = today.replace(day=1)
    target_month = target_date.replace(day=1)
    while cursor_month <= target_month:
        months_available.append(cursor_month.strftime("%Y-%m"))
        if cursor_month.month == 12:
            cursor_month = cursor_month.replace(year=cursor_month.year + 1, month=1)
        else:
            cursor_month = cursor_month.replace(month=cursor_month.month + 1)

    # Distribute pallets across months (front-load: earliest months first)
    monthly_pallets: dict[str, list[dict]] = defaultdict(list)
    for i, p in enumerate(pallets):
        month_idx = min(i, len(months_available) - 1) if months_available else 0
        month = months_available[month_idx] if months_available else "ASAP"
        monthly_pallets[month].append(p)

    return {
        "config": {
            "pallet_max_units": pallet_max,
            "amazon_in_by": amazon_in_by,
            "scenario": scenario,
            "include_3pl_transfer": include_3pl,
            "include_awd": include_awd,
        },
        "sku_plans": sku_plans,
        "total_nov_dec_demand": sum(p["nov_dec_demand"] for p in sku_plans),
        "total_amazon_supply": sum(p["amazon_supply"] for p in sku_plans),
        "total_gap": total_gap,
        "num_pallets": num_pallets,
        "pallets": pallets,
        "monthly_schedule": dict(monthly_pallets),
        "months": months_available,
        "units_still_short": sum(remaining_gaps.values()),
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
        tpls = {r["sku"]: r for r in fetch_all("inventory_3pl_snapshots")}
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
        fba_now = sum(int(s.get(k, 0) or 0) for k in
                      ["fulfillable", "reserved", "researching", "unfulfillable"])
        inbound_now = sum(int(s.get(k, 0) or 0) for k in
                          ["inbound_working", "inbound_shipped", "inbound_receiving"])
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
) -> dict[str, int]:
    """Holiday sell-through per SKU. With velocities, covers every scenario."""
    totals: dict[str, float] = {s: 0 for s in target_skus}
    for sku in target_skus:
        vel = (velocities or {}).get(sku, {})
        if velocities:
            totals[sku] = holiday_demand_covering_projections(
                fc_rows, sku, planning_daily(vel),
            )["planned_total"]
            continue
        if scenario == "yoy_anchored":
            totals[sku] = holiday_demand_covering_projections(
                fc_rows, sku, planning_daily(vel),
            )["planned_total"]
            continue
        fc = forecast_by_holiday_month(fc_rows, sku, scenario)
        totals[sku] = holiday_month_plan(
            fc, planning_daily(vel), include_jan,
        )["planned_total"]
    return {s: int(v) for s, v in totals.items()}


def build_manufacturer_headsup(
    pallet_max: int = 19_000,
    month_weights: tuple[float, ...] = (0.0, 0.50, 0.50),
    include_jan: bool = True,
    tpl_offsets_production: bool = False,
    committed_months: list[str] | None = None,
    skus: list[str] | None = None,
) -> dict:
    """Build rolling 3-month manufacturer production schedule.

    Per SKU:
      1. Inventory reorder — same (cover + lead) × V30 − on_hand as /inventory
      2. Holiday manufacture — Nov+Dec (+Jan) forecast minus FBA/inbound/AWD
      3. Manufacture — max of those two
      4. Transfer to FBA — 3PL + AWD already on hand

    Month 1 (current) ships the inventory reorder so Amazon does not
    stock out now. Nov/Dec/Jan manufacture goes on September and October
    pallets so it is Prime-eligible by ``amazon_in_by`` (end of October).
    Ship-by is pulled forward by receiving lead time. Pallet = 19 000
    cartons; a month may ship more than one.
    """
    target_skus = skus or LIP_BALM_SKUS
    today = date.today()
    committed = set(committed_months or [])
    production_months = _month_list(today, 3)
    amazon_in_by = DEFAULTS.get("amazon_in_by") or AMAZON_IN_BY

    # Load data once
    snaps = {r["sku"]: r for r in fetch_all("inventory_snapshots")}
    awds_data = {r["sku"]: r for r in fetch_all("inventory_awd")}
    tpls_data: dict[str, dict] = {}
    try:
        tpls_data = {r["sku"]: r for r in fetch_all("inventory_3pl_snapshots")}
    except Exception:
        pass
    fc_rows = fetch_all("forecast_weekly")
    vel_rows: list[dict] = []
    try:
        vel_rows = fetch_all("sku_velocity")
    except Exception:
        pass
    vel_by_sku = {r["sku"]: r for r in vel_rows if r.get("sku")}

    settings = {
        "target_cover_days": 60,
        "holiday_mode": False,
        "include_inbound": True,
        "include_3pl": True,
        "include_awd": True,
        "receiving_days_normal": 14,
        "awd_to_fba_days": 14,
    }
    try:
        setting_rows = fetch_all("inventory_settings")
        if setting_rows:
            for k in settings:
                if setting_rows[0].get(k) is not None:
                    settings[k] = setting_rows[0][k]
    except Exception:
        pass

    signals_by_sku: dict[str, dict] = {}
    try:
        for r in fetch_all("inventory_sku_signals"):
            if r.get("sku"):
                signals_by_sku[r["sku"]] = r
    except Exception:
        pass

    leadtime: dict = {}
    try:
        lt_rows = fetch_all("inventory_leadtime_summary")
        if lt_rows:
            lt_rows.sort(key=lambda r: r.get("as_of_date") or "", reverse=True)
            leadtime = lt_rows[0]
    except Exception:
        pass

    # Per-SKU inventory + inventory-page reorder (scenario-independent)
    inv: dict[str, dict] = {}
    for sku in target_skus:
        s = snaps.get(sku, {})
        fba = sum(int(s.get(k, 0) or 0) for k in
                  ["fulfillable", "reserved", "researching", "unfulfillable"])
        inbound = sum(int(s.get(k, 0) or 0) for k in
                      ["inbound_working", "inbound_shipped", "inbound_receiving"])
        awd_v = int(awds_data.get(sku, {}).get("awd_on_hand", 0) or 0)
        tpl_v = int(tpls_data.get(sku, {}).get("available", 0) or 0)
        sig = signals_by_sku.get(sku, {})
        vel = vel_by_sku.get(sku, {})
        v30 = float(vel.get("total_u_30", 0) or 0)
        plan_daily = planning_daily(vel)
        inv_v30 = sig.get("inventory_u_30")
        try:
            inv_v30_f = float(inv_v30) if inv_v30 is not None else None
        except (TypeError, ValueError):
            inv_v30_f = None
        div_pct = sig.get("rate_divergence_pct")
        try:
            div_pct_f = float(div_pct) if div_pct is not None else None
        except (TypeError, ValueError):
            div_pct_f = None
        rec = amazon_inventory_reorder(
            fba=fba, inbound=inbound, awd=awd_v, tpl=tpl_v,
            daily_velocity=v30, settings=settings,
            measured_receive_days=sig.get("measured_receive_days"),
            measured_replenish_days=sig.get("measured_replenish_days"),
            fba_optimized_receive_median=leadtime.get("fba_optimized_receive_median"),
            fba_receive_median=leadtime.get("fba_receive_median"),
            awd_replenish_median=leadtime.get("awd_replenish_median"),
        )
        dos = days_of_supply(fba, v30)
        pipeline = days_of_supply(fba + inbound + awd_v, v30)
        flag = inventory_flag(dos, v30)
        inv[sku] = {
            "fba": fba, "inbound": inbound, "awd": awd_v, "tpl": tpl_v,
            "v30": v30,
            "planning_daily": plan_daily,
            "inv_v30": inv_v30_f,
            "rate_divergence_pct": div_pct_f,
            "dos": dos,
            "pipeline_dos": pipeline,
            "flag": flag,
            "target_days": rec["target_days"],
            "lead_days": rec["lead_days"],
            "on_hand": rec["on_hand"],
            "inventory_reorder": rec["reorder_qty"],
        }

    # Build both scenarios
    scenarios_out: dict[str, dict] = {}
    all_sku_summaries: dict[str, list[dict]] = {}

    for scenario in ["correction_factor", "actual_2025"]:
        sku_summaries: list[dict] = []
        holiday_mfg: dict[str, int] = {}
        reorder_by_sku: dict[str, int] = {}
        for sku in target_skus:
            i = inv[sku]
            if scenario == "correction_factor":
                month_plan = holiday_demand_covering_projections(
                    fc_rows, sku, i.get("planning_daily", 0),
                )
            else:
                month_fc = forecast_by_holiday_month(fc_rows, sku, scenario)
                month_plan = holiday_month_plan(
                    month_fc, i.get("planning_daily", 0), include_jan,
                )
            demand = month_plan["planned_total"]
            transfer = i["tpl"] + i["awd"]  # to be moved to FBA

            # Holiday gap = demand - FBA - inbound - AWD
            # (3PL only subtracted if toggle ON)
            deductions = i["fba"] + i["inbound"] + i["awd"]
            if tpl_offsets_production:
                deductions += i["tpl"]
            holiday_gap = max(0, demand - deductions)
            inv_reorder = int(i["inventory_reorder"])
            manufacture = manufacture_need(inv_reorder, holiday_gap)
            holiday_mfg[sku] = holiday_gap
            reorder_by_sku[sku] = inv_reorder

            sku_summaries.append({
                "sku": sku,
                "label": SKU_LABEL_MAP.get(sku, sku),
                "holiday_demand": demand,
                "holiday_forecast_total": month_plan["forecast_total"],
                "holiday_floor_total": month_plan["floor_total"],
                "holiday_months": month_plan["months"],
                "nov_demand": next(
                    (m["forecast"] for m in month_plan["months"] if m["month"] == "2026-11"), 0,
                ),
                "dec_demand": next(
                    (m["forecast"] for m in month_plan["months"] if m["month"] == "2026-12"), 0,
                ),
                "jan_demand": next(
                    (m["forecast"] for m in month_plan["months"] if m["month"] == "2027-01"), 0,
                ),
                "fba": i["fba"],
                "inbound": i["inbound"],
                "awd": i["awd"],
                "tpl": i["tpl"],
                "transfer": transfer,
                "holiday_manufacture": holiday_gap,
                "inventory_reorder": inv_reorder,
                "v30": round(float(i["v30"]), 1),
                "planning_daily": round(float(i.get("planning_daily", 0)), 1),
                "inv_v30": i.get("inv_v30"),
                "rate_divergence_pct": i.get("rate_divergence_pct"),
                "dos": i.get("dos"),
                "pipeline_dos": i.get("pipeline_dos"),
                "flag": i.get("flag", "OK"),
                "target_days": i["target_days"],
                "lead_days": i["lead_days"],
                "on_hand": i["on_hand"],
                "manufacture": manufacture,
            })

        all_sku_summaries[scenario] = sku_summaries

        lead_days = max((int(inv[s].get("lead_days") or 0) for s in target_skus), default=19)
        if lead_days <= 0:
            lead_days = 19
        flags = {sku: str(inv[sku].get("flag") or "OK") for sku in target_skus}
        priority = sku_pack_priority(target_skus, flags, reorder_by_sku)
        mixes = allocate_monthly_units(
            target_skus, reorder_by_sku, holiday_mfg,
            production_months,
            amazon_in_by=amazon_in_by,
            lead_days=lead_days,
            priority=priority,
        )
        cap = pallet_max or PALLET_MAX_UNITS
        entries: list[dict] = []
        today_iso = today.isoformat()
        for mi, month in enumerate(production_months):
            mix = mixes[mi] if mi < len(mixes) else {}
            packed = pack_pallets(mix, priority, cap)
            total = sum(mix.values())
            n_pallets = len(packed)
            ship_by = ship_by_for_amazon_deadline(month, amazon_in_by, lead_days)
            arrive_by = (
                date.fromisoformat(ship_by) + timedelta(days=lead_days)
            ).isoformat()
            entries.append({
                "month": month,
                "month_label": _month_label(month),
                "status": "FIRM" if month in committed else "INDICATIVE",
                "pallets": n_pallets,
                "units": total,
                "mix": mix,
                "packed": packed,
                "pallet_max": cap,
                "fill_pct": month_pallet_fill_pct(total, n_pallets, cap),
                "ship_by": ship_by,
                "arrive_by": arrive_by,
                "overdue": today_iso > ship_by and total > 0,
            })

        scenarios_out[scenario] = {
            "entries": entries,
            "total_units": sum(e["units"] for e in entries),
            "total_pallets": sum(e["pallets"] for e in entries),
        }

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
        if i["tpl"] > 0:
            transfers.append({
                "sku": sku,
                "label": SKU_LABEL_MAP.get(sku, sku),
                "source": "3PL",
                "units": i["tpl"],
                "timing": "Ship to FBA by Sep 30 for receiving before holiday ramp",
            })

    return {
        "generated": today.isoformat(),
        "amazon_in_by": amazon_in_by,
        "pallet_max": pallet_max,
        "cover_target_days": next(iter(inv.values()), {}).get("target_days", 60),
        "lead_days": next(iter(inv.values()), {}).get("lead_days", 0),
        "holiday_mode": bool(settings.get("holiday_mode")),
        "include_jan": include_jan,
        "tpl_offsets_production": tpl_offsets_production,
        "months": production_months,
        "month_weights": list(month_weights),
        "primary": scenarios_out["correction_factor"],
        "sensitivity": scenarios_out["actual_2025"],
        "primary_scenario": "correction_factor",
        "sensitivity_scenario": "actual_2025",
        "sku_summary": all_sku_summaries["correction_factor"],
        "sku_summary_sensitivity": all_sku_summaries["actual_2025"],
        "transfers": transfers,
        "skus": target_skus,
    }


def format_manufacturer_csv(headsup: dict) -> str:
    """Format manufacturer heads-up as CSV."""
    lines: list[str] = []

    # SKU summary section
    lines.append("Section,SKU,SKU_Label,Nov_Demand,Dec_Demand,Jan_Demand,"
                 "Holiday_Forecast,Holiday_Demand,FBA,Inbound,AWD,TPL,"
                 "Transfer,Inventory_Reorder,Holiday_Manufacture,Manufacture,"
                 "V30,Target_Days,Lead_Days,Scenario")
    for scenario, key in [("correction_factor", "sku_summary"),
                          ("actual_2025", "sku_summary_sensitivity")]:
        for s in headsup[key]:
            lines.append(
                f"SKU_Summary,{s['sku']},{s['label']},"
                f"{s.get('nov_demand', 0)},{s.get('dec_demand', 0)},"
                f"{s.get('jan_demand', 0)},{s.get('holiday_forecast_total', s['holiday_demand'])},"
                f"{s['holiday_demand']},"
                f"{s['fba']},{s['inbound']},{s['awd']},{s['tpl']},"
                f"{s['transfer']},{s.get('inventory_reorder', 0)},"
                f"{s.get('holiday_manufacture', s['manufacture'])},"
                f"{s['manufacture']},{s.get('v30', '')},"
                f"{s.get('target_days', '')},{s.get('lead_days', '')},{scenario}"
            )

    # Monthly production
    lines.append("")
    lines.append("Section,Month,Month_Label,Status,SKU,SKU_Label,Units,"
                 "Pallets,Ship_By,Scenario")
    for sc_key, sc_label in [("primary", "correction_factor"),
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
    demand_period = "Nov + Dec + Jan" if headsup.get("include_jan") else "Nov + Dec"
    a(f"Demand period: {demand_period} (forecast_weekly)")
    a(f"Pallet capacity: {headsup['pallet_max']:,} units")
    a(f"FBA cover target: {headsup['cover_target_days']} days"
      f" (inventory page; holiday_mode={headsup.get('holiday_mode')})")
    a("Month 1 = inventory reorder + a balanced share of holiday leftover.")
    a("Nov/Dec/Jan below are SELL-THROUGH months — tell the manufacturer")
    a("what Amazon must cover. Those units ship on Sep/Oct pallets.")
    a(f"All units in Amazon FBA by: {headsup['amazon_in_by']}")
    tpl_note = "3PL OFFSETS production" if headsup.get("tpl_offsets_production") \
        else "3PL shown as transfer only (does NOT reduce manufacture)"
    a(f"3PL policy: {tpl_note}")

    # ── Per-SKU summary ──
    a("")
    a("-" * 65)
    a("PER-SKU SUMMARY (correction_factor)")
    a("-" * 65)
    a(f"  {'SKU':<14} {'Nov':>7} {'Dec':>7} {'Jan':>7} {'Planned':>8}"
      f" {'Reorder':>8} {'Mfg':>8}")
    a(f"  {'-'*63}")
    for s in headsup["sku_summary"]:
        a(f"  {SKU_SHORT_MAP.get(s['sku'], s['sku']):<14}"
          f" {s.get('nov_demand', 0):>7,} {s.get('dec_demand', 0):>7,}"
          f" {s.get('jan_demand', 0):>7,} {s['holiday_demand']:>8,}"
          f" {s.get('inventory_reorder', 0):>8,}"
          f" {s['manufacture']:>8,}")
    total_nov = sum(s.get("nov_demand", 0) for s in headsup["sku_summary"])
    total_dec = sum(s.get("dec_demand", 0) for s in headsup["sku_summary"])
    total_jan = sum(s.get("jan_demand", 0) for s in headsup["sku_summary"])
    total_demand = sum(s["holiday_demand"] for s in headsup["sku_summary"])
    total_mfg = sum(s["manufacture"] for s in headsup["sku_summary"])
    total_reorder = sum(s.get("inventory_reorder", 0) for s in headsup["sku_summary"])
    a(f"  {'-'*63}")
    a(f"  {'TOTAL':<14} {total_nov:>7,} {total_dec:>7,} {total_jan:>7,}"
      f" {total_demand:>8,} {total_reorder:>8,} {total_mfg:>8,}")

    # ── Production schedule ──
    a("")
    a("-" * 65)
    a("PRODUCTION SCHEDULE — current month = reorder; Sep/Oct = holiday")
    a("-" * 65)

    for entry in headsup["primary"]["entries"]:
        a("")
        a(f"  {entry['month_label']}  —  {entry['status']}")
        if entry["units"] == 0:
            a("    No production needed this month.")
        else:
            a(f"    Pallets: {entry['pallets']}  ({entry['units']:,} units"
              f" @ 19,000/pallet)")
            for sku in headsup["skus"]:
                qty = entry["mix"].get(sku, 0)
                if qty > 0:
                    a(f"      {SKU_LABEL_MAP.get(sku, sku)}: {qty:,}")
            for packed in entry.get("packed") or []:
                mix_str = ", ".join(
                    f"{SKU_SHORT_MAP.get(s, s)} {q:,}"
                    for s, q in packed["mix"].items()
                )
                a(f"      Pallet {packed['pallet_num']}: "
                  f"{packed['total_units']:,} / 19,000 — {mix_str}")
            ship_note = (
                f"Ship ASAP (missed {entry['ship_by']})"
                if entry.get("overdue")
                else f"Ship by: {entry['ship_by']}"
            )
            a(f"    {ship_note}")

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
    a(f"SENSITIVITY: actual_2025")
    a("-" * 65)
    a(f"  {'SKU':<14} {'Demand':>8} {'Mfg':>8}")
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
    a("  - Current month = inventory-page reorder (keep Amazon covered now).")
    a("  - Nov/Dec/Jan are sell-through, not production months. Alert the")
    a("    manufacturer with those totals; they ship on Sep/Oct pallets")
    a("    so stock is in Amazon by end of October.")
    a("  - One pallet holds 19,000 lip-balm cartons. A month can ship")
    a("    multiple pallets; CRITICAL / highest reorder packs first.")
    a("  - FIRM months represent committed production volumes.")
    a("    INDICATIVE months are forecasts and may change.")
    a("  - Manufacture volumes assume 3PL stock is transferred")
    a("    to FBA separately (see Transfers section).")
    a("  - This is a planning aid, not a purchase order.")
    a("-" * 65)
    a("")
    return "\n".join(L)
