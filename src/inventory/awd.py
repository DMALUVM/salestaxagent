"""AWD (Amazon Warehousing & Distribution) inventory sync.

Endpoint: GET /awd/2024-05-09/inventory
Returns per-SKU: totalOnhandQuantity, totalInboundQuantity
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from src.inventory.awd_client import awd_get
from src.db import upsert_rows, log_ingestion
from src.inventory.freshness import skip_empty

log = logging.getLogger(__name__)

AWD_PATH = "/inventory"


def fetch_awd_inventory(dry_run: bool = False) -> dict:
    """Fetch AWD inventory and upsert to inventory_awd."""
    all_items: list[dict] = []
    next_token: str | None = None

    while True:
        params: dict[str, str] = {"details": "SHOW"}
        if next_token:
            params["nextToken"] = next_token

        body = awd_get(AWD_PATH, params=params, timeout=30)
        items = body.get("inventory") or []
        all_items.extend(items)

        next_token = body.get("nextToken")
        if not next_token:
            break

    rows = _awd_inventory_rows(all_items)

    result = {"rows_total": len(rows), "rows_inserted": 0, "dry_run": dry_run}
    if not rows:
        result.update(skip_empty("amazon returned 0 AWD inventory rows"))

    if not dry_run and rows:
        result["rows_inserted"] = upsert_rows(
            "inventory_awd", rows, on_conflict="sku",
        )
        log_ingestion(
            filename="awd_inventory",
            file_type="amazon_inventory",
            rows_total=len(rows),
            rows_inserted=result["rows_inserted"],
        )

    return result


def _awd_inventory_rows(
    all_items: list[dict],
    pulled_at: str | datetime | None = None,
) -> list[dict]:
    """Build inventory_awd rows, always stamping pulled_at.

    Upsert-on-sku would otherwise leave pulled_at frozen at first insert
    while inventory-sync reports success.
    """
    stamp = (
        pulled_at.isoformat() if isinstance(pulled_at, datetime)
        else pulled_at
    ) or datetime.now(timezone.utc).isoformat()
    rows = []
    for item in all_items:
        sku = item.get("sku", "")
        if not sku:
            continue
        summary = item.get("inventoryDetails") or item.get("inventorySummary") or item
        on_hand = int(
            item.get("totalOnhandQuantity")
            or summary.get("totalOnhandQuantity")
            or summary.get("availableDistributableQuantity")
            or 0,
        )
        inbound = int(
            item.get("totalInboundQuantity")
            or summary.get("totalInboundQuantity")
            or 0,
        )
        to_fba = int(summary.get("replenishmentQuantity") or 0)
        rows.append({
            "sku": sku,
            "awd_on_hand": on_hand,
            "awd_inbound": inbound,
            "awd_to_fba_in_transit": to_fba,
            "pulled_at": stamp,
        })
    return rows
