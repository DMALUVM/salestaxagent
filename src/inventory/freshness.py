"""Stamp pull timestamps so inventory upserts cannot stay silently stale.

Postgres DEFAULT now() applies on INSERT only. A successful inventory_sync
that re-upserts the same sku / shipment_id without an explicit stamp leaves
2026-08-17 dates while job_runs.status=success.
"""
from __future__ import annotations

from datetime import datetime, timezone

# Table → column the daily job must refresh (or skip with a reason).
WAREHOUSE_STAMP_FIELDS: dict[str, str] = {
    "inventory_snapshots": "snapshot_at",
    "inventory_awd": "pulled_at",
    "inventory_restock": "pulled_at",
    "inventory_planning": "pulled_at",
    "inventory_awd_replenishments": "synced_at",
    "inventory_awd_replenishment_items": "synced_at",
    "inventory_inbound_shipments": "synced_at",
    "inventory_inbound_shipment_items": "synced_at",
    "inventory_awd_inbound_shipments": "synced_at",
    "inventory_3pl_snapshots": "pulled_at",
    "inventory_sku_signals": "updated_at",
    "inventory_leadtime_summary": "updated_at",
    "inventory_snapshots_daily": "recorded_at",
}


def stamp_now(
    rows: list[dict],
    field: str,
    now: datetime | None = None,
) -> list[dict]:
    """Set a freshness column on every row so upsert refreshes DEFAULT now()."""
    ts = (now or datetime.now(timezone.utc)).isoformat()
    for row in rows:
        row[field] = ts
    return rows


def skip_empty(reason: str) -> dict:
    """Explicit skip — never a silent stale leftover."""
    return {"skipped": True, "skip_reason": reason}


def collect_skip_reasons(results: dict) -> list[str]:
    """Pull skip_reason from sync_all / job step result dicts."""
    out: list[str] = []
    for name, payload in results.items():
        if name == "errors" or not isinstance(payload, dict):
            continue
        if payload.get("skipped") and payload.get("skip_reason"):
            out.append(f"{name}: {payload['skip_reason']}")
    return out
