"""Sync FBA inbound shipments for measured warehouse → FBA lead time."""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from statistics import median

import httpx

from src.amazon_sp.client import BASE_URL, SPAPIError, _headers, _marketplace_id
from src.db import fetch_all, upsert_rows

log = logging.getLogger(__name__)

INBOUND_PATH = "/fba/inbound/v0"
CLOSED_STATUSES = frozenset({"CLOSED", "RECEIVING", "DELIVERED", "CHECKED_IN"})


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        s = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _get_shipments_page(
    last_updated_after: datetime,
    last_updated_before: datetime | None,
    next_token: str | None,
) -> dict:
    params: dict = {
        "QueryType": "DATE_RANGE",
        "MarketplaceId": _marketplace_id(),
        "LastUpdatedAfter": last_updated_after.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if last_updated_before:
        params["LastUpdatedBefore"] = last_updated_before.strftime("%Y-%m-%dT%H:%M:%SZ")
    if next_token:
        params["NextToken"] = next_token

    resp = httpx.get(
        f"{BASE_URL}{INBOUND_PATH}/shipments",
        headers=_headers(),
        params=params,
        timeout=60,
    )
    if resp.status_code != 200:
        raise SPAPIError(
            f"Inbound getShipments failed ({resp.status_code}): {resp.text[:400]}"
        )
    payload = resp.json().get("payload") or resp.json()
    return payload


def _get_shipment_items(shipment_id: str) -> list[dict]:
    resp = httpx.get(
        f"{BASE_URL}{INBOUND_PATH}/shipments/{shipment_id}/items",
        headers=_headers(),
        timeout=60,
    )
    if resp.status_code != 200:
        log.warning("Inbound items %s: %s", shipment_id, resp.status_code)
        return []
    payload = resp.json().get("payload") or resp.json()
    data = payload.get("ItemData") or payload.get("items") or []
    return data if isinstance(data, list) else []


def sync_inbound_shipments(days_back: int = 180, dry_run: bool = False) -> dict:
    """Pull recent inbound shipments + item quantities; compute receive_days."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days_back)
    shipments: list[dict] = []
    items: list[dict] = []
    next_token: str | None = None

    while True:
        page = _get_shipments_page(start, now, next_token)
        data = page.get("ShipmentData") or []
        shipments.extend(data)
        next_token = page.get("NextToken")
        if not next_token:
            break

    ship_rows: list[dict] = []
    item_rows: list[dict] = []

    for sh in shipments:
        sid = sh.get("ShipmentId") or sh.get("shipmentId")
        if not sid:
            continue
        status = (sh.get("ShipmentStatus") or sh.get("shipmentStatus") or "").upper()
        dest = sh.get("DestinationFulfillmentCenterId") or sh.get("destinationFulfillmentCenterId")
        created = _parse_ts(sh.get("CreatedDate") or sh.get("createdDate"))
        updated = _parse_ts(
            sh.get("LastUpdatedDate") or sh.get("lastUpdatedDate")
            or sh.get("UpdatedDate"),
        )

        sh_items = _get_shipment_items(sid)
        shipped = 0
        received = 0
        for it in sh_items:
            sku = (it.get("SellerSKU") or it.get("sellerSKU") or it.get("FulfillmentNetworkSKU") or "").strip()
            if not sku:
                continue
            qs = int(it.get("QuantityShipped") or it.get("quantityShipped") or 0)
            qr = int(it.get("QuantityReceived") or it.get("quantityReceived") or 0)
            shipped += qs
            received += qr
            item_rows.append({
                "shipment_id": sid,
                "sku": sku,
                "quantity_shipped": qs,
                "quantity_received": qr,
            })

        closed_at = updated if status == "CLOSED" else None
        receive_days: int | None = None
        if created and closed_at and status == "CLOSED":
            receive_days = max((closed_at.date() - created.date()).days, 0)
        elif created and status in CLOSED_STATUSES and updated:
            receive_days = max((updated.date() - created.date()).days, 0)

        ship_rows.append({
            "shipment_id": sid,
            "shipment_status": status,
            "destination_fc": dest,
            "units_shipped": shipped,
            "units_received": received,
            "created_at": created.isoformat() if created else None,
            "closed_at": closed_at.isoformat() if closed_at else None,
            "receive_days": receive_days,
            "last_updated_at": updated.isoformat() if updated else None,
            "raw": sh,
        })

    result = {
        "shipments_found": len(ship_rows),
        "items_found": len(item_rows),
        "rows_upserted": 0,
        "dry_run": dry_run,
    }
    if dry_run or not ship_rows:
        return result

    result["rows_upserted"] = upsert_rows(
        "inventory_inbound_shipments", ship_rows, on_conflict="shipment_id",
    )
    if item_rows:
        upsert_rows(
            "inventory_inbound_shipment_items", item_rows,
            on_conflict="shipment_id,sku",
        )
    return result


def median_receive_days(limit: int = 5, sku: str | None = None) -> tuple[int | None, int]:
    """Median receive_days from last N closed shipments (optionally containing sku)."""
    try:
        if sku:
            links = fetch_all("inventory_inbound_shipment_items")
            ship_ids = {
                r["shipment_id"] for r in links
                if r.get("sku") == sku and int(r.get("quantity_shipped", 0) or 0) > 0
            }
            ships = [
                r for r in fetch_all("inventory_inbound_shipments")
                if r.get("shipment_id") in ship_ids
            ]
        else:
            ships = fetch_all("inventory_inbound_shipments")
    except Exception:
        return None, 0

    vals: list[int] = []
    for s in sorted(
        ships,
        key=lambda r: r.get("closed_at") or r.get("last_updated_at") or "",
        reverse=True,
    ):
        if (s.get("shipment_status") or "").upper() != "CLOSED":
            continue
        rd = s.get("receive_days")
        if rd is None:
            continue
        try:
            d = int(rd)
        except (TypeError, ValueError):
            continue
        if d >= 0:
            vals.append(d)
        if len(vals) >= limit:
            break
    if not vals:
        return None, 0
    return int(median(vals)), len(vals)
