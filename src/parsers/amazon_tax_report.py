"""Parser for Amazon Custom Combined Tax reports.

These large reports contain per-order, per-jurisdiction tax rows with
ship_from_state and ship_to_state — critical for nexus analysis.

Each order has multiple rows (one per jurisdiction level: State, City,
County, District).  We deduplicate by (order_id, asin) so each line item
is counted only once for sales totals.
"""
from __future__ import annotations

import csv
import hashlib
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

from src.db import log_audit, log_ingestion, upsert_rows
from src.models.schema import SalesByState

# ---------------------------------------------------------------------------
# Header detection
# ---------------------------------------------------------------------------

SIGNATURE_HEADERS = {
    "ship_from_state",
    "ship_to_state",
    "total_tax_collected_by_amazon",
}

HEADER_ALIASES: dict[str, str] = {
    "order id": "order_id",
    "orderid": "order_id",
    "order_date": "order_date",
    "orderdate": "order_date",
    "shipment_date": "shipment_date",
    "shipmentdate": "shipment_date",
    "shipment date": "shipment_date",
    "shipment_id": "shipment_id",
    "shipmentid": "shipment_id",
    "shipment id": "shipment_id",
    "asin": "asin",
    "sku": "sku",
    "quantity": "quantity",
    "ship from state": "ship_from_state",
    "ship_from_state": "ship_from_state",
    "shipfromstate": "ship_from_state",
    "ship from city": "ship_from_city",
    "ship_from_city": "ship_from_city",
    "shipfromcity": "ship_from_city",
    "ship to state": "ship_to_state",
    "ship_to_state": "ship_to_state",
    "shiptostate": "ship_to_state",
    "ship to city": "ship_to_city",
    "ship_to_city": "ship_to_city",
    "shiptocity": "ship_to_city",
    "ship to country": "ship_to_country",
    "ship_to_country": "ship_to_country",
    "shiptocountry": "ship_to_country",
    "display_price": "display_price",
    "display price": "display_price",
    "taxexclusive_selling_price": "taxexclusive_selling_price",
    "taxexclusive selling price": "taxexclusive_selling_price",
    "tax_exclusive_selling_price": "taxexclusive_selling_price",
    "total_tax": "total_tax",
    "total tax": "total_tax",
    "totaltax": "total_tax",
    "total_tax_collected_by_amazon": "total_tax_collected_by_amazon",
    "total tax collected by amazon": "total_tax_collected_by_amazon",
    "tax_amount": "tax_amount",
    "tax amount": "tax_amount",
    "taxable_amount": "taxable_amount",
    "taxable amount": "taxable_amount",
    "jurisdiction_level": "jurisdiction_level",
    "jurisdiction level": "jurisdiction_level",
    "transaction_type": "transaction_type",
    "transaction type": "transaction_type",
    "currency": "currency",
    "fulfillment": "fulfillment",
    "marketplace": "marketplace",
}

US_STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC",
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_header(header: str) -> str:
    h = header.strip().lower().strip('"')
    for ch in (" ", "-"):
        h = h.replace(ch, "_")
    # Strip parenthetical suffixes like "(UTC)"
    if "(" in h:
        h = h[: h.index("(")].strip().rstrip("_")
    return HEADER_ALIASES.get(h, h)


