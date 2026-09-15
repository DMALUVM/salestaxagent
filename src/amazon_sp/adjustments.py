"""GET_LEDGER_DETAIL_VIEW_DATA Adjustments → fba_inventory_adjustments.

Amazon deprecated GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA on
2023-01-31. The live replacement is the inventory ledger detailed view
with reportOptions.eventType=Adjustments.

This feed is the warehouse-loss / damage source for the Needs-case
queue. It is not paid cash — that stays on GET_FBA_REIMBURSEMENTS_DATA.
"""
from __future__ import annotations

import csv
import io
import logging
from datetime import date, datetime, timezone

from src.amazon_sp.client import request_and_download
from src.amazon_sp.reports import (
    INVENTORY_LEDGER_REPORT,
    _build_header_lookup,
    _date_chunks,
    _detect_delimiter,
    _get,
    _parse_date,
)
from src.db import log_audit, log_ingestion, upsert_rows
from src.sku_normalize import normalize_sku

log = logging.getLogger(__name__)

LEDGER_ADJUSTMENTS_SOURCE = "spapi_ledger_adjustments"
ADJUSTMENTS_EVENT_TYPE = "Adjustments"


def adjustment_event_key(
    event_date: date | str,
    fc: str,
    sku: str,
    reason: str,
    reference_id: str,
    quantity: int,
) -> str:
    """Stable key for a ledger adjustment row."""
    day = event_date.isoformat() if hasattr(event_date, "isoformat") else str(event_date)[:10]
    return "|".join([
        "adj",
        day,
        (fc or "").upper(),
        normalize_sku(sku),
        (reason or "").strip(),
        (reference_id or "").strip(),
        str(int(quantity)),
    ])


def parse_ledger_adjustments(content: str, source_file: str = LEDGER_ADJUSTMENTS_SOURCE) -> dict:
    """Parse a ledger detail report into adjustment records.

    Accepts a full ledger or an eventType=Adjustments slice. Non-adjustment
    rows are counted and skipped. Reason / Reference ID are kept — the
    nexus inventory_events parser drops both.
    """
    result: dict = {
        "rows_total": 0,
        "rows_parsed": 0,
        "rows_skipped": 0,
        "records": [],
        "reasons": {},
    }
    if not (content or "").strip():
        result["warnings"] = ["Empty report"]
        return result

    first_line = content.split("\n", 1)[0]
    delimiter = _detect_delimiter(first_line)
    reader = csv.DictReader(io.StringIO(content), delimiter=delimiter, quotechar='"')
    if not reader.fieldnames:
        result["warnings"] = ["Empty report or no headers"]
        return result

    H = _build_header_lookup(reader.fieldnames)
    now = datetime.now(timezone.utc).isoformat()

    for row in reader:
        result["rows_total"] += 1
        event_type = _get(row, H, "event-type", "event_type", "eventtype")
        date_str = (
            _get(row, H, "date-and-time", "date_and_time")
            or _get(row, H, "date")
        )
        event_date = _parse_date(date_str) if date_str else None
        if not event_date:
            result["rows_skipped"] += 1
            continue
        if event_type and event_type.lower() != ADJUSTMENTS_EVENT_TYPE.lower():
            result["rows_skipped"] += 1
            continue

        try:
            qty = int(float(_get(row, H, "quantity") or "0"))
        except (ValueError, TypeError):
            qty = 0

        sku = normalize_sku(_get(row, H, "msku", "sku") or None)
        if sku == "UNKNOWN":
            sku = normalize_sku(_get(row, H, "fnsku") or None)
        reason = _get(row, H, "reason") or ""
        fc = (_get(row, H, "fulfillment-center", "fulfillment_center") or "").upper()
        ref = _get(row, H, "reference-id", "reference_id", "referenceid") or ""
        key = adjustment_event_key(event_date, fc, sku, reason, ref, qty)

        rec = {
            "event_key": key,
            "event_date": event_date.isoformat(),
            "sku": sku,
            "asin": _get(row, H, "asin") or None,
            "fnsku": (_get(row, H, "fnsku") or "").upper() or None,
            "product_name": _get(row, H, "title", "product-name", "product_name") or None,
            "event_type": event_type or ADJUSTMENTS_EVENT_TYPE,
            "reference_id": ref or None,
            "quantity": qty,
            "fulfillment_center": fc or None,
            "disposition": _get(row, H, "disposition") or None,
            "reason": reason or None,
            "country": _get(row, H, "country") or None,
            "source_file": source_file,
            "synced_at": now,
        }
        recon = _get(row, H, "reconciled-quantity", "reconciled_quantity")
        unrecon = _get(row, H, "unreconciled-quantity", "unreconciled_quantity")
        try:
            rec["reconciled_qty"] = int(float(recon)) if recon else None
        except (ValueError, TypeError):
            rec["reconciled_qty"] = None
        try:
            rec["unreconciled_qty"] = int(float(unrecon)) if unrecon else None
        except (ValueError, TypeError):
            rec["unreconciled_qty"] = None

        result["records"].append(rec)
        result["rows_parsed"] += 1
        if reason:
            result["reasons"][reason] = result["reasons"].get(reason, 0) + 1

    return result


