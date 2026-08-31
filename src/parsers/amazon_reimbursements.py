"""Seller Central FBA reimbursements CSV → fba_reimbursements.

SP-API GET_FBA_REIMBURSEMENTS_DATA is the primary fill (nightly, 90d).
This parser accepts the same flat file from Reports → Fulfillment →
Reimbursements when the API window missed a month or the job failed.
"""
from __future__ import annotations

from pathlib import Path

from src.amazon_sp.reports import parse_reimbursements
from src.db import log_audit, log_ingestion, upsert_rows


def _normalize_header(header: str) -> str:
    return header.strip().strip('"').lower().replace("_", "-").replace(" ", "-")


def is_fba_reimbursements_report(headers: list[str]) -> bool:
    """True for GET_FBA_REIMBURSEMENTS_DATA / Seller Central reimbursements.

    Requires reimbursement-id + approval-date so a SKU Economics column
    named "FBA Inventory Reimbursement" does not match.
    """
    normalized = {_normalize_header(h) for h in headers}
    return "reimbursement-id" in normalized and "approval-date" in normalized


def ingest_amazon_reimbursements(file_path: str | Path, dry_run: bool = False) -> dict:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    content = path.read_text(encoding="utf-8-sig", errors="replace")
    parsed = parse_reimbursements(content, source_file=path.name)
    summary = {
        "filename": path.name,
        "report_type": "amazon_reimbursements",
        "rows_total": parsed["rows_total"],
        "rows_parsed": parsed["rows_parsed"],
        "rows_skipped": parsed["rows_skipped"],
        "total_amount": round(parsed["total_amount"], 2),
        "warnings": [],
        "dry_run": dry_run,
        "rows_inserted": 0,
    }
    if dry_run or not parsed["records"]:
        return summary

    inserted = upsert_rows(
        "fba_reimbursements", parsed["records"],
        on_conflict="reimbursement_id,sku",
    )
    summary["rows_inserted"] = inserted
    log_ingestion(
        filename=path.name,
        file_type="amazon_reimbursements",
        rows_total=parsed["rows_total"],
        rows_inserted=inserted,
        rows_skipped=parsed["rows_skipped"],
    )
    log_audit(
        action="ingest_amazon_reimbursements",
        category="ingestion",
        details={"filename": path.name, "total_amount": summary["total_amount"]},
        rows_affected=inserted,
    )
    return summary
