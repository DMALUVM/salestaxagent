"""FBA inbound sync via Fulfillment Inbound API v2024-03-20 (Send to Amazon)."""
from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone

import httpx

from src.amazon_sp.client import BASE_URL, SPAPIError, _headers
from src.inventory.shipment_timing import (
    compute_receive_days,
    ledger_receipt_dates,
    parse_ts,
    update_received_at,
    update_shipped_at,
)

log = logging.getLogger(__name__)

INBOUND_V2024 = "/inbound/fba/2024-03-20"
MIN_INTERVAL_SEC = 0.35
MAX_RETRIES = 5
_last_request_at = 0.0

CLOSED_STATUSES = frozenset({"CLOSED", "DELIVERED", "CHECKED_IN"})
SHIPPED_STATUSES = frozenset({"SHIPPED", "IN_TRANSIT", "DELIVERED", "RECEIVING", "CLOSED", "CHECKED_IN"})

_AWD_PLAN_MARKERS = (
    "amazon warehousing and distribution",
    "not supported for amazon warehousing",
)


def _is_awd_inbound_plan(summary: dict) -> bool:
    """AWD warehouse→AWD plans appear in listInboundPlans but reject getInboundPlan."""
    plan_id = str(
        summary.get("inboundPlanId")
        or summary.get("inbound_plan_id")
        or ""
    ).strip()
    if plan_id.lower().startswith("wf"):
        return True
    for key in ("source", "inboundPlanType", "planType", "destinationType"):
        val = str(summary.get(key) or "").upper()
        if "AWD" in val or "WAREHOUSING" in val:
            return True
    return False


def _is_awd_plan_error(exc: SPAPIError) -> bool:
    msg = str(exc).lower()
    return any(marker in msg for marker in _AWD_PLAN_MARKERS)


def _throttle() -> None:
    global _last_request_at
    elapsed = time.monotonic() - _last_request_at
    if elapsed < MIN_INTERVAL_SEC:
        time.sleep(MIN_INTERVAL_SEC - elapsed)
    _last_request_at = time.monotonic()


def _inbound_get(path: str, *, params: dict | None = None) -> dict:
    url = f"{BASE_URL}{INBOUND_V2024}{path}"
    last_error: SPAPIError | None = None
    for attempt in range(MAX_RETRIES):
        _throttle()
        resp = httpx.get(url, headers=_headers(), params=params or {}, timeout=60)
        if resp.status_code == 429:
            wait = min(2 ** attempt, 30)
            if attempt + 1 >= MAX_RETRIES:
                raise SPAPIError(f"Inbound v2024 quota exceeded (429) on {path}: {resp.text[:300]}")
            log.info("Inbound v2024 429 on %s — retry in %.1fs", path, wait)
            time.sleep(wait)
            continue
        if resp.status_code != 200:
            raise SPAPIError(
                f"Inbound v2024 failed ({resp.status_code}) on {path}: {resp.text[:400]}"
            )
        return resp.json()
    if last_error:
        raise last_error
    raise SPAPIError(f"Inbound v2024 failed on {path}")


def _list_plans_page(pagination_token: str | None = None) -> dict:
    params: dict = {
        "pageSize": 30,
        "sortBy": "LAST_UPDATED_TIME",
        "sortOrder": "DESC",
    }
    if pagination_token:
        params["paginationToken"] = pagination_token
    return _inbound_get("/inboundPlans", params=params)


def _get_plan(plan_id: str) -> dict:
    if str(plan_id).lower().startswith("wf"):
        raise SPAPIError(
            f"Skip GetInboundPlan for AWD inbound plan {plan_id}"
        )
    return _inbound_get(f"/inboundPlans/{plan_id}")


def _get_shipment(plan_id: str, shipment_id: str) -> dict:
    return _inbound_get(f"/inboundPlans/{plan_id}/shipments/{shipment_id}")


def _list_shipment_items(plan_id: str, shipment_id: str) -> list[dict]:
    items: list[dict] = []
    token: str | None = None
    while True:
        params: dict = {"pageSize": 100}
        if token:
            params["paginationToken"] = token
        page = _inbound_get(
            f"/inboundPlans/{plan_id}/shipments/{shipment_id}/items",
            params=params,
        )
        items.extend(page.get("items") or [])
        token = (page.get("pagination") or {}).get("nextToken")
        if not token:
            break
    return items


def _shipped_at_from_v2024(sh: dict, plan: dict) -> datetime | None:
    dates = sh.get("dates") or {}
    window = dates.get("readyToShipWindow") or {}
    for key in ("startDate", "endDate"):
        dt = parse_ts(window.get(key))
        if dt:
            return dt
    sel = sh.get("selectedDeliveryWindow") or {}
    dt = parse_ts(sel.get("startDate"))
    if dt:
        return dt
    tracking = sh.get("trackingDetails") or {}
    spd = tracking.get("spdTrackingDetail") or {}
    for pkg in spd.get("spdTrackingItems") or spd.get("trackingItems") or []:
        dt = parse_ts(pkg.get("shipDate") or pkg.get("deliveryDate"))
        if dt:
            return dt
    return parse_ts(plan.get("lastUpdatedAt"))


def _canonical_shipment_id(sh: dict) -> str:
    confirm = (sh.get("shipmentConfirmationId") or "").strip()
    if confirm:
        return confirm
    return (sh.get("shipmentId") or "").strip()


