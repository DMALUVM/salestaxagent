"""Sync AWD replenishment orders and measure AWD → FBA (Prime-eligible) lead time."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from statistics import median

from src.db import fetch_all, upsert_rows
from src.inventory.awd_client import awd_get
from src.amazon_sp.client import SPAPIError

log = logging.getLogger(__name__)

SUCCESS_STATUSES = frozenset({"SUCCESS", "INVENTORY_OUTBOUND", "CONFIRMED", "EXECUTING"})


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _list_orders_page(
    updated_after: datetime,
    next_token: str | None,
    max_results: int = 100,
) -> dict:
    params: dict = {
        "updatedAfter": updated_after.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "maxResults": max_results,
        "sortOrder": "DESCENDING",
    }
    if next_token:
        params["nextToken"] = next_token
    return awd_get("/replenishmentOrders", params=params)


def _get_order(order_id: str) -> dict | None:
    try:
        body = awd_get(f"/replenishmentOrders/{order_id}")
    except SPAPIError as e:
        if "404" in str(e):
            return None
        if "429" in str(e):
            log.warning("AWD getReplenishmentOrder %s: quota exceeded, using list summary", order_id)
            return None
        log.warning("AWD getReplenishmentOrder %s: %s", order_id, e)
        return None
    except Exception as e:
        log.warning("AWD getReplenishmentOrder %s: %s", order_id, e)
        return None
    return body.get("order") or body


def _needs_order_detail(summary: dict) -> bool:
    """Fetch detail only when list payload lacks fields needed for lead time."""
    status = (summary.get("status") or "").upper()
    if status != "SUCCESS":
        return False
    outbound = summary.get("outboundShipments") or []
    if not outbound:
        return True
    if summary.get("shippedProducts") or summary.get("products"):
        for ob in outbound:
            sid = str(ob.get("shipmentId") or ob.get("shipment_id") or "")
            if sid.startswith("FBA"):
                return False
        return True
    return True


def _fba_shipments_by_id() -> dict[str, dict]:
    try:
        ships = fetch_all("inventory_inbound_shipments")
    except Exception:
        return {}
    by_id: dict[str, dict] = {}
    for s in ships:
        sid = s.get("shipment_id")
        if sid:
            by_id[sid] = s
        raw = s.get("raw") or {}
        if not isinstance(raw, dict):
            continue
        for key in ("shipmentConfirmationId", "internalShipmentId"):
            alt = raw.get(key)
            if alt:
                by_id[str(alt)] = s
        inner = raw.get("shipment") or {}
        if isinstance(inner, dict):
            confirm = inner.get("shipmentConfirmationId")
            if confirm:
                by_id[str(confirm)] = s
    return by_id


def _products_from_order(order: dict, key: str) -> list[dict]:
    items = order.get(key) or []
    rows: list[dict] = []
    for p in items:
        sku = (p.get("sku") or "").strip()
        if not sku:
            continue
        rows.append({
            "sku": sku,
            "quantity": int(p.get("quantity", 0) or 0),
        })
    return rows


def _compute_replenish_days(
    order: dict,
    fba_by_id: dict[str, dict],
) -> tuple[int | None, str]:
    """AWD outbound ship → FBA received / Prime-eligible (via linked inbound shipment)."""
    outbound = order.get("outboundShipments") or []
    shipped_dates: list[datetime] = []
    end_dates: list[datetime] = []
    end_prime: list[datetime] = []

    for ob in outbound:
        ob_status = (ob.get("shipmentStatus") or "").upper()
        ob_shipped = _parse_ts(ob.get("updatedAt") or ob.get("createdAt"))
        if ob_status in {"IN_TRANSIT", "DELIVERED", "RECEIVING", "RECEIVED", "CLOSED"} and ob_shipped:
            shipped_dates.append(ob_shipped)

        sid = ob.get("shipmentId") or ob.get("shipment_id") or ob.get("shipmentConfirmationId")
        if not sid:
            continue
        fba = fba_by_id.get(sid)
        if not fba:
            continue
        fba_shipped = _parse_ts(fba.get("shipped_at"))
        if fba_shipped:
            shipped_dates.append(fba_shipped)
        recv = _parse_ts(fba.get("prime_eligible_at") or fba.get("received_at") or fba.get("closed_at"))
        if recv:
            end_dates.append(recv)
        prime = _parse_ts(fba.get("prime_eligible_at"))
        if prime:
            end_prime.append(prime)

    start = min(shipped_dates) if shipped_dates else _parse_ts(order.get("confirmedOn") or order.get("createdAt"))
    if not start:
        return None, "unknown"

    if end_prime:
        end = max(end_prime)
        return max((end.date() - start.date()).days, 0), "shipped_to_prime"
    if end_dates:
        end = max(end_dates)
        return max((end.date() - start.date()).days, 0), "shipped_to_received"

    status = (order.get("status") or "").upper()
    if status == "SUCCESS":
        end = _parse_ts(order.get("updatedAt"))
        if end:
            return max((end.date() - start.date()).days, 0), "confirm_to_success_fallback"
    return None, "unknown"


def sync_awd_replenishments(days_back: int = 180, dry_run: bool = False) -> dict:
    """Pull AWD replenishment orders and compute measured AWD→FBA lead times."""
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=days_back)
    fba_by_id = _fba_shipments_by_id()

    orders: list[dict] = []
    next_token: str | None = None
    while True:
        page = _list_orders_page(start, next_token)
        orders.extend(page.get("orders") or [])
        next_token = page.get("nextToken")
        if not next_token:
            break

    order_rows: list[dict] = []
    item_rows: list[dict] = []
    detail_fetched = 0
    detail_skipped = 0

    for summary in orders:
        oid = summary.get("orderId") or summary.get("order_id")
        if not oid:
            continue
        if _needs_order_detail(summary):
            detail = _get_order(oid) or summary
            detail_fetched += 1
        else:
            detail = summary
            detail_skipped += 1
        status = (detail.get("status") or "").upper()
        confirmed = _parse_ts(detail.get("confirmedOn"))
        created = _parse_ts(detail.get("createdAt"))
        updated = _parse_ts(detail.get("updatedAt"))

        outbound = detail.get("outboundShipments") or []
        outbound_ids = [
            ob.get("shipmentId") or ob.get("shipment_id")
            for ob in outbound
            if ob.get("shipmentId") or ob.get("shipment_id")
        ]

        shipped = _products_from_order(detail, "shippedProducts")
        requested = _products_from_order(detail, "products")
        products = shipped or requested

        units_requested = sum(p["quantity"] for p in requested)
        units_shipped = sum(p["quantity"] for p in shipped)

        replenish_days, replenish_basis = _compute_replenish_days(detail, fba_by_id)

        earliest_ship = None
        for ob in outbound:
            sid = ob.get("shipmentId") or ob.get("shipment_id") or ob.get("shipmentConfirmationId")
            fba = fba_by_id.get(sid) if sid else None
            for cand in (
                fba.get("shipped_at") if fba else None,
                ob.get("updatedAt"),
                ob.get("createdAt"),
            ):
                dt = _parse_ts(cand)
                if dt and (earliest_ship is None or dt < earliest_ship):
                    earliest_ship = dt

        order_rows.append({
            "order_id": oid,
            "order_status": status,
            "created_at": created.isoformat() if created else None,
            "confirmed_at": confirmed.isoformat() if confirmed else None,
            "shipped_at": earliest_ship.isoformat() if earliest_ship else None,
            "completed_at": updated.isoformat() if status == "SUCCESS" and updated else None,
            "replenish_days": replenish_days,
            "replenish_days_basis": replenish_basis,
            "outbound_shipment_ids": outbound_ids,
            "outbound_fc_count": len(outbound_ids),
            "units_requested": units_requested,
            "units_shipped": units_shipped,
            "raw": detail,
        })

        seen_skus: set[str] = set()
        for p in products:
            sku = p["sku"]
            if sku in seen_skus:
                continue
            seen_skus.add(sku)
            req = next((x["quantity"] for x in requested if x["sku"] == sku), 0)
            shp = next((x["quantity"] for x in shipped if x["sku"] == sku), 0)
            item_rows.append({
                "order_id": oid,
                "sku": sku,
                "quantity_requested": req,
                "quantity_shipped": shp,
            })

    result = {
        "orders_found": len(order_rows),
        "items_found": len(item_rows),
        "rows_upserted": 0,
        "detail_fetched": detail_fetched,
        "detail_skipped": detail_skipped,
        "dry_run": dry_run,
    }
    if dry_run or not order_rows:
        return result

    result["rows_upserted"] = upsert_rows(
        "inventory_awd_replenishments", order_rows, on_conflict="order_id",
    )
    if item_rows:
        upsert_rows(
            "inventory_awd_replenishment_items", item_rows,
            on_conflict="order_id,sku",
        )
    return result


def median_replenish_days(limit: int = 5, sku: str | None = None) -> tuple[int | None, int]:
    """Median AWD→FBA days from last N completed replenishment orders."""
    try:
        if sku:
            links = fetch_all("inventory_awd_replenishment_items")
            order_ids = {
                r["order_id"] for r in links
                if r.get("sku") == sku and int(r.get("quantity_shipped", 0) or 0) > 0
            }
            orders = [
                r for r in fetch_all("inventory_awd_replenishments")
                if r.get("order_id") in order_ids
            ]
        else:
            orders = fetch_all("inventory_awd_replenishments")
    except Exception:
        return None, 0

    vals: list[int] = []
    for o in sorted(
        orders,
        key=lambda r: r.get("completed_at") or r.get("confirmed_at") or r.get("created_at") or "",
        reverse=True,
    ):
        if (o.get("order_status") or "").upper() != "SUCCESS":
            continue
        basis = (o.get("replenish_days_basis") or "").lower()
        if basis == "confirm_to_success_fallback":
            continue
        rd = o.get("replenish_days")
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
