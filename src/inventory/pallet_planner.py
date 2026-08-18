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


# ---------------------------------------------------------------------------
# Manufacturer Heads-Up — rolling 3-month production schedule
# ---------------------------------------------------------------------------

SKU_LABEL_MAP: dict[str, str] = {
    "DDPE0001Shop": "Unscented 3pk",
    "DDPE0002Shop": "Peppermint 3pk",
    "DDPE0003Shop": "Sweet Orange 3pk",
    "DDPE0004Shop": "Assorted 3pk",
}


def _next_month(d: date) -> date:
    if d.month == 12:
        return d.replace(year=d.year + 1, month=1)
    return d.replace(month=d.month + 1)


def _month_label(m: str) -> str:
    """'2026-08' → 'August 2026'."""
    y, mo = m.split("-")
    import calendar
    return f"{calendar.month_name[int(mo)]} {y}"


def _days_in_month_str(m: str) -> int:
    import calendar
    y, mo = m.split("-")
    return calendar.monthrange(int(y), int(mo))[1]


def _month_list(start: date, n: int) -> list[str]:
    months: list[str] = []
    cursor = start.replace(day=1)
    for _ in range(n):
        months.append(cursor.strftime("%Y-%m"))
        cursor = _next_month(cursor)
    return months


def _monthly_demand(
    fc_rows: list[dict],
    vel_rows: list[dict],
    target_skus: list[str],
    scenario: str,
    months: list[str],
) -> dict[str, dict[str, float]]:
    """Monthly demand per SKU.  Forecast where available, velocity fallback."""
    fc: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for r in fc_rows:
        if r.get("scenario") != scenario:
            continue
        sku = r.get("sku")
        if sku not in target_skus:
            continue
        ws = str(r.get("week_start", ""))[:7]
        fc[sku][ws] += float(r.get("units", 0) or 0)

    vel_daily: dict[str, float] = {}
    for v in vel_rows:
        sku = v.get("sku")
        if sku in target_skus:
            vel_daily[sku] = float(v.get("total_u_30", 0) or 0) / 30.0

    result: dict[str, dict[str, float]] = {}
    for sku in target_skus:
        result[sku] = {}
        for m in months:
            fv = fc[sku].get(m, 0)
            if fv > 0:
                result[sku][m] = round(fv)
            else:
                result[sku][m] = round(vel_daily.get(sku, 0) * _days_in_month_str(m))
    return result


def _forward_demand_60d(
    month: str, sku_demand: dict[str, float], all_months: list[str],
) -> float:
    """Sum ~60 days of demand starting from end of *month*."""
    try:
        idx = all_months.index(month)
    except ValueError:
        return 0
    total = 0.0
    days = 0
    for i in range(idx + 1, len(all_months)):
        m = all_months[i]
        dim = _days_in_month_str(m)
        if days + dim <= 60:
            total += sku_demand.get(m, 0)
            days += dim
        else:
            remaining = 60 - days
            daily = sku_demand.get(m, 0) / dim if dim else 0
            total += daily * remaining
            break
    return total


def build_manufacturer_headsup(
    pallet_max: int = 19_000,
    cover_target_days: int = 60,
    committed_months: list[str] | None = None,
    include_3pl: bool = True,
    include_awd: bool = True,
    skus: list[str] | None = None,
) -> dict:
    """Build rolling 3-month manufacturer production schedule.

    Uses monthly stock-flow model with 60-day forward cover target:
      For each month, stock depletes by demand.  If projected stock at
      month-end falls below 60 days of forward demand, production is
      needed to fill the gap.

    Returns primary (correction_factor) and sensitivity (actual_2025)
    scenarios side-by-side, with firm/indicative status per month.
    """
    target_skus = skus or LIP_BALM_SKUS
    today = date.today()
    committed = set(committed_months or [])

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

    # 3-month production window + forward months for cover calc
    production_months = _month_list(today, 3)
    all_months = _month_list(today, 8)  # through ~Apr 2027 for 60d fwd

    amazon_in_by = DEFAULTS["amazon_in_by"]

    scenarios_out: dict[str, dict] = {}
    for scenario in ["correction_factor", "actual_2025"]:
        md = _monthly_demand(fc_rows, vel_rows, target_skus, scenario, all_months)

        sku_month_prod: dict[str, dict[str, int]] = {}
        for sku in target_skus:
            s = snaps.get(sku, {})
            fba = sum(int(s.get(k, 0) or 0) for k in
                      ["fulfillable", "reserved", "researching", "unfulfillable"])
            inbound = sum(int(s.get(k, 0) or 0) for k in
                          ["inbound_working", "inbound_shipped", "inbound_receiving"])
            awd_v = int(awds_data.get(sku, {}).get("awd_on_hand", 0) or 0) if include_awd else 0
            tpl_v = int(tpls_data.get(sku, {}).get("available", 0) or 0) if include_3pl else 0
            stock = fba + inbound + awd_v + tpl_v

            sku_month_prod[sku] = {}
            for m in all_months:
                demand = md[sku].get(m, 0)
                stock -= demand
                fwd = _forward_demand_60d(m, md[sku], all_months)
                deficit = max(0, round(fwd - stock))
                if m in production_months:
                    sku_month_prod[sku][m] = deficit
                stock += deficit

        entries: list[dict] = []
        for m in production_months:
            mix = {}
            for sku in target_skus:
                v = sku_month_prod[sku].get(m, 0)
                if v > 0:
                    mix[sku] = v
            total = sum(mix.values())
            n_pallets = math.ceil(total / pallet_max) if total > 0 else 0

            # Ship-by: 15th of month (allow 2-week Amazon receiving)
            ship_day = 20
            y, mo = m.split("-")
            ship_by = f"{y}-{mo}-{ship_day:02d}"

            entries.append({
                "month": m,
                "month_label": _month_label(m),
                "status": "FIRM" if m in committed else "INDICATIVE",
                "pallets": n_pallets,
                "units": total,
                "mix": mix,
                "ship_by": ship_by,
            })

        scenarios_out[scenario] = {
            "entries": entries,
            "total_units": sum(e["units"] for e in entries),
            "total_pallets": sum(e["pallets"] for e in entries),
        }

    return {
        "generated": today.isoformat(),
        "amazon_in_by": amazon_in_by,
        "pallet_max": pallet_max,
        "cover_target_days": cover_target_days,
        "months": production_months,
        "primary": scenarios_out["correction_factor"],
        "sensitivity": scenarios_out["actual_2025"],
        "primary_scenario": "correction_factor",
        "sensitivity_scenario": "actual_2025",
        "skus": target_skus,
    }


