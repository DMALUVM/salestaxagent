"""Sync AWD replenishment orders and measure AWD → FBA (Prime-eligible) lead time."""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta, timezone
from statistics import median

from src.db import fetch_all, upsert_rows
from src.inventory.awd_client import awd_get
from src.amazon_sp.client import SPAPIError

log = logging.getLogger(__name__)

SUCCESS_STATUSES = frozenset({"SUCCESS", "INVENTORY_OUTBOUND", "CONFIRMED", "EXECUTING"})
DETAIL_FETCH_LIMIT = 20
FBA_ID_RE = re.compile(r"^FBA[A-Z0-9]+$")


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
    """Fetch detail when list payload lacks FBA shipment links or SKU breakdown."""
    status = (summary.get("status") or "").upper()
    if status != "SUCCESS":
        return False
    outbound = summary.get("outboundShipments") or []
    if not outbound:
        return True
    has_fba = any(
        FBA_ID_RE.match(str(ob.get("shipmentConfirmationId") or ob.get("shipmentId") or ""))
        for ob in outbound
    )
    if has_fba and (summary.get("shippedProducts") or summary.get("products")):
        return False
    return True


def _ledger_any_fc_receipts(
    skus: list[str],
    start: datetime,
    window_days: int = 120,
) -> tuple[datetime | None, datetime | None]:
    """First receipt and first sellable receipt at any FC after start."""
    if not skus:
        return None, None
    try:
        events = fetch_all("inventory_events")
    except Exception:
        return None, None

    sku_set = {s.upper() for s in skus if s}
    end = start.date() + timedelta(days=window_days)
    first_recv: datetime | None = None
    first_sellable: datetime | None = None

    for ev in events:
        if (ev.get("sku") or "").upper() not in sku_set:
            continue
        ed = ev.get("event_date")
        if not ed:
            continue
        try:
            edate = date.fromisoformat(str(ed)[:10])
        except ValueError:
            continue
        if edate < start.date() or edate > end:
            continue
        et = (ev.get("event_type") or "").lower()
        if int(ev.get("quantity", 0) or 0) <= 0:
            continue
        if "receipt" not in et:
            continue
        ts = datetime.combine(edate, datetime.min.time(), tzinfo=timezone.utc)
        if first_recv is None or ts < first_recv:
            first_recv = ts
        disp = (ev.get("disposition") or "").lower()
        if "sellable" in disp or disp in {"", "sellable"}:
            if first_sellable is None or ts < first_sellable:
                first_sellable = ts

    return first_recv, first_sellable


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

    products = _products_from_order(order, "shippedProducts") or _products_from_order(order, "products")
    skus = [p["sku"] for p in products if p.get("sku")]
    if skus:
        ledger_recv, ledger_sellable = _ledger_any_fc_receipts(skus, start)
        if ledger_sellable:
            d = (ledger_sellable.date() - start.date()).days
            if d >= 2:
                return d, "ledger_shipped_to_sellable"
        if ledger_recv:
            d = (ledger_recv.date() - start.date()).days
            if d >= 2:
                return d, "ledger_shipped_to_received"

    status = (order.get("status") or "").upper()
    if status == "SUCCESS":
        end = _parse_ts(order.get("updatedAt"))
        if end:
            d = max((end.date() - start.date()).days, 0)
            if d >= 1:
                return d, "shipped_to_success"
            return d, "confirm_to_success_fallback"
    return None, "unknown"


def recompute_stored_replenish_days() -> dict:
    """Recompute lead times from stored AWD replenishment rows (no API calls)."""
    try:
        rows = fetch_all("inventory_awd_replenishments")
    except Exception:
        return {"rows": 0, "updated": 0}
    fba_by_id = _fba_shipments_by_id()
    updates: list[dict] = []
    for row in rows:
        raw = row.get("raw") if isinstance(row.get("raw"), dict) else {}
        order = dict(raw)
        if not order.get("status"):
            order["status"] = row.get("order_status")
        if not order.get("updatedAt") and row.get("completed_at"):
            order["updatedAt"] = row.get("completed_at")
        if not order.get("confirmedOn") and row.get("confirmed_at"):
            order["confirmedOn"] = row.get("confirmed_at")
        if not order.get("createdAt") and row.get("created_at"):
            order["createdAt"] = row.get("created_at")
        if row.get("shipped_at"):
            outbound = list(order.get("outboundShipments") or [])
            if outbound:
                outbound[0] = dict(outbound[0])
                outbound[0].setdefault("shipmentStatus", "IN_TRANSIT")
                outbound[0]["createdAt"] = row["shipped_at"]
                order["outboundShipments"] = outbound
        days, basis = _compute_replenish_days(order, fba_by_id)
        updates.append({
            "order_id": row["order_id"],
            "order_status": row.get("order_status"),
            "created_at": row.get("created_at"),
            "confirmed_at": row.get("confirmed_at"),
            "shipped_at": row.get("shipped_at"),
            "completed_at": row.get("completed_at"),
            "replenish_days": days,
            "replenish_days_basis": basis,
            "outbound_shipment_ids": row.get("outbound_shipment_ids"),
            "outbound_fc_count": row.get("outbound_fc_count"),
            "units_requested": row.get("units_requested"),
            "units_shipped": row.get("units_shipped"),
            "raw": row.get("raw"),
        })
    n = upsert_rows("inventory_awd_replenishments", updates, on_conflict="order_id") if updates else 0
    return {"rows": len(updates), "updated": n}


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

    detail_budget = DETAIL_FETCH_LIMIT

    for summary in orders:
        oid = summary.get("orderId") or summary.get("order_id")
        if not oid:
            continue
        if _needs_order_detail(summary) and detail_budget > 0:
            detail = _get_order(oid) or summary
            detail_fetched += 1
            detail_budget -= 1
        else:
            detail = summary
            detail_skipped += 1
        status = (detail.get("status") or "").upper()
        confirmed = _parse_ts(detail.get("confirmedOn"))
        created = _parse_ts(detail.get("createdAt"))
        updated = _parse_ts(detail.get("updatedAt"))

        outbound = detail.get("outboundShipments") or []
        outbound_ids = [
            ob.get("shipmentConfirmationId") or ob.get("shipmentId") or ob.get("shipment_id")
            for ob in outbound
            if ob.get("shipmentConfirmationId") or ob.get("shipmentId") or ob.get("shipment_id")
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
        "order_rows": order_rows,
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
        if basis in {"confirm_to_success_fallback", "unknown"}:
            continue
        rd = o.get("replenish_days")
        if rd is None:
            continue
        try:
            d = int(rd)
        except (TypeError, ValueError):
            continue
        if d < 1:
            continue
        vals.append(d)
        if len(vals) >= limit:
            break
    if not vals:
        return None, 0
    return int(median(vals)), len(vals)
