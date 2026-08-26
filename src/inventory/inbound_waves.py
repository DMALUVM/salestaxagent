"""Warehouse → Amazon inbound wave planner.

Schedules 3PL shipments so FBA maintains ≥60d forward cover at phased
(seasonal) demand — not peak holiday rate in the trough.

Assumes warehouse ship → Prime-eligible on Amazon in ~2–3 weeks
(`receiving_days_normal` from inventory_settings).
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, timedelta

from src.db import fetch_all
from src.inventory.holiday_surge import AMAZON_MIN_COVER_DAYS, amazon_cover_target
from src.inventory.pallet_planner import LIP_BALM_SKUS, _holiday_demand_by_sku

# Default warehouse → FBA receiving (2–3 weeks)
DEFAULT_RECEIVING_DAYS = 18
DEFAULT_AWD_TO_FBA_DAYS = 14
FORWARD_COVER_WEEKS = 9  # ~63 days lookahead for cover math


def _parse_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except (ValueError, TypeError):
        return None


def _load_settings() -> dict:
    defaults = {
        "target_cover_days": AMAZON_MIN_COVER_DAYS,
        "holiday_mode": False,
        "receiving_days_normal": DEFAULT_RECEIVING_DAYS,
        "receiving_days_peak": 21,
        "awd_to_fba_days": DEFAULT_AWD_TO_FBA_DAYS,
        "peak_start_date": "2026-10-01",
        "peak_end_date": "2027-01-15",
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


def _load_seasonality() -> dict[int, float]:
    result: dict[int, float] = {}
    try:
        for r in fetch_all("seasonality_weekly"):
            if r.get("sku") == "_account_" and r.get("year") == 0:
                result[int(r["week"])] = float(r.get("multiplier", 1.0) or 1.0)
    except Exception:
        pass
    return result


def _iso_week_clamped(d: date) -> int:
    jan1 = date(d.year, 1, 1)
    iso_week = math.ceil(
        ((d - jan1).days + jan1.weekday() + 1) / 7
    )
    return max(1, min(52, iso_week or 1))


def _build_forecast_index(
    fc_rows: list[dict],
    sku: str,
    scenario: str,
) -> list[tuple[date, float]]:
    weeks: list[tuple[date, float]] = []
    for r in fc_rows:
        if r.get("sku") != sku or r.get("scenario") != scenario:
            continue
        ws = _parse_date(str(r.get("week_start", "")))
        if ws:
            weeks.append((ws, float(r.get("units", 0) or 0)))
    weeks.sort(key=lambda x: x[0])
    return weeks


def _forecast_units_for_range(
    forecast_weeks: list[tuple[date, float]],
    cursor: date,
    week_end: date,
) -> float | None:
    cursor_ms = cursor.toordinal()
    end_ms = week_end.toordinal()
    best: float | None = None
    best_dist = 10_000
    for fw_start, units in forecast_weeks:
        fw_end = fw_start + timedelta(days=6)
        if fw_start.toordinal() <= end_ms and fw_end.toordinal() >= cursor_ms:
            dist = abs(fw_start.toordinal() - cursor_ms)
            if dist < best_dist:
                best = units
                best_dist = dist
    return best


def _weekly_demand(
    base_daily_v30: float,
    cursor: date,
    week_end: date,
    season_map: dict[int, float],
    forecast_weeks: list[tuple[date, float]],
) -> float:
    days = (week_end - cursor).days + 1
    if days <= 0:
        return 0.0
    clamped_wk = _iso_week_clamped(cursor)
    mult = season_map.get(clamped_wk, 1.0)
    fc_units = _forecast_units_for_range(forecast_weeks, cursor, week_end)
    if fc_units is not None:
        return round(fc_units * (days / 7))
    return round(base_daily_v30 * days * mult)


def _forward_phased_avg_daily(
    start: date,
    end: date,
    base_daily_v30: float,
    horizon_days: int,
    season_map: dict[int, float],
    forecast_weeks: list[tuple[date, float]],
) -> float:
    """Phased average daily over horizon_days from start (matches dashboard PhDOS)."""
    total_units = 0.0
    counted_days = 0
    cursor = start
    while counted_days < horizon_days and cursor <= end:
        week_end = min(cursor + timedelta(days=6), end)
        span_days = (week_end - cursor).days + 1
        use_days = min(span_days, horizon_days - counted_days)
        week_units = _weekly_demand(
            base_daily_v30, cursor, week_end, season_map, forecast_weeks,
        )
        total_units += week_units * (use_days / span_days)
        counted_days += use_days
        cursor = week_end + timedelta(days=1)
    return total_units / counted_days if counted_days > 0 else base_daily_v30


def _pipeline_receipts_ahead(
    scheduled: dict[int, int],
    wi: int,
    weeks: list[date],
    lead_days: int,
) -> int:
    total = 0
    deadline = weeks[wi].toordinal() + lead_days
    for fj in range(wi + 1, len(weeks)):
        if weeks[fj].toordinal() > deadline:
            break
        total += scheduled.get(fj, 0)
    return total


def _week_list(start: date, end: date) -> list[date]:
    monday = start - timedelta(days=start.weekday())
    weeks: list[date] = []
    cursor = monday
    while cursor <= end:
        weeks.append(cursor)
        cursor += timedelta(days=7)
    return weeks


def build_inbound_wave_plan(
    skus: list[str] | None = None,
    until_date: str | None = None,
    buffer_days: int = 14,
    cover_target_days: int | None = None,
    receiving_days: int | None = None,
    scenario: str = "correction_factor",
    include_awd_in_supply: bool = True,
    inbound_arrive_week: int | None = None,
    awd_arrive_week: int | None = None,
) -> dict:
    """Plan warehouse → FBA inbound waves with receiving lead time.

    Returns per-SKU summaries, scheduled waves (ship_by / arrive / units),
    and warehouse shortfall vs full holiday needs.
    """
    target_skus = skus or LIP_BALM_SKUS
    settings = _load_settings()
    today = date.today()

    peak_end = _parse_date(settings.get("peak_end_date")) or date(2027, 1, 15)
    end = _parse_date(until_date) or peak_end
    end = end + timedelta(days=buffer_days)

    holiday_mode = bool(settings.get("holiday_mode"))
    target_days = cover_target_days or amazon_cover_target(
        int(settings.get("target_cover_days", AMAZON_MIN_COVER_DAYS) or AMAZON_MIN_COVER_DAYS),
        holiday_mode=holiday_mode,
    )
    recv_days = receiving_days or int(settings.get("receiving_days_normal", DEFAULT_RECEIVING_DAYS))
    awd_days = int(settings.get("awd_to_fba_days", DEFAULT_AWD_TO_FBA_DAYS))
    awd_week = awd_arrive_week if awd_arrive_week is not None else max(1, math.ceil(awd_days / 7))

    inbound_week = inbound_arrive_week
    if inbound_week is None:
        inbound_week = max(0, min(math.ceil(recv_days / 7) - 1, 1))

    # Load inventory
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
    if not weeks:
        weeks = [today - timedelta(days=today.weekday())]

    # Holiday demand (Nov–Dec + Jan) for shortfall math
    holiday_by_sku = _holiday_demand_by_sku(
        fc_rows, target_skus, "correction_factor", include_jan=True, velocities=velocities,
    )

    sku_results: list[dict] = []
    all_waves: list[dict] = []

    for sku in target_skus:
        snap = snaps.get(sku, {})
        vel = velocities.get(sku, {})
        base_daily = float(vel.get("total_u_30", 0) or 0)

        fba = sum(int(snap.get(k, 0) or 0) for k in
                  ["fulfillable", "reserved", "researching", "unfulfillable"])
        inbound = sum(int(snap.get(k, 0) or 0) for k in
                      ["inbound_working", "inbound_shipped", "inbound_receiving"])
        awd_oh = int(awds.get(sku, {}).get("awd_on_hand", 0) or 0)
        tpl_oh = int(tpls.get(sku, {}).get("available", 0) or 0)
        owned_total = fba + inbound + awd_oh + tpl_oh
        fba_supply = fba + inbound + (awd_oh if include_awd_in_supply else 0)

        holiday_demand = holiday_by_sku.get(sku, 0)
        holiday_fba_gap = max(holiday_demand - fba_supply, 0)
        warehouse_short = max(holiday_fba_gap - tpl_oh, 0)
        produce_short = holiday_fba_gap  # 3PL is transfer-only, same as pallet planner

        if base_daily <= 0:
            sku_results.append({
                "sku": sku,
                "product_name": vel.get("product_name") or sku,
                "fba": fba,
                "inbound": inbound,
                "awd": awd_oh,
                "tpl": tpl_oh,
                "owned_total": owned_total,
                "holiday_demand": holiday_demand,
                "holiday_fba_gap": holiday_fba_gap,
                "warehouse_short": warehouse_short,
                "produce_short": produce_short,
                "total_ship_from_warehouse": 0,
                "waves": [],
                "weeks": [],
                "alerts": [],
            })
            continue

        forecast_weeks = _build_forecast_index(fc_rows, sku, scenario)
        demand_by_week: dict[str, float] = {}
        for w in weeks:
            week_end = min(w + timedelta(days=6), end)
            demand_by_week[w.isoformat()] = _weekly_demand(
                base_daily, w, week_end, season_map, forecast_weeks,
            )

        # Pre-schedule existing inbound + AWD transfers
        scheduled: dict[int, int] = defaultdict(int)
        if inbound > 0:
            scheduled[min(inbound_week, len(weeks) - 1)] += inbound
        awd_pool = awd_oh if not include_awd_in_supply else 0
        if include_awd_in_supply and awd_oh > 0:
            scheduled[min(awd_week, len(weeks) - 1)] += awd_oh

        warehouse_pool = tpl_oh
        waves: list[dict] = []
        alerts: list[dict] = []
        week_rows: list[dict] = []

        fba_sim = fba  # FBA-only burn (matches plan page)

        for wi, w in enumerate(weeks):
            w_iso = w.isoformat()
            receipt = scheduled.get(wi, 0)
            fba_sim += receipt

            avg_daily = _forward_phased_avg_daily(
                w, end, base_daily, target_days, season_map, forecast_weeks,
            )
            pipeline = _pipeline_receipts_ahead(scheduled, wi, weeks, recv_days)
            effective_fba = fba_sim + pipeline
            if avg_daily > 0:
                cover_days = effective_fba / avg_daily
            else:
                cover_days = 999.0

            inbound_grace = max(target_days - 15, recv_days + 7) if inbound > 0 else target_days - 7
            flagged = cover_days < inbound_grace and cover_days < 999

            if flagged and avg_daily > 0:
                target_fba = target_days * avg_daily
                deficit = math.ceil(max(target_fba - effective_fba, 0))
                critical_urgent = cover_days < recv_days
                wave_cap = (
                    warehouse_pool
                    if critical_urgent
                    else min(
                        warehouse_pool,
                        max(
                            math.ceil(avg_daily * recv_days),
                            math.ceil(avg_daily * 7),
                        ),
                    )
                )

                if deficit > 0:
                    from_awd = min(deficit, awd_pool, wave_cap)
                    if from_awd > 0:
                        awd_pool -= from_awd
                        scheduled[wi] += from_awd
                        fba_sim += from_awd
                        waves.append({
                            "sku": sku,
                            "source": "AWD",
                            "units": from_awd,
                            "arrive_date": w_iso,
                            "ship_by": (w - timedelta(days=awd_days)).isoformat(),
                            "urgent": critical_urgent,
                        })
                        deficit -= from_awd

                    tpl_cap = (
                        warehouse_pool
                        if critical_urgent
                        else min(warehouse_pool, wave_cap - from_awd)
                    )
                    from_tpl = min(deficit, tpl_cap)
                    if from_tpl > 0:
                        warehouse_pool -= from_tpl
                        scheduled[wi] += from_tpl
                        fba_sim += from_tpl
                        ship_by = w - timedelta(days=recv_days)
                        waves.append({
                            "sku": sku,
                            "source": "3PL",
                            "units": from_tpl,
                            "arrive_date": w_iso,
                            "ship_by": ship_by.isoformat(),
                            "urgent": critical_urgent,
                        })
                        if critical_urgent:
                            alerts.append({
                                "sku": sku,
                                "week": w_iso,
                                "cover_days": round(cover_days),
                                "units_needed": from_tpl,
                                "message": "Ship immediately — cover below receiving lead time",
                            })

            wk_demand = demand_by_week.get(w_iso, 0)
            fba_sim = max(fba_sim - wk_demand, 0)

            avg_daily_post = _forward_phased_avg_daily(
                w, end, base_daily, target_days, season_map, forecast_weeks,
            )
            cover_post = (
                fba_sim / avg_daily_post if avg_daily_post > 0 else None
            )

            week_rows.append({
                "week": w_iso,
                "demand": round(wk_demand),
                "receipt": receipt,
                "fba": round(fba_sim),
                "cover_days": round(cover_post) if cover_post is not None else None,
                "flagged": flagged,
            })

            if flagged:
                alerts.append({
                    "sku": sku,
                    "week": w_iso,
                    "cover_days": round(cover_days),
                    "fba": round(fba_sim),
                    "daily_rate": round(avg_daily, 1),
                })

        tpl_ship_total = sum(w["units"] for w in waves if w["source"] == "3PL")
        warehouse_short_live = max(tpl_ship_total - tpl_oh, 0)

        sku_results.append({
            "sku": sku,
            "product_name": vel.get("product_name") or sku,
            "fba": fba,
            "inbound": inbound,
            "awd": awd_oh,
            "tpl": tpl_oh,
            "owned_total": owned_total,
            "holiday_demand": holiday_demand,
            "holiday_fba_gap": holiday_fba_gap,
            "warehouse_short": max(warehouse_short, warehouse_short_live),
            "produce_short": produce_short,
            "total_ship_from_warehouse": tpl_ship_total,
            "waves": waves,
            "weeks": week_rows,
            "alerts": alerts,
        })
        all_waves.extend(waves)

    # Consolidate waves by ship_by for pallet view
    by_ship: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for w in all_waves:
        if w["source"] == "3PL":
            by_ship[w["ship_by"]][w["sku"]] += w["units"]

    consolidated: list[dict] = []
    for ship_by in sorted(by_ship.keys()):
        mix = dict(by_ship[ship_by])
        consolidated.append({
            "ship_by": ship_by,
            "mix": mix,
            "total_units": sum(mix.values()),
            "urgent": any(
                w["source"] == "3PL"
                and w["ship_by"] == ship_by
                and w.get("urgent")
                for w in all_waves
            ),
        })

    return {
        "generated": today.isoformat(),
        "until_date": end.isoformat(),
        "cover_target_days": target_days,
        "receiving_days": recv_days,
        "awd_to_fba_days": awd_days,
        "scenario": scenario,
        "holiday_mode": holiday_mode,
        "sku_plans": sku_results,
        "waves_consolidated": consolidated,
        "total_warehouse_ship": sum(
            p["total_ship_from_warehouse"] for p in sku_results
        ),
        "total_warehouse_short": sum(p["warehouse_short"] for p in sku_results),
        "total_produce_short": sum(p["produce_short"] for p in sku_results),
        "total_holiday_demand": sum(p["holiday_demand"] for p in sku_results),
    }


def format_inbound_plan_text(plan: dict) -> str:
    """Human-readable inbound wave plan."""
    L: list[str] = []
    a = L.append
    a("=" * 70)
    a("WAREHOUSE → AMAZON INBOUND WAVE PLAN")
    a(f"Generated: {plan['generated']}")
    a(f"Cover target: {plan['cover_target_days']}d forward at phased demand")
    a(f"Receiving lead: {plan['receiving_days']}d (warehouse ship → Prime eligible)")
    a(f"Plan through: {plan['until_date']}")
    a("=" * 70)

    a("")
    a(f"Holiday demand (Nov–Jan YoY): {plan['total_holiday_demand']:,} units")
    a(f"Ship from warehouse (planned): {plan['total_warehouse_ship']:,} units")
    a(f"Warehouse short vs holiday:    {plan['total_warehouse_short']:,} units")
    a(f"Produce short (network):       {plan['total_produce_short']:,} units")

    a("")
    a("PER-SKU SUMMARY")
    a(f"  {'SKU':<18} {'Holiday':>8} {'3PL':>7} {'Ship':>7} {'Short':>7} {'Produce':>8}")
    a(f"  {'-'*58}")
    for p in plan["sku_plans"]:
        a(
            f"  {p['sku']:<18} {p['holiday_demand']:>8,} {p['tpl']:>7,} "
            f"{p['total_ship_from_warehouse']:>7,} {p['warehouse_short']:>7,} "
            f"{p['produce_short']:>8,}"
        )

    if plan["waves_consolidated"]:
        a("")
        a("CONSOLIDATED SHIP SCHEDULE (3PL → FBA)")
        for w in plan["waves_consolidated"]:
            flag = " URGENT" if w["urgent"] else ""
            a(f"  Ship by {w['ship_by']}: {w['total_units']:,} units{flag}")
            for sku, qty in w["mix"].items():
                a(f"    {sku}: {qty:,}")

    a("")
    return "\n".join(L)
