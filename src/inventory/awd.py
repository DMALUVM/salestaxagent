"""AWD (Amazon Warehousing & Distribution) inventory sync.

Endpoint: GET /awd/2024-05-09/inventory
Returns per-SKU: totalOnhandQuantity, totalInboundQuantity
"""
from __future__ import annotations

import logging

import httpx

from src.amazon_sp.client import _headers, _marketplace_id, BASE_URL, SPAPIError
from src.db import upsert_rows, log_ingestion

log = logging.getLogger(__name__)

AWD_PATH = "/awd/2024-05-09/inventory"


def fetch_awd_inventory(dry_run: bool = False) -> dict:
    """Fetch AWD inventory and upsert to inventory_awd."""
    all_items: list[dict] = []
    next_token: str | None = None

    while True:
        params: dict[str, str] = {}
        if next_token:
            params["nextToken"] = next_token

        resp = httpx.get(
            f"{BASE_URL}{AWD_PATH}",
            headers=_headers(),
            params=params,
            timeout=30,
        )

        if resp.status_code != 200:
            raise SPAPIError(
                f"AWD inventory failed ({resp.status_code}): "
                f"{resp.text[:500]}"
            )

        body = resp.json()
        items = body.get("inventory", [])
        all_items.extend(items)

        next_token = body.get("nextToken")
        if not next_token:
            break

    rows = []
    for item in all_items:
        sku = item.get("sku", "")
        if not sku:
            continue
        rows.append({
            "sku": sku,
            "awd_on_hand": int(item.get("totalOnhandQuantity", 0) or 0),
            "awd_inbound": int(item.get("totalInboundQuantity", 0) or 0),
        })

    result = {"rows_total": len(rows), "rows_inserted": 0, "dry_run": dry_run}

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
