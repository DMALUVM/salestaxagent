"""SP-API report types, parsing, and ingestion.

Orchestrates: request report → download → parse → write to DB.
Reuses the existing SalesByState and InventoryEvent models.
"""
from __future__ import annotations

import csv
import io
import re
from collections import defaultdict
from datetime import date, datetime, timedelta

from src.channels import AMAZON
from src.db import delete_rows, log_audit, log_ingestion, upsert_rows
from src.mappers.fc_to_state import fc_to_state
from src.models.schema import InventoryEvent, SalesByState
from src.sku_normalize import normalize_sku

from src.amazon_sp.client import request_and_download

# ── Report type constants ────────────────────────────────────

ORDERS_REPORT = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL"
INVENTORY_LEDGER_REPORT = "GET_LEDGER_DETAIL_VIEW_DATA"
FBA_SHIPMENTS_REPORT = "GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL"
FBA_RETURNS_REPORT = "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA"

SOURCE_LABEL = "amazon_spapi"

US_STATES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC",
}

# Full state name → 2-letter code.  SP-API orders report uses full names
# in ship-state (e.g. "Iowa", "North Carolina").
_STATE_NAME_TO_CODE: dict[str, str] = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT",
    "delaware": "DE", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
    "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME",
    "maryland": "MD", "massachusetts": "MA", "michigan": "MI",
    "minnesota": "MN", "mississippi": "MS", "missouri": "MO",
    "montana": "MT", "nebraska": "NE", "nevada": "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
    "new york": "NY", "north carolina": "NC", "north dakota": "ND",
    "ohio": "OH", "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA",
    "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
    "virginia": "VA", "washington": "WA", "west virginia": "WV",
    "wisconsin": "WI", "wyoming": "WY",
    "district of columbia": "DC", "washington dc": "DC", "d.c.": "DC",
}


def _normalize_state(value: str) -> str | None:
    """Convert a state value to its 2-letter code.

    Accepts: "IA", "Iowa", "iowa", "IOWA", etc.
    Returns None if unrecognizable.
    """
    v = value.strip()
    if not v:
        return None
    upper = v.upper()
    if upper in US_STATES:
        return upper
    return _STATE_NAME_TO_CODE.get(v.lower())


# ── Helpers ──────────────────────────────────────────────────


def _detect_delimiter(first_line: str) -> str:
    """Detect whether the report is tab- or space-delimited.

    SP-API reports vary: the orders report is tab-delimited with
    unquoted headers, while the inventory ledger detail report is
    space-delimited with quoted headers.
    """
    if "\t" in first_line:
        return "\t"
    # Space-separated with quoted fields (e.g. "Date" "FNSKU" ...)
    if first_line.startswith('"') and '" "' in first_line:
        return " "
    # Comma-separated fallback
    if "," in first_line:
        return ","
    return "\t"


def _build_header_lookup(fieldnames: list[str]) -> dict[str, str]:
    """Build a mapping from canonical-name → original-header-name.

    Produces entries for both hyphenated and underscored variants,
    so callers can look up ``lookup["fulfillment-center"]`` or
    ``lookup["fulfillment_center"]`` and get the original key that
    csv.DictReader uses in row dicts.
    """
    lookup: dict[str, str] = {}
    for orig in fieldnames:
        clean = orig.strip().strip('"').strip()
        # lowered-hyphen form: "Fulfillment Center" → "fulfillment-center"
        normed = clean.lower().replace(" ", "-").replace("_", "-")
        lookup[normed] = orig
        # lowered-underscore form: "fulfillment_center"
        normed_u = clean.lower().replace(" ", "_").replace("-", "_")
        if normed_u != normed:
            lookup[normed_u] = orig
        # raw lowercase: "date", "asin"
        raw_lower = clean.lower()
        if raw_lower not in lookup:
            lookup[raw_lower] = orig
    return lookup


def _get(row: dict, lookup: dict[str, str], *names: str) -> str:
    """Look up a field in *row* by trying each canonical name in order.

    Returns the stripped value, or "" if no name matches.
    """
    for name in names:
        orig = lookup.get(name)
        if orig is not None:
            v = row.get(orig)
            if v is not None:
                return v.strip()
    return ""


