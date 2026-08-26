"""Pull Amazon SP-API inventory data: restock recommendations, planning, FBA summaries.

Report types:
  GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT — recommended replenishment
  GET_FBA_INVENTORY_PLANNING_DATA              — inventory health / aged stock

FBA Inventory Summaries API — live fulfillable/inbound/reserved counts.
"""
from __future__ import annotations

import csv
import io
import json
import logging
from datetime import date, timedelta

import httpx

from src.amazon_sp.auth import get_access_token
from src.amazon_sp.client import (
    BASE_URL,
    SPAPIError,
    request_and_download,
    _headers,
    _marketplace_id,
)
from src.db import upsert_rows, log_ingestion
from src.inventory.awd_client import AWD_ROLE_HINT

log = logging.getLogger(__name__)

FBA_ROLE_HINT = (
    "Ensure SP-API app has 'Amazon Fulfillment' and "
    "'Inventory and Order Management' roles."
)
AWD_SYNC_NAMES = frozenset({"awd", "awd_replenishments", "awd_inbound"})

RESTOCK_REPORT = "GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT"
PLANNING_REPORT = "GET_FBA_INVENTORY_PLANNING_DATA"


# ---------------------------------------------------------------------------
# Restock recommendations
# ---------------------------------------------------------------------------

def fetch_restock(dry_run: bool = False, on_poll=None) -> dict:
    """Fetch restock recommendations report and upsert."""
    end = date.today()
    start = end - timedelta(days=30)

    if on_poll:
        on_poll("requesting restock report", 0)

    content = request_and_download(RESTOCK_REPORT, start, end, on_poll=on_poll)
    rows = _parse_restock(content)

    result = {"rows_total": len(rows), "rows_inserted": 0, "dry_run": dry_run}

    if not dry_run and rows:
        result["rows_inserted"] = upsert_rows(
            "inventory_restock", rows, on_conflict="sku",
        )
        log_ingestion(
            filename="restock_recommendations",
            file_type="amazon_inventory",
            rows_total=len(rows),
            rows_inserted=result["rows_inserted"],
        )

    return result


def _parse_restock(content: str) -> list[dict]:
    """Parse restock recommendations TSV."""
    lines = content.strip().split("\n")
    if len(lines) < 2:
        return []

    delimiter = "\t" if "\t" in lines[0] else ","
    reader = csv.DictReader(io.StringIO(content), delimiter=delimiter)

    from src.amazon_sp.reports import _build_header_lookup, _get

    H = _build_header_lookup(reader.fieldnames or [])
    rows = []

    for row in reader:
        sku = _get(row, H, "merchant-sku", "sku", "seller-sku", "msku")
        if not sku:
            continue

        asin = _get(row, H, "asin") or None
        product_name = _get(row, H, "product-name", "title", "item-name") or None

        rec_qty_str = _get(row, H, "recommended-replenishment-qty",
                           "recommended-quantity", "recommended-order-quantity",
                           "rec-quantity", "quantity-to-be-shipped")
        rec_qty = _safe_int(rec_qty_str)

        rec_ship = _get(row, H, "recommended-ship-date",
                        "recommended-action-date") or None

        dos_str = _get(row, H, "days-of-supply", "estimated-days-of-supply",
                       "days-of-supply-at-merchant")
        dos = _safe_float(dos_str)

        sold30 = _safe_int(_get(row, H, "units-sold-last-30-days",
                                "sold-last-30-days", "units-sold-30"))
        avail = _safe_int(_get(row, H, "available", "available-inventory",
                               "fulfillable-quantity"))
        inbound = _safe_int(_get(row, H, "inbound", "inbound-quantity",
                                 "inbound-units", "inbound-working",
                                 "total-inbound"))
        alert = _get(row, H, "alert", "recommendation-alert") or None

        rows.append({
            "sku": sku,
            "asin": asin,
            "product_name": product_name,
            "recommended_qty": rec_qty,
            "recommended_ship_date": rec_ship[:10] if rec_ship and len(rec_ship) >= 10 else None,
            "days_of_supply": dos,
            "units_sold_30": sold30,
            "available": avail,
            "inbound": inbound,
            "alert": alert,
            "raw": json.dumps({k: v for k, v in row.items() if v}),
        })

    return rows


# ---------------------------------------------------------------------------
# Inventory planning
# ---------------------------------------------------------------------------

def fetch_planning(dry_run: bool = False, on_poll=None) -> dict:
    """Fetch inventory planning report and upsert."""
    end = date.today()
    start = end - timedelta(days=30)

    if on_poll:
        on_poll("requesting planning report", 0)

    content = request_and_download(PLANNING_REPORT, start, end, on_poll=on_poll)
    rows = _parse_planning(content)

    result = {"rows_total": len(rows), "rows_inserted": 0, "dry_run": dry_run}

    if not dry_run and rows:
        result["rows_inserted"] = upsert_rows(
            "inventory_planning", rows, on_conflict="sku",
        )
        log_ingestion(
            filename="inventory_planning",
            file_type="amazon_inventory",
            rows_total=len(rows),
            rows_inserted=result["rows_inserted"],
        )

    return result


