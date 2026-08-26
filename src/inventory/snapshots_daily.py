"""Append daily FBA inventory totals for implied-velocity calibration."""
from __future__ import annotations

import logging
from datetime import date

from src.db import upsert_rows
from src.inventory.freshness import stamp_now

log = logging.getLogger(__name__)


def fba_on_hand(row: dict) -> int:
    return sum(int(row.get(k, 0) or 0) for k in (
        "fulfillable", "reserved", "researching", "unfulfillable",
    ))


def inbound_total(row: dict) -> int:
    return sum(int(row.get(k, 0) or 0) for k in (
        "inbound_working", "inbound_shipped", "inbound_receiving",
    ))


def append_daily_snapshots(rows: list[dict], snapshot_date: date | None = None) -> dict:
    """Upsert one daily row per SKU from FBA summary sync output."""
    day = snapshot_date or date.today()
    daily: list[dict] = []
    for row in rows:
        sku = row.get("sku")
        if not sku:
            continue
        total = int(row.get("total_quantity", 0) or 0)
        fba = fba_on_hand(row)
        if total <= 0 and fba > 0:
            total = fba + inbound_total(row)
        daily.append({
            "sku": sku,
            "snapshot_date": day.isoformat(),
            "total_quantity": total,
            "fba_on_hand": fba,
            "inbound_total": inbound_total(row),
            "fulfillable": int(row.get("fulfillable", 0) or 0),
        })
    if not daily:
        return {"rows": 0, "snapshot_date": day.isoformat()}
    stamp_now(daily, "recorded_at")
    n = upsert_rows("inventory_snapshots_daily", daily, on_conflict="sku,snapshot_date")
    log.info("[SnapshotsDaily] %d SKUs for %s", n, day)
    return {"rows": n, "snapshot_date": day.isoformat()}