def _dedupe_adjustments(records: list[dict]) -> list[dict]:
    seen: dict[str, int] = {}
    for i, rec in enumerate(records):
        seen[str(rec.get("event_key") or "")] = i
    return [records[i] for i in sorted(seen.values()) if records[i].get("event_key")]


def fetch_ledger_adjustments(
    start: date,
    end: date,
    dry_run: bool = False,
    on_poll: callable | None = None,
) -> dict:
    """Fetch ledger Adjustments (chunked ≤30d) and upsert."""
    chunks = _date_chunks(start, end)
    records: list[dict] = []
    rows_parsed = 0
    rows_total = 0
    chunk_errors = 0
    reasons: dict[str, int] = {}

    for c_start, c_end in chunks:
        try:
            content = request_and_download(
                INVENTORY_LEDGER_REPORT,
                c_start,
                c_end,
                on_poll=on_poll,
                report_options={"eventType": ADJUSTMENTS_EVENT_TYPE},
            )
        except Exception as e:
            chunk_errors += 1
            log.warning("Ledger adjustments chunk %s->%s failed: %s", c_start, c_end, e)
            continue
        parsed = parse_ledger_adjustments(content)
        records.extend(parsed["records"])
        rows_parsed += parsed["rows_parsed"]
        rows_total += parsed["rows_total"]
        for reason, n in parsed.get("reasons", {}).items():
            reasons[reason] = reasons.get(reason, 0) + n

    deduped = _dedupe_adjustments(records)
    summary = {
        "report_type": "ledger_adjustments",
        "report": INVENTORY_LEDGER_REPORT,
        "event_type": ADJUSTMENTS_EVENT_TYPE,
        "period": f"{start} to {end}",
        "chunks": len(chunks),
        "chunk_errors": chunk_errors,
        "rows_total": rows_total,
        "rows_parsed": rows_parsed,
        "rows_deduped": max(0, len(records) - len(deduped)),
        "reasons": reasons,
        "dry_run": dry_run,
        "rows_inserted": 0,
        "records": deduped if dry_run else [],
    }

    if dry_run or not deduped:
        return summary

    inserted = upsert_rows(
        "fba_inventory_adjustments",
        deduped,
        on_conflict="event_key",
    )
    summary["rows_inserted"] = inserted
    try:
        log_ingestion(
            filename=f"spapi_ledger_adjustments_{start}_{end}",
            file_type="amazon_ledger_adjustments",
            rows_total=rows_total,
            rows_inserted=inserted,
            rows_skipped=max(0, rows_total - rows_parsed),
        )
        log_audit(
            action="fetch_ledger_adjustments",
            category="ingestion",
            details={"period": f"{start} to {end}", "chunks": len(chunks)},
            rows_affected=inserted,
        )
    except Exception:
        log.warning("Could not log ledger adjustments ingestion", exc_info=True)
    return summary