def sync_inbound_plans_v2024(
    days_back: int = 180,
    dry_run: bool = False,
    existing: dict[str, dict] | None = None,
) -> dict:
    """Pull Send-to-Amazon inbound shipments for receive-day calibration."""
    from src.inventory.inbound_shipments import _existing_by_id

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=days_back)
    existing = existing if existing is not None else _existing_by_id()

    plan_summaries: list[dict] = []
    awd_plans_skipped = 0
    token: str | None = None
    all_awd_pages = 0

    while True:
        page = _list_plans_page(token)
        batch = page.get("inboundPlans") or []
        if not batch:
            break

        hit_cutoff = False
        page_all_awd = True
        for p in batch:
            updated = parse_ts(p.get("lastUpdatedAt"))
            if updated and updated < cutoff:
                hit_cutoff = True
                break
            if _is_awd_inbound_plan(p):
                awd_plans_skipped += 1
            else:
                page_all_awd = False
                plan_summaries.append(p)

        if hit_cutoff:
            break

        if page_all_awd:
            all_awd_pages += 1
            if all_awd_pages >= 1 and not plan_summaries:
                log.info(
                    "Inbound v2024: AWD-only inbound plans — skipping FBA Send-to-Amazon sync",
                )
                break
        else:
            all_awd_pages = 0

        token = (page.get("pagination") or {}).get("nextToken")
        if not token:
            break

    ship_rows: list[dict] = []
    item_rows: list[dict] = []

    for summary in plan_summaries:
        plan_id = summary.get("inboundPlanId")
        if not plan_id:
            continue
        try:
            plan = _get_plan(plan_id)
        except SPAPIError as e:
            if _is_awd_plan_error(e):
                awd_plans_skipped += 1
                continue
            log.warning("Inbound plan %s: %s", plan_id, e)
            continue

        created = parse_ts(plan.get("createdAt") or summary.get("createdAt"))
        plan_updated = parse_ts(plan.get("lastUpdatedAt") or summary.get("lastUpdatedAt"))

        for sh_summary in plan.get("shipments") or []:
            internal_id = sh_summary.get("shipmentId")
            if not internal_id:
                continue
            try:
                sh = _get_shipment(plan_id, internal_id)
            except SPAPIError as e:
                log.warning("Inbound shipment %s/%s: %s", plan_id, internal_id, e)
                sh = sh_summary

            sid = _canonical_shipment_id(sh)
            if not sid:
                continue

            status = (sh.get("status") or sh_summary.get("status") or "").upper()
            dest_obj = sh.get("destination") or {}
            dest = dest_obj.get("warehouseId") or dest_obj.get("destinationType")

            try:
                sh_items = _list_shipment_items(plan_id, internal_id)
            except SPAPIError:
                sh_items = []

            shipped = 0
            received = 0
            skus: list[str] = []
            for it in sh_items:
                sku = (it.get("msku") or "").strip()
                if not sku:
                    continue
                skus.append(sku)
                qty = int(it.get("quantity", 0) or 0)
                shipped += qty
                qr = qty if status in CLOSED_STATUSES else 0
                if status in CLOSED_STATUSES:
                    received += qty
                item_rows.append({
                    "shipment_id": sid,
                    "sku": sku,
                    "quantity_shipped": qty,
                    "quantity_received": qr,
                })

            prev = existing.get(sid)
            transport_dt = _shipped_at_from_v2024(sh, plan)
            shipped_at = update_shipped_at(prev, status, plan_updated, created, transport_dt)
            if shipped_at is None and prev:
                shipped_at = parse_ts(prev.get("shipped_at"))
            if shipped_at is None and status in SHIPPED_STATUSES and transport_dt:
                shipped_at = transport_dt

            closed_at = plan_updated if status == "CLOSED" else parse_ts((prev or {}).get("closed_at"))
            if status == "CLOSED" and plan_updated:
                closed_at = plan_updated

            received_at = update_received_at(prev, status, plan_updated, closed_at, received)
            if received_at is None and prev:
                received_at = parse_ts(prev.get("received_at"))

            prime_eligible_at = parse_ts((prev or {}).get("prime_eligible_at"))
            window_start = (shipped_at or created or cutoff).date() if (shipped_at or created) else None
            window_end = (closed_at or plan_updated or now).date() if (closed_at or plan_updated) else None
            if window_start and dest and skus:
                ledger_recv, ledger_sellable = ledger_receipt_dates(
                    skus, str(dest), window_start, window_end,
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
                "last_updated_at": plan_updated.isoformat() if plan_updated else None,
                "raw": {
                    "source": "inbound_v2024",
                    "inboundPlanId": plan_id,
                    "internalShipmentId": internal_id,
                    "shipmentConfirmationId": sh.get("shipmentConfirmationId"),
                    "shipment": sh,
                },
            })

    if awd_plans_skipped:
        log.info(
            "Skipped %d AWD inbound plans (use AWD inbound API; not FBA Send-to-Amazon)",
            awd_plans_skipped,
        )

    return {
        "plans_scanned": len(plan_summaries) + awd_plans_skipped,
        "awd_plans_skipped": awd_plans_skipped,
        "shipments_found": len(ship_rows),
        "items_found": len(item_rows),
        "ship_rows": ship_rows,
        "item_rows": item_rows,
        "dry_run": dry_run,
    }
