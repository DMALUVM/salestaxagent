"""SP-API settlement report: fetch, parse, and reconcile against order-based sales.

Settlement reports are Amazon-generated; we only retrieve them.  We must NOT
call createReport for settlement types — Amazon returns a 400 ("Request for
report type 1118 is not allowed at this time").  Instead we use getReports
(list_reports) to find existing DONE reports, then download + parse + upsert.

Report types we look for:
  - GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2
  - GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE  (older variant)
"""
from __future__ import annotations

import csv
import io
import logging
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from src.amazon_sp.client import list_reports, download_report, SPAPIError
from src.channels import AMAZON
from src.db import fetch_all, upsert_rows, log_ingestion

log = logging.getLogger(__name__)

SETTLEMENT_REPORT_TYPES = [
    "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2",
    "GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE",
]
SOURCE_LABEL = "amazon_settlement"


def fetch_settlements(
    start: date,
    end: date,
    dry_run: bool = False,
    on_poll=None,
) -> dict:
    """List existing settlement reports from SP-API, download + parse each.

    Does NOT call createReport.  Settlement reports are produced by Amazon
    on their own schedule (roughly every 14 days).

    Returns summary dict with settlement totals.
    """
    # SP-API getReports rejects createdSince older than 90 days from now
    earliest_allowed = (datetime.now(timezone.utc) - timedelta(days=89)).date()
    effective_start = max(start, earliest_allowed)
    created_since = datetime.combine(
        effective_start, datetime.min.time(), tzinfo=timezone.utc
    ).isoformat()

    if on_poll:
        on_poll("listing reports", 0)

    reports = list_reports(SETTLEMENT_REPORT_TYPES, created_since=created_since)

    # Only process DONE reports
    done_reports = [r for r in reports if r.get("processingStatus") == "DONE"]
    skipped = len(reports) - len(done_reports)

    log.info(
        "Settlement reports: %d found, %d DONE, %d skipped",
        len(reports), len(done_reports), skipped,
    )

    if on_poll:
        on_poll(f"found {len(done_reports)} DONE reports ({skipped} skipped)", 0)

    all_rows: list[dict] = []
    totals: dict[str, float] = defaultdict(float)
    settlement_ids: set[str] = set()
    reports_ingested = 0

    for idx, report in enumerate(done_reports, 1):
        report_id = report.get("reportId", "?")
        doc_id = report.get("reportDocumentId")
        if not doc_id:
            log.warning("Report %s has no reportDocumentId, skipping", report_id)
            continue

        if on_poll:
            on_poll(f"downloading {idx}/{len(done_reports)}", 0)

        try:
            content = download_report(doc_id)
        except SPAPIError as exc:
            log.warning("Failed to download report %s: %s", report_id, exc)
            # Back off on 429 rate-limit errors
            if "429" in str(exc) or "QuotaExceeded" in str(exc):
                time.sleep(5)
            continue

        rows = _parse_settlement_content(content, totals, settlement_ids)
        all_rows.extend(rows)
        reports_ingested += 1

        # Respect SP-API rate limits between downloads
        if idx < len(done_reports):
            time.sleep(1)

    # Deduplicate rows: multiple report types can cover the same settlement
    # period.  The upsert key is (settlement_id, order_id, amount_type,
    # amount_description) — keep the last occurrence (later report wins).
    seen: dict[tuple, int] = {}
    for i, row in enumerate(all_rows):
        key = (row["settlement_id"], row["order_id"],
               row["amount_type"], row["amount_description"])
        seen[key] = i
    deduped_rows = [all_rows[i] for i in sorted(seen.values())]

    result = {
        "report_types": SETTLEMENT_REPORT_TYPES,
        "reports_found": len(reports),
        "reports_done": len(done_reports),
        "reports_skipped": skipped,
        "reports_ingested": reports_ingested,
        "rows_total": len(all_rows),
        "rows_parsed": len(all_rows),
        "rows_deduped": len(deduped_rows),
        "settlements": len(settlement_ids),
        "totals_by_type": dict(totals),
        "dry_run": dry_run,
    }

    if not dry_run and deduped_rows:
        inserted = upsert_rows(
            "amazon_settlements", deduped_rows,
            on_conflict="settlement_id,order_id,amount_type,amount_description",
        )
        result["rows_inserted"] = inserted
        log_ingestion(
            filename=f"settlement_{start}_{end}",
            file_type="amazon_sales",  # CHECK constraint lacks amazon_settlement
            rows_total=len(all_rows),
            rows_inserted=inserted,
            status="success",
        )
    else:
        result["rows_inserted"] = 0

    return result


