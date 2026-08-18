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

def _build_weekly_demand(
    fc_rows: list[dict],
    vel_rows: list[dict],
    target_skus: list[str],
    scenario: str,
    weeks: list[date],
) -> dict[str, dict[str, float]]:
    """Build per-SKU weekly demand lookup.

    Uses forecast_weekly where available; falls back to velocity-based
    daily rate × 7 for weeks not covered by the forecast.
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

    # Velocity fallback: daily rate from sku_velocity (total_u_30 / 30)
    vel_daily: dict[str, float] = {}
    for v in vel_rows:
        sku = v.get("sku")
        if sku in target_skus:
            u30 = float(v.get("total_u_30", 0) or 0)
            vel_daily[sku] = u30 / 30.0

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