def _parse_date(value: str) -> date | None:
    v = value.strip()
    if not v:
        return None
    # ISO-like: "2024-01-15T08:30:00+00:00", "2024-01-15"
    if len(v) >= 10 and v[4:5] == "-":
        try:
            return datetime.strptime(v[:10], "%Y-%m-%d").date()
        except ValueError:
            pass
    # SP-API ledger datetime: "Aug 1, 2025 3:00:00 AM PDT"
    cleaned = re.sub(r"\s+[A-Z]{2,4}$", "", v)
    for fmt in ("%b %d, %Y %I:%M:%S %p", "%b %d, %Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(cleaned, fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(v).date()
    except (ValueError, TypeError):
        return None


def _parse_money(value: str) -> float:
    v = value.strip().replace(",", "")
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


MAX_CHUNK_DAYS = 30


def _date_chunks(start: date, end: date) -> list[tuple[date, date]]:
    """Split a date range into calendar-month-aligned chunks.

    Each chunk covers one calendar month (or partial month at the
    boundaries).  This keeps the chunks aligned with our sales_by_state
    monthly aggregation periods and avoids hitting Amazon's report-range
    limit (~30 days for the orders report).

    Returns a list of ``(chunk_start, chunk_end)`` tuples.
    """
    chunks: list[tuple[date, date]] = []
    cursor = start
    while cursor <= end:
        # End of this calendar month
        chunk_end = _month_end(cursor)
        # Clamp to overall end
        if chunk_end > end:
            chunk_end = end
        chunks.append((cursor, chunk_end))
        # Advance to first day of next month
        cursor = chunk_end + timedelta(days=1)
    return chunks


# ── Orders report parser ─────────────────────────────────────


def parse_orders_report(content: str) -> dict:
    """Parse a GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL report.

    Aggregates order-level sales data by (ship_to_state, month) into
    SalesByState records.

    Key quirks of this report format:
    - Tab-delimited, lowercase-hyphenated headers, unquoted.
    - ``ship-state`` contains **full state names** ("Iowa", "North Carolina"),
      not 2-letter codes.  We normalize via ``_normalize_state()``.
    - Multi-Channel Fulfillment (MCF) rows have ``sales-channel = "Non-Amazon"``
      and leave price/address fields blank.  We skip those.
    - Each row is a line item; one order can span multiple rows.
    """
    result: dict = {
        "rows_total": 0,
        "rows_parsed": 0,
        "rows_skipped": 0,
        "warnings": [],
        "sales_records": [],
        "ship_to_states": set(),
        "total_gross_sales": 0.0,
        "total_tax": 0.0,
        "unique_orders": 0,
    }

    first_line = content.split("\n", 1)[0]
    delimiter = _detect_delimiter(first_line)
    reader = csv.DictReader(
        io.StringIO(content), delimiter=delimiter, quotechar='"',
    )
    if not reader.fieldnames:
        result["warnings"].append("Empty report or no headers")
        return result

    H = _build_header_lookup(reader.fieldnames)

    sales_agg: dict[tuple, dict] = defaultdict(lambda: {
        "order_ids": set(),
        "gross_sales": 0.0,
        "tax_collected": 0.0,
        "quantity": 0,
    })
    all_order_ids: set[str] = set()

    for row in reader:
        result["rows_total"] += 1

        order_id = _get(row, H, "amazon-order-id")
        status = _get(row, H, "order-status").lower()
        country = _get(row, H, "ship-country").upper()
        raw_state = _get(row, H, "ship-state")

        # Skip rows without an order id
        if not order_id:
            result["rows_skipped"] += 1
            continue

        # Skip cancelled / pending orders
        if status in ("cancelled", "pending"):
            result["rows_skipped"] += 1
            continue

        # Skip non-US destinations
        if country and country not in ("US", ""):
            result["rows_skipped"] += 1
            continue

        # Skip rows with no state (MCF / Non-Amazon rows often lack address)
        if not raw_state:
            result["rows_skipped"] += 1
            continue

        # Normalize state: "Iowa" → "IA", "IA" → "IA"
        state = _normalize_state(raw_state)
        if not state:
            result["rows_skipped"] += 1
            continue

        # Skip rows with no price data (MCF orders with blank amounts)
        price_str = _get(row, H, "item-price")
        if not price_str:
            result["rows_skipped"] += 1
            continue

        result["rows_parsed"] += 1
        all_order_ids.add(order_id)
        result["ship_to_states"].add(state)

        purchase_date = _parse_date(_get(row, H, "purchase-date"))
        if not purchase_date:
            continue

        month_key = _month_start(purchase_date)

        price = _parse_money(price_str)
        tax = _parse_money(_get(row, H, "item-tax"))
        try:
            qty = int(float(_get(row, H, "quantity") or "0"))
        except (ValueError, TypeError):
            qty = 0

        bucket = sales_agg[(state, month_key)]
        bucket["order_ids"].add(order_id)
        bucket["gross_sales"] += price
        bucket["tax_collected"] += tax
        bucket["quantity"] += max(qty, 1)

    for (state, period_start), bucket in sales_agg.items():
        period_end = _month_end(period_start)
        record = SalesByState(
            state_code=state,
            channel=AMAZON,
            period_start=period_start,
            period_end=period_end,
            order_count=len(bucket["order_ids"]),
            gross_sales=round(bucket["gross_sales"], 2),
            net_sales=round(bucket["gross_sales"], 2),
            tax_collected=round(bucket["tax_collected"], 2),
            source=SOURCE_LABEL,
        )
        result["sales_records"].append(record)
        result["total_gross_sales"] += record.gross_sales
        result["total_tax"] += record.tax_collected

    result["unique_orders"] = len(all_order_ids)
    result["total_gross_sales"] = round(result["total_gross_sales"], 2)
    result["total_tax"] = round(result["total_tax"], 2)

    # Diagnostic: if nothing parsed, report why so the user isn't mystified
    if result["rows_total"] == 0 and reader.fieldnames:
        lines = content.count("\n")
        result["warnings"].append(
            f"Report has headers ({len(reader.fieldnames)} cols, "
            f"delim={delimiter!r}) but 0 data rows ({lines} lines total). "
            f"The date range may be empty or extend into the future."
        )

    # Store a few sample records for dry-run display
    result["_samples"] = result["sales_records"][:5]

    return result


# ── Orders → SKU-level parser ─────────────────────────────────


def parse_orders_by_sku(content: str) -> dict:
    """Parse the same orders report but aggregate by (sku, state, month)
    into rows suitable for sales_by_sku.
    """
    result: dict = {
        "rows_total": 0,
        "rows_parsed": 0,
        "rows_skipped": 0,
        "warnings": [],
        "sku_rows": [],
        "unique_skus": 0,
    }

    first_line = content.split("\n", 1)[0]
    delimiter = _detect_delimiter(first_line)
    reader = csv.DictReader(
        io.StringIO(content), delimiter=delimiter, quotechar='"',
    )
    if not reader.fieldnames:
        result["warnings"].append("Empty report or no headers")
        return result

    H = _build_header_lookup(reader.fieldnames)

    # Key: (sku, state, month_start)
    agg: dict[tuple, dict] = defaultdict(lambda: {
        "units": 0, "gross_sales": 0.0, "order_ids": set(),
        "asin": None, "title": None,
    })

    for row in reader:
        result["rows_total"] += 1

        order_id = _get(row, H, "amazon-order-id")
        status = _get(row, H, "order-status").lower()
        country = _get(row, H, "ship-country").upper()
        raw_state = _get(row, H, "ship-state")

        if not order_id:
            result["rows_skipped"] += 1
            continue
        if status in ("cancelled", "pending"):
            result["rows_skipped"] += 1
            continue
        if country and country not in ("US", ""):
            result["rows_skipped"] += 1
            continue

        state = _normalize_state(raw_state) if raw_state else "XX"
        if not state:
            state = "XX"

        raw_sku = _get(row, H, "sku")
        sku = normalize_sku(raw_sku)
        if sku == "UNKNOWN":
            result["rows_skipped"] += 1
            continue

        price_str = _get(row, H, "item-price")
        if not price_str:
            result["rows_skipped"] += 1
            continue

        purchase_date = _parse_date(_get(row, H, "purchase-date"))
        if not purchase_date:
            result["rows_skipped"] += 1
            continue

        result["rows_parsed"] += 1
        month_key = _month_start(purchase_date)
        price = _parse_money(price_str)
        try:
            qty = int(float(_get(row, H, "quantity") or "0"))
        except (ValueError, TypeError):
            qty = 0

        key = (sku, state, month_key)
        b = agg[key]
        b["units"] += max(qty, 1)
        b["gross_sales"] += price
        b["order_ids"].add(order_id)

        asin = _get(row, H, "asin")
        if asin and not b["asin"]:
            b["asin"] = asin
        title = _get(row, H, "product-name")
        if title and (not b["title"] or len(title) > len(b["title"])):
            b["title"] = title

    # Build output rows
    rows = []
    for (sku, state, month_start), b in agg.items():
        rows.append({
            "channel": "amazon",
            "sku": sku,
            "asin": b["asin"],
            "product_title": b["title"],
            "state_code": state,
            "period_start": month_start.isoformat(),
            "period_end": _month_end(month_start).isoformat(),
            "units": b["units"],
            "gross_sales": round(b["gross_sales"], 2),
            "net_sales": round(b["gross_sales"], 2),
            "refund_units": 0,
            "refund_sales": 0,
            "order_count": len(b["order_ids"]),
            "source": SOURCE_LABEL,
        })

    result["sku_rows"] = rows
    result["unique_skus"] = len(set(r["sku"] for r in rows)) if rows else 0
    return result


def fetch_amazon_skus(
    start: date,
    end: date,
    dry_run: bool = False,
    on_poll: callable | None = None,
) -> dict:
    """Fetch SP-API orders report, parse SKU-level, upsert to sales_by_sku."""
    chunks = _date_chunks(start, end)

    all_rows: list[dict] = []
    total_parsed = 0
    total_skipped = 0
    total_raw = 0
    warnings: list[str] = []

    for i, (c_start, c_end) in enumerate(chunks, 1):
        label = c_start.strftime("%Y-%m")
        if on_poll:
            on_poll(f"chunk {i}/{len(chunks)} ({label}): requesting", 0)

        content = request_and_download(
            ORDERS_REPORT, c_start, c_end, on_poll=on_poll,
        )
        parsed = parse_orders_by_sku(content)
        total_raw += parsed["rows_total"]
        total_parsed += parsed["rows_parsed"]
        total_skipped += parsed["rows_skipped"]
        warnings.extend(parsed["warnings"])
        all_rows.extend(parsed["sku_rows"])

        if on_poll:
            on_poll(
                f"chunk {i}/{len(chunks)} ({label}): "
                f"{parsed['rows_parsed']:,} rows, "
                f"{parsed['unique_skus']} SKUs",
                0,
            )

    unique_skus = len(set(r["sku"] for r in all_rows)) if all_rows else 0

    summary = {
        "report_type": "amazon_skus",
        "source": SOURCE_LABEL,
        "period": f"{start} to {end}",
        "chunks": len(chunks),
        "rows_total": total_raw,
        "rows_parsed": total_parsed,
        "rows_skipped": total_skipped,
        "sku_rows": len(all_rows),
        "unique_skus": unique_skus,
        "warnings": warnings,
        "dry_run": dry_run,
        "rows_inserted": 0,
    }

    if dry_run or not all_rows:
        return summary

    # Deduplicate on upsert key before writing
    seen: dict[tuple, dict] = {}
    for row in all_rows:
        key = (row["channel"], row["sku"], row["state_code"],
               row["period_start"], row["source"])
        existing = seen.get(key)
        if existing:
            existing["units"] += row["units"]
            existing["gross_sales"] = round(existing["gross_sales"] + row["gross_sales"], 2)
            existing["net_sales"] = round((existing["net_sales"] or 0) + (row["net_sales"] or 0), 2)
            existing["order_count"] = (existing["order_count"] or 0) + (row["order_count"] or 0)
            # Keep longest title
            if row.get("product_title") and (
                not existing.get("product_title")
                or len(row["product_title"]) > len(existing["product_title"])
            ):
                existing["product_title"] = row["product_title"]
        else:
            seen[key] = dict(row)

    deduped = list(seen.values())

    inserted = upsert_rows(
        "sales_by_sku", deduped,
        on_conflict="channel,sku,state_code,period_start,source",
    )
    summary["rows_inserted"] = inserted

    log_ingestion(
        filename=f"spapi_skus_{start}_{end}",
        file_type="amazon_sales",
        rows_total=total_raw,
        rows_inserted=inserted,
        rows_skipped=total_skipped,
        warnings=warnings or None,
    )
    log_audit(
        action="fetch_amazon_skus",
        category="ingestion",
        details={
            "period": f"{start} to {end}",
            "unique_skus": unique_skus,
            "sku_rows": len(deduped),
        },
        rows_affected=inserted,
    )

    return summary


# ── Inventory Ledger parser ──────────────────────────────────


def parse_inventory_ledger(content: str) -> dict:
    """Parse a GET_LEDGER_DETAIL_VIEW_DATA report.

    Each row maps to an InventoryEvent.

    SP-API inventory ledger columns (space-delimited, quoted):
        "Date" "FNSKU" "ASIN" "MSKU" "Title" "Event Type"
        "Reference ID" "Quantity" "Fulfillment Center"
        "Disposition" "Reason" "Country"
        "Reconciled Quantity" "Unreconciled Quantity"
        "Date and Time" "Store"
    """
    result: dict = {
        "rows_total": 0,
        "rows_parsed": 0,
        "rows_skipped": 0,
        "warnings": [],
        "events": [],
        "states_found": set(),
        "unknown_fcs": set(),
    }

    first_line = content.split("\n", 1)[0]
    delimiter = _detect_delimiter(first_line)
    reader = csv.DictReader(
        io.StringIO(content), delimiter=delimiter, quotechar='"',
    )
    if not reader.fieldnames:
        result["warnings"].append("Empty report or no headers")
        return result

    H = _build_header_lookup(reader.fieldnames)

    # Verify we found the critical column
    fc_key = H.get("fulfillment-center") or H.get("fulfillment_center")
    if not fc_key:
        result["warnings"].append(
            f"Cannot find 'Fulfillment Center' column. "
            f"Headers detected ({delimiter!r} delim): "
            f"{reader.fieldnames[:5]}{'...' if len(reader.fieldnames) > 5 else ''}"
        )
        return result

    source_file = "spapi_inventory_ledger"

    for row in reader:
        result["rows_total"] += 1

        fc_code = _get(row, H, "fulfillment-center", "fulfillment_center").upper()
        # Try the precise "Date and Time" first, fall back to "Date"
        date_str = (
            _get(row, H, "date-and-time", "date_and_time")
            or _get(row, H, "date")
        )

        if not fc_code or not date_str:
            result["rows_skipped"] += 1
            continue

        event_date = _parse_date(date_str)
        if not event_date:
            result["rows_skipped"] += 1
            continue

        state_code = fc_to_state(fc_code)
        if state_code is None:
            result["unknown_fcs"].add(fc_code)

        try:
            qty = int(float(_get(row, H, "quantity") or "0"))
        except (ValueError, TypeError):
            qty = 0

        event = InventoryEvent(
            source_file=source_file,
            event_date=event_date,
            fc_code=fc_code,
            state_code=state_code,
            asin=_get(row, H, "asin") or None,
            sku=_get(row, H, "msku").upper() or None,
            fnsku=_get(row, H, "fnsku").upper() or None,
            quantity=qty,
            event_type=_get(row, H, "event-type", "event_type") or None,
            disposition=_get(row, H, "disposition") or None,
        )

        result["events"].append(event)
        result["rows_parsed"] += 1
        if state_code:
            result["states_found"].add(state_code)

    if result["unknown_fcs"]:
        result["warnings"].append(
            f"Unknown FC codes: {sorted(result['unknown_fcs'])}. "
            f"Add them to config/fc_codes.json."
        )

    return result


# ── Full fetch-and-ingest orchestrators ──────────────────────


def fetch_orders(
    start: date,
    end: date,
    dry_run: bool = False,
    on_poll: callable | None = None,
) -> dict:
    """Fetch orders report via SP-API and ingest into sales_by_state.

    Automatically splits ranges longer than one calendar month into
    monthly chunks, since Amazon returns empty reports for ranges
    that are too wide.
    """
    chunks = _date_chunks(start, end)

    # Accumulators across all chunks
    all_records: list[SalesByState] = []
    total_rows = 0
    total_parsed = 0
    total_skipped = 0
    all_order_ids: set[str] = set()
    all_states: set[str] = set()
    total_gross = 0.0
    total_tax = 0.0
    warnings: list[str] = []
    samples: list[SalesByState] = []

    for i, (c_start, c_end) in enumerate(chunks, 1):
        label = c_start.strftime("%Y-%m")
        if on_poll:
            on_poll(f"chunk {i}/{len(chunks)} ({label}): requesting", 0)

        content = request_and_download(
            ORDERS_REPORT, c_start, c_end, on_poll=on_poll,
        )
        parsed = parse_orders_report(content)

        total_rows += parsed["rows_total"]
        total_parsed += parsed["rows_parsed"]
        total_skipped += parsed["rows_skipped"]
        all_states.update(parsed["ship_to_states"])
        total_gross += parsed["total_gross_sales"]
        total_tax += parsed["total_tax"]
        warnings.extend(parsed["warnings"])
        all_records.extend(parsed["sales_records"])

        if not samples:
            samples = parsed.get("_samples", [])

        if on_poll:
            on_poll(
                f"chunk {i}/{len(chunks)} ({label}): "
                f"{parsed['rows_parsed']:,} rows, "
                f"${parsed['total_gross_sales']:,.0f}, "
                f"{parsed['unique_orders']:,} orders",
                0,
            )

    summary = {
        "report_type": "orders",
        "source": SOURCE_LABEL,
        "period": f"{start} to {end}",
        "chunks": len(chunks),
        "rows_total": total_rows,
        "rows_parsed": total_parsed,
        "rows_skipped": total_skipped,
        "unique_orders": 0,  # filled below from order_count sum
        "sales_periods": len(all_records),
        "ship_to_states": sorted(all_states),
        "total_gross_sales": round(total_gross, 2),
        "total_tax": round(total_tax, 2),
        "warnings": warnings,
        "_samples": samples,
        "dry_run": dry_run,
        "rows_inserted": 0,
    }

    # Recount unique orders from the aggregated records
    summary["unique_orders"] = sum(r.order_count for r in all_records)

    if dry_run or not all_records:
        return summary

    rows = [r.model_dump() for r in all_records]
    inserted = upsert_rows(
        "sales_by_state", rows,
        on_conflict="state_code,channel,period_start,period_end",
    )
    summary["rows_inserted"] = inserted

    log_ingestion(
        filename=f"spapi_orders_{start}_{end}",
        file_type="amazon_sales",
        rows_total=total_rows,
        rows_inserted=inserted,
        rows_skipped=total_skipped,
        warnings=warnings or None,
    )
    log_audit(
        action="fetch_spapi_orders",
        category="ingestion",
        details={
            "period": f"{start} to {end}",
            "chunks": len(chunks),
            "total_gross_sales": round(total_gross, 2),
            "states": sorted(all_states),
        },
        rows_affected=inserted,
    )

    return summary


def fetch_inventory(
    start: date,
    end: date,
    dry_run: bool = False,
    on_poll: callable | None = None,
) -> dict:
    """Fetch inventory ledger via SP-API and ingest into inventory_events."""
    content = request_and_download(
        INVENTORY_LEDGER_REPORT, start, end, on_poll=on_poll,
    )

    parsed = parse_inventory_ledger(content)

    summary = {
        "report_type": "inventory_ledger",
        "source": SOURCE_LABEL,
        "period": f"{start} to {end}",
        "rows_total": parsed["rows_total"],
        "rows_parsed": parsed["rows_parsed"],
        "rows_skipped": parsed["rows_skipped"],
        "states_found": sorted(parsed["states_found"]),
        "unknown_fcs": sorted(parsed["unknown_fcs"]),
        "warnings": parsed["warnings"],
        "dry_run": dry_run,
        "rows_inserted": 0,
    }

    if dry_run or not parsed["events"]:
        return summary

    # Deduplicate on the DB unique constraint columns.
    # The ledger can contain rows that collide on all six conflict-key
    # fields (same FC, ASIN, event type, quantity, date, source_file).
    # Postgres ON CONFLICT DO UPDATE rejects a batch that touches the
    # same target row twice, so we must send only one per key.
    # Last occurrence wins (it appears later in the report).
    CONFLICT_KEYS = ("source_file", "event_date", "fc_code",
                     "asin", "event_type", "quantity")
    seen: dict[tuple, dict] = {}
    for e in parsed["events"]:
        row = e.model_dump()
        key = tuple(row.get(k) for k in CONFLICT_KEYS)
        seen[key] = row
    rows = list(seen.values())
    duplicates_removed = len(parsed["events"]) - len(rows)
    if duplicates_removed:
        summary["warnings"].append(
            f"Deduplicated {duplicates_removed:,} rows on conflict key "
            f"before upsert ({len(parsed['events']):,} → {len(rows):,})"
        )

    inserted = upsert_rows(
        "inventory_events", rows,
        on_conflict="source_file,event_date,fc_code,asin,event_type,quantity",
    )
    summary["rows_inserted"] = inserted

    log_ingestion(
        filename=f"spapi_inventory_{start}_{end}",
        file_type="amazon_inventory",
        rows_total=parsed["rows_total"],
        rows_inserted=inserted,
        rows_skipped=parsed["rows_skipped"],
        warnings=parsed["warnings"] or None,
    )
    log_audit(
        action="fetch_spapi_inventory",
        category="ingestion",
        details={
            "period": f"{start} to {end}",
            "states": sorted(parsed["states_found"]),
            "unknown_fcs": sorted(parsed["unknown_fcs"]),
        },
        rows_affected=inserted,
    )

    return summary


# ---------------------------------------------------------------------------
# FBA Customer Returns
# ---------------------------------------------------------------------------

def parse_fba_returns(content: str) -> dict:
    """Parse GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA report."""
    result: dict = {
        "rows_total": 0, "rows_parsed": 0, "rows_skipped": 0,
        "warnings": [], "return_records": [],
        "skus_found": set(), "reasons": {},
    }

    first_line = content.split("\n", 1)[0]
    delimiter = _detect_delimiter(first_line)
    reader = csv.DictReader(io.StringIO(content), delimiter=delimiter, quotechar='"')
    if not reader.fieldnames:
        return result

    H = _build_header_lookup(reader.fieldnames)
    from collections import Counter
    reason_counts: Counter = Counter()

    for row in reader:
        result["rows_total"] += 1
        return_date = _get(row, H, "return-date")
        order_id = _get(row, H, "order-id")
        sku = _get(row, H, "sku")
        if not return_date or not order_id or not sku:
            result["rows_skipped"] += 1
            continue

        try:
            qty = max(int(float(_get(row, H, "quantity") or "1")), 1)
        except (ValueError, TypeError):
            qty = 1

        reason = _get(row, H, "reason")
        reason_counts[reason] += qty

        result["return_records"].append({
            "return_date": return_date,
            "order_id": order_id,
            "sku": sku,
            "asin": _get(row, H, "asin") or None,
            "fnsku": _get(row, H, "fnsku") or None,
            "product_name": _get(row, H, "product-name") or None,
            "quantity": qty,
            "fulfillment_center": _get(row, H, "fulfillment-center-id") or None,
            "disposition": _get(row, H, "detailed-disposition") or None,
            "reason": reason or None,
            "status": _get(row, H, "status") or None,
            "customer_comments": _get(row, H, "customer-comments") or None,
            "source_file": SOURCE_LABEL,
        })
        result["skus_found"].add(sku)
        result["rows_parsed"] += 1

    result["reasons"] = dict(reason_counts)
    result["skus_found"] = sorted(result["skus_found"])
    return result


def fetch_fba_returns(
    start: date, end: date,
    dry_run: bool = False, on_poll: callable | None = None,
) -> dict:
    """Fetch FBA returns report and upsert into fba_returns."""
    content = request_and_download(FBA_RETURNS_REPORT, start, end, on_poll=on_poll)
    parsed = parse_fba_returns(content)

    summary = {
        "report_type": "fba_returns",
        "period": f"{start} to {end}",
        "rows_total": parsed["rows_total"],
        "rows_parsed": parsed["rows_parsed"],
        "rows_skipped": parsed["rows_skipped"],
        "skus_found": parsed["skus_found"],
        "reasons": parsed["reasons"],
        "dry_run": dry_run,
        "rows_inserted": 0,
    }

    if dry_run or not parsed["return_records"]:
        return summary

    inserted = upsert_rows(
        "fba_returns", parsed["return_records"],
        on_conflict="return_date,order_id,sku,quantity,reason",
    )
    summary["rows_inserted"] = inserted

    log_ingestion(
        filename=f"spapi_returns_{start}_{end}",
        file_type="amazon_returns",
        rows_total=parsed["rows_total"],
        rows_inserted=inserted,
        rows_skipped=parsed["rows_skipped"],
    )

    return summary
