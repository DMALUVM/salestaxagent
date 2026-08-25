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
    sku_seasonality = _load_sku_seasonality()

    today = date.today()
    peak_start = _parse_date(settings.get("peak_start_date", "2026-10-01"))
    peak_end = _parse_date(settings.get("peak_end_date", "2027-01-15"))

    receiving_days = (
        settings["receiving_days_peak"]
        if peak_start and today >= peak_start - timedelta(days=30)
        else settings["receiving_days_normal"]
    )
    awd_to_fba = settings["awd_to_fba_days"]
    production_lead = settings["production_lead_days"]
    from src.inventory.holiday_surge import (
        AMAZON_MIN_COVER_DAYS,
        amazon_cover_target,
        amazon_demand_daily,
    )

    holiday_mode = bool(settings.get("holiday_mode"))
    target_days = amazon_cover_target(
        int(settings.get("target_cover_days", AMAZON_MIN_COVER_DAYS) or AMAZON_MIN_COVER_DAYS),
        holiday_mode=holiday_mode,
    )

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

        # Always use trough-resistant / holiday-anchored planning rate
        total_u_30 = float(vel.get("total_u_30", 0) or 0)
        demand_daily = amazon_demand_daily(vel, today=today)
        surge = float(vel.get("holiday_surge_mult", 1) or 1)
        planning_u = demand_daily
        if demand_daily <= 0:
            sku_plans.append(_empty_plan(sku, vel, fba_on_hand, inbound, awd_on_hand, tpl_available, ft3))
            continue

        # Forecast weekly demand for next 20 weeks using seasonality
        # Prefer per-SKU peak floor (holiday surge) over account curve.
        sku_seas = sku_seasonality.get(sku, {})
        current_week = today.isocalendar()[1]
        weekly_demand = []
        for w_offset in range(20):
            wk = ((current_week - 1 + w_offset) % 52) + 1
            acct_mult = seasonality.get(wk, 1.0)
            sku_mult = sku_seas.get(wk)
            if sku_mult is not None and sku_mult > acct_mult:
                mult = sku_mult
            else:
                mult = acct_mult
            # Planning rate already holiday-anchored — scale relatively vs current week
            if surge > 1.05:
                cur_mult = max(seasonality.get(current_week, 1.0), 0.5)
                rel = mult / cur_mult
                weekly_units = demand_daily * 7 * rel
            else:
                weekly_units = demand_daily * 7 * mult
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
        # Floor: never plan below holiday planning daily
        if planning_u > avg_seasonal_daily:
            avg_seasonal_daily = planning_u
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
        # Assign to arrival month (today + receiving days)
        arrival_date = today + timedelta(days=receiving_days)
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
            "planning_u_30": demand_daily,
            "holiday_surge_mult": surge,
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
                "CRITICAL" if dos_fba_only < AMAZON_MIN_COVER_DAYS and fba_on_hand > 0 else
                "LOW" if dos_fba_only < target_days else
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
    """Account-level weekly multipliers (sku=_account_, year=0)."""
    result: dict[int, float] = {}
    try:
        for r in fetch_all("seasonality_weekly"):
            if r.get("sku") == "_account_" and r.get("year") == 0:
                result[r["week"]] = float(r.get("multiplier", 1.0) or 1.0)
    except Exception:
        pass
    return result


def _load_sku_seasonality() -> dict[str, dict[int, float]]:
    """Per-SKU peak-week floors from holiday surge (excludes _account_)."""
    result: dict[str, dict[int, float]] = {}
    try:
        for r in fetch_all("seasonality_weekly"):
            sku = r.get("sku")
            if not sku or sku == "_account_" or r.get("year") != 0:
                continue
            result.setdefault(sku, {})[int(r["week"])] = float(
                r.get("multiplier", 1.0) or 1.0
            )
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
