"""FBA capacity planning engine.

Computes weekly demand forecast through Q1, back-calculates required
arrivals by week accounting for receiving lead times, and splits
recommendations into send-to-FBA vs send-to-AWD vs produce based
on monthly capacity headroom.
"""
from __future__ import annotations

import math
from datetime import date, timedelta
from collections import defaultdict

from src.db import fetch_all


def build_capacity_plan() -> dict:
    """Build a full capacity-aware restock plan.

    Returns:
        settings: planning parameters
        capacity: monthly headroom
        sku_plans: per-SKU plan with produce/AWD/FBA split
        waves: recommended inbound waves by month
    """
    settings = _load_full_settings()
    capacity = _load_capacity()
    volumes = _load_sku_volumes()
    snapshots = {r["sku"]: r for r in _safe_fetch("inventory_snapshots")}
    awd = {r["sku"]: r for r in _safe_fetch("inventory_awd")}
    tpl = {r["sku"]: r for r in _safe_fetch("inventory_3pl_snapshots")}
    velocities = {r["sku"]: r for r in _safe_fetch("sku_velocity")}
    seasonality = _load_seasonality()

    today = date.today()
    peak_start = _parse_date(settings.get("peak_start_date", "2026-10-01"))
    peak_end = _parse_date(settings.get("peak_end_date", "2027-01-15"))

    from src.inventory.leadtime_effective import (
        effective_awd_to_fba_days,
        effective_fba_receive_days,
        is_peak_receiving,
        load_leadtime_summary,
        load_signals_map,
    )

    signals = load_signals_map()
    account_summary = load_leadtime_summary()
    peak = is_peak_receiving(settings)

    receiving_days = effective_fba_receive_days(
        None, settings, signals, peak=peak, account_summary=account_summary,
    )
    awd_to_fba = effective_awd_to_fba_days(
        None, settings, signals, account_summary=account_summary,
    )
    production_lead = settings["production_lead_days"]
    target_days = 90 if settings.get("holiday_mode") else settings["target_cover_days"]

    # Active SKUs: have stock or velocity
    active_skus = sorted(set(snapshots) | set(v for v, d in velocities.items()
                                              if float(d.get("total_u_30", 0) or 0) > 0))

    sku_plans = []
    monthly_ft3: dict[str, float] = defaultdict(float)  # month -> proposed ft3

    for sku in active_skus:
        snap = snapshots.get(sku, {})
        vel = velocities.get(sku, {})
        awd_inv = awd.get(sku, {})
        tpl_inv = tpl.get(sku, {})
        ft3 = float(volumes.get(sku, 0.10))

        # Current stock
        fulfillable = int(snap.get("fulfillable", 0) or 0)
        reserved = int(snap.get("reserved", 0) or 0)
        researching = int(snap.get("researching", 0) or 0)
        unfulfillable = int(snap.get("unfulfillable", 0) or 0)
        fba_on_hand = fulfillable + reserved + researching + unfulfillable

        inbound = (
            int(snap.get("inbound_working", 0) or 0)
            + int(snap.get("inbound_shipped", 0) or 0)
            + int(snap.get("inbound_receiving", 0) or 0)
        )
        awd_on_hand = int(awd_inv.get("awd_on_hand", 0) or 0)
        tpl_available = int(tpl_inv.get("available", 0) or 0)

        total_supply = fba_on_hand + inbound + awd_on_hand + tpl_available

        # Velocity and seasonality
        total_u_30 = float(vel.get("total_u_30", 0) or 0)
        if total_u_30 <= 0:
            sku_plans.append(_empty_plan(sku, vel, fba_on_hand, inbound, awd_on_hand, tpl_available, ft3))
            continue

        # Forecast weekly demand for next 20 weeks using seasonality
        current_week = today.isocalendar()[1]
        weekly_demand = []
        for w_offset in range(20):
            wk = ((current_week - 1 + w_offset) % 52) + 1
            mult = seasonality.get(wk, 1.0)
            weekly_units = total_u_30 * 7 * mult
            weekly_demand.append({
                "week_offset": w_offset,
                "iso_week": wk,
                "multiplier": mult,
                "demand_units": round(weekly_units, 1),
            })

        # Peak demand (highest single week in forecast)
        peak_week_demand = max(w["demand_units"] for w in weekly_demand)

        # Total demand through forecast horizon
        total_forecast_demand = sum(w["demand_units"] for w in weekly_demand)

        # How many days current total supply covers at seasonal velocity
        avg_seasonal_daily = sum(w["demand_units"] for w in weekly_demand[:8]) / 56
        eps = 0.001
        dos_fba_only = fba_on_hand / max(avg_seasonal_daily, eps)
        dos_fba_inbound = (fba_on_hand + inbound) / max(avg_seasonal_daily, eps)
        dos_fba_awd = (fba_on_hand + inbound + awd_on_hand) / max(avg_seasonal_daily, eps)
        dos_total = total_supply / max(avg_seasonal_daily, eps)

        # What we need: target_days of cover at seasonal velocity
        target_units = math.ceil(target_days * avg_seasonal_daily)
        gap = max(target_units - total_supply, 0)

        # Split: AWD can cover some, rest needs production
        send_from_awd = min(awd_on_hand, max(target_units - fba_on_hand - inbound, 0))
        produce_qty = max(gap - awd_on_hand, 0) if gap > 0 else 0

        # FBA send: what should go to FBA now (limited by capacity)
        send_to_fba = min(
            send_from_awd + min(tpl_available, max(gap - send_from_awd, 0)),
            max(target_units - fba_on_hand - inbound, 0),
        )
        send_to_awd = max(produce_qty - send_to_fba, 0) if produce_qty > 0 else 0

        # Capacity impact
        fba_ft3 = send_to_fba * ft3
        sku_recv = effective_fba_receive_days(
            sku, settings, signals, peak=peak, account_summary=account_summary,
        )
        sku_awd = effective_awd_to_fba_days(
            sku, settings, signals, account_summary=account_summary,
        )
        # AWD-sourced sends arrive via AWD→FBA path; direct sends use FBA receive.
        arrival_lead = sku_awd if send_from_awd > 0 and send_from_awd >= send_to_fba // 2 else sku_recv
        arrival_date = today + timedelta(days=arrival_lead)
        arrival_month = arrival_date.strftime("%Y-%m")
        monthly_ft3[arrival_month] += fba_ft3

        # Stockout date
        stockout_days = int(fba_on_hand / max(avg_seasonal_daily, eps))
        stockout_date = (today + timedelta(days=stockout_days)).isoformat() if avg_seasonal_daily > eps else None

        product_name = vel.get("product_name") or ""
        asin = vel.get("asin") or snap.get("asin") or ""

        sku_plans.append({
            "sku": sku,
            "asin": asin,
            "product_name": product_name,
            "fba_on_hand": fba_on_hand,
            "inbound": inbound,
            "awd_on_hand": awd_on_hand,
            "tpl_available": tpl_available,
            "total_supply": total_supply,
            "total_u_30": total_u_30,
            "peak_week_demand": round(peak_week_demand, 0),
            "dos_fba_only": round(dos_fba_only, 0),
            "dos_fba_inbound": round(dos_fba_inbound, 0),
            "dos_fba_awd": round(dos_fba_awd, 0),
            "dos_total": round(dos_total, 0),
            "produce_qty": produce_qty,
            "send_to_fba": send_to_fba,
            "send_to_awd": send_to_awd,
            "send_from_awd_to_fba": send_from_awd,
            "ft3_per_unit": ft3,
            "fba_ft3_impact": round(fba_ft3, 2),
            "arrival_month": arrival_month,
            "stockout_date": stockout_date,
            "flag": (
                "CRITICAL" if dos_fba_only < 14 and fba_on_hand > 0 else
                "LOW" if dos_fba_only < 21 else
                "OK" if produce_qty == 0 else
                "RESTOCK"
            ),
        })

    # Capacity check: flag months where proposed sends exceed headroom
    capacity_status = []
    for month_str in sorted(capacity.keys()):
        c = capacity[month_str]
        proposed = monthly_ft3.get(month_str, 0)
        headroom = c["limit_ft3"] - c["used_ft3"]
        capacity_status.append({
            "month": month_str,
            "limit_ft3": c["limit_ft3"],
            "used_ft3": c["used_ft3"],
            "headroom_ft3": round(headroom, 2),
            "proposed_ft3": round(proposed, 2),
            "remaining_ft3": round(headroom - proposed, 2),
            "source": c["source"],
            "blocked": proposed > headroom,
        })

    # Mark SKUs as BLOCKED if their arrival month is over capacity
    blocked_months = {cs["month"] for cs in capacity_status if cs["blocked"]}
    for plan in sku_plans:
        if plan.get("arrival_month") in blocked_months and plan.get("send_to_fba", 0) > 0:
            plan["flag"] = "BLOCKED"

    # Sort: CRITICAL, BLOCKED, LOW, RESTOCK, OK
    flag_order = {"CRITICAL": 0, "BLOCKED": 1, "LOW": 2, "RESTOCK": 3, "OK": 4}
    sku_plans.sort(key=lambda p: (flag_order.get(p["flag"], 4), -(p.get("total_u_30", 0))))

    return {
        "settings": settings,
        "capacity": capacity_status,
        "sku_plans": sku_plans,
        "receiving_days": receiving_days,
    }


