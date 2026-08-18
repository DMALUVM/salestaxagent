"""Parse Ship Sidekick 3PL invoice CSV (multi-section).

Sections:
  MONTHLY SUMMARY — one row per month with fee columns
  PACKAGING FEES BY MONTH — (month, fee_name, qty, amount)
  AD-HOC FEES BY MONTH — same structure
  DETAIL — line-level charges

Resilient to column-name variants ($2 Order Fee vs $2.00 Order Fee).
"""
from __future__ import annotations

import csv
import hashlib
import io
import logging
from pathlib import Path

from src.db import upsert_rows

log = logging.getLogger(__name__)


def _safe_float(v: str) -> float:
    try:
        return float(v.replace(",", "").replace("$", "").strip())
    except (ValueError, TypeError, AttributeError):
        return 0.0


def _col(headers: list[str], *candidates: str) -> int | None:
    """Find column index matching any candidate (case-insensitive, substring)."""
    for c in candidates:
        cl = c.lower()
        for i, h in enumerate(headers):
            if cl in h.lower():
                return i
    return None


def _line_hash(row: dict) -> str:
    """Deterministic hash for dedup of detail lines."""
    parts = "|".join(str(row.get(k, "")) for k in
                     ["date", "category", "fee_name", "reference", "order_id", "amount", "qty"])
    return hashlib.md5(parts.encode()).hexdigest()


def parse_tpl_invoice(file_path: str | Path) -> dict:
    """Parse a multi-section 3PL invoice CSV.

    Returns dict with monthly, packaging, adhoc, detail lists and summary.
    """
    path = Path(file_path)
    content = path.read_text(encoding="utf-8-sig")
    source = path.name

    # Split into sections by blank-line-delimited headers
    sections: dict[str, list[str]] = {}
    current_section = None
    current_lines: list[str] = []

    for line in content.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        # Detect section headers (all-caps, no commas or very few)
        if stripped.isupper() and stripped.count(",") <= 1 and len(stripped) > 3:
            if current_section:
                sections[current_section] = current_lines
            current_section = stripped
            current_lines = []
        else:
            current_lines.append(line)

    if current_section:
        sections[current_section] = current_lines

    monthly_rows: list[dict] = []
    fee_rows: list[dict] = []
    detail_rows: list[dict] = []

    # ── MONTHLY SUMMARY ──
    if "MONTHLY SUMMARY" in sections:
        lines = sections["MONTHLY SUMMARY"]
        if lines:
            reader = csv.DictReader(io.StringIO("\n".join(lines)))
            for row in reader:
                if not row.get("Month"):
                    continue
                # Find columns resilient to name variants
                headers = list(row.keys())

                def _get(*names: str) -> float:
                    for n in names:
                        nl = n.lower()
                        for h in headers:
                            if nl in h.lower():
                                return _safe_float(row.get(h, "0"))
                    return 0.0

                # Sum ALL order fee columns (variants: $2 Order Fee, $2.00 Order Fee)
                order_fee_total = sum(
                    _safe_float(row.get(h, "0"))
                    for h in headers if "order fee" in h.lower()
                )

                monthly_rows.append({
                    "month": row["Month"].strip(),
                    "shipping": _get("shipping"),
                    "pick": _get("pick"),
                    "order_fee": order_fee_total,
                    "packaging": _get("packaging"),
                    "storage_shelf": _get("master carton", "shelf storage"),
                    "storage_bin_med": _get("medium bin"),
                    "storage_pallet": _get("pallet storage"),
                    "storage_bin_sm": _get("small bin"),
                    "account_mgmt": _get("account management"),
                    "adhoc": _get("ad-hoc", "adhoc"),
                    "total": _get("total"),
                    "source_file": source,
                })

    # ── PACKAGING / AD-HOC FEES ──
    for section_name, section_key in [
        ("PACKAGING FEES BY MONTH", "packaging"),
        ("AD-HOC FEES BY MONTH", "adhoc"),
    ]:
        if section_name not in sections:
            continue
        lines = sections[section_name]
        if not lines:
            continue
        reader = csv.DictReader(io.StringIO("\n".join(lines)))
        for row in reader:
            month = (row.get("Month") or "").strip()
            fee_name = (row.get("Fee Name") or "").strip()
            if not month or not fee_name:
                continue
            fee_rows.append({
                "month": month,
                "section": section_key,
                "fee_name": fee_name,
                "qty": _safe_float(row.get("Qty", "0")),
                "amount": _safe_float(row.get("Amount", "0")),
                "source_file": source,
            })

    # ── DETAIL ──
    if "DETAIL" in sections:
        lines = sections["DETAIL"]
        if lines:
            reader = csv.DictReader(io.StringIO("\n".join(lines)))
            for row in reader:
                month = (row.get("Month") or "").strip()
                if not month:
                    continue
                d = {
                    "date": (row.get("Date") or "").strip(),
                    "period_start": (row.get("Period Start") or "").strip() or None,
                    "period_end": (row.get("Period End") or "").strip() or None,
                    "month": month,
                    "entry": (row.get("Entry") or "").strip() or None,
                    "category": (row.get("Category") or "").strip() or None,
                    "fee_name": (row.get("Fee Name") or "").strip() or None,
                    "reference": (row.get("Reference") or "").strip() or None,
                    "order_id": (row.get("Order") or "").strip() or None,
                    "qty": _safe_float(row.get("Qty", "")) or None,
                    "amount": _safe_float(row.get("Amount", "0")),
                    "source_file": source,
                }
                d["line_hash"] = _line_hash(d)
                detail_rows.append(d)

    return {
        "file": str(path),
        "monthly": monthly_rows,
        "fees": fee_rows,
        "detail": detail_rows,
        "months_covered": sorted(set(r["month"] for r in monthly_rows)),
        "monthly_count": len(monthly_rows),
        "fee_count": len(fee_rows),
        "detail_count": len(detail_rows),
    }


def import_tpl_invoice(file_path: str | Path, dry_run: bool = False) -> dict:
    """Parse and upsert 3PL invoice data."""
    parsed = parse_tpl_invoice(file_path)

    result = {
        "file": parsed["file"],
        "months_covered": parsed["months_covered"],
        "monthly_count": parsed["monthly_count"],
        "fee_count": parsed["fee_count"],
        "detail_count": parsed["detail_count"],
        "dry_run": dry_run,
        "rows_inserted": 0,
    }

    if dry_run:
        return result

    inserted = 0
    if parsed["monthly"]:
        inserted += upsert_rows("tpl_cost_monthly", parsed["monthly"],
                                on_conflict="month")
    if parsed["fees"]:
        inserted += upsert_rows("tpl_cost_fees", parsed["fees"],
                                on_conflict="month,section,fee_name")
    if parsed["detail"]:
        inserted += upsert_rows("tpl_cost_detail", parsed["detail"],
                                on_conflict="line_hash")

    result["rows_inserted"] = inserted
    return result
