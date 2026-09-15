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
group, with approval on/after the event (plus a 7-day settle pad), leave
the Needs-case list. Same FBA shipment_id + SKU from SP-API and Sellerboard
collapses to one row.

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
    "https://sellercentral.amazon.com/gp/fba/inbound-shipment-workflow/index.html"
    "?shipmentId={shipment_id}"
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
    "Warehouse damage is filed in IDR (Inventory → Inventory Defect and "
    "Reimbursement), not via a generic Support hub button. That hub is NOT a "
    "pre-filled lost-inbound or warehouse case. Dave submits; this desk never auto-files."
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
        "Seller Central → Inventory → Inventory Defect and Reimbursement (IDR).",
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

SOURCE_LEDGER = "ledger_adjustment"
SOURCE_INBOUND = "inbound_discrepancy"
SOURCE_SELLERBOARD = "sellerboard_inbound"
INBOUND_SOURCES = frozenset({SOURCE_INBOUND, SOURCE_SELLERBOARD})

HOW_TO_FILE_INBOUND = (
    "Lost inbound / inbound short is filed from the shipment tracker + "
    "IDR / lost inbound — not the ledger Reference ID damage path. "
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


def _fba_id(value: str | None) -> str | None:
    raw = (value or "").strip().upper()
    if FBA_SHIPMENT_RE.match(raw):
        return raw
    return None


def seller_central_link(shipment_id: str | None, reference_id: str | None) -> tuple[str | None, str]:
    """Best available SC URL and a documented kind.

    Real FBA* ids → inbound shipment tracker. Digit ledger transaction IDs
    are not shipment IDs — those get IDR instructions, not a fake Support
    hub claim URL. There is no stable pre-filled case deep link.
    """
    sid = fba_shipment_id(shipment_id, reference_id)
    if sid:
        return SC_INBOUND_SHIPMENT.format(shipment_id=sid), LINK_KIND_INBOUND
    return None, LINK_KIND_IDR


def inbound_ready(ship: dict, as_of: date) -> bool:
    """True when a short-receive is case-eligible (not still in transit)."""
    status = (ship.get("shipment_status") or "").upper()
    if status in CLOSED_INBOUND:
        return True
    if status not in STALE_INBOUND:
        return False
    updated = _parse_day(ship.get("last_updated_at") or ship.get("received_at"))
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
        })
    return out


def inbound_source_key(row: dict) -> tuple[str, str] | None:
    sid = fba_shipment_id(row.get("shipment_id"))
    sku = normalize_sku(row.get("sku"))
    if not sid or sku == "UNKNOWN":
        return None
    return sid, sku


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
    """Keep Dave's case_submitted dismiss across Mini rebuilds.

    Paid / found-offset wins. New event_keys (new shipment) stay Needs case.
    """
    prior: dict[str, dict] = {}
    for row in existing:
        key = str(row.get("event_key") or "").strip()
        if key and row.get("status") == STATUS_CASE_SUBMITTED:
            prior[key] = row
    out: list[dict] = []
    for ev in events:
        row = dict(ev)
        key = str(row.get("event_key") or "").strip()
        saved = prior.get(key)
        if saved and row.get("status") == STATUS_NEEDS_CASE:
            row["status"] = STATUS_CASE_SUBMITTED
            row["dismissed_at"] = saved.get("dismissed_at")
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
        sid = fba_shipment_id(row.get("shipment_id"), ref)
        url, kind = seller_central_link(sid, None)
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
            "reason_group": reason_group(reason, disposition),
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
        pool.append({
            "sku": normalize_sku(row.get("sku")),
            "group": group,
            "day": day,
            "qty": units,
            "reimbursement_id": row.get("reimbursement_id"),
            "amount_per_unit": float(row.get("amount_per_unit") or 0) or None,
            "amount_total": float(row.get("amount_total") or 0),
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
    """Subtract paid units; leftover stays Needs case."""
    pool = paid_pool(reimbursements)
    out: list[dict] = []
    for ev in sorted(events, key=lambda e: (e["event_date"], e["event_key"])):
        if ev.get("status") == STATUS_FOUND_OFFSET:
            ev.setdefault("estimated_amount", None)
            ev.setdefault("amount_basis", AMOUNT_BASIS_UNKNOWN)
            ev.setdefault("matched_reimbursement_id", None)
            ev.setdefault("matched_reimbursed_qty", 0)
            out.append(ev)
            continue
        left = int(ev["quantity"])
        matched_id = None
        matched_qty = 0
        sku = ev["sku"]
        group = ev["reason_group"]
        event_day: date = ev["event_date"]
        for item in pool:
            if left <= 0:
                break
            if item["qty"] <= 0 or item["sku"] != sku or item["group"] != group:
                continue
            earliest = event_day - timedelta(days=PAID_SETTLE_PAD_DAYS)
            latest = event_day + timedelta(days=PAID_LOOKAHEAD_DAYS)
            if item["day"] < earliest or item["day"] > latest:
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
) -> list[dict]:
    """Pure builder — no I/O. Returns rows ready for fba_case_events."""
    as_of = as_of or end
    adj_list = list(adjustments)
    paid_list = list(reimbursements)
    existing_list = list(existing_events or [])
    ledger = adjustment_candidates(adj_list, start, end)
    spapi_inbound = inbound_discrepancies(shipments, shipment_items, as_of, start, end)
    sb_raw = list(sellerboard_rows or []) + existing_sellerboard_rows(existing_list)
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
    merged = _enrich_asin(merged, adj_list, paid_list)
    out = apply_paid_dedupe(merged, paid_list)
    out = preserve_submitted_status(out, existing_list)
    for row in out:
        row["classification_version"] = CLASSIFICATION_VERSION
        row["reason_group"] = reason_group(row.get("reason"), row.get("disposition"))
        row["reason_label"] = reason_label(row.get("reason"), row.get("disposition"))
        sid = fba_shipment_id(row.get("shipment_id"), None)
        row["shipment_id"] = sid
        url, kind = seller_central_link(sid, None)
        row["seller_central_url"] = url
        row["seller_central_link_kind"] = kind
    return out


def _stamp(rows: list[dict]) -> list[dict]:
    now = datetime.now(timezone.utc).isoformat()
    out = []
    for row in rows:
        rec = dict(row)
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
    start = end - timedelta(days=window)

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