def format_manufacturer_csv(headsup: dict) -> str:
    """Format manufacturer heads-up as CSV."""
    lines = ["Month,Month_Label,Status,SKU,SKU_Label,Units,Pallets,Scenario"]
    for scenario_key, scenario_label in [
        ("primary", headsup["primary_scenario"]),
        ("sensitivity", headsup["sensitivity_scenario"]),
    ]:
        for entry in headsup[scenario_key]["entries"]:
            if not entry["mix"]:
                lines.append(
                    f"{entry['month']},{entry['month_label']},{entry['status']},"
                    f",,0,0,{scenario_label}"
                )
            for sku, qty in entry["mix"].items():
                lines.append(
                    f"{entry['month']},{entry['month_label']},{entry['status']},"
                    f"{sku},{SKU_LABEL_MAP.get(sku, sku)},{qty},{entry['pallets']},"
                    f"{scenario_label}"
                )
    return "\n".join(lines) + "\n"


def format_manufacturer_sheet(headsup: dict) -> str:
    """Format printable manufacturer planning sheet."""
    lines: list[str] = []
    a = lines.append
    a("=" * 60)
    a("TALLOWBOURN")
    a("MANUFACTURER PLANNING SHEET")
    a(f"Lip Balm 3pk · Holiday Production Schedule")
    a(f"Generated: {headsup['generated']}")
    a("=" * 60)
    a("")
    a("SKU REFERENCE:")
    for sku, label in SKU_LABEL_MAP.items():
        a(f"  {sku}  =  {label}")
    a("")
    a(f"Pallet capacity: {headsup['pallet_max']:,} units")
    a(f"FBA cover target: {headsup['cover_target_days']} days forward stock")
    a(f"All units in Amazon FBA by: {headsup['amazon_in_by']}")
    a("")
    a("-" * 60)
    a(f"PRIMARY SCENARIO: {headsup['primary_scenario']}")
    a("-" * 60)

    for entry in headsup["primary"]["entries"]:
        a("")
        a(f"  {entry['month_label']}  —  {entry['status']}")
        if entry["units"] == 0:
            a("    No production needed this month.")
        else:
            a(f"    Pallets: {entry['pallets']}  ({entry['units']:,} units)")
            for sku in headsup["skus"]:
                qty = entry["mix"].get(sku, 0)
                if qty > 0:
                    a(f"      {SKU_LABEL_MAP.get(sku, sku)}: {qty:,}")
            a(f"    Ship by: {entry['ship_by']}")

    a("")
    p = headsup["primary"]
    a(f"  TOTAL: {p['total_units']:,} units across {p['total_pallets']} pallet(s)")

    a("")
    a("-" * 60)
    a(f"SENSITIVITY: {headsup['sensitivity_scenario']}")
    a("-" * 60)
    for entry in headsup["sensitivity"]["entries"]:
        if entry["units"] > 0:
            mix_str = ", ".join(
                f"{SKU_LABEL_MAP.get(s, s).split()[0]} {q:,}"
                for s, q in entry["mix"].items()
            )
            a(f"  {entry['month_label']}: {entry['units']:,} units "
              f"({entry['pallets']} pallet) — {mix_str}")
        else:
            a(f"  {entry['month_label']}: no production needed")
    s = headsup["sensitivity"]
    a(f"  TOTAL: {s['total_units']:,} units across {s['total_pallets']} pallet(s)")

    a("")
    a("-" * 60)
    a("NOTES:")
    a("  • FIRM months represent committed production volumes.")
    a("    INDICATIVE months are forecasts and may change.")
    a("  • Volumes are driven by forecast demand and a policy of")
    a(f"    maintaining {headsup['cover_target_days']}-day forward FBA cover.")
    a("  • This is a planning aid, not a purchase order.")
    a("-" * 60)
    a("")
    return "\n".join(lines)
