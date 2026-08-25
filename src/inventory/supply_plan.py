"""Four-number supply plan — manufacturer, warehouse inbound, FBA DOS, network OOS.

1. Manufacture order qty + order-by (lip 6w, balm/deo 8–10w lead)
2. Warehouse → FBA/AWD shipments with ship-by dates
3. FBA DOS at phased demand (no new FBA sends)
4. Network OOS date (FBA + inbound + AWD + 3PL at phased demand)
"""
from __future__ import annotations

import math
import re
from datetime import date, timedelta

from src.db import fetch_all
from src.inventory.inbound_waves import (
    _build_forecast_index,
    _iso_week_clamped,
    _load_settings,
    _load_seasonality,
    _parse_date,
    _weekly_demand,
    _week_list,
    build_inbound_wave_plan,
)
from src.inventory.pallet_planner import LIP_BALM_SKUS

# Manufacturer lead times (warehouse receipt)
PRODUCTION_LEAD_DAYS = {
    "lip": 42,       # 6 weeks
    "balm": 70,      # 10 weeks (conservative end of 8–10)
    "deodorant": 70,
    "other": 70,
}


def sku_product_line(sku: str, product_name: str = "") -> str:
    """Classify SKU for production lead time."""
    text = f"{sku} {product_name}".lower()
    if sku in LIP_BALM_SKUS or text.startswith("ddpe") or (
        "lip" in text and "balm" in text
    ):
        return "lip"
    if re.search(r"\b(deodorant|deo)\b", text):
        return "deodorant"
    if "balm" in text or "tallow" in text:
        return "balm"
    return "other"


def production_lead_days(product_line: str) -> int:
    return PRODUCTION_LEAD_DAYS.get(product_line, PRODUCTION_LEAD_DAYS["other"])


def _phased_stockout_date(
    stock: float,
    base_daily: float,
    season_map: dict[int, float],
    forecast_weeks: list[tuple[date, float]],
    start: date,
    end: date,
    include_inbound_schedule: dict[int, int] | None = None,
    weeks: list[date] | None = None,
) -> date | None:
    """Walk phased demand until stock hits zero."""
    if stock <= 0:
        return start
    if base_daily <= 0.001:
        return None

    week_list = weeks or _week_list(start, end)
    inbound_sched = include_inbound_schedule or {}
    remaining = stock
    cursor = start

    for wi, w in enumerate(week_list):
        if w > end:
            break
        remaining += inbound_sched.get(wi, 0)
        week_end = min(w + timedelta(days=6), end)
        demand = _weekly_demand(base_daily, w, week_end, season_map, forecast_weeks)
        if demand <= 0:
            continue
        if remaining <= demand:
            frac = remaining / demand if demand > 0 else 0
            out = w + timedelta(days=int(frac * 7))
            return min(out, end)
        remaining -= demand

    return None


def _active_skus() -> list[str]:
    snaps = {r["sku"]: r for r in fetch_all("inventory_snapshots")}
    velocities = fetch_all("sku_velocity")
    tpls: dict[str, dict] = {}
    awds: dict[str, dict] = {}
    try:
        tpls = {r["sku"]: r for r in fetch_all("inventory_3pl_snapshots")}
    except Exception:
        pass
    try:
        awds = {r["sku"]: r for r in fetch_all("inventory_awd")}
    except Exception:
        pass

    active: set[str] = set(snaps) | set(tpls) | set(awds)
    for v in velocities:
        if float(v.get("total_u_30", 0) or 0) > 0:
            active.add(v["sku"])
    return sorted(s for s in active if s and s not in ("UNKNOW", "UNKNOWN"))


