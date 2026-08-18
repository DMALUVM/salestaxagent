"""Lip Balm Monthly Pallet Planner.

Computes how many pallets of mixed SKUs need to be produced and shipped
so that all Nov+Dec forecast demand is in Amazon (FBA) by a target date.

Config defaults:
  pallet_max_units = 19,000
  amazon_in_by = 2026-10-31
  scenario = correction_factor
  include_3pl_transfer = True  (3PL stock counts if transferred by target)
  include_awd = True
"""
from __future__ import annotations

import math
from datetime import date
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
