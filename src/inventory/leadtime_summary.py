"""Account-level FBA vs AWD lead-time aggregates for dashboard."""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date
from statistics import median

from src.db import fetch_all, upsert_rows
from src.inventory.awd_replenishments import median_replenish_days
from src.inventory.inbound_shipments import median_receive_days
from src.inventory.split_leadtime import first_last_from_replenishments

log = logging.getLogger(__name__)

OPTIMIZED_MIN_FCS = 2


def _group_inbound_batches(ships: list[dict]) -> tuple[list[int], list[int]]:
    """Split closed FBA receive_days into optimized multi-FC vs single-FC batches."""
    closed = [
        s for s in ships
        if (s.get("shipment_status") or "").upper() == "CLOSED"
        and s.get("receive_days") is not None
        and (s.get("receive_days_basis") or "") != "created_to_closed_fallback"
        and (s.get("shipped_at") or s.get("created_at"))
    ]
    by_day: dict[str, list[dict]] = defaultdict(list)
    for s in closed:
        day = str(s.get("shipped_at") or s.get("created_at", ""))[:10]
        if day:
            by_day[day].append(s)

    optimized: list[int] = []
    single: list[int] = []
    for group in by_day.values():
        fcs = {
            s.get("destination_fc")
            for s in group
            if s.get("destination_fc")
        }
        days = [int(s["receive_days"]) for s in group if int(s.get("receive_days", -1)) >= 0]
        if not days:
            continue
        if len(fcs) >= OPTIMIZED_MIN_FCS:
            optimized.extend(days)
        elif len(group) == 1:
            single.extend(days)
    return optimized, single


def _median(vals: list[int]) -> int | None:
    if not vals:
        return None
    return int(median(vals))


def sync_leadtime_summary(configured_awd_days: int = 14) -> dict:
    """Write one account-level row comparing FBA direct vs optimized vs AWD."""
    try:
        settings = fetch_all("inventory_settings")
        if settings:
            configured_awd_days = int(
                settings[0].get("awd_to_fba_days", configured_awd_days) or configured_awd_days,
            )
    except Exception:
        pass

    fba_med, fba_n = median_receive_days(limit=10)
    awd_med, awd_n = median_replenish_days(limit=10)

    try:
        ships = fetch_all("inventory_inbound_shipments")
    except Exception:
        ships = []

    opt_vals, single_vals = _group_inbound_batches(ships)
    opt_med = _median(opt_vals[-20:]) if opt_vals else None
    opt_n = len(opt_vals[-20:])
    single_med = _median(single_vals[-10:]) if single_vals else None
    single_n = len(single_vals[-10:])

    try:
        replen_orders = fetch_all("inventory_awd_replenishments")
    except Exception:
        replen_orders = []
    split = first_last_from_replenishments(replen_orders)

    today = date.today().isoformat()
    row = {
        "as_of_date": today,
        "fba_receive_median": fba_med,
        "fba_receive_n": fba_n,
        "fba_optimized_receive_median": opt_med,
        "fba_optimized_receive_n": opt_n,
        "fba_single_receive_median": single_med,
        "fba_single_receive_n": single_n,
        "awd_replenish_median": awd_med,
        "awd_replenish_n": awd_n,
        "configured_awd_to_fba_days": configured_awd_days,
        "first_box_days": split["first_box_days"],
        "last_box_days": split["last_box_days"],
        "box_spread_days": split["box_spread_days"],
        "split_n": split["split_n"],
    }

    upsert_rows("inventory_leadtime_summary", [row], on_conflict="as_of_date")
    log.info(
        "[LeadTime] FBA=%sd (n=%s) optimized=%sd (n=%s) AWD=%sd (n=%s)",
        fba_med, fba_n, opt_med, opt_n, awd_med, awd_n,
    )
    return row