def build_four_numbers_plan(
    skus: list[str] | None = None,
    until_date: str | None = None,
    buffer_days: int = 14,
    scenario: str = "correction_factor",
) -> dict:
    """Build the four planning numbers for each SKU and portfolio totals."""
    target_skus = skus or _active_skus()
    settings = _load_settings()
    today = date.today()
    peak_end = _parse_date(settings.get("peak_end_date")) or date(2027, 1, 15)
    end = (_parse_date(until_date) or peak_end) + timedelta(days=buffer_days)
    recv_days = int(settings.get("receiving_days_normal", 18))

    inbound = build_inbound_wave_plan(
        skus=target_skus,
        until_date=until_date,
        buffer_days=buffer_days,
        scenario=scenario,
    )

    snaps = {r["sku"]: r for r in fetch_all("inventory_snapshots")}
    awds = {r["sku"]: r for r in fetch_all("inventory_awd")}
    tpls: dict[str, dict] = {}
    try:
        tpls = {r["sku"]: r for r in fetch_all("inventory_3pl_snapshots")}
    except Exception:
        pass
    velocities = {r["sku"]: r for r in fetch_all("sku_velocity")}
    fc_rows = fetch_all("forecast_weekly")
    season_map = _load_seasonality()
    weeks = _week_list(today, end)

    inbound_by_sku = {p["sku"]: p for p in inbound["sku_plans"]}

    sku_rows: list[dict] = []
    totals = {
        "manufacture_qty": 0,
        "warehouse_ship_fba": 0,
        "warehouse_ship_awd": 0,
    }

    for sku in target_skus:
        snap = snaps.get(sku, {})
        vel = velocities.get(sku, {})
        product_name = vel.get("product_name") or sku
        line = sku_product_line(sku, product_name)
        prod_lead = production_lead_days(line)

        fba = sum(int(snap.get(k, 0) or 0) for k in
                  ["fulfillable", "reserved", "researching", "unfulfillable"])
        inbound_qty = sum(int(snap.get(k, 0) or 0) for k in
                          ["inbound_working", "inbound_shipped", "inbound_receiving"])
        awd_oh = int(awds.get(sku, {}).get("awd_on_hand", 0) or 0)
        tpl_oh = int(tpls.get(sku, {}).get("available", 0) or 0)
        base_daily = float(vel.get("total_u_30", 0) or 0)

        inbound_plan = inbound_by_sku.get(sku, {})
        waves = inbound_plan.get("waves", [])
        tpl_waves = [w for w in waves if w.get("source") == "3PL"]
        awd_waves = [w for w in waves if w.get("source") == "AWD"]

        ship_fba = sum(w["units"] for w in tpl_waves)
        ship_awd_internal = sum(w["units"] for w in awd_waves)

        # Overflow to AWD: warehouse stock beyond FBA wave need (staging)
        ship_tpl_to_awd = max(0, tpl_oh - ship_fba) if awd_oh == 0 and tpl_oh > ship_fba else 0

        manufacture_qty = inbound_plan.get("produce_short", 0)

        # Order-by: first warehouse ship need minus production lead + receiving
        tpl_ship_dates = [w["ship_by"] for w in tpl_waves]
        if manufacture_qty > 0:
            if tpl_ship_dates:
                first_ship = min(tpl_ship_dates)
                need_at_wh = date.fromisoformat(first_ship) - timedelta(days=recv_days)
                order_by = need_at_wh - timedelta(days=prod_lead)
            else:
                peak_start = _parse_date(settings.get("peak_start_date")) or date(
                    today.year, 10, 1,
                )
                order_by = peak_start - timedelta(days=prod_lead + recv_days)
            order_urgent = order_by < today
        else:
            order_by = None
            order_urgent = False

        # #3 FBA DOS — phased, no new sends (existing inbound still arrives week 1)
        fba_dos_phased: float | None = None
        fba_stockout: str | None = None
        network_oos: str | None = None

        if base_daily > 0:
            forecast_weeks = _build_forecast_index(fc_rows, sku, scenario)
            inbound_sched: dict[int, int] = {}
            if inbound_qty > 0:
                inbound_sched[min(1, len(weeks) - 1)] = inbound_qty

            fba_out = _phased_stockout_date(
                fba, base_daily, season_map, forecast_weeks, today, end,
                include_inbound_schedule=inbound_sched, weeks=weeks,
            )
            fba_stockout = fba_out.isoformat() if fba_out else None

            network_stock = fba + inbound_qty + awd_oh + tpl_oh
            net_out = _phased_stockout_date(
                network_stock, base_daily, season_map, forecast_weeks,
                today, end, weeks=weeks,
            )
            network_oos = net_out.isoformat() if net_out else None

            # Forward phased avg daily (60d) for DOS display
            forward_units = 0.0
            forward_days = 0
            for wi, w in enumerate(weeks):
                if forward_days >= 60:
                    break
                week_end = min(w + timedelta(days=6), end)
                forward_units += _weekly_demand(
                    base_daily, w, week_end, season_map, forecast_weeks,
                )
                forward_days += (week_end - w).days + 1
            avg_phased = forward_units / forward_days if forward_days > 0 else base_daily
            if avg_phased > 0:
                fba_dos_phased = round(fba / avg_phased)

        warehouse_shipments: list[dict] = []
        for w in tpl_waves:
            warehouse_shipments.append({
                "destination": "FBA",
                "units": w["units"],
                "ship_by": w["ship_by"],
                "arrive_date": w["arrive_date"],
                "urgent": w.get("urgent", False),
            })
        for w in awd_waves:
            warehouse_shipments.append({
                "destination": "FBA",
                "units": w["units"],
                "ship_by": w["ship_by"],
                "arrive_date": w["arrive_date"],
                "urgent": w.get("urgent", False),
                "note": "AWD → FBA transfer",
            })
        if ship_tpl_to_awd > 0:
            ship_by_awd = (today + timedelta(days=7)).isoformat()
            warehouse_shipments.append({
                "destination": "AWD",
                "units": ship_tpl_to_awd,
                "ship_by": ship_by_awd,
                "arrive_date": (today + timedelta(days=recv_days)).isoformat(),
                "urgent": False,
                "note": "3PL overflow staging",
            })

        sku_rows.append({
            "sku": sku,
            "product_name": product_name,
            "product_line": line,
            "production_lead_days": prod_lead,
            # 1 Manufacture
            "manufacture_qty": manufacture_qty,
            "order_by": order_by.isoformat() if order_by else None,
            "order_urgent": order_urgent,
            # 2 Warehouse inbound
            "ship_to_fba": ship_fba,
            "ship_to_awd": ship_tpl_to_awd,
            "warehouse_shipments": warehouse_shipments,
            "waves": waves,
            # 3 FBA DOS (no new sends)
            "fba_dos_phased": fba_dos_phased,
            "fba_stockout_date": fba_stockout,
            # 4 Network OOS
            "network_oos_date": network_oos,
            "network_supply": fba + inbound_qty + awd_oh + tpl_oh,
            # Context
            "fba": fba,
            "inbound": inbound_qty,
            "awd": awd_oh,
            "tpl": tpl_oh,
            "holiday_demand": inbound_plan.get("holiday_demand", 0),
            "warehouse_short": inbound_plan.get("warehouse_short", 0),
        })

        totals["manufacture_qty"] += manufacture_qty
        totals["warehouse_ship_fba"] += ship_fba
        totals["warehouse_ship_awd"] += ship_tpl_to_awd

    return {
        "generated": today.isoformat(),
        "until_date": end.isoformat(),
        "receiving_days": inbound["receiving_days"],
        "cover_target_days": inbound["cover_target_days"],
        "scenario": scenario,
        "sku_rows": sku_rows,
        "waves_consolidated": inbound["waves_consolidated"],
        "totals": totals,
        "total_manufacture": totals["manufacture_qty"],
        "total_warehouse_ship_fba": totals["warehouse_ship_fba"],
        "total_warehouse_ship_awd": totals["warehouse_ship_awd"],
        "production_lead_days": dict(PRODUCTION_LEAD_DAYS),
    }


