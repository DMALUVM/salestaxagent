"""Sync FBA inbound shipments for measured ship → receive lead time."""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from statistics import median

import httpx

from src.amazon_sp.client import BASE_URL, SPAPIError, _headers, _marketplace_id
from src.db import fetch_all, upsert_rows
from src.inventory.shipment_timing import (
    CLOSED_STATUSES,
    compute_receive_days,
    ledger_receipt_dates,
    parse_ts,
    transport_shipped_date,
    update_received_at,
    update_shipped_at,
)

log = logging.getLogger(__name__)

INBOUND_PATH = "/fba/inbound/v0"
TRANSPORT_FETCH_LIMIT = 25

SHIPMENT_STATUSES = (
    "WORKING",
    "SHIPPED",
    "RECEIVING",
    "CLOSED",
    "IN_TRANSIT",
    "DELIVERED",
    "CHECKED_IN",
    "CANCELLED",
    "ERROR",
)


def _shipments_query_params(
    last_updated_after: datetime,
    last_updated_before: datetime | None,
    next_token: str | None,
) -> list[tuple[str, str]]:
    """Build getShipments query params.

    Amazon requires ShipmentStatusList even for DATE_RANGE queries (API quirk).
    Pagination uses QueryType=NEXT_TOKEN.
    """
    if next_token:
        return [
            ("QueryType", "NEXT_TOKEN"),
            ("MarketplaceId", _marketplace_id()),
            ("NextToken", next_token),
        ]

    params: list[tuple[str, str]] = [
        ("QueryType", "DATE_RANGE"),
        ("MarketplaceId", _marketplace_id()),
        ("LastUpdatedAfter", last_updated_after.strftime("%Y-%m-%dT%H:%M:%SZ")),
    ]
    if last_updated_before:
        params.append(
            ("LastUpdatedBefore", last_updated_before.strftime("%Y-%m-%dT%H:%M:%SZ")),
        )
    for status in SHIPMENT_STATUSES:
        params.append(("ShipmentStatusList", status))
    return params


def _get_shipments_page(
    last_updated_after: datetime,
    last_updated_before: datetime | None,
    next_token: str | None,
) -> dict:
    params = _shipments_query_params(last_updated_after, last_updated_before, next_token)

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


def _get_transport_details(shipment_id: str) -> dict | None:
    resp = httpx.get(
        f"{BASE_URL}{INBOUND_PATH}/shipments/{shipment_id}/transport",
        headers=_headers(),
        timeout=60,
    )
    if resp.status_code != 200:
        return None
    body = resp.json()
    return body.get("payload") or body


def _existing_by_id() -> dict[str, dict]:
    try:
        rows = fetch_all("inventory_inbound_shipments")
    except Exception:
        return {}
    return {r["shipment_id"]: r for r in rows if r.get("shipment_id")}


def sync_inbound_shipments(days_back: int = 180, dry_run: bool = False) -> dict:
    """Pull inbound shipments; measure ship → receive / Prime-eligible days."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days_back)
    existing = _existing_by_id()
    transport_budget = TRANSPORT_FETCH_LIMIT

    shipments: list[dict] = []
    next_token: str | None = None
    while True:
        page = _get_shipments_page(start, now, next_token)
        shipments.extend(page.get("ShipmentData") or [])
        next_token = page.get("NextToken")
        if not next_token:
            break

    ship_rows: list[dict] = []
    item_rows: list[dict] = []
    shipment_skus: dict[str, list[str]] = {}

    for sh in shipments:
        sid = sh.get("ShipmentId") or sh.get("shipmentId")
        if not sid:
            continue
        status = (sh.get("ShipmentStatus") or sh.get("shipmentStatus") or "").upper()
        dest = sh.get("DestinationFulfillmentCenterId") or sh.get("destinationFulfillmentCenterId")
        created = parse_ts(sh.get("CreatedDate") or sh.get("createdDate"))
        updated = parse_ts(
            sh.get("LastUpdatedDate") or sh.get("lastUpdatedDate") or sh.get("UpdatedDate"),
        )

        sh_items = _get_shipment_items(sid)
        shipped = 0
        received = 0
        skus: list[str] = []
        for it in sh_items:
            sku = (it.get("SellerSKU") or it.get("sellerSKU") or it.get("FulfillmentNetworkSKU") or "").strip()
            if not sku:
                continue
            skus.append(sku)
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
        shipment_skus[sid] = skus

        prev = existing.get(sid)
        transport_dt = None
        if not parse_ts((prev or {}).get("shipped_at")) and transport_budget > 0:
            if status in CLOSED_STATUSES or status in {"SHIPPED", "RECEIVING", "IN_TRANSIT", "DELIVERED"}:
                transport_payload = _get_transport_details(sid)
                transport_dt = transport_shipped_date(transport_payload)
                transport_budget -= 1

        shipped_at = update_shipped_at(prev, status, updated, created, transport_dt)
        if shipped_at is None and prev:
            shipped_at = parse_ts(prev.get("shipped_at"))

        closed_at = updated if status == "CLOSED" else parse_ts((prev or {}).get("closed_at"))
        if status == "CLOSED" and updated:
            closed_at = updated

        received_at = update_received_at(prev, status, updated, closed_at, received)
        if received_at is None and prev:
            received_at = parse_ts(prev.get("received_at"))

        prime_eligible_at = parse_ts((prev or {}).get("prime_eligible_at"))
        window_start = (shipped_at or created or start).date() if (shipped_at or created) else None
        window_end = (closed_at or updated or now).date() if (closed_at or updated) else None
        if window_start and dest and skus:
            ledger_recv, ledger_sellable = ledger_receipt_dates(
                skus, dest, window_start, window_end,
            )
            if ledger_recv and (received_at is None or ledger_recv < received_at):
                received_at = ledger_recv
            if ledger_sellable:
                prime_eligible_at = ledger_sellable if (
                    prime_eligible_at is None or ledger_sellable < prime_eligible_at
                ) else prime_eligible_at

        receive_days, receive_basis = compute_receive_days(
            shipped_at, received_at, prime_eligible_at, closed_at, created,
        )

        ship_rows.append({
            "shipment_id": sid,
            "shipment_status": status,
            "destination_fc": dest,
            "units_shipped": shipped,
            "units_received": received,
            "created_at": created.isoformat() if created else None,
            "shipped_at": shipped_at.isoformat() if shipped_at else None,
            "received_at": received_at.isoformat() if received_at else None,
            "prime_eligible_at": prime_eligible_at.isoformat() if prime_eligible_at else None,
            "closed_at": closed_at.isoformat() if closed_at else None,
            "receive_days": receive_days,
            "receive_days_basis": receive_basis,
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
    """Median ship→receive days from last N closed shipments."""
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
        key=lambda r: r.get("closed_at") or r.get("received_at") or r.get("last_updated_at") or "",
        reverse=True,
    ):
        if (s.get("shipment_status") or "").upper() != "CLOSED":
            continue
        basis = (s.get("receive_days_basis") or "").lower()
        if basis == "created_to_closed_fallback":
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
