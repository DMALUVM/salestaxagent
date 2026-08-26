"""Ship Sidekick API client.

Endpoint: GET /api/v1/inventory-levels
Auth:     Authorization: Bearer {SHIPSIDEKICK_API_KEY}
Base URL: SHIPSIDEKICK_BASE_URL (default https://www.shipsidekick.com)

Pagination is cursor-based: response has hasMore + nextCursor.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

import httpx

from src.config import settings
from src.db import fetch_all, upsert_rows, log_ingestion

log = logging.getLogger(__name__)


def _sku_key(sku: str | None) -> str:
    """Case-insensitive match key. Does not rewrite digits or collapse SKUs."""
    return (sku or "").strip().casefold()


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
    - Digital products (requiresShipping=false) with no quantity
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

    return _parse_inventory_items(all_items)


def _parse_inventory_items(all_items: list[dict]) -> list[dict]:
    """Parse inventory-levels payloads into snapshot items.

    SKU strings are stripped only — similar codes stay distinct (no digit
    collapse). Digital variants (requiresShipping=false) are skipped only
    when they have no quantity, so a bad shipping flag cannot hide
    in-stock rows.
    """
    seen_skus: dict[str, dict] = {}

    for item in all_items:
        variant = item.get("productVariant") or {}
        sku = (variant.get("sku") or item.get("sku") or "").strip()
        if not sku:
            continue

        available = int(item.get("availableQuantity", 0) or 0)
        committed = int(item.get("committedQuantity", 0) or 0)
        reserved = int(item.get("reservedQuantity", 0) or 0)
        incoming = int(item.get("incomingQuantity", 0) or 0)
        damaged = int(item.get("damagedQuantity", 0) or 0)
        qty_signal = available + committed + reserved + incoming + damaged

        if not variant.get("requiresShipping", True) and qty_signal <= 0:
            continue

        warehouse = item.get("warehouse") or {}
        wh_name = warehouse.get("name") if isinstance(warehouse, dict) else None

        entry = {
            "sku": sku,
            "product_name": (variant.get("title") or "")[:200],
            "available": available,
            "committed": committed,
            "reserved": reserved,
            "incoming": incoming,
            "damaged": damaged,
            "warehouse": wh_name,
            "warehouse_id": item.get("warehouseId"),
            "raw": json.dumps({
                k: v for k, v in item.items()
                if k != "productVariant" and v
            }),
        }

        key = _sku_key(sku)
        if key in seen_skus:
            if entry["available"] > seen_skus[key]["available"]:
                seen_skus[key] = entry
        else:
            seen_skus[key] = entry

    return list(seen_skus.values())


def _carry_forward_missing_instock(
    feed_items: list[dict],
    prior_rows: list[dict],
) -> list[dict]:
    """Re-attach every prior in-stock SKU omitted from this pull.

    Applies to every SKU already in inventory_3pl_snapshots. No named
    allowlist and no SKU-specific special case. Copies last observed
    quantities — does not invent stock. A SKU the feed reports at zero
    stays zero. Prior zeros are not carried.
    """
    feed_keys = {_sku_key(i.get("sku")) for i in feed_items if i.get("sku")}
    extra: list[dict] = []
    for row in prior_rows:
        sku = (row.get("sku") or "").strip()
        if not sku or _sku_key(sku) in feed_keys:
            continue
        available = int(row.get("available") or 0)
        incoming = int(row.get("incoming") or 0)
        if available <= 0 and incoming <= 0:
            continue
        extra.append({
            "sku": sku,
            "product_name": (row.get("product_name") or "")[:200],
            "available": available,
            "committed": int(row.get("committed") or 0),
            "reserved": int(row.get("reserved") or 0),
            "incoming": incoming,
            "damaged": int(row.get("damaged") or 0),
            "warehouse": row.get("warehouse"),
            "warehouse_id": None,
            "raw": json.dumps({
                "carried_forward": True,
                "prior_pulled_at": str(row.get("pulled_at") or ""),
                "available": available,
            }),
        })
        log.warning(
            "3PL feed omitted in-stock SKU %s (available=%s); carrying last known qty",
            sku,
            available,
        )
    return list(feed_items) + extra


def live_3pl_snapshots(rows: list[dict]) -> list[dict]:
    """Latest pulled_at cohort plus leftover in-stock SKUs.

    Applies to every SKU in inventory_3pl_snapshots — no named allowlist.
    Upsert-only sync leaves omitted SKUs at their old pulled_at. Treating
    max(pulled_at) as the sole live snapshot hides leftover stock. Keep older
    rows with available/incoming > 0 that are absent from the latest
    cohort. Do not invent quantities.
    """
    if not rows:
        return []
    latest = ""
    for row in rows:
        pulled = str(row.get("pulled_at") or "")
        if pulled > latest:
            latest = pulled
    latest_keys = {
        _sku_key(row.get("sku"))
        for row in rows
        if str(row.get("pulled_at") or "") == latest
    }
    live: list[dict] = []
    for row in rows:
        if str(row.get("pulled_at") or "") == latest:
            live.append(row)
            continue
        available = int(row.get("available") or 0)
        incoming = int(row.get("incoming") or 0)
        if (available > 0 or incoming > 0) and _sku_key(row.get("sku")) not in latest_keys:
            live.append(row)
    return live


def _snapshot_rows(items: list[dict], pulled_at: str | None = None) -> list[dict]:
    """Build inventory_3pl_snapshots rows, always stamping pulled_at.

    Postgres DEFAULT now() applies on INSERT only. Upsert-on-sku would
    otherwise leave pulled_at frozen at first insert, so monitors can show
    a stale snapshot while the 3PL job reports success.
    """
    stamp = pulled_at or datetime.now(timezone.utc).isoformat()
    return [
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
            "pulled_at": stamp,
        }
        for item in items
    ]


def sync_3pl(dry_run: bool = False) -> dict:
    """Fetch Ship Sidekick inventory and upsert to inventory_3pl_snapshots.

    Returns summary dict.
    """
    items = get_inventory()
    prior: list[dict] = []
    try:
        prior = fetch_all("inventory_3pl_snapshots")
    except Exception as exc:
        log.warning("Could not load prior 3PL snapshots for carry-forward: %s", exc)

    feed_keys = {_sku_key(i.get("sku")) for i in items if i.get("sku")}
    items = _carry_forward_missing_instock(items, prior)
    rows = _snapshot_rows(items)

    result = {
        "source": "shipsidekick",
        "rows_total": len(rows),
        "rows_inserted": 0,
        "dry_run": dry_run,
        "skus": [r["sku"] for r in rows],
        "carried_forward": [
            i["sku"] for i in items if _sku_key(i.get("sku")) not in feed_keys
        ],
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