def format_four_numbers_text(plan: dict) -> str:
    """Terminal summary of the four numbers."""
    L: list[str] = []
    a = L.append
    a("=" * 72)
    a("SUPPLY PLAN — FOUR NUMBERS")
    a(f"Generated: {plan['generated']}  ·  Through: {plan['until_date']}")
    a(f"Receiving: {plan['receiving_days']}d warehouse→Prime  ·  "
      f"Cover target: {plan['cover_target_days']}d phased")
    a("=" * 72)

    a("")
    a("PORTFOLIO")
    a(f"  1) Manufacture order:     {plan['total_manufacture']:,} units")
    a(f"  2) Warehouse→FBA ship:  {plan['total_warehouse_ship_fba']:,} units")
    a(f"     Warehouse→AWD ship:  {plan['total_warehouse_ship_awd']:,} units (overflow)")
    leads = plan["production_lead_days"]
    a(f"     Lead times: lip {leads['lip']}d · balm/deo {leads['balm']}d")

    a("")
    a("PER-SKU")
    a(f"  {'SKU':<16} {'Line':<6} {'Mfg':>7} {'OrderBy':<12} "
      f"{'→FBA':>7} {'FBA DOS':>8} {'Net OOS':<12}")
    a(f"  {'-'*68}")
    for r in plan["sku_rows"]:
        if r["manufacture_qty"] == 0 and r["ship_to_fba"] == 0 and not r["fba_dos_phased"]:
            continue
        order = r["order_by"] or "—"
        if r["order_urgent"]:
            order += "!"
        dos = f"{r['fba_dos_phased']}d" if r["fba_dos_phased"] else "—"
        net = r["network_oos_date"] or "—"
        a(
            f"  {r['sku']:<16} {r['product_line']:<6} "
            f"{r['manufacture_qty']:>7,} {order:<12} "
            f"{r['ship_to_fba']:>7,} {dos:>8} {net:<12}"
        )

    if plan["waves_consolidated"]:
        a("")
        a("WAREHOUSE SHIP SCHEDULE (3PL → FBA)")
        for w in plan["waves_consolidated"]:
            urg = " URGENT" if w["urgent"] else ""
            a(f"  Ship by {w['ship_by']}: {w['total_units']:,}{urg}")

    a("")
    return "\n".join(L)