def _empty_plan(sku, vel, fba, inbound, awd, tpl, ft3):
    return {
        "sku": sku, "asin": vel.get("asin", ""),
        "product_name": vel.get("product_name", ""),
        "fba_on_hand": fba, "inbound": inbound,
        "awd_on_hand": awd, "tpl_available": tpl,
        "total_supply": fba + inbound + awd + tpl,
        "total_u_30": 0, "peak_week_demand": 0,
        "dos_fba_only": 9999 if fba > 0 else 0,
        "dos_fba_inbound": 9999 if fba + inbound > 0 else 0,
        "dos_fba_awd": 9999 if fba + inbound + awd > 0 else 0,
        "dos_total": 9999 if fba + inbound + awd + tpl > 0 else 0,
        "produce_qty": 0, "send_to_fba": 0, "send_to_awd": 0,
        "send_from_awd_to_fba": 0,
        "ft3_per_unit": ft3, "fba_ft3_impact": 0,
        "arrival_month": "", "stockout_date": None, "flag": "OK",
    }


def _load_full_settings() -> dict:
    defaults = {
        "target_cover_days": 60, "lead_time_days": 35,
        "holiday_mode": False, "include_inbound": True,
        "include_3pl": True, "include_awd": True,
        "receiving_days_normal": 14, "receiving_days_peak": 28,
        "awd_to_fba_days": 14, "production_lead_days": 45,
        "peak_start_date": "2026-10-01", "peak_end_date": "2027-01-15",
    }
    try:
        rows = fetch_all("inventory_settings")
        if rows:
            s = rows[0]
            for k in defaults:
                if k in s and s[k] is not None:
                    defaults[k] = s[k]
    except Exception:
        pass
    return defaults


def _load_capacity() -> dict[str, dict]:
    result: dict[str, dict] = {}
    try:
        for r in fetch_all("fba_capacity_limits"):
            result[r["month"]] = {
                "limit_ft3": float(r.get("limit_ft3", 0) or 0),
                "used_ft3": float(r.get("used_ft3", 0) or 0),
                "source": r.get("source", "estimate"),
            }
    except Exception:
        pass
    return result


def _load_sku_volumes() -> dict[str, float]:
    result: dict[str, float] = {}
    try:
        for r in fetch_all("inventory_sku_volume"):
            result[r["sku"]] = float(r.get("ft3_per_unit", 0.10) or 0.10)
    except Exception:
        pass
    return result


def _load_seasonality() -> dict[int, float]:
    result: dict[int, float] = {}
    try:
        for r in fetch_all("seasonality_weekly"):
            if r.get("sku") == "_account_" and r.get("year") == 0:
                result[r["week"]] = float(r.get("multiplier", 1.0) or 1.0)
    except Exception:
        pass
    return result


def _parse_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError):
        return None


def _safe_fetch(table: str) -> list[dict]:
    try:
        return fetch_all(table)
    except Exception:
        return []
