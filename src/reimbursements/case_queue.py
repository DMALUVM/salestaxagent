"""Build the FBA Needs-case queue from live warehouse sources.

Eligible / open cases are inferred. Amazon has no SP-API for "open claims"
or reimbursement eligibility. Do not invent Eligible rows from paid-only
GET_FBA_REIMBURSEMENTS_DATA.

Sources
-------
1. fba_inventory_adjustments — GET_LEDGER_DETAIL_VIEW_DATA Adjustments
   (Damaged_Warehouse / Lost_Warehouse / Lost_Inbound, negative qty)
2. inventory_inbound_shipments + items — shipped > received after close
   (SP-API live WORKING / IN_TRANSIT / RECEIVING only — no CLOSED history)
3. sellerboard_inbound_discrepancies — Dana MCP upserts Sellerboard CLOSED
   shorts (real FBA* shipment_ids). Dashboard never calls Sellerboard.

Dedupe: units already paid in fba_reimbursements for the same SKU + reason
group leave the Needs-case list for ledger/warehouse rows. Lost_Inbound rows
tied to a specific FBA shipment only consume reimbursements whose case_id /
order_id is that shipment (or another FBA* id) — SKU-pooled Lost_Inbound
cash must not fake a partial on this shipment. Same FBA shipment_id + SKU
from SP-API and Sellerboard collapses to one row.

Receipts SoT: before keeping a Sellerboard/SP-API Lost_Inbound short,
``apply_receipt_cover`` checks inventory_events Receipts (Reference ID =
FBA* when present). If receipts cover shipped qty for that shipment+SKU,
mark found_offset (durable for zero-recv CLOSED ghosts).

This module never opens Seller Central cases.
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Iterable

from src.reimbursements.qa import (
    CaseQueueSyncError,
    evaluate_queue_qa,
)
from src.reimbursements.reason_legend import (
    CLASSIFICATION_VERSION,
    ELIGIBLE_REASON_GROUPS,
    MINI_RESYNC_HINT,
    is_eligible_loss,
    is_found_reason,
    lookup_reason,
    reason_group,
    reason_label,
)
from src.sku_normalize import normalize_sku

log = logging.getLogger(__name__)

FBA_SHIPMENT_RE = re.compile(r"^FBA[A-Z0-9]+$", re.IGNORECASE)

SC_SUPPORT_HUB = "https://sellercentral.amazon.com/help/hub/contact-us"
SC_INBOUND_SHIPMENT = (
    "https://sellercentral.amazon.com/fba/inbound-shipment/summary/"
    "{shipment_id}/shipmentEvents"
)
# Dave’s confirmed claim window for pasting ledger transaction / Reference IDs.
SC_ELIGIBLE_FOR_CLAIM = (
    "https://sellercentral.amazon.com/help/hub/reference/GEV4254LJJ9BAEG#mnd_2jc_jcb"
)
SC_LEDGER_HUB = "https://sellercentral.amazon.com/reportcentral/INVENTORY_LEDGER/1"

LINK_KIND_INBOUND = "inbound_shipment"
LINK_KIND_IDR = "idr_instructions"
LINK_KIND_SUPPORT_MANUAL = "support_manual"
# Legacy rows stored this before the trust fix.
LINK_KIND_SUPPORT_HUB = "support_hub"

# Honest: Amazon does not publish a stable pre-filled "open this case" URL.
SELLER_CENTRAL_LINK_LIMIT = (
    "No stable Seller Central deep link opens a pre-filled FBA case. "
    "Only real FBA* shipment IDs link to the inbound shipment tracker. "
    "Ledger reference / transaction IDs (digit strings) are not shipment IDs. "
    "Warehouse damage is filed by pasting the transaction ID in the Seller "
    "Central claim window (help/hub/reference/GEV4254LJJ9BAEG#mnd_2jc_jcb), "
    "not via a generic Support hub button. That hub is NOT a pre-filled "
    "lost-inbound or warehouse case. The Eligible for claim inventory page "
    "may still exist. Dave submits; this desk never auto-files."
)

IDR_INSTRUCTION = "Open IDR (Inventory → Inventory Defect and Reimbursement)"

HOW_TO_FILE_TITLE = "How to file"

HOW_TO_FILE_INTRO = (
    "Current queue is warehouse damage (codes 7 / E — Damaged at FC). "
    "Amazon auto-pays many warehouse lost/damaged events. This desk never auto-files."
)

HOW_TO_FILE_STEPS = (
    (
        "Check Paid / Reimbursements report first",
        "Amazon auto-pays many warehouse lost/damaged units. Skip filing if "
        "already paid within ~60 days (Already reimbursed tab).",
    ),
    (
        "File within 60 days",
        "The clock starts on the ledger event date.",
    ),
    (
        "Use Reference ID + SKU details",
        "Paste the digit Reference ID plus FNSKU/SKU/ASIN/qty/FC/date. "
        "Reference ID is a ledger transaction ID — not a shipment ID.",
    ),
    (
        "Preferred: Inventory Defect and Reimbursement (IDR)",
        "Paste the ledger transaction / Reference ID in the Seller Central claim "
        "window: https://sellercentral.amazon.com/help/hub/reference/GEV4254LJJ9BAEG#mnd_2jc_jcb. "
        "Inventory → Inventory Defect and Reimbursement (IDR) / Eligible for claim "
        "may still exist; this help/claim-window link is the confirmed entry point. "
        "Not a pre-filled case.",
    ),
    (
        "Classic path",
        "Reports → Fulfillment → Inventory Adjustments / Ledger Adjustments → "
        "find Damaged at FC row → Help / Get Support → FBA → warehouse "
        "lost/damaged (or the warehouse-damaged status tool with Transaction Item ID).",
    ),
    (
        "One case per event",
        "Copy the case packet from the row and paste those fields. "
        "Do not batch unrelated events.",
    ),
)

HOW_TO_FILE_NO_DEEP_LINK = (
    "There is no stable deep link that opens a pre-filled case. "
    "Do not use a generic Support hub button as if it does."
)

CASE_QUEUE_SOURCE_NOTE = (
    "Needs case currently comes from (1) ledger adjustments with eligible codes "
    "and (2) CLOSED/stale inbound shipped−received shorts."
)

NO_INBOUND_DISCREPANCIES = (
    "No CLOSED inbound discrepancies in warehouse right now"
)

CLOSED_INBOUND = frozenset({"CLOSED"})
STALE_INBOUND = frozenset({"RECEIVING", "DELIVERED", "CHECKED_IN"})
OPEN_INBOUND = frozenset({"WORKING", "IN_TRANSIT", "SHIPPED", "READY_TO_SHIP"})
STALE_INBOUND_DAYS = 21
FOUND_OFFSET_DAYS = 30
PAID_LOOKAHEAD_DAYS = 90
PAID_SETTLE_PAD_DAYS = 7

STATUS_NEEDS_CASE = "needs_case"
STATUS_ALREADY_REIMBURSED = "already_reimbursed"
STATUS_FOUND_OFFSET = "found_offset"
STATUS_CASE_SUBMITTED = "case_submitted"

CLEAR_NOTE_FILED = "filed"
CLEAR_NOTE_RECONCILED = "reconciled"
CLEAR_NOTE_NOT_PURSUING = "not_pursuing"
CLEAR_NOTE_RECEIPTS_COVER = "receipts_cover"

# Sellerboard CLOSED + UnitsReceived=0 ghosts: ledger Receipts often land at a
# different FC than the plan destination. Prefer Reference ID (= FBA*) match;
# fall back to exact-qty SKU receipt pool near plan/event date (consumed once).
RECEIPT_COVER_BEFORE_DAYS = 14
RECEIPT_COVER_AFTER_DAYS = 60

SOURCE_LEDGER = "ledger_adjustment"
SOURCE_INBOUND = "inbound_discrepancy"
SOURCE_SELLERBOARD = "sellerboard_inbound"
INBOUND_SOURCES = frozenset({SOURCE_INBOUND, SOURCE_SELLERBOARD})

HOW_TO_FILE_INBOUND = (
    "Lost inbound / inbound short is filed from shipment events "
    "(https://sellercentral.amazon.com/fba/inbound-shipment/summary/"
    "{SHIPMENT_ID}/shipmentEvents) + IDR / lost inbound — not the ledger "
    "Reference ID damage path and not a generic Support hub. "
    "Use the real FBA* shipment ID, FC, and shipped / received / short qty. "
    "Inbound shorts may come from Sellerboard CLOSED history when the SP-API "
    "warehouse has no CLOSED rows (live WORKING / IN_TRANSIT / RECEIVING only)."
)

AMOUNT_BASIS_RECENT = "recent_reimbursement"
AMOUNT_BASIS_UNKNOWN = "unknown"


def is_fba_shipment_id(value: str | None) -> bool:
    """True only for real FBA inbound shipment IDs (FBA…)."""
    return bool(FBA_SHIPMENT_RE.match((value or "").strip()))


def fba_shipment_id(*candidates: str | None) -> str | None:
    """First real FBA* id among candidates. Digit ledger refs are not shipments."""
    for value in candidates:
        raw = (value or "").strip().upper()
        if FBA_SHIPMENT_RE.match(raw):
            return raw
    return None


def _fba_id(value: str | None) -> str | None:
    return fba_shipment_id(value)


def inbound_event_key(shipment_id: str, sku: str) -> str:
    return f"inbound|{shipment_id}|{normalize_sku(sku)}"


def _parse_day(value: object) -> date | None:
    if value is None:
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    raw = str(value).strip()
    if not raw:
        return None
    if len(raw) >= 10 and raw[4] == "-" and raw[7] == "-":
        try:
            return date.fromisoformat(raw[:10])
        except ValueError:
            return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt.date()
    except ValueError:
        return None


def _plan_anchor_day(row: dict) -> date | None:
    """Best date for receipt-window matching (plan/ship, not stale event_date)."""
    direct = _parse_day(row.get("plan_date"))
    if direct:
        return direct
    raw = row.get("raw") if isinstance(row.get("raw"), dict) else None
    if raw:
        plan_ts = raw.get("plan_date") or raw.get("shipment_date")
        if plan_ts is not None:
            try:
                ts = int(plan_ts)
                if ts > 10_000_000_000:  # ms
                    ts //= 1000
                return datetime.fromtimestamp(ts, tz=timezone.utc).date()
            except (TypeError, ValueError, OSError, OverflowError):
                pass
        for key in ("plan_date", "shipment_date", "closed_at"):
            day = _parse_day(raw.get(key))
            if day:
                return day
    return (
        _parse_day(row.get("closed_at"))
        or _parse_day(row.get("last_updated_at"))
        or _parse_day(row.get("event_date"))
    )

def _fba_id(value: str | None) -> str | None:
    raw = (value or "").strip().upper()
    if FBA_SHIPMENT_RE.match(raw):
        return raw
    return None


def seller_central_link(
    shipment_id: str | None,
    reference_id: str | None = None,
    reason_group: str | None = None,
) -> tuple[str | None, str]:
    """Best available SC URL and a documented kind.

    lost_inbound + real FBA* id → shipment events. Every other Needs-case
    reason (warehouse damage, lost warehouse, damaged & lost) uses the
    claim-window help article — even if a row has an FBA-looking id. Digit
    ledger transaction IDs are not shipment IDs. There is no stable
    pre-filled case deep link and no Support hub fallback.
    """
    sid = fba_shipment_id(shipment_id, reference_id)
    inbound = bool(sid) and (reason_group is None or reason_group == "lost_inbound")
    if inbound:
        return SC_INBOUND_SHIPMENT.format(shipment_id=sid), LINK_KIND_INBOUND
    return SC_ELIGIBLE_FOR_CLAIM, LINK_KIND_IDR


def inbound_age_day(ship: dict) -> date | None:
    """Date used for the stale-receiving ≥21-day clock.

    Prefer ``received_at`` — Amazon often leaves LastUpdatedDate stuck at
    ship time while receive date advances. Then ``closed_at``, then
    ``last_updated_at``. Do not invent CLOSED from these dates.
    """
    return (
        _parse_day(ship.get("received_at"))
        or _parse_day(ship.get("closed_at"))
        or _parse_day(ship.get("last_updated_at"))
    )


def inbound_ready(ship: dict, as_of: date) -> bool:
    """True when a short-receive is case-eligible (not still in transit)."""
    status = (ship.get("shipment_status") or "").upper()
    if status in CLOSED_INBOUND:
        return True
    if status not in STALE_INBOUND:
        return False
    updated = inbound_age_day(ship)
    if not updated:
        return False
    return (as_of - updated).days >= STALE_INBOUND_DAYS


def inbound_discrepancies(
    shipments: Iterable[dict],
    items: Iterable[dict],
    as_of: date,
    start: date,
    end: date,
) -> list[dict]:
    """CLOSED (or stale receiving) rows where shipped > received."""
    ships = {str(s.get("shipment_id") or ""): s for s in shipments if s.get("shipment_id")}
    out: list[dict] = []
    for it in items:
        sid = str(it.get("shipment_id") or "")
        ship = ships.get(sid)
        if not ship or not inbound_ready(ship, as_of):
            continue
        try:
            shipped = int(it.get("quantity_shipped") or 0)
            received = int(it.get("quantity_received") or 0)
        except (TypeError, ValueError):
            continue
        short = shipped - received
        if short <= 0:
            continue
        event_day = (
            _parse_day(ship.get("closed_at"))
            or _parse_day(ship.get("received_at"))
            or _parse_day(ship.get("last_updated_at"))
            or _parse_day(ship.get("shipped_at"))
        )
        if event_day is None or event_day < start or event_day > end:
            continue
        sku = normalize_sku(it.get("sku"))
        fc = ship.get("destination_fc")
        fba = fba_shipment_id(sid)
        url, kind = seller_central_link(fba, None)
        out.append({
            "event_key": inbound_event_key(sid, sku),
            "source": SOURCE_INBOUND,
            "event_date": event_day,
            "sku": sku,
            "asin": it.get("asin") or None,
            "fnsku": None,
            "product_name": None,
            "quantity": short,
            "quantity_shipped": shipped,
            "quantity_received": received,
            "reason": "Lost_Inbound",
            "reason_group": "lost_inbound",
            "fulfillment_center": fc,
            "shipment_id": fba,
            "reference_id": None if fba else (sid or None),
            "disposition": None,
            "classification_version": CLASSIFICATION_VERSION,
            "seller_central_url": url,
            "seller_central_link_kind": kind,
        })
    return out


def _int_or_none(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def sellerboard_inbound_discrepancies(
    rows: Iterable[dict],
    as_of: date,
    start: date,
    end: date,
) -> list[dict]:
    """CLOSED (or stale receiving) Sellerboard shorts → Lost_Inbound events.

    Dana upserts ``sellerboard_inbound_discrepancies`` (or already-shaped
    ``fba_case_events`` with source sellerboard_inbound). WORKING / IN_TRANSIT
    zeros are never case-eligible.
    """
    out: list[dict] = []
    for raw in rows:
        sid = str(raw.get("shipment_id") or "")
        sku = normalize_sku(raw.get("sku"))
        if sku == "UNKNOWN" and not sid:
            continue
        status = (raw.get("shipment_status") or "CLOSED").upper()
        ship = {
            "shipment_status": status,
            "last_updated_at": raw.get("last_updated_at") or raw.get("closed_at"),
            "received_at": raw.get("received_at") or raw.get("closed_at"),
        }
        if not inbound_ready(ship, as_of):
            continue
        shipped = _int_or_none(raw.get("quantity_shipped"))
        received = _int_or_none(raw.get("quantity_received"))
        short = _int_or_none(raw.get("quantity_short"))
        if short is None:
            qty = _int_or_none(raw.get("quantity"))
            if shipped is not None and received is not None:
                short = shipped - received
            elif qty is not None and qty > 0:
                short = qty
            else:
                continue
        if short <= 0:
            continue
        if shipped is None and received is not None:
            shipped = received + short
        if received is None and shipped is not None:
            received = shipped - short
        event_day = (
            _parse_day(raw.get("event_date"))
            or _parse_day(raw.get("closed_at"))
            or _parse_day(raw.get("last_updated_at"))
        )
        if event_day is None or event_day < start or event_day > end:
            continue
        fba = fba_shipment_id(sid)
        if not fba:
            continue
        url, kind = seller_central_link(fba, None)
        fc = raw.get("fulfillment_center") or raw.get("destination_fc")
        # Keep Sellerboard raw / plan_date so receipt-cover can window off the
        # real ship plan (event_date is often a stale Dana upsert day).
        raw_blob = raw.get("raw") if isinstance(raw.get("raw"), dict) else None
        plan_day = _plan_anchor_day(raw) or _plan_anchor_day({"raw": raw_blob} if raw_blob else {})
        out.append({
            "event_key": inbound_event_key(fba, sku),
            "source": SOURCE_SELLERBOARD,
            "event_date": event_day,
            "sku": sku,
            "asin": raw.get("asin") or None,
            "fnsku": raw.get("fnsku") or None,
            "product_name": raw.get("product_name") or None,
            "quantity": short,
            "quantity_shipped": shipped,
            "quantity_received": received,
            "reason": "Lost_Inbound",
            "reason_group": "lost_inbound",
            "fulfillment_center": fc,
            "shipment_id": fba,
            "reference_id": None,
            "disposition": None,
            "classification_version": CLASSIFICATION_VERSION,
            "seller_central_url": url,
            "seller_central_link_kind": kind,
            "raw": raw_blob or raw,
            "plan_date": plan_day.isoformat() if plan_day else None,
        })
    return out


def inbound_source_key(row: dict) -> tuple[str, str] | None:
    sid = fba_shipment_id(row.get("shipment_id"))
    sku = normalize_sku(row.get("sku"))
    if not sid or sku == "UNKNOWN":
        return None
    return sid, sku


def inbound_match_key(shipment_id: object, sku: object) -> tuple[str, str] | None:
    """Case-insensitive (FBA shipment, SKU) key. Sellerboard SKUs are mixed case."""
    sid = fba_shipment_id(str(shipment_id) if shipment_id is not None else None)
    sku_n = normalize_sku(None if sku is None else str(sku))
    if not sid or sku_n == "UNKNOWN":
        return None
    return sid, sku_n


def inbound_live_short(
    shipped: int | None,
    received: int | None,
    quantity_short: int | None = None,
) -> int | None:
    """Live short qty. Prefer shipped−received when both exist; else Sellerboard short.

    Missing ship/recv is not a balance. Never invent a short from case ``quantity``.
    """
    if shipped is not None and received is not None:
        return shipped - received
    return quantity_short


def is_inbound_balanced(
    shipped: int | None,
    received: int | None,
    quantity_short: int | None = None,
) -> bool:
    short = inbound_live_short(shipped, received, quantity_short)
    return short is not None and short <= 0


def _is_inbound_event(row: dict) -> bool:
    if row.get("source") in INBOUND_SOURCES:
        return True
    return reason_group(row.get("reason"), row.get("disposition")) == "lost_inbound"


AMAZON_RECONCILE_BATCH = 5  # large ShipmentIdList batches drop CLOSED headers


def _ingest_live_qty_row(out: dict[tuple[str, str], dict], raw: dict) -> None:
    key = inbound_match_key(raw.get("shipment_id"), raw.get("sku"))
    if not key:
        return
    shipped = _int_or_none(raw.get("quantity_shipped"))
    received = _int_or_none(raw.get("quantity_received"))
    short = inbound_live_short(shipped, received, _int_or_none(raw.get("quantity_short")))
    if shipped is None and received is None and short is None:
        return
    out[key] = {
        "quantity_shipped": shipped,
        "quantity_received": received,
        "quantity_short": short,
    }


def collect_live_inbound_qty(
    sellerboard_rows: Iterable[dict],
    shipment_items: Iterable[dict],
    amazon_rows: Iterable[dict] | None = None,
) -> dict[tuple[str, str], dict]:
    """Latest shipped/received/short by (FBA id, normalized SKU).

    Priority (last write wins): warehouse SP-API items → Sellerboard →
    live Amazon inbound v0. Includes balanced rows (short ≤ 0) so a rebuild
    can mark ``found_offset``. Does not invent qty from case ``quantity``.
    """
    out: dict[tuple[str, str], dict] = {}
    for it in shipment_items:
        _ingest_live_qty_row(out, it)
    for raw in sellerboard_rows:
        _ingest_live_qty_row(out, raw)
    for raw in amazon_rows or []:
        _ingest_live_qty_row(out, raw)
    return out


def collect_reconcile_shipment_ids(*row_groups: Iterable[dict]) -> list[str]:
    """Unique FBA* ids from open inbound Needs-case / Sellerboard rows."""
    ids: list[str] = []
    seen: set[str] = set()
    for rows in row_groups:
        for row in rows:
            sid = fba_shipment_id(row.get("shipment_id"))
            if not sid or sid in seen:
                continue
            if not _is_inbound_event(row) and row.get("source") not in INBOUND_SOURCES:
                continue
            seen.add(sid)
            ids.append(sid)
    return ids


def amazon_qty_from_spapi_payloads(
    shipments: Iterable[dict],
    items_by_sid: dict[str, list[dict]],
) -> tuple[list[dict], dict[str, dict]]:
    """Parse inbound v0 payloads into item rows + shipment-level totals.

    Item SKUs are case-insensitive. Shipment-level totals are used only
    when Amazon returns ≤1 SKU (or header-only) so we do not invent
    per-SKU balance on multi-SKU shipments.
    """
    rows: list[dict] = []
    totals: dict[str, dict] = {}
    for sh in shipments:
        sid = fba_shipment_id(
            sh.get("ShipmentId") or sh.get("shipmentId") or sh.get("shipment_id"),
        )
        if not sid:
            continue
        header_shipped = _int_or_none(
            sh.get("QuantityShipped") or sh.get("quantityShipped") or sh.get("quantity_shipped"),
        )
        header_received = _int_or_none(
            sh.get("QuantityReceived") or sh.get("quantityReceived") or sh.get("quantity_received"),
        )
        items = items_by_sid.get(sid) or []
        sku_count = 0
        for it in items:
            sku = (
                it.get("SellerSKU")
                or it.get("sellerSKU")
                or it.get("sku")
                or it.get("FulfillmentNetworkSKU")
            )
            shipped = _int_or_none(
                it.get("QuantityShipped") or it.get("quantityShipped") or it.get("quantity_shipped"),
            )
            received = _int_or_none(
                it.get("QuantityReceived") or it.get("quantityReceived") or it.get("quantity_received"),
            )
            key = inbound_match_key(sid, sku)
            if not key or (shipped is None and received is None):
                continue
            sku_count += 1
            rows.append({
                "shipment_id": sid,
                "sku": key[1],
                "quantity_shipped": shipped,
                "quantity_received": received,
                "quantity_short": inbound_live_short(shipped, received),
            })
        totals[sid] = {
            "quantity_shipped": header_shipped,
            "quantity_received": header_received,
            "quantity_short": inbound_live_short(header_shipped, header_received),
            "sku_count": sku_count,
        }
    return rows, totals


def fetch_amazon_inbound_qty(
    shipment_ids: Iterable[str],
    *,
    get_shipments=None,
    get_items=None,
    batch_size: int = AMAZON_RECONCILE_BATCH,
) -> tuple[list[dict], dict[str, dict]]:
    """Live FBA inbound v0 getShipments(SHIPMENT) + getShipmentItems.

    Batches of 1–5. Large 50-id lists silently return only a few CLOSED
    headers. No I/O when callables are injected (unit tests).
    """
    ids = []
    seen: set[str] = set()
    for raw in shipment_ids:
        sid = fba_shipment_id(raw)
        if sid and sid not in seen:
            seen.add(sid)
            ids.append(sid)
    if not ids:
        return [], {}
    size = max(1, min(int(batch_size or AMAZON_RECONCILE_BATCH), AMAZON_RECONCILE_BATCH))
    if get_shipments is None or get_items is None:
        from src.inventory.inbound_shipments import (
            _get_shipment_items,
            _get_shipments_by_ids,
        )
        if get_shipments is None:
            get_shipments = _get_shipments_by_ids
        if get_items is None:
            get_items = _get_shipment_items
    shipments: list[dict] = []
    for i in range(0, len(ids), size):
        batch = ids[i : i + size]
        try:
            shipments.extend(get_shipments(batch) or [])
        except Exception as e:
            log.warning("Amazon getShipments batch failed (%s): %s", batch, e)
    items_by_sid: dict[str, list[dict]] = {}
    for sh in shipments:
        sid = fba_shipment_id(
            sh.get("ShipmentId") or sh.get("shipmentId") or sh.get("shipment_id"),
        )
        if not sid or sid in items_by_sid:
            continue
        try:
            items_by_sid[sid] = list(get_items(sid) or [])
        except Exception as e:
            log.warning("Amazon getShipmentItems failed for %s: %s", sid, e)
            items_by_sid[sid] = []
    return amazon_qty_from_spapi_payloads(shipments, items_by_sid)


def _mark_inbound_found_offset(row: dict, info: dict | None = None) -> dict:
    out = dict(row)
    if info:
        if info.get("quantity_shipped") is not None:
            out["quantity_shipped"] = info["quantity_shipped"]
        if info.get("quantity_received") is not None:
            out["quantity_received"] = info["quantity_received"]
    out["quantity"] = 0
    if out.get("status") != STATUS_ALREADY_REIMBURSED:
        out["status"] = STATUS_FOUND_OFFSET
    if not out.get("dismissed_note"):
        out["dismissed_note"] = CLEAR_NOTE_RECONCILED
    return out


def apply_inbound_balance(
    events: list[dict],
    live: dict[tuple[str, str], dict],
    existing: Iterable[dict] | None = None,
    shipment_totals: dict[str, dict] | None = None,
) -> list[dict]:
    """Refresh inbound ship/recv and clear Needs case when live short ≤ 0.

    Evidence stays (status ``found_offset``). Does not invent balanced
    shipments — only clears when Amazon/Sellerboard or stored ship/recv
    show shipped ≤ received or ``quantity_short <= 0``. Case-insensitive SKU.
    Amazon shipment-level totals apply only for single-SKU shipments.
    Auto-reconcile does not set ``dismissed_at`` so a later short can reopen.
    """
    existing_list = list(existing or [])
    totals = shipment_totals or {}
    out: list[dict] = []
    seen: set[str] = set()

    def _skus_for_sid(sid: str) -> set[str]:
        skus: set[str] = set()
        for row in list(events) + existing_list:
            key = inbound_match_key(row.get("shipment_id"), row.get("sku"))
            if key and key[0] == sid:
                skus.add(key[1])
        return skus

    def _shipment_fallback(sid: str) -> dict | None:
        tot = totals.get(sid)
        if not tot:
            return None
        sku_count = tot.get("sku_count")
        try:
            n = int(sku_count) if sku_count is not None else 0
        except (TypeError, ValueError):
            n = 0
        if n > 1:
            return None
        if n == 0 and len(_skus_for_sid(sid)) != 1:
            return None
        shipped = _int_or_none(tot.get("quantity_shipped"))
        received = _int_or_none(tot.get("quantity_received"))
        short = inbound_live_short(shipped, received, _int_or_none(tot.get("quantity_short")))
        if shipped is None and received is None and short is None:
            return None
        return {
            "quantity_shipped": shipped,
            "quantity_received": received,
            "quantity_short": short,
        }

    def _refresh(row: dict) -> dict:
        rec = dict(row)
        key = inbound_match_key(rec.get("shipment_id"), rec.get("sku"))
        info = live.get(key) if key else None
        if not info and key:
            info = _shipment_fallback(key[0])
        if info:
            if info.get("quantity_shipped") is not None:
                rec["quantity_shipped"] = info["quantity_shipped"]
            if info.get("quantity_received") is not None:
                rec["quantity_received"] = info["quantity_received"]
        if not _is_inbound_event(rec):
            return rec
        shipped = _int_or_none(rec.get("quantity_shipped"))
        received = _int_or_none(rec.get("quantity_received"))
        live_short = info.get("quantity_short") if info else None
        short = inbound_live_short(shipped, received, live_short)
        if short is not None and short <= 0:
            return _mark_inbound_found_offset(rec, info)
        if short is not None and rec.get("status") != STATUS_FOUND_OFFSET:
            rec["quantity"] = short
        return rec

    for ev in events:
        row = _refresh(ev)
        out.append(row)
        key = str(row.get("event_key") or "").strip()
        if key:
            seen.add(key)

    for prior in existing_list:
        if prior.get("status") not in (
            STATUS_NEEDS_CASE, STATUS_CASE_SUBMITTED, STATUS_FOUND_OFFSET,
        ):
            continue
        if not _is_inbound_event(prior):
            continue
        match = inbound_match_key(prior.get("shipment_id"), prior.get("sku"))
        ek = str(prior.get("event_key") or "").strip()
        if match:
            ek = ek or inbound_event_key(match[0], match[1])
        if not ek or ek in seen:
            continue
        info = live.get(match) if match else None
        if not info and match:
            info = _shipment_fallback(match[0])
        shipped = (info or {}).get("quantity_shipped")
        if shipped is None:
            shipped = _int_or_none(prior.get("quantity_shipped"))
        received = (info or {}).get("quantity_received")
        if received is None:
            received = _int_or_none(prior.get("quantity_received"))
        short = inbound_live_short(
            shipped,
            received,
            (info or {}).get("quantity_short"),
        )
        row = dict(prior)
        row["event_key"] = ek
        if match:
            row["shipment_id"] = match[0]
            row["sku"] = match[1]
        row["reason"] = row.get("reason") or "Lost_Inbound"
        row["reason_group"] = "lost_inbound"
        if short is not None and short <= 0:
            out.append(_mark_inbound_found_offset(row, {
                "quantity_shipped": shipped,
                "quantity_received": received,
                "quantity_short": short,
            }))
            seen.add(ek)
            continue
        if (
            prior.get("status") == STATUS_FOUND_OFFSET
            and short is not None
            and short > 0
            and not prior.get("dismissed_at")
        ):
            row["quantity"] = short
            row["status"] = STATUS_NEEDS_CASE
            if shipped is not None:
                row["quantity_shipped"] = shipped
            if received is not None:
                row["quantity_received"] = received
            out.append(row)
            seen.add(ek)
    return out


def merge_inbound_sources(
    spapi: Iterable[dict],
    sellerboard: Iterable[dict],
) -> list[dict]:
    """One Lost_Inbound row per FBA shipment + SKU.

    Prefer SP-API ``inbound_discrepancy`` when both exist; keep Sellerboard
    when SP-API warehouse has no CLOSED row for that shipment.
    """
    by_key: dict[tuple[str, str], dict] = {}
    for ev in sellerboard:
        key = inbound_source_key(ev)
        if key:
            by_key[key] = ev
    for ev in spapi:
        key = inbound_source_key(ev)
        if not key:
            continue
        existing = by_key.get(key)
        row = dict(ev)
        if existing:
            row.setdefault("quantity_shipped", existing.get("quantity_shipped"))
            row.setdefault("quantity_received", existing.get("quantity_received"))
            if not row.get("fulfillment_center"):
                row["fulfillment_center"] = existing.get("fulfillment_center")
            if not row.get("asin"):
                row["asin"] = existing.get("asin")
        by_key[key] = row
    return list(by_key.values())


def existing_sellerboard_rows(existing: Iterable[dict]) -> list[dict]:
    """Dana-upserted fba_case_events with source sellerboard_inbound."""
    out: list[dict] = []
    for row in existing:
        if row.get("source") != SOURCE_SELLERBOARD:
            continue
        out.append(row)
    return out


def preserve_submitted_status(
    events: list[dict],
    existing: Iterable[dict],
) -> list[dict]:
    """Keep Dave's case_submitted / manual reconciled dismiss across Mini rebuilds.

    Paid / live found-offset wins. Auto-reconcile (found_offset without
    dismissed_at) is recomputed each sync so a later short can reopen.
    New event_keys (new shipment) stay Needs case.
    """
    prior: dict[str, dict] = {}
    for row in existing:
        key = str(row.get("event_key") or "").strip()
        if not key:
            continue
        status = row.get("status")
        if status == STATUS_CASE_SUBMITTED:
            prior[key] = row
        elif status == STATUS_FOUND_OFFSET and row.get("dismissed_at"):
            prior[key] = row
    out: list[dict] = []
    for ev in events:
        row = dict(ev)
        key = str(row.get("event_key") or "").strip()
        saved = prior.get(key)
        if saved and row.get("status") == STATUS_NEEDS_CASE:
            row["status"] = saved.get("status") or STATUS_CASE_SUBMITTED
            row["dismissed_at"] = saved.get("dismissed_at")
            row["dismissed_note"] = saved.get("dismissed_note")
        out.append(row)
    return out


def preserve_found_offset_unless_amazon_short(
    events: list[dict],
    existing: Iterable[dict],
    amazon_live: dict[tuple[str, str], dict] | None = None,
    amazon_totals: dict[str, dict] | None = None,
) -> list[dict]:
    """Keep Amazon-cleared found_offset rows across Sellerboard upserts.

    Reopen only when live Amazon short > 0. Missing Amazon data must not
    let a stale Sellerboard short revive last night's 24 balanced IDs.
    Manual dismiss (dismissed_at) still wins via preserve_submitted_status.
    """
    prior: dict[str, dict] = {}
    for row in existing:
        key = str(row.get("event_key") or "").strip()
        if key and row.get("status") == STATUS_FOUND_OFFSET:
            prior[key] = row
    if not prior:
        return events
    live = amazon_live or {}
    totals = amazon_totals or {}
    out: list[dict] = []
    for ev in events:
        row = dict(ev)
        saved = prior.get(str(row.get("event_key") or "").strip())
        if saved and row.get("status") not in (
            STATUS_ALREADY_REIMBURSED, STATUS_CASE_SUBMITTED, STATUS_FOUND_OFFSET,
        ):
            match = inbound_match_key(row.get("shipment_id"), row.get("sku"))
            info = live.get(match) if match else None
            if not info and match:
                tot = totals.get(match[0]) or {}
                try:
                    sku_count = int(tot.get("sku_count") or 0)
                except (TypeError, ValueError):
                    sku_count = 0
                if sku_count <= 1:
                    info = tot or None
            short = None
            if info:
                short = inbound_live_short(
                    _int_or_none(info.get("quantity_shipped")),
                    _int_or_none(info.get("quantity_received")),
                    _int_or_none(info.get("quantity_short")),
                )
            if short is None or short <= 0:
                row = _mark_inbound_found_offset(row, info)
                if saved.get("dismissed_note"):
                    row["dismissed_note"] = saved.get("dismissed_note")
        out.append(row)
    return out


def is_active_inbound_alert(row: dict) -> bool:
    """Overview alert: CLOSED/stale inbound short, not submitted / paid / zero."""
    if row.get("status") != STATUS_NEEDS_CASE:
        return False
    if int(row.get("quantity") or 0) <= 0:
        return False
    if reason_group(row.get("reason"), row.get("disposition")) != "lost_inbound":
        return False
    source = row.get("source")
    if source in INBOUND_SOURCES:
        return bool(fba_shipment_id(row.get("shipment_id")))
    # Ledger Lost_Inbound with a real FBA* id is the same discrepancy.
    return bool(fba_shipment_id(row.get("shipment_id")))


def _unreconciled(row: dict) -> int | None:
    raw = row.get("unreconciled_qty")
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def negative_adjustments_in_window(
    adjustments: Iterable[dict], start: date, end: date,
) -> list[dict]:
    """Negative ledger rows in the window (for unknown-reason QA)."""
    out: list[dict] = []
    for row in adjustments:
        day = _parse_day(row.get("event_date"))
        if day is None or day < start or day > end:
            continue
        try:
            qty = int(row.get("quantity") or 0)
        except (TypeError, ValueError):
            continue
        if qty >= 0:
            continue
        out.append(row)
    return out


def adjustment_candidates(adjustments: Iterable[dict], start: date, end: date) -> list[dict]:
    """Negative eligible-reason ledger adjustments in the window.

    Q/P disposition churn, D/G disposed, N/O corrections, and Found are excluded.
    Disposition (WAREHOUSE_DAMAGED) cannot promote D/O or unknown letters.
    Letter M is lost_warehouse (misplaced), never lost inbound.
    Digit ``reference_id`` values are ledger transaction IDs, not FBA shipments.
    """
    out: list[dict] = []
    for row in adjustments:
        day = _parse_day(row.get("event_date"))
        if day is None or day < start or day > end:
            continue
        try:
            qty = int(row.get("quantity") or 0)
        except (TypeError, ValueError):
            continue
        reason = row.get("reason")
        disposition = row.get("disposition")
        if not is_eligible_loss(reason, qty, disposition, _unreconciled(row)):
            continue
        sku = normalize_sku(row.get("sku"))
        ref = row.get("reference_id")
        group = reason_group(reason, disposition)
        sid = fba_shipment_id(row.get("shipment_id"), ref)
        url, kind = seller_central_link(sid, None, group)
        out.append({
            "event_key": row.get("event_key") or "",
            "source": SOURCE_LEDGER,
            "event_date": day,
            "sku": sku,
            "asin": row.get("asin"),
            "fnsku": row.get("fnsku"),
            "product_name": row.get("product_name"),
            "quantity": abs(qty),
            "reason": reason or "Unknown",
            "reason_group": group,
            "reason_label": reason_label(reason, disposition),
            "fulfillment_center": row.get("fulfillment_center"),
            "shipment_id": sid,
            "reference_id": ref,
            "disposition": disposition,
            "classification_version": CLASSIFICATION_VERSION,
            "seller_central_url": url,
            "seller_central_link_kind": kind,
        })
    return out


def found_offsets(adjustments: Iterable[dict]) -> list[tuple[date, str, str, int]]:
    """(date, sku, fc, qty) for Found / Found_Warehouse (positive qty)."""
    out: list[tuple[date, str, str, int]] = []
    for row in adjustments:
        if not is_found_reason(row.get("reason")):
            continue
        try:
            qty = int(row.get("quantity") or 0)
        except (TypeError, ValueError):
            continue
        if qty <= 0:
            continue
        day = _parse_day(row.get("event_date"))
        if day is None:
            continue
        out.append((
            day,
            normalize_sku(row.get("sku")),
            (row.get("fulfillment_center") or "").upper(),
            qty,
        ))
    return out


def apply_found_offsets(events: list[dict], found: list[tuple[date, str, str, int]]) -> list[dict]:
    """Reduce lost/damage qty when a later Found lands for the same SKU+FC."""
    pool = [{"day": d, "sku": s, "fc": f, "qty": q} for d, s, f, q in found]
    out: list[dict] = []
    for ev in sorted(events, key=lambda e: (e["event_date"], e["event_key"])):
        left = int(ev["quantity"])
        sku = ev["sku"]
        fc = (ev.get("fulfillment_center") or "").upper()
        for item in pool:
            if left <= 0:
                break
            if item["qty"] <= 0 or item["sku"] != sku or item["fc"] != fc:
                continue
            delta = (item["day"] - ev["event_date"]).days
            if delta < 0 or delta > FOUND_OFFSET_DAYS:
                continue
            take = min(left, item["qty"])
            item["qty"] -= take
            left -= take
        row = dict(ev)
        if left <= 0:
            row["quantity"] = 0
            row["status"] = STATUS_FOUND_OFFSET
            row["matched_reimbursement_id"] = None
            row["matched_reimbursed_qty"] = 0
        else:
            row["quantity"] = left
        out.append(row)
    return out



def _is_receipt_event(row: dict) -> bool:
    et = (row.get("event_type") or "").strip().lower()
    return "receipt" in et




def collect_receipt_qty_by_shipment(
    receipt_events: Iterable[dict],
) -> dict[tuple[str, str], int]:
    """Sum Receipts qty keyed by (FBA shipment_id, normalized SKU).

    Ledger detail Reference ID for Receipts is the FBA* shipment id when
    Amazon stamped it. Rows without a parseable FBA reference are ignored
    here (see ``collect_receipt_qty_pool``).
    """
    out: dict[tuple[str, str], int] = {}
    for row in receipt_events:
        if not _is_receipt_event(row):
            continue
        try:
            qty = int(row.get("quantity") or 0)
        except (TypeError, ValueError):
            continue
        if qty <= 0:
            continue
        sid = fba_shipment_id(
            row.get("reference_id"),
            row.get("shipment_id"),
            (row.get("raw_data") or {}).get("reference_id")
            if isinstance(row.get("raw_data"), dict)
            else None,
            (row.get("raw_data") or {}).get("Reference ID")
            if isinstance(row.get("raw_data"), dict)
            else None,
        )
        sku = normalize_sku(row.get("sku") or row.get("msku"))
        if not sid or sku == "UNKNOWN":
            continue
        key = (sid, sku)
        out[key] = out.get(key, 0) + qty
    return out


def collect_receipt_qty_pool(
    receipt_events: Iterable[dict],
) -> list[dict]:
    """Consumable Receipts pool for zero-recv CLOSED heuristic cover.

    Each pool row is one ledger Receipt line (sku, day, qty left, fc).
    Exact-qty consumption prevents one receipt from clearing two ghosts.
    """
    pool: list[dict] = []
    for row in receipt_events:
        if not _is_receipt_event(row):
            continue
        try:
            qty = int(row.get("quantity") or 0)
        except (TypeError, ValueError):
            continue
        if qty <= 0:
            continue
        day = _parse_day(row.get("event_date"))
        if day is None:
            continue
        sku = normalize_sku(row.get("sku") or row.get("msku"))
        if sku == "UNKNOWN":
            continue
        # Skip rows already attributed to a specific FBA id — those are
        # handled by collect_receipt_qty_by_shipment.
        sid = fba_shipment_id(
            row.get("reference_id"),
            row.get("shipment_id"),
            (row.get("raw_data") or {}).get("reference_id")
            if isinstance(row.get("raw_data"), dict)
            else None,
        )
        pool.append({
            "sku": sku,
            "day": day,
            "qty": qty,
            "fc": (row.get("fc_code") or row.get("fulfillment_center") or "").upper(),
            "shipment_id": sid,
        })
    return pool


def _receipt_cover_for_row(
    row: dict,
    by_shipment: dict[tuple[str, str], int],
    pool: list[dict],
) -> tuple[int, str | None]:
    """Return (covered_qty, basis) for one Lost_Inbound row."""
    key = inbound_match_key(row.get("shipment_id"), row.get("sku"))
    if not key:
        return 0, None
    sid, sku = key
    shipped = _int_or_none(row.get("quantity_shipped"))
    if shipped is None:
        shipped = _int_or_none(row.get("quantity"))
    if shipped is None or shipped <= 0:
        return 0, None

    direct = int(by_shipment.get(key) or 0)
    if direct >= shipped:
        return shipped, "reference_id"
    if direct > 0:
        return direct, "reference_id"

    # Heuristic: only for Sellerboard-style zero-recv (or missing recv) CLOSED
    # ghosts. Real partials keep Amazon/Sellerboard ship−recv.
    received = _int_or_none(row.get("quantity_received"))
    if received is not None and received > 0:
        return 0, None

    anchor = _plan_anchor_day(row) or _parse_day(row.get("event_date"))
    if anchor is None:
        return 0, None
    earliest = anchor - timedelta(days=RECEIPT_COVER_BEFORE_DAYS)
    latest = anchor + timedelta(days=RECEIPT_COVER_AFTER_DAYS)

    # Prefer exact-qty unused receipt (no shipment_id, or matching sid).
    for item in pool:
        if item["qty"] <= 0 or item["sku"] != sku:
            continue
        if item["day"] < earliest or item["day"] > latest:
            continue
        if item.get("shipment_id") and item["shipment_id"] != sid:
            continue
        if item["qty"] == shipped:
            item["qty"] = 0
            return shipped, "sku_qty_pool"

    # Otherwise consume multiple receipts up to shipped.
    covered = 0
    for item in pool:
        if covered >= shipped:
            break
        if item["qty"] <= 0 or item["sku"] != sku:
            continue
        if item["day"] < earliest or item["day"] > latest:
            continue
        if item.get("shipment_id") and item["shipment_id"] != sid:
            continue
        take = min(shipped - covered, item["qty"])
        item["qty"] -= take
        covered += take
    if covered > 0:
        return covered, "sku_qty_pool"
    return 0, None


def apply_receipt_cover(
    events: list[dict],
    receipt_events: Iterable[dict] | None = None,
    *,
    durable_zero_recv: bool = True,
) -> list[dict]:
    """Clear Lost_Inbound when warehouse Receipts cover shipped qty.

    Prefer Reference-ID (= FBA*) matches. For CLOSED zero-recv Sellerboard
    ghosts without reference_id yet, consume an exact-qty SKU receipt pool
    near the plan/ship date. Durable dismiss (dismissed_at) for full cover
    on zero-recv so Sellerboard 0-recv dumps cannot reopen the ghost.
    Real recv shorts (received > 0 and short > 0) are left alone unless a
    shipment-keyed receipt reduces the remaining short.
    """
    receipts = list(receipt_events or [])
    if not receipts:
        return events
    by_shipment = collect_receipt_qty_by_shipment(receipts)
    pool = collect_receipt_qty_pool(receipts)
    now = datetime.now(timezone.utc).isoformat()
    out: list[dict] = []
    for ev in events:
        row = dict(ev)
        if not _is_inbound_event(row):
            out.append(row)
            continue
        if row.get("status") == STATUS_ALREADY_REIMBURSED:
            out.append(row)
            continue
        orig_recv = _int_or_none(row.get("quantity_received"))
        # case_submitted: only reclassify zero-recv ghosts (wrongly filed)
        if row.get("status") == STATUS_CASE_SUBMITTED and orig_recv not in (None, 0):
            out.append(row)
            continue
        covered, basis = _receipt_cover_for_row(row, by_shipment, pool)
        if covered <= 0:
            out.append(row)
            continue
        shipped = _int_or_none(row.get("quantity_shipped"))
        if shipped is None:
            shipped = _int_or_none(row.get("quantity")) or covered
        stored_recv = orig_recv if orig_recv is not None else 0
        effective_recv = max(stored_recv, covered)
        short = shipped - effective_recv
        info = {
            "quantity_shipped": shipped,
            "quantity_received": effective_recv,
        }
        if short <= 0:
            row = _mark_inbound_found_offset(row, info)
            row["dismissed_note"] = CLEAR_NOTE_RECEIPTS_COVER
            zero_recv_ghost = orig_recv in (None, 0)
            if durable_zero_recv and zero_recv_ghost and not row.get("dismissed_at"):
                row["dismissed_at"] = now
            row["receipt_cover_basis"] = basis
            row["receipt_cover_qty"] = covered
        else:
            # Partial receipt cover on a real short — keep Needs-case remainder.
            if row.get("status") == STATUS_CASE_SUBMITTED:
                out.append(dict(ev))
                continue
            row["quantity_shipped"] = shipped
            row["quantity_received"] = effective_recv
            row["quantity"] = short
            if row.get("status") == STATUS_FOUND_OFFSET and not row.get("dismissed_at"):
                row["status"] = STATUS_NEEDS_CASE
            elif row.get("status") not in (STATUS_FOUND_OFFSET, STATUS_CASE_SUBMITTED):
                row["status"] = STATUS_NEEDS_CASE
            row["receipt_cover_basis"] = basis
            row["receipt_cover_qty"] = covered
        out.append(row)
    return out


def _paid_units(row: dict) -> int:

    total = int(row.get("qty_total") or 0)
    if total != 0:
        return max(total, 0)
    return max(int(row.get("qty_cash") or 0) + int(row.get("qty_inventory") or 0), 0)


def paid_pool(reimbursements: Iterable[dict]) -> list[dict]:
    """Positive paid units grouped for consumption."""
    pool: list[dict] = []
    for row in reimbursements:
        group = reason_group(row.get("reason"))
        if group not in ELIGIBLE_REASON_GROUPS:
            continue
        units = _paid_units(row)
        if units <= 0:
            continue
        day = _parse_day(row.get("approval_date"))
        if day is None:
            continue
        ship_ref = fba_shipment_id(
            row.get("case_id"),
            row.get("order_id"),
            row.get("amazon_order_id"),
            row.get("shipment_id"),
        )
        pool.append({
            "sku": normalize_sku(row.get("sku")),
            "group": group,
            "day": day,
            "qty": units,
            "reimbursement_id": row.get("reimbursement_id"),
            "amount_per_unit": float(row.get("amount_per_unit") or 0) or None,
            "amount_total": float(row.get("amount_total") or 0),
            "shipment_id": ship_ref,  # FBA* only when paid row ties to a shipment
        })
    return pool


def estimate_unit_rate(paid: list[dict], sku: str, group: str) -> tuple[float | None, str]:
    """Recent positive amount_per_unit for the same SKU (prefer same group)."""
    matches = [
        p for p in paid
        if p["sku"] == sku and p.get("amount_per_unit") and p["amount_per_unit"] > 0
    ]
    same = [p for p in matches if p["group"] == group]
    use = same or matches
    if not use:
        return None, AMOUNT_BASIS_UNKNOWN
    use.sort(key=lambda p: p["day"], reverse=True)
    return float(use[0]["amount_per_unit"]), AMOUNT_BASIS_RECENT


def apply_paid_dedupe(events: list[dict], reimbursements: Iterable[dict]) -> list[dict]:
    """Subtract paid units; leftover stays Needs case.

    Lost_Inbound rows with a real FBA shipment_id only consume reimbursements
    tied to that shipment (case_id / order_id is FBA*). SKU-pooled Lost_Inbound
    cash is recorded on ``sku_pool_reimbursed_qty`` for transparency but does
    **not** reduce that shipment's claimable qty (stops fake "partial reimb
    28/85 on this shipment").
    """
    pool = paid_pool(reimbursements)
    out: list[dict] = []
    for ev in sorted(events, key=lambda e: (e["event_date"], e["event_key"])):
        if ev.get("status") == STATUS_FOUND_OFFSET:
            ev.setdefault("estimated_amount", None)
            ev.setdefault("amount_basis", AMOUNT_BASIS_UNKNOWN)
            ev.setdefault("matched_reimbursement_id", None)
            ev.setdefault("matched_reimbursed_qty", 0)
            ev.setdefault("sku_pool_reimbursed_qty", 0)
            out.append(ev)
            continue
        left = int(ev["quantity"])
        matched_id = None
        matched_qty = 0
        sku_pool_qty = 0
        sku = ev["sku"]
        group = ev["reason_group"]
        event_day: date = ev["event_date"]
        event_sid = fba_shipment_id(ev.get("shipment_id"))
        shipment_scoped = bool(event_sid) and group == "lost_inbound"
        for item in pool:
            if left <= 0 and not shipment_scoped:
                break
            if item["qty"] <= 0 or item["sku"] != sku or item["group"] != group:
                continue
            earliest = event_day - timedelta(days=PAID_SETTLE_PAD_DAYS)
            latest = event_day + timedelta(days=PAID_LOOKAHEAD_DAYS)
            if item["day"] < earliest or item["day"] > latest:
                continue
            item_sid = item.get("shipment_id")
            if shipment_scoped:
                if item_sid and item_sid == event_sid:
                    take = min(left, item["qty"])
                    item["qty"] -= take
                    left -= take
                    matched_qty += take
                    matched_id = item.get("reimbursement_id") or matched_id
                elif not item_sid:
                    # SKU-pool only — do not attribute to this shipment.
                    sku_pool_qty += item["qty"]
                # else: paid against a different FBA id — ignore
                continue
            take = min(left, item["qty"])
            item["qty"] -= take
            left -= take
            matched_qty += take
            matched_id = item.get("reimbursement_id") or matched_id
        rate, basis = estimate_unit_rate(pool, sku, group)
        row = dict(ev)
        row["matched_reimbursement_id"] = matched_id
        row["matched_reimbursed_qty"] = matched_qty
        row["sku_pool_reimbursed_qty"] = sku_pool_qty if shipment_scoped else 0
        if left <= 0:
            row["quantity"] = 0
            row["status"] = STATUS_ALREADY_REIMBURSED
            row["estimated_amount"] = None
            row["amount_basis"] = AMOUNT_BASIS_UNKNOWN
        else:
            row["quantity"] = left
            row["status"] = STATUS_NEEDS_CASE
            if rate is not None:
                row["estimated_amount"] = round(rate * left, 2)
                row["amount_basis"] = basis
            else:
                row["estimated_amount"] = None
                row["amount_basis"] = AMOUNT_BASIS_UNKNOWN
        out.append(row)
    return out


def _enrich_asin(events: list[dict], adjustments: Iterable[dict], paid: Iterable[dict]) -> list[dict]:
    by_sku: dict[str, str] = {}
    for row in list(adjustments) + list(paid):
        sku = normalize_sku(row.get("sku"))
        asin = (row.get("asin") or "").strip()
        if sku != "UNKNOWN" and asin and sku not in by_sku:
            by_sku[sku] = asin
    out = []
    for ev in events:
        row = dict(ev)
        if not row.get("asin"):
            row["asin"] = by_sku.get(row["sku"])
        out.append(row)
    return out


def build_case_events(
    *,
    adjustments: Iterable[dict],
    shipments: Iterable[dict],
    shipment_items: Iterable[dict],
    reimbursements: Iterable[dict],
    start: date,
    end: date,
    as_of: date | None = None,
    sellerboard_rows: Iterable[dict] | None = None,
    existing_events: Iterable[dict] | None = None,
    amazon_inbound_rows: Iterable[dict] | None = None,
    amazon_shipment_totals: dict[str, dict] | None = None,
    receipt_events: Iterable[dict] | None = None,
) -> list[dict]:
    """Pure builder — no I/O. Returns rows ready for fba_case_events."""
    as_of = as_of or end
    adj_list = list(adjustments)
    paid_list = list(reimbursements)
    existing_list = list(existing_events or [])
    items_list = list(shipment_items)
    sb_live = list(sellerboard_rows or [])
    amazon_rows = list(amazon_inbound_rows or [])
    receipts = list(receipt_events or [])
    live_qty = collect_live_inbound_qty(sb_live, items_list, amazon_rows)
    ledger = adjustment_candidates(adj_list, start, end)
    spapi_inbound = inbound_discrepancies(shipments, items_list, as_of, start, end)
    sb_raw = sb_live + existing_sellerboard_rows(existing_list)
    sb_inbound = sellerboard_inbound_discrepancies(sb_raw, as_of, start, end)
    inbound = merge_inbound_sources(spapi_inbound, sb_inbound)
    # Prefer inbound row when the same FBA id + SKU also appears as Lost_Inbound
    # on the ledger — one Needs-case line, shipment link kept.
    inbound_keys = {(e["shipment_id"], e["sku"]) for e in inbound if e.get("shipment_id")}
    ledger_kept = []
    for ev in ledger:
        sid = ev.get("shipment_id")
        if ev["reason_group"] == "lost_inbound" and sid and (sid, ev["sku"]) in inbound_keys:
            continue
        ledger_kept.append(ev)
    merged = apply_found_offsets(ledger_kept + inbound, found_offsets(adj_list))
    merged = apply_inbound_balance(
        merged, live_qty, existing_list, amazon_shipment_totals,
    )
    amazon_only = collect_live_inbound_qty([], [], amazon_rows)
    merged = preserve_found_offset_unless_amazon_short(
        merged, existing_list, amazon_only, amazon_shipment_totals,
    )
    # Receipts SoT after Amazon/Sellerboard balance — clears zero-recv CLOSED
    # ghosts even when SP-API is silent or also shows UnitsReceived=0.
    merged = apply_receipt_cover(merged, receipts)
    merged = _enrich_asin(merged, adj_list, paid_list)
    out = apply_paid_dedupe(merged, paid_list)
    out = preserve_submitted_status(out, existing_list)
    for row in out:
        row["classification_version"] = CLASSIFICATION_VERSION
        row["reason_group"] = reason_group(row.get("reason"), row.get("disposition"))
        row["reason_label"] = reason_label(row.get("reason"), row.get("disposition"))
        group = row["reason_group"]
        sid = fba_shipment_id(row.get("shipment_id"), None)
        row["shipment_id"] = sid
        url, kind = seller_central_link(sid, None, group)
        row["seller_central_url"] = url
        row["seller_central_link_kind"] = kind
    return out


# Ephemeral builder keys — not columns on fba_case_events.
_STAMP_DROP = frozenset({
    "raw", "plan_date", "receipt_cover_basis", "receipt_cover_qty",
    "sku_pool_reimbursed_qty", "reason_label",
})


def _stamp(rows: list[dict]) -> list[dict]:
    now = datetime.now(timezone.utc).isoformat()
    out = []
    for row in rows:
        rec = {k: v for k, v in row.items() if k not in _STAMP_DROP}
        day = rec.get("event_date")
        if isinstance(day, date):
            rec["event_date"] = day.isoformat()
        rec["synced_at"] = now
        rec["classification_version"] = CLASSIFICATION_VERSION
        out.append(rec)
    return out


def _with_one_retry(fn, *args, **kwargs):
    """Retry a warehouse read/write once on transient failure."""
    try:
        return fn(*args, **kwargs)
    except Exception as e:
        log.warning("Transient warehouse failure, retrying once: %s", e)
        return fn(*args, **kwargs)


def orphan_needs_case_keys(existing: Iterable[dict]) -> list[str]:
    """event_keys that are still needs_case but are no longer eligible.

    Upsert-only rebuilds leave stale D/O (and other excluded-letter) rows.
    Mini must delete these orphans after reimbursements-case-sync.
    """
    keys: list[str] = []
    for row in existing:
        if row.get("status") != STATUS_NEEDS_CASE:
            continue
        key = str(row.get("event_key") or "").strip()
        if not key:
            continue
        if row.get("source") in INBOUND_SOURCES and reason_group(row.get("reason")) == "lost_inbound":
            continue
        entry = lookup_reason(row.get("reason"))
        if entry and entry.eligible:
            continue
        keys.append(key)
    return keys


def purge_ineligible_needs_case_orphans() -> int:
    """Delete stale D/O (and other ineligible) needs_case rows left by upsert."""
    from src.db import fetch_all, get_client

    existing = _with_one_retry(fetch_all, "fba_case_events", {"status": STATUS_NEEDS_CASE})
    keys = orphan_needs_case_keys(existing)
    if not keys:
        return 0
    client = get_client()
    deleted = 0
    for i in range(0, len(keys), 200):
        chunk = keys[i : i + 200]
        result = (
            client.table("fba_case_events")
            .delete()
            .eq("status", STATUS_NEEDS_CASE)
            .in_("event_key", chunk)
            .execute()
        )
        deleted += len(result.data) if result.data else 0
    if deleted:
        log.warning("Purged %s ineligible needs_case orphans (D/O and excluded codes)", deleted)
    return deleted


def fail_if_empty_adjustments_pull(
    previous_count: int,
    pulled: int,
    pull_error: str | None,
) -> None:
    """Loud fail when a live pull is empty after a prior sync had rows."""
    if previous_count > 0 and pulled <= 0:
        detail = pull_error or "adjustments pull returned 0 rows"
        raise CaseQueueSyncError(
            "Adjustments pull returned empty when previous sync had "
            f"{previous_count} rows ({detail}). Do not rebuild from an empty "
            f"ledger. {MINI_RESYNC_HINT}"
        )


def sync_case_queue(
    days: int | None = None,
    dry_run: bool = False,
    fetch_ledger: bool = True,
    on_poll: callable | None = None,
) -> dict:
    """Pull ledger Adjustments (optional) and rebuild fba_case_events.

    Retries warehouse read/write once. Fails loudly when a live adjustments
    pull is empty after a prior sync had rows, or when unknown-reason QA
    exceeds the threshold. Mini must re-run this after a classification
    deploy so ``classification_version`` is current.
    """
    from src.amazon_sp.adjustments import fetch_ledger_adjustments
    from src.db import fetch_all, upsert_rows
    from src.rules import SPAPI_CASE_QUEUE_DAYS, amazon_as_of

    window = SPAPI_CASE_QUEUE_DAYS if days is None else max(1, min(int(days), 365))
    end = amazon_as_of()
    # Inclusive lookback so --days 30 is one ≤30d linear chunk (throttle-safe).
    start = end - timedelta(days=max(window - 1, 0))

    previous_adj_count = 0
    try:
        previous_adj_count = len(_with_one_retry(fetch_all, "fba_inventory_adjustments"))
    except Exception as e:
        log.warning("Could not count prior fba_inventory_adjustments: %s", e)

    adj_summary: dict = {}
    if fetch_ledger:
        try:
            adj_summary = fetch_ledger_adjustments(start, end, dry_run=dry_run, on_poll=on_poll)
        except Exception as e:
            log.error("Ledger adjustments pull failed: %s", e)
            adj_summary = {"error": str(e)[:300], "rows_inserted": 0, "rows_parsed": 0}
            if not dry_run:
                fail_if_empty_adjustments_pull(previous_adj_count, 0, str(e)[:300])

        pulled = int(adj_summary.get("rows_parsed") or 0)
        if not pulled:
            pulled = len(adj_summary.get("records") or [])
        if not dry_run:
            fail_if_empty_adjustments_pull(
                previous_adj_count, pulled, adj_summary.get("error"),
            )

    if dry_run:
        adjustments = adj_summary.get("records") or []
    else:
        try:
            adjustments = _with_one_retry(fetch_all, "fba_inventory_adjustments")
        except Exception:
            adjustments = adj_summary.get("records") or []

    try:
        shipments = _with_one_retry(fetch_all, "inventory_inbound_shipments")
        items = _with_one_retry(fetch_all, "inventory_inbound_shipment_items")
    except Exception as e:
        log.warning("Inbound tables unavailable: %s", e)
        shipments, items = [], []
    try:
        sellerboard = _with_one_retry(fetch_all, "sellerboard_inbound_discrepancies")
    except Exception as e:
        log.warning("sellerboard_inbound_discrepancies unavailable: %s", e)
        sellerboard = []
    try:
        existing_events = _with_one_retry(fetch_all, "fba_case_events")
    except Exception as e:
        log.warning("fba_case_events unavailable for Sellerboard/dismiss merge: %s", e)
        existing_events = []
    try:
        paid = _with_one_retry(fetch_all, "fba_reimbursements")
    except Exception as e:
        log.warning("fba_reimbursements unavailable: %s", e)
        paid = []
    try:
        inventory_events = _with_one_retry(fetch_all, "inventory_events")
        receipt_events = [
            r for r in inventory_events
            if "receipt" in (r.get("event_type") or "").lower()
            and int(r.get("quantity") or 0) > 0
        ]
    except Exception as e:
        log.warning("inventory_events receipts unavailable: %s", e)
        receipt_events = []

    amazon_rows: list[dict] = []
    amazon_totals: dict[str, dict] = {}
    amazon_ids = collect_reconcile_shipment_ids(existing_events, sellerboard)
    if amazon_ids:
        try:
            amazon_rows, amazon_totals = fetch_amazon_inbound_qty(amazon_ids)
        except Exception as e:
            log.warning("Amazon inbound reconcile fetch failed: %s", e)

    events = build_case_events(
        adjustments=adjustments,
        shipments=shipments,
        shipment_items=items,
        reimbursements=paid,
        start=start,
        end=end,
        as_of=end,
        sellerboard_rows=sellerboard,
        existing_events=existing_events,
        amazon_inbound_rows=amazon_rows,
        amazon_shipment_totals=amazon_totals,
        receipt_events=receipt_events,
    )
    negatives = negative_adjustments_in_window(adjustments, start, end)
    qa = evaluate_queue_qa(
        events,
        negative_adjustments=negatives,
        adjustments_empty_after_prior=False,
    )
    needs = [e for e in events if e.get("status") == STATUS_NEEDS_CASE]
    stamped = _stamp(events)
    summary = {
        "report_type": "fba_case_queue",
        "period": f"{start} to {end}",
        "days": window,
        "adjustments_inserted": adj_summary.get("rows_inserted", 0),
        "adjustments_error": adj_summary.get("error"),
        "events_total": len(events),
        "needs_case": len(needs),
        "already_reimbursed": sum(1 for e in events if e.get("status") == STATUS_ALREADY_REIMBURSED),
        "found_offset": sum(1 for e in events if e.get("status") == STATUS_FOUND_OFFSET),
        "needs_units": sum(int(e.get("quantity") or 0) for e in needs),
        "dry_run": dry_run,
        "rows_inserted": 0,
        "seller_central_link_limit": SELLER_CENTRAL_LINK_LIMIT,
        "auto_submit": False,
        "classification_version": CLASSIFICATION_VERSION,
        "qa": qa,
        "mini_resync": MINI_RESYNC_HINT,
        "orphans_purged": 0,
        "amazon_reconcile_ids": len(amazon_ids),
        "amazon_reconcile_rows": len(amazon_rows),
    }
    if dry_run:
        summary["events"] = stamped
        if not qa["ok"]:
            summary["qa_failed"] = True
        return summary

    if stamped:
        try:
            inserted = _with_one_retry(
                upsert_rows, "fba_case_events", stamped, on_conflict="event_key",
            )
        except Exception as e:
            raise CaseQueueSyncError(
                f"fba_case_events upsert failed after retry: {e}. {MINI_RESYNC_HINT}",
                qa=qa,
            ) from e
        summary["rows_inserted"] = inserted

    try:
        purged = _with_one_retry(purge_ineligible_needs_case_orphans)
    except Exception as e:
        log.warning("Could not purge ineligible needs_case orphans: %s", e)
        purged = 0
    summary["orphans_purged"] = purged

    if not qa["ok"]:
        raise CaseQueueSyncError(
            "Needs-case QA failed — do not prep Reese packets. "
            + "; ".join(qa["errors"]),
            qa=qa,
        )
    return summary