def _parse_planning(content: str) -> list[dict]:
    """Parse inventory planning TSV."""
    lines = content.strip().split("\n")
    if len(lines) < 2:
        return []

    delimiter = "\t" if "\t" in lines[0] else ","
    reader = csv.DictReader(io.StringIO(content), delimiter=delimiter)

    from src.amazon_sp.reports import _build_header_lookup, _get

    H = _build_header_lookup(reader.fieldnames or [])
    rows = []

    for row in reader:
        sku = _get(row, H, "sku", "merchant-sku", "seller-sku", "msku")
        if not sku:
            continue

        rows.append({
            "sku": sku,
            "asin": _get(row, H, "asin") or None,
            "product_name": _get(row, H, "product-name", "item-name", "title") or None,
            "condition_type": _get(row, H, "condition", "condition-type", "item-condition") or None,
            "available": _safe_int(_get(row, H, "available", "afn-fulfillable-quantity",
                                        "available-quantity")),
            "days_of_supply": _safe_float(_get(row, H, "weeks-of-cover-t30",
                                               "estimated-days", "days-of-supply")),
            "sell_through": _safe_float(_get(row, H, "sell-through",
                                             "sell-through-rate")),
            "inv_age_0_90": _safe_int(_get(row, H, "inv-age-0-to-90-days",
                                           "qty-with-removals-recommendation")),
            "inv_age_91_180": _safe_int(_get(row, H, "inv-age-91-to-180-days")),
            "inv_age_181_270": _safe_int(_get(row, H, "inv-age-181-to-270-days")),
            "inv_age_271_365": _safe_int(_get(row, H, "inv-age-271-to-365-days")),
            "inv_age_365_plus": _safe_int(_get(row, H, "inv-age-365-plus-days")),
            "estimated_storage_cost": _safe_float(
                _get(row, H, "estimated-excess-charge", "estimated-storage-cost",
                     "projected-ltsf-6-mo", "estimated-ltsf-next-charge")
            ),
            "raw": json.dumps({k: v for k, v in row.items() if v}),
        })

    return rows


# ---------------------------------------------------------------------------
# FBA inventory summaries (API, not report)
# ---------------------------------------------------------------------------

def fetch_fba_summaries(dry_run: bool = False) -> dict:
    """Fetch FBA inventory summaries via Inventory API and upsert snapshots."""
    all_items: list[dict] = []
    next_token = None

    while True:
        params: dict = {
            "details": "true",
            "granularityType": "Marketplace",
            "granularityId": _marketplace_id(),
            "marketplaceIds": _marketplace_id(),
        }
        if next_token:
            params["nextToken"] = next_token

        resp = httpx.get(
            f"{BASE_URL}/fba/inventory/v1/summaries",
            headers=_headers(),
            params=params,
            timeout=30,
        )

        if resp.status_code != 200:
            raise SPAPIError(
                f"FBA Inventory summaries failed ({resp.status_code}): "
                f"{resp.text[:500]}"
            )

        body = resp.json()
        payload = body.get("payload") or body
        items = payload.get("inventorySummaries", [])
        all_items.extend(items)

        pagination = payload.get("pagination") or body.get("pagination") or {}
        next_token = pagination.get("nextToken")
        if not next_token:
            break

    # Aggregate by seller SKU (API may split by condition/marketplace)
    sku_agg: dict[str, dict] = {}
    for item in all_items:
        sku = item.get("sellerSku") or item.get("sellerSKU", "")
        if not sku:
            continue

        inv = item.get("inventoryDetails") or {}

        # fulfillableQuantity = units available for customer orders
        fb = int(inv.get("fulfillableQuantity", 0) or 0)

        inbound_w = int(inv.get("inboundWorkingQuantity", 0) or 0)
        inbound_s = int(inv.get("inboundShippedQuantity", 0) or 0)
        inbound_r = int(inv.get("inboundReceivingQuantity", 0) or 0)

        reserved_obj = inv.get("reservedQuantity", {})
        reserved_total = (
            int(reserved_obj.get("totalReservedQuantity", 0) or 0)
            if isinstance(reserved_obj, dict) else int(reserved_obj or 0)
        )

        researching_obj = inv.get("researchingQuantity", {})
        researching_total = (
            int(researching_obj.get("totalResearchingQuantity", 0) or 0)
            if isinstance(researching_obj, dict) else int(researching_obj or 0)
        )

        unfulfillable_obj = inv.get("unfulfillableQuantity", {})
        unfulfillable_total = (
            int(unfulfillable_obj.get("totalUnfulfillableQuantity", 0) or 0)
            if isinstance(unfulfillable_obj, dict) else int(unfulfillable_obj or 0)
        )

        total_qty = int(item.get("totalQuantity", 0) or 0)

        if sku in sku_agg:
            a = sku_agg[sku]
            a["fulfillable"] += fb
            a["inbound_working"] += inbound_w
            a["inbound_shipped"] += inbound_s
            a["inbound_receiving"] += inbound_r
            a["reserved"] += reserved_total
            a["researching"] += researching_total
            a["unfulfillable"] += unfulfillable_total
            a["total_quantity"] += total_qty
        else:
            sku_agg[sku] = {
                "sku": sku,
                "asin": item.get("asin") or None,
                "fnsku": item.get("fnsku") or item.get("fnSku") or None,
                "product_name": item.get("productName") or None,
                "fulfillable": fb,
                "inbound_working": inbound_w,
                "inbound_shipped": inbound_s,
                "inbound_receiving": inbound_r,
                "reserved": reserved_total,
                "researching": researching_total,
                "unfulfillable": unfulfillable_total,
                "total_quantity": total_qty,
                "source": "fba_inventory_api",
            }

    rows = list(sku_agg.values())

    result = {"rows_total": len(rows), "rows_inserted": 0, "dry_run": dry_run}

    if not dry_run and rows:
        result["rows_inserted"] = upsert_rows(
            "inventory_snapshots", rows, on_conflict="sku",
        )
        try:
            from src.inventory.snapshots_daily import append_daily_snapshots
            result["daily"] = append_daily_snapshots(rows)
        except Exception as e:
            log.warning("[Inventory] daily snapshot append failed: %s", e)
            result["daily_error"] = str(e)[:200]
        log_ingestion(
            filename="fba_inventory_summaries",
            file_type="amazon_inventory",
            rows_total=len(rows),
            rows_inserted=result["rows_inserted"],
        )

    return result


