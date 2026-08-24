"""Seller Central All Orders CSV → sales_by_sku.

SP-API orders reports typically retain ~2 years, so Jan–Jul 2024 is
outside the API floor (~2024-08-24 as of 2026-08). Seller Central
Reports → Fulfillment → All Orders still has those months. This
parser accepts that flat file (tab or comma) and writes the same
amazon_spapi rows `backfill-amazon-skus` writes, so SKU economics
stays on one source.
"""
from __future__ import annotations

from pathlib import Path

from src.amazon_sp.reports import (
    SOURCE_LABEL,
    parse_orders_by_sku,
    upsert_amazon_sku_rows,
)
from src.db import log_audit, log_ingestion


ORDERS_HEADER_MARKERS = (
    "amazon-order-id", "amazon_order_id", "amazonorderid",
)


def _normalize_header(header: str) -> str:
    return header.strip().strip('"').lower().replace("_", "-").replace(" ", "-")


def is_amazon_orders_report(headers: list[str]) -> bool:
    """True for an All Orders / orders-by-order-date flat file."""
    normalized = {_normalize_header(h) for h in headers}
    has_order = any(m.replace("_", "-") in normalized for m in ORDERS_HEADER_MARKERS)
    has_sku = "sku" in normalized or "seller-sku" in normalized or "msku" in normalized
    has_price = "item-price" in normalized or "item-price-amount" in normalized
    return has_order and has_sku and has_price


def ingest_amazon_orders_skus(file_path: str | Path, dry_run: bool = False) -> dict:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    content = path.read_text(encoding="utf-8-sig", errors="replace")
    parsed = parse_orders_by_sku(content)
    summary = {
        "filename": path.name,
        "report_type": "amazon_orders_skus",
        "source": SOURCE_LABEL,
        "rows_total": parsed["rows_total"],
        "rows_parsed": parsed["rows_parsed"],
        "rows_skipped": parsed["rows_skipped"],
        "sku_rows": len(parsed["sku_rows"]),
        "unique_skus": parsed["unique_skus"],
        "warnings": list(parsed.get("warnings") or []),
        "dry_run": dry_run,
        "rows_inserted": 0,
    }
    if dry_run or not parsed["sku_rows"]:
        if not parsed["sku_rows"] and not summary["warnings"]:
            summary["warnings"].append("No SKU rows parsed — check that this is an All Orders report.")
        return summary

    inserted, deduped = upsert_amazon_sku_rows(parsed["sku_rows"])
    summary["rows_inserted"] = inserted
    summary["sku_rows"] = len(deduped)
    log_ingestion(
        filename=path.name,
        file_type="amazon_sales",
        rows_total=parsed["rows_total"],
        rows_inserted=inserted,
        rows_skipped=parsed["rows_skipped"],
        warnings=summary["warnings"] or None,
    )
    log_audit(
        action="ingest_amazon_orders_skus",
        category="ingestion",
        details={"filename": path.name, "unique_skus": parsed["unique_skus"]},
        rows_affected=inserted,
    )
    return summary
