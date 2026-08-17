"""Ship Sidekick API client.

Endpoint: GET /api/v1/inventory-levels
Auth:     Authorization: Bearer {SHIPSIDEKICK_API_KEY}
Base URL: SHIPSIDEKICK_BASE_URL (default https://www.shipsidekick.com)

Pagination is cursor-based: response has hasMore + nextCursor.
"""
from __future__ import annotations

import json
import logging

import httpx

from src.config import settings
from src.db import upsert_rows, log_ingestion

log = logging.getLogger(__name__)


class ShipSidekickError(Exception):
    """Ship Sidekick API error."""


def _base_url() -> str:
    return getattr(settings, "shipsidekick_base_url", "") or "https://www.shipsidekick.com"


def _api_key() -> str:
    key = getattr(settings, "shipsidekick_api_key", "") or ""
    if not key:
        raise ShipSidekickError(
            "SHIPSIDEKICK_API_KEY not set in .env"
        )
    return key


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_api_key()}",
        "Content-Type": "application/json",
    }


def get_inventory() -> list[dict]:
    """Fetch all inventory levels from Ship Sidekick.

    Returns list of {sku, product_name, available, committed, reserved,
    incoming, damaged, warehouse, warehouse_id, raw}.

    Filters out:
    - Items with no SKU
    - Digital products (requiresShipping=false) — gift cards, bundles
    - Deduplicates by SKU (keeps highest available qty)
    """
    base = _base_url()
    headers = _headers()
    all_items: list[dict] = []
    cursor: str | None = None

    while True:
        params: dict[str, str] = {}
        if cursor:
            params["cursor"] = cursor

        resp = httpx.get(
            f"{base}/api/v1/inventory-levels",
            headers=headers,
            params=params,
            timeout=30,
        )

        if resp.status_code != 200:
            raise ShipSidekickError(
                f"inventory-levels failed ({resp.status_code}): "
                f"{resp.text[:500]}"
            )

        body = resp.json()
        items = body.get("data", [])
        all_items.extend(items)

        if not body.get("hasMore"):
            break
        cursor = body.get("nextCursor")
        if not cursor:
            break

    # Parse and filter
    results: list[dict] = []
    seen_skus: dict[str, dict] = {}

    for item in all_items:
        variant = item.get("productVariant") or {}
        sku = (variant.get("sku") or "").strip()
        if not sku:
            continue

        # Skip digital / non-physical products
        if not variant.get("requiresShipping", True):
            continue

        warehouse = item.get("warehouse") or {}
        wh_name = warehouse.get("name") if isinstance(warehouse, dict) else None

        entry = {
            "sku": sku,
            "product_name": (variant.get("title") or "")[:200],
            "available": int(item.get("availableQuantity", 0) or 0),
            "committed": int(item.get("committedQuantity", 0) or 0),
            "reserved": int(item.get("reservedQuantity", 0) or 0),
            "incoming": int(item.get("incomingQuantity", 0) or 0),
            "damaged": int(item.get("damagedQuantity", 0) or 0),
            "warehouse": wh_name,
            "warehouse_id": item.get("warehouseId"),
            "raw": json.dumps({
                k: v for k, v in item.items()
                if k != "productVariant" and v
            }),
        }

        # Deduplicate: keep entry with highest available for each SKU
        if sku in seen_skus:
            if entry["available"] > seen_skus[sku]["available"]:
                seen_skus[sku] = entry
        else:
            seen_skus[sku] = entry

    return list(seen_skus.values())


def sync_3pl(dry_run: bool = False) -> dict:
    """Fetch Ship Sidekick inventory and upsert to inventory_3pl_snapshots.

    Returns summary dict.
    """
    items = get_inventory()

    rows = [
        {
            "sku": item["sku"],
            "product_name": item["product_name"],
            "available": item["available"],
            "committed": item["committed"],
            "reserved": item["reserved"],
            "incoming": item["incoming"],
            "damaged": item["damaged"],
            "warehouse": item["warehouse"],
            "raw": item["raw"],
        }
        for item in items
    ]

    result = {
        "source": "shipsidekick",
        "rows_total": len(rows),
        "rows_inserted": 0,
        "dry_run": dry_run,
        "skus": [r["sku"] for r in rows],
    }

    if not dry_run and rows:
        result["rows_inserted"] = upsert_rows(
            "inventory_3pl_snapshots", rows, on_conflict="sku",
        )
        log_ingestion(
            filename="shipsidekick_inventory",
            file_type="other",
            rows_total=len(rows),
            rows_inserted=result["rows_inserted"],
        )

    return result
