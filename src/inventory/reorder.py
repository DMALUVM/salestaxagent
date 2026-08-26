"""Shared inventory reorder math.

The inventory page and pallet planner must use the same formula:

    reorder = max(ceil((cover_target + lead) × V30) − on_hand, 0)

Cover target is 90 days when holiday_mode is on, otherwise
``target_cover_days``. On-hand follows the inventory-page include flags
(FBA + optional inbound / 3PL / AWD).
"""
from __future__ import annotations

import math


HOLIDAY_COVER_DAYS = 90


def cover_target_days(settings: dict) -> int:
    """Match the inventory page: holiday_mode → 90, else target_cover_days."""
    if settings.get("holiday_mode"):
        return HOLIDAY_COVER_DAYS
    try:
        return int(settings.get("target_cover_days") or 60)
    except (TypeError, ValueError):
        return 60


def inventory_on_hand(
    fba: int,
    inbound: int,
    awd: int,
    tpl: int,
    settings: dict | None = None,
) -> int:
    """Owned units counted toward reorder, same flags as /inventory."""
    s = settings or {}
    n = int(fba or 0)
    if s.get("include_inbound", True):
        n += int(inbound or 0)
    if s.get("include_3pl", True):
        n += int(tpl or 0)
    if s.get("include_awd", True) is not False:
        n += int(awd or 0)
    return n


def effective_lead_days_for_reorder(
    *,
    measured_receive_days: float | None,
    measured_replenish_days: float | None,
    fba_optimized_receive_median: float | None,
    fba_receive_median: float | None,
    awd_replenish_median: float | None,
    receiving_days_normal: int,
    awd_to_fba_days: int,
    awd_on_hand: int,
    fba_on_hand: int,
    inbound: int,
) -> int:
    """Lead used in (target + lead) × V30. Zero measured values are treated as missing."""
    fba = (
        measured_receive_days
        if measured_receive_days and measured_receive_days > 0
        else None
    )
    if fba is None:
        fba = fba_optimized_receive_median if fba_optimized_receive_median and fba_optimized_receive_median > 0 else None
    if fba is None:
        fba = fba_receive_median if fba_receive_median and fba_receive_median > 0 else None
    if fba is None:
        fba = receiving_days_normal

    awd = (
        measured_replenish_days
        if measured_replenish_days and measured_replenish_days > 0
        else None
    )
    if awd is None:
        awd = awd_replenish_median if awd_replenish_median and awd_replenish_median > 0 else None
    if awd is None:
        awd = awd_to_fba_days

    fba_i = int(round(float(fba)))
    awd_i = int(round(float(awd)))
    if awd_on_hand > 0 and awd_on_hand >= fba_on_hand + inbound:
        return max(fba_i, awd_i)
    return fba_i


def reorder_qty(
    target_days: int,
    lead_days: int,
    daily_velocity: float,
    on_hand: int,
) -> int:
    """Units to produce/transfer to hit cover + lead at daily velocity."""
    if daily_velocity <= 0:
        return 0
    return max(math.ceil((target_days + lead_days) * daily_velocity) - on_hand, 0)


def amazon_inventory_reorder(
    *,
    fba: int,
    inbound: int,
    awd: int,
    tpl: int,
    daily_velocity: float,
    settings: dict,
    measured_receive_days: float | None = None,
    measured_replenish_days: float | None = None,
    fba_optimized_receive_median: float | None = None,
    fba_receive_median: float | None = None,
    awd_replenish_median: float | None = None,
) -> dict:
    """Full inventory-page Amazon reorder for one SKU."""
    target = cover_target_days(settings)
    on_hand = inventory_on_hand(fba, inbound, awd, tpl, settings)
    lead = effective_lead_days_for_reorder(
        measured_receive_days=measured_receive_days,
        measured_replenish_days=measured_replenish_days,
        fba_optimized_receive_median=fba_optimized_receive_median,
        fba_receive_median=fba_receive_median,
        awd_replenish_median=awd_replenish_median,
        receiving_days_normal=int(settings.get("receiving_days_normal") or 14),
        awd_to_fba_days=int(settings.get("awd_to_fba_days") or 14),
        awd_on_hand=int(awd or 0),
        fba_on_hand=int(fba or 0),
        inbound=int(inbound or 0),
    )
    return {
        "target_days": target,
        "lead_days": lead,
        "on_hand": on_hand,
        "reorder_qty": reorder_qty(target, lead, daily_velocity, on_hand),
    }


def manufacture_need(inventory_reorder: int, holiday_manufacture: int) -> int:
    """Produce at least the inventory-page reorder and the holiday gap."""
    return max(int(inventory_reorder or 0), int(holiday_manufacture or 0))


def allocate_monthly_units(
    skus: list[str],
    inventory_reorder: dict[str, int],
    holiday_manufacture: dict[str, int],
    n_months: int,
    weights: tuple[float, ...] | list[float],
) -> list[dict[str, int]]:
    """Spread production across months, front-loading the inventory reorder.

    Month 0 receives each SKU's inventory-page reorder in full, plus that
    month's weight share of any leftover holiday surplus. Later months
    split only the leftover. Last month absorbs rounding remainder.
    """
    if n_months <= 0:
        return []

    w = list(weights) if weights else [1.0]
    while len(w) < n_months:
        w.append(0.0)
    w_all = sum(w[:n_months]) or 1.0

    leftover: dict[str, int] = {}
    mixes: list[dict[str, int]] = [dict() for _ in range(n_months)]

    for sku in skus:
        reorder = int(inventory_reorder.get(sku, 0) or 0)
        holiday = int(holiday_manufacture.get(sku, 0) or 0)
        mfg = manufacture_need(reorder, holiday)
        floor = min(reorder, mfg)
        extra_pool = mfg - floor
        extra0 = min(round(extra_pool * w[0] / w_all), extra_pool) if extra_pool > 0 else 0
        mixes[0][sku] = floor + extra0
        leftover[sku] = extra_pool - extra0

    rest = n_months - 1
    if rest <= 0:
        return [{sku: qty for sku, qty in mix.items() if qty > 0} for mix in mixes]

    rest_w = w[1:n_months]
    for mi in range(rest):
        month_idx = mi + 1
        last = mi == rest - 1
        w_i = rest_w[mi] if mi < len(rest_w) else 0.0
        w_sum = sum(rest_w[mi:]) or 0.01
        for sku in skus:
            rem = leftover[sku]
            if rem <= 0:
                continue
            alloc = rem if last else min(round(rem * w_i / w_sum), rem)
            if alloc > 0:
                mixes[month_idx][sku] = alloc
                leftover[sku] -= alloc

    return [{sku: qty for sku, qty in mix.items() if qty > 0} for mix in mixes]