def _parse_settlement_content(
    content: str,
    totals: dict[str, float],
    settlement_ids: set[str],
) -> list[dict]:
    """Parse a single settlement report TSV into row dicts."""
    lines = content.strip().split("\n")
    if len(lines) < 2:
        return []

    reader = csv.DictReader(io.StringIO(content), delimiter="\t")
    rows: list[dict] = []

    for row in reader:
        settlement_id = row.get("settlement-id", "")
        amount_type = row.get("amount-type", "")
        amount_desc = row.get("amount-description", "")
        amount = _to_float(row.get("amount", "0"))
        order_id = row.get("order-id", "")
        sku = row.get("sku", "")
        deposit_date = row.get("deposit-date", "")
        start_date = row.get("settlement-start-date", "")
        end_date = row.get("settlement-end-date", "")
        marketplace = row.get("marketplace-name", "")
        txn_type = row.get("transaction-type", "")

        if settlement_id:
            settlement_ids.add(settlement_id)

        totals[amount_type] += amount

        rows.append({
            "settlement_id": settlement_id,
            "settlement_start": start_date[:10] if start_date else None,
            "settlement_end": end_date[:10] if end_date else None,
            "deposit_date": deposit_date[:10] if deposit_date else None,
            "transaction_type": txn_type,
            "amount_type": amount_type,
            "amount_description": amount_desc,
            "order_id": order_id,
            "sku": sku,
            "amount": amount,
            "marketplace": marketplace,
            "source": SOURCE_LABEL,
        })

    return rows


def reconcile(
    start_date: str,
    end_date: str,
) -> dict:
    """Compare order-based sales_by_state vs settlement principals.

    Returns comparison dict with totals and gap analysis.
    """
    # A: Order-based gross sales (from sales_by_state, channel=amazon)
    sales = fetch_all("sales_by_state")
    order_total = 0.0
    order_by_state = defaultdict(float)
    for r in sales:
        ch = r.get("channel", "")
        if "amazon" not in ch.lower():
            continue
        ps = str(r.get("period_start", ""))
        if ps < start_date or ps > end_date:
            continue
        amt = float(r.get("gross_sales", 0) or 0)
        order_total += amt
        order_by_state[r.get("state_code", "??")] += amt

    # B: Settlement product sales / principal
    try:
        settlements = fetch_all("amazon_settlements")
    except Exception:
        settlements = []

    settlement_total = 0.0
    settlement_fees = 0.0
    settlement_refunds = 0.0
    settlement_other = 0.0

    # Build a map: settlement_id → (start, end) from the rows that have dates
    settlement_periods: dict[str, tuple[str, str]] = {}
    for s in settlements:
        sid = s.get("settlement_id", "")
        ss = s.get("settlement_start")
        se = s.get("settlement_end")
        if sid and ss and se:
            settlement_periods[sid] = (str(ss), str(se))

    for s in settlements:
        sid = s.get("settlement_id", "")
        # Use the settlement's period dates (from header row) to filter
        period = settlement_periods.get(sid)
        if period:
            s_start, s_end = period
            if s_end < start_date or s_start > end_date:
                continue
        # If no period info, include the row (don't silently drop)

        amt = float(s.get("amount", 0) or 0)
        atype = (s.get("amount_type") or "").lower()

        if "itemfees" in atype or "shipmentfees" in atype or "fba" in atype:
            settlement_fees += amt
        elif "refund" in (s.get("transaction_type") or "").lower():
            settlement_refunds += amt
        elif "itemprice" in atype or "product" in atype or "principal" in atype:
            settlement_total += amt
        else:
            settlement_other += amt

    delta = order_total - settlement_total

    return {
        "period": {"start": start_date, "end": end_date},
        "order_based_gross": round(order_total, 2),
        "settlement_principal": round(settlement_total, 2),
        "settlement_fees": round(settlement_fees, 2),
        "settlement_refunds": round(settlement_refunds, 2),
        "settlement_other": round(settlement_other, 2),
        "delta": round(delta, 2),
        "delta_pct": round(delta / order_total * 100, 1) if order_total else 0,
        "expected_gaps": [
            "Order-date vs settlement-period timing differences",
            "Refunds processed after original order period",
            "FBA fees, shipping credits, promotional rebates",
            "Reserve holds and delayed disbursements",
            "Chargebacks and A-to-Z claims",
        ],
        "methodology": (
            "Order-based: sales_by_state where channel=amazon, summed gross_sales by period_start. "
            "Settlement: amazon_settlements principal/product amounts for overlapping settlement periods. "
            "These two views are NOT expected to match exactly — order-date is accrual, "
            "settlement is cash basis."
        ),
        "has_settlement_data": len(settlements) > 0,
    }


def _to_float(v) -> float:
    try:
        return float(v.replace(",", "")) if v else 0.0
    except (ValueError, AttributeError):
        return 0.0
