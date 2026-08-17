"""Terminal inventory report — at-risk SKUs, stockout ETA, reorder list."""
from __future__ import annotations

import math
from datetime import date, timedelta

from src.db import fetch_all


def build_report() -> dict:
    """Build a consolidated inventory report from DB tables.

    Returns dict with summary stats + per-SKU rows ready for display.
    """
    snapshots = {r["sku"]: r for r in _safe_fetch("inventory_snapshots")}
    velocities = {r["sku"]: r for r in _safe_fetch("sku_velocity")}
    restock = {r["sku"]: r for r in _safe_fetch("inventory_restock")}
    tpl_snapshots = {r["sku"]: r for r in _safe_fetch("inventory_3pl_snapshots")}
    awd_snapshots = {r["sku"]: r for r in _safe_fetch("inventory_awd")}
    settings = _load_settings()

    target_days = settings["target_cover_days"]
    lead_days = settings["lead_time_days"]
    include_inbound = settings["include_inbound"]
    include_3pl = settings.get("include_3pl", True)

    all_skus = sorted(
        set(snapshots) | set(velocities) | set(restock) | set(tpl_snapshots)
    )
    rows = []

    for sku in all_skus:
        snap = snapshots.get(sku, {})
        vel = velocities.get(sku, {})
        rec = restock.get(sku, {})
        tpl = tpl_snapshots.get(sku, {})

        fulfillable = int(snap.get("fulfillable", 0) or 0)
        inbound_total = (
            int(snap.get("inbound_working", 0) or 0)
            + int(snap.get("inbound_shipped", 0) or 0)
            + int(snap.get("inbound_receiving", 0) or 0)
        )
        reserved = int(snap.get("reserved", 0) or 0)
        researching = int(snap.get("researching", 0) or 0)
        unfulfillable = int(snap.get("unfulfillable", 0) or 0)
        tpl_available = int(tpl.get("available", 0) or 0)

        # FBA on-hand matches Seller Central: fulfillable + reserved +
        # researching + unfulfillable (all units physically at FBA).
        fba_on_hand = fulfillable + reserved + researching + unfulfillable

        awd_oh = int(awd_snapshots.get(sku, {}).get("awd_on_hand", 0) or 0)

        # Velocity
        total_vel_30 = float(vel.get("total_u_30", 0) or 0)
        amazon_vel_30 = float(vel.get("amazon_u_30", 0) or 0)
        shopify_vel_30 = float(vel.get("shopify_u_30", 0) or 0)
        eps = 0.001

        # ── Channel detection ──
        # Minimum velocity to consider active (filters junk/mapping SKUs)
        min_vel = 0.1  # at least ~3 units/month
        amazon_active = (
            fba_on_hand > 0 or awd_oh > 0 or inbound_total > 0
            or amazon_vel_30 > min_vel
        )
        shopify_only = (
            not amazon_active
            and (shopify_vel_30 > min_vel or tpl_available > 0)
        )
        # Skip completely inactive / junk SKUs
        if not amazon_active and not shopify_only:
            continue

        channel = "shopify_only" if shopify_only else "amazon"

        amz_rec_qty = int(rec.get("recommended_qty", 0) or 0)
        amz_rec_ship = rec.get("recommended_ship_date")
        amz_dos = rec.get("days_of_supply")
        sold30 = int(rec.get("units_sold_30", 0) or 0)
        recv_days = settings.get("receiving_days_normal", 28)

        if shopify_only:
            # ── Shopify-only: supply = 3PL, demand = Shopify velocity ──
            demand_rate = shopify_vel_30
            supply = tpl_available
            owned_total = tpl_available

            fba_dos = 0  # not applicable
            fba_on_hand = 0

            dos_value = supply / max(demand_rate, eps) if demand_rate > eps else (
                9999 if supply > 0 else 0
            )
            pipeline_dos = dos_value  # same for shopify-only
            pipeline_stockout = None

            if demand_rate > eps:
                stockout_days = int(supply / demand_rate)
                stockout_date = (date.today() + timedelta(days=stockout_days)).isoformat()
            else:
                stockout_days = 9999
                stockout_date = None

            transfer_to_fba = 0
            our_reorder = max(
                math.ceil((target_days + lead_days) * demand_rate) - supply, 0
            )
            breach_date = None
            ship_by = None

            # Shopify cover policy: LOW if < 30d, OK otherwise
            if dos_value < 30 and demand_rate > eps:
                flag = "LOW"
            elif our_reorder > 0:
                flag = "RESTOCK"
            else:
                flag = "OK"

        else:
            # ── Amazon-active: FBA rules with 60d floor ──
            demand_rate = total_vel_30

            fba_dos = fba_on_hand / max(demand_rate, eps) if demand_rate > eps else (
                9999 if fba_on_hand > 0 else 0
            )
            dos_value = fba_dos

            amz_supply = fba_on_hand + (inbound_total if include_inbound else 0) + awd_oh
            pipeline_supply = fba_on_hand + inbound_total + awd_oh
            if demand_rate > eps:
                pipeline_dos = int(pipeline_supply / demand_rate)
                pipeline_stockout = (date.today() + timedelta(days=pipeline_dos)).isoformat()
            else:
                pipeline_dos = 9999
                pipeline_stockout = None

            owned_total = fba_on_hand + inbound_total + awd_oh + tpl_available

            fba_min = target_days  # 60d floor
            fba_target_units = math.ceil(fba_min * demand_rate)
            transfer_to_fba = max(fba_target_units - fba_on_hand - inbound_total, 0)

            total_cover_needed = math.ceil((target_days + lead_days) * demand_rate)
            our_reorder = max(total_cover_needed - owned_total, 0)

            if demand_rate > eps:
                stockout_days = int(fba_on_hand / demand_rate)
                stockout_date = (date.today() + timedelta(days=stockout_days)).isoformat()
            else:
                stockout_days = 9999
                stockout_date = None

            breach_days = max(stockout_days - fba_min, 0) if stockout_days < 9999 else 9999
            breach_date = (
                (date.today() + timedelta(days=breach_days)).isoformat()
                if breach_days < 9999 else None
            )
            ship_by = (
                (date.today() + timedelta(days=max(breach_days - recv_days, 0))).isoformat()
                if breach_days < 9999 else None
            )

            # Flag: 60d FBA policy floor
            if fba_dos < fba_min and demand_rate > eps:
                if breach_days <= recv_days:
                    flag = "CRITICAL"
                else:
                    flag = "LOW"
            elif transfer_to_fba > 0:
                flag = "TRANSFER"
            elif our_reorder > 0:
                flag = "RESTOCK"
            else:
                flag = "OK"

        product_name = (
            vel.get("product_name")
            or rec.get("product_name")
            or snap.get("product_name")
            or ""
        )
        asin = vel.get("asin") or rec.get("asin") or snap.get("asin") or ""

        shopify_share = (
            round(shopify_vel_30 / total_vel_30 * 100, 0)
            if total_vel_30 > 0 else 0
        )

        rows.append({
            "sku": sku,
            "asin": asin,
            "product_name": product_name,
            "fulfillable": fulfillable,
            "fba_on_hand": fba_on_hand,
            "inbound": inbound_total,
            "reserved": reserved,
            "researching": researching,
            "unfulfillable_qty": unfulfillable,
            "awd_on_hand": awd_oh,
            "tpl_available": tpl_available,
            "on_hand": owned_total,
            "transfer_to_fba": transfer_to_fba,
            "breach_date": breach_date,
            "ship_by": ship_by,
            "amazon_u_7": float(vel.get("amazon_u_7", 0) or 0),
            "amazon_u_30": amazon_vel_30,
            "shopify_u_7": float(vel.get("shopify_u_7", 0) or 0),
            "shopify_u_30": shopify_vel_30,
            "total_u_7": float(vel.get("total_u_7", 0) or 0),
            "total_u_30": total_vel_30,
            "shopify_share_pct": shopify_share,
            "channel": channel,
            "dos": round(dos_value, 1),
            "our_reorder_qty": our_reorder,
            "amz_rec_qty": amz_rec_qty,
            "amz_rec_ship": amz_rec_ship,
            "amz_dos": amz_dos,
            "amz_sold_30": sold30,
            "stockout_date": stockout_date,
            "stockout_days": stockout_days,
            "pipeline_dos": pipeline_dos,
            "pipeline_stockout": pipeline_stockout,
            "flag": flag,
        })

    # Sort: CRITICAL first, then LOW, then by FBA DOS ascending
    flag_order = {"CRITICAL": 0, "LOW": 1, "RESTOCK": 2, "OK": 3}
    rows.sort(key=lambda r: (flag_order.get(r["flag"], 3), r["dos"]))

    # Summary
    at_risk = [r for r in rows if r["dos"] < 60 and r["fba_on_hand"] > 0]
    total_reorder = sum(r["our_reorder_qty"] for r in rows)
    total_amz_rec = sum(r["amz_rec_qty"] for r in rows)
    active_skus = [r for r in rows if r["fba_on_hand"] > 0 or r["total_u_30"] > 0]

    # Portfolio weeks of cover (FBA-only at current velocity)
    total_fba = sum(r["fba_on_hand"] for r in rows)
    total_vel = sum(r["total_u_30"] for r in rows)
    portfolio_weeks = (
        round(total_fba / (total_vel * 7), 1)
        if total_vel > 0 else 0
    )

    return {
        "settings": settings,
        "summary": {
            "active_skus": len(active_skus),
            "at_risk_skus": len(at_risk),
            "total_our_reorder": total_reorder,
            "total_amz_recommended": total_amz_rec,
            "portfolio_weeks_cover": portfolio_weeks,
        },
        "rows": rows,
    }


def _load_settings() -> dict:
    """Load inventory settings with defaults."""
    try:
        rows = fetch_all("inventory_settings")
        if rows:
            s = rows[0]
            return {
                "target_cover_days": int(s.get("target_cover_days", 60) or 60),
                "lead_time_days": int(s.get("lead_time_days", 35) or 35),
                "holiday_mode": bool(s.get("holiday_mode", False)),
                "include_inbound": bool(s.get("include_inbound", True)),
                "include_3pl": bool(s.get("include_3pl", True)),
            }
    except Exception:
        pass
    return {
        "target_cover_days": 60,
        "lead_time_days": 35,
        "holiday_mode": False,
        "include_inbound": True,
        "include_3pl": True,
    }


def _safe_fetch(table: str) -> list[dict]:
    try:
        return fetch_all(table)
    except Exception:
        return []
