"""Sync AWD inbound shipments (warehouse → AWD) with ship→receive timing."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from statistics import median

from src.db import fetch_all, upsert_rows
from src.inventory.awd_client import awd_get
from src.inventory.shipment_timing import (
    compute_receive_days,
    parse_ts,
    update_received_at,
    update_shipped_at,
)

log = logging.getLogger(__name__)

AWD_INBOUND_CLOSED = frozenset({"CLOSED", "DELIVERED", "RECEIVING"})


def _existing_by_id() -> dict[str, dict]:
    try:
        rows = fetch_all("inventory_awd_inbound_shipments")
    except Exception:
        return {}
    return {r["shipment_id"]: r for r in rows if r.get("shipment_id")}


def sync_awd_inbound_shipments(days_back: int = 180, dry_run: bool = False) -> dict:
    """Pull AWD inbound shipments; measure warehouse ship → AWD received."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days_back)
    existing = _existing_by_id()

    shipments: list[dict] = []
    next_token: str | None = None
    while True:
        params: dict = {
            "updatedAfter": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "maxResults": 100,
            "sortOrder": "DESCENDING",
        }
        if next_token:
            params["nextToken"] = next_token
        page = awd_get("/inboundShipments", params=params)
        shipments.extend(page.get("shipments") or [])
        next_token = page.get("nextToken")
        if not next_token:
            break

    rows: list[dict] = []
    for sh in shipments:
        sid = sh.get("shipmentId") or sh.get("shipment_id")
        if not sid:
            continue
        status = (sh.get("shipmentStatus") or sh.get("shipment_status") or "").upper()
        updated = parse_ts(sh.get("updatedAt") or sh.get("updated_at"))
        created = parse_ts(sh.get("createdAt") or sh.get("created_at"))

        prev = existing.get(sid)
        shipped_at = update_shipped_at(prev, status, updated, created, None)
        if shipped_at is None and prev:
            shipped_at = parse_ts(prev.get("shipped_at"))

        closed_at = updated if status == "CLOSED" else parse_ts((prev or {}).get("closed_at"))
        if status == "CLOSED" and updated:
            closed_at = updated

        received_at = update_received_at(prev, status, updated, closed_at, 1 if status in AWD_INBOUND_CLOSED else 0)
        if received_at is None and prev:
            received_at = parse_ts(prev.get("received_at"))

        receive_days, receive_basis = compute_receive_days(
            shipped_at, received_at, None, closed_at, created,
        )

        rows.append({
            "shipment_id": sid,
            "order_id": sh.get("orderId") or sh.get("order_id"),
            "shipment_status": status,
            "created_at": created.isoformat() if created else None,
            "shipped_at": shipped_at.isoformat() if shipped_at else None,
            "received_at": received_at.isoformat() if received_at else None,
            "closed_at": closed_at.isoformat() if closed_at else None,
            "receive_days": receive_days,
            "receive_days_basis": receive_basis,
            "last_updated_at": updated.isoformat() if updated else None,
            "raw": sh,
        })

    result = {
        "shipments_found": len(rows),
        "rows_upserted": 0,
        "dry_run": dry_run,
    }
    if dry_run or not rows:
        return result

    result["rows_upserted"] = upsert_rows(
        "inventory_awd_inbound_shipments", rows, on_conflict="shipment_id",
    )
    return result


def median_awd_inbound_days(limit: int = 5) -> tuple[int | None, int]:
    """Median warehouse→AWD receive days from closed inbound shipments."""
    try:
        ships = fetch_all("inventory_awd_inbound_shipments")
    except Exception:
        return None, 0

    vals: list[int] = []
    for s in sorted(
        ships,
        key=lambda r: r.get("closed_at") or r.get("received_at") or "",
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