def _parse_date(value: str) -> date | None:
    v = value.strip().strip('"')
    if not v:
        return None
    # "2023-12-22+00:00" — grab first 10 chars
    if len(v) >= 10:
        try:
            return datetime.strptime(v[:10], "%Y-%m-%d").date()
        except ValueError:
            pass
    for fmt in ("%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    return None


def _parse_money(value: str) -> float:
    v = value.strip().strip('"').replace(",", "").replace("$", "")
    if not v:
        return 0.0
    try:
        return float(v)
    except (ValueError, TypeError):
        return 0.0


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _month_end(d: date) -> date:
    if d.month == 12:
        return d.replace(month=12, day=31)
    return date(d.year, d.month + 1, 1) - timedelta(days=1)


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


# ---------------------------------------------------------------------------
# Public detection helper
# ---------------------------------------------------------------------------


def is_custom_combined_tax(headers: list[str]) -> bool:
    """Return True if *headers* match a Custom Combined Tax report."""
    normalized = {_normalize_header(h) for h in headers}
    return SIGNATURE_HEADERS.issubset(normalized)


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


def parse_amazon_tax_report(file_path: str | Path) -> dict:
    """Parse an Amazon Custom Combined Tax report.

    Returns aggregated sales by destination state (economic nexus)
    and ship-from state signals (physical nexus).
    """
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    result: dict = {
        "filename": path.name,
        "rows_total": 0,
        "rows_parsed": 0,
        "rows_skipped": 0,
        "warnings": [],
        "sales_records": [],
        "inventory_records": [],
        "ship_to_states": set(),
        "ship_from_states": set(),
        "total_gross_sales": 0.0,
        "total_tax_collected": 0.0,
        "unique_orders": 0,
    }

    fhash = _file_hash(path)

    # Aggregation: (ship_to_state, month_start) -> bucket
    sales_agg: dict[tuple, dict] = defaultdict(lambda: {
        "order_ids": set(),
        "gross_sales": 0.0,
        "tax_collected": 0.0,
        "quantity": 0,
    })

    # Ship-from: (ship_from_state, month_start) -> bucket
    ship_from_agg: dict[tuple, dict] = defaultdict(lambda: {
        "quantity": 0,
        "cities": set(),
    })

    seen_order_lines: set[tuple[str, str]] = set()
    all_order_ids: set[str] = set()

    with open(path, "r", encoding="utf-8-sig") as f:
        first_line = f.readline()
        delimiter = "\t" if "\t" in first_line else ","
        f.seek(0)

        reader = csv.DictReader(f, delimiter=delimiter)
        raw_headers = reader.fieldnames or []
        header_map = {orig: _normalize_header(orig) for orig in raw_headers}

        norm_headers = set(header_map.values())
        if not SIGNATURE_HEADERS.issubset(norm_headers):
            result["warnings"].append(
                f"Not a Custom Combined Tax report. Missing headers: "
                f"{SIGNATURE_HEADERS - norm_headers}"
            )
            return result

        for row_num, raw_row in enumerate(reader, start=2):
            result["rows_total"] += 1
            row = {
                header_map.get(k, k): v
                for k, v in raw_row.items()
                if k in header_map
            }

            order_id = (row.get("order_id") or "").strip()
            asin = (row.get("asin") or "").strip()
            ship_to_state = (row.get("ship_to_state") or "").strip().upper()
            ship_from_state = (row.get("ship_from_state") or "").strip().upper()
            ship_to_country = (row.get("ship_to_country") or "").strip().upper()

            if not order_id or not ship_to_state:
                result["rows_skipped"] += 1
                continue

            # Only US destinations
            if ship_to_country and ship_to_country != "US":
                result["rows_skipped"] += 1
                continue

            if ship_to_state not in US_STATES:
                result["rows_skipped"] += 1
                continue

            result["rows_parsed"] += 1
            all_order_ids.add(order_id)

            result["ship_to_states"].add(ship_to_state)
            if ship_from_state in US_STATES:
                result["ship_from_states"].add(ship_from_state)

            # Deduplicate jurisdiction rows: count each line item once
            dedup_key = (order_id, asin)
            if dedup_key in seen_order_lines:
                continue
            seen_order_lines.add(dedup_key)

            # Date — prefer shipment, fall back to order
            effective_date = (
                _parse_date(row.get("shipment_date") or "")
                or _parse_date(row.get("order_date") or "")
            )
            if effective_date is None:
                continue

            month_key = _month_start(effective_date)

            price = _parse_money(
                row.get("taxexclusive_selling_price")
                or row.get("display_price")
                or "0"
            )
            tax = _parse_money(
                row.get("total_tax_collected_by_amazon")
                or row.get("total_tax")
                or "0"
            )

            qty = 0
            try:
                qty = int(float((row.get("quantity") or "0").strip() or "0"))
            except (ValueError, TypeError):
                qty = 0

            # Accumulate sales by (destination state, month)
            bucket = sales_agg[(ship_to_state, month_key)]
            bucket["order_ids"].add(order_id)
            bucket["gross_sales"] += price * max(qty, 1)
            bucket["tax_collected"] += tax
            bucket["quantity"] += max(qty, 1)

            # Accumulate ship-from by (source state, month)
            if ship_from_state in US_STATES:
                sf = ship_from_agg[(ship_from_state, month_key)]
                sf["quantity"] += max(qty, 1)
                sf["cities"].add(
                    (row.get("ship_from_city") or "").strip().upper()
                )

    # ---- Build SalesByState records ----
    for (state, period_start), bucket in sales_agg.items():
        period_end = _month_end(period_start)
        record = SalesByState(
            state_code=state,
            channel="amazon",
            period_start=period_start,
            period_end=period_end,
            order_count=len(bucket["order_ids"]),
            gross_sales=round(bucket["gross_sales"], 2),
            net_sales=round(bucket["gross_sales"], 2),
            tax_collected=round(bucket["tax_collected"], 2),
            source="amazon_custom_combined_tax",
        )
        result["sales_records"].append(record)
        result["total_gross_sales"] += record.gross_sales
        result["total_tax_collected"] += record.tax_collected

    # ---- Build inventory_events for ship-from signals ----
    for (state, period_start), bucket in ship_from_agg.items():
        result["inventory_records"].append({
            "source_file": path.name,
            "event_date": period_start.isoformat(),
            "fc_code": f"TAX-RPT-{state}",
            "state_code": state,
            "asin": "ALL",
            "sku": None,
            "fnsku": None,
            "quantity": bucket["quantity"],
            "event_type": "TaxReportShipFrom",
            "disposition": None,
            "raw_data": {
                "cities": sorted(bucket["cities"] - {""}),
                "source": "amazon_custom_combined_tax",
            },
        })

    result["unique_orders"] = len(all_order_ids)
    result["file_hash"] = fhash
    result["total_gross_sales"] = round(result["total_gross_sales"], 2)
    result["total_tax_collected"] = round(result["total_tax_collected"], 2)

    return result


# ---------------------------------------------------------------------------
# Ingest (parse + write to DB)
# ---------------------------------------------------------------------------


def ingest_amazon_tax_report(file_path: str | Path, dry_run: bool = False) -> dict:
    """Parse and ingest an Amazon Custom Combined Tax report."""
    parsed = parse_amazon_tax_report(file_path)

    summary = {
        "filename": parsed["filename"],
        "rows_total": parsed["rows_total"],
        "rows_parsed": parsed["rows_parsed"],
        "rows_skipped": parsed["rows_skipped"],
        "unique_orders": parsed["unique_orders"],
        "ship_to_states": sorted(parsed["ship_to_states"]),
        "ship_from_states": sorted(parsed["ship_from_states"]),
        "total_gross_sales": parsed["total_gross_sales"],
        "total_tax_collected": parsed["total_tax_collected"],
        "sales_periods": len(parsed["sales_records"]),
        "warnings": parsed["warnings"],
        "dry_run": dry_run,
        "rows_inserted": 0,
        "ship_from_rows_inserted": 0,
    }

    if dry_run or (not parsed["sales_records"] and not parsed["inventory_records"]):
        return summary

    # Upsert sales_by_state
    if parsed["sales_records"]:
        sales_rows = [r.model_dump() for r in parsed["sales_records"]]
        inserted = upsert_rows(
            "sales_by_state",
            sales_rows,
            on_conflict="state_code,channel,period_start,period_end",
        )
        summary["rows_inserted"] = inserted

    # Upsert ship-from inventory events
    if parsed["inventory_records"]:
        ship_inserted = upsert_rows(
            "inventory_events",
            parsed["inventory_records"],
            on_conflict="source_file,event_date,fc_code,asin,event_type,quantity",
        )
        summary["ship_from_rows_inserted"] = ship_inserted

    total_inserted = summary["rows_inserted"] + summary["ship_from_rows_inserted"]

    log_ingestion(
        filename=parsed["filename"],
        file_type="amazon_sales",
        file_hash=parsed.get("file_hash"),
        rows_total=parsed["rows_total"],
        rows_inserted=total_inserted,
        rows_skipped=parsed["rows_skipped"],
        warnings=parsed["warnings"] or None,
    )

    log_audit(
        action="ingest_amazon_tax_report",
        category="ingestion",
        details={
            "ship_to_states": sorted(parsed["ship_to_states"]),
            "ship_from_states": sorted(parsed["ship_from_states"]),
            "unique_orders": parsed["unique_orders"],
            "total_gross_sales": parsed["total_gross_sales"],
            "total_tax_collected": parsed["total_tax_collected"],
            "sales_periods": len(parsed["sales_records"]),
        },
        source_file=parsed["filename"],
        rows_affected=summary["rows_inserted"],
    )

    return summary