# ---------------------------------------------------------------------------
# Combined sync
# ---------------------------------------------------------------------------

def sync_all(dry_run: bool = False, on_poll=None, echo=None) -> dict:
    """Pull restock + planning + FBA summaries + AWD."""
    from src.inventory.awd import fetch_awd_inventory

    def _say(msg: str) -> None:
        log.info(msg)
        if echo:
            echo(msg)

    results = {}
    errors = []
    replenishment_orders: list[dict] | None = None

    for name, fn in [
        ("fba_summaries", lambda: fetch_fba_summaries(dry_run=dry_run)),
        ("awd", lambda: fetch_awd_inventory(dry_run=dry_run)),
        ("restock", lambda: fetch_restock(dry_run=dry_run, on_poll=on_poll)),
        ("planning", lambda: fetch_planning(dry_run=dry_run, on_poll=on_poll)),
        ("awd_replenishments", lambda: _sync_awd_replenishments(dry_run)),
        ("inbound_shipments", lambda: _sync_inbound(dry_run, replenishment_orders)),
        ("awd_inbound", lambda: _sync_awd_inbound(dry_run)),
    ]:
        _say(f"  {name}...")
        try:
            results[name] = fn()
            if name == "awd_replenishments":
                replenishment_orders = (results[name] or {}).get("order_rows") or []
            count = results[name].get(
                "rows_total",
                results[name].get("shipments_found", results[name].get("orders_found", 0)),
            )
            _say(f"  {name}: {count} rows")
        except SPAPIError as e:
            err = str(e)
            results[name] = {"error": err[:300]}
            errors.append(f"{name}: {err[:200]}")
            _say(f"  {name}: ERROR")
            if "403" in err or "Unauthorized" in err or "access denied" in err.lower():
                hint = AWD_ROLE_HINT if name in AWD_SYNC_NAMES else FBA_ROLE_HINT
                log.warning("[Inventory] %s access denied — %s", name, hint)
        except Exception as e:
            results[name] = {"error": str(e)[:300]}
            errors.append(f"{name}: {e}")
            _say(f"  {name}: ERROR — {str(e)[:120]}")

    results["errors"] = errors
    return results


def _sync_inbound(dry_run: bool, replenishment_orders: list[dict] | None = None) -> dict:
    if dry_run:
        return {"dry_run": True}
    from src.inventory.inbound_shipments import sync_inbound_shipments
    return sync_inbound_shipments(
        days_back=180,
        dry_run=False,
        replenishment_orders=replenishment_orders,
    )


def _sync_awd_replenishments(dry_run: bool) -> dict:
    if dry_run:
        return {"dry_run": True}
    from src.inventory.awd_replenishments import sync_awd_replenishments
    return sync_awd_replenishments(days_back=180, dry_run=False)


def _sync_awd_inbound(dry_run: bool) -> dict:
    if dry_run:
        return {"dry_run": True}
    from src.inventory.awd_inbound import sync_awd_inbound_shipments
    return sync_awd_inbound_shipments(days_back=180, dry_run=False)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_int(v: str) -> int:
    try:
        return int(float(v.replace(",", ""))) if v else 0
    except (ValueError, AttributeError):
        return 0


def _safe_float(v: str) -> float | None:
    try:
        return float(v.replace(",", "")) if v else None
    except (ValueError, AttributeError):
        return None
