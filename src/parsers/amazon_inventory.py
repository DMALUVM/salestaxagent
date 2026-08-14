from __future__ import annotations

import csv
import hashlib
from datetime import date, datetime
from pathlib import Path
from typing import TextIO

from src.db import insert_rows, log_ingestion, log_audit, upsert_rows
from src.mappers.fc_to_state import fc_to_state
from src.models.schema import InventoryEvent

EXPECTED_HEADERS = {
    "date-time", "fulfillment-center-id", "asin", "sku", "quantity",
    "event-type", "disposition",
}

HEADER_ALIASES = {
    "date/time": "date-time",
    "datetime": "date-time",
    "fulfillment-center": "fulfillment-center-id",
    "fulfillment center": "fulfillment-center-id",
    "fc": "fulfillment-center-id",
    "event type": "event-type",
    "eventtype": "event-type",
}


def _normalize_header(header: str) -> str:
    h = header.strip().lower()
    return HEADER_ALIASES.get(h, h)


def _detect_delimiter(first_line: str) -> str:
    if "\t" in first_line:
        return "\t"
    return ","


def _parse_date(value: str) -> date | None:
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(value.strip(), fmt).date()
        except ValueError:
            continue
    return None


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def parse_amazon_inventory_file(file_path: str | Path) -> dict:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    result = {
        "filename": path.name,
        "rows_total": 0,
        "rows_parsed": 0,
        "rows_skipped": 0,
        "warnings": [],
        "events": [],
        "states_found": set(),
        "unknown_fcs": set(),
    }

    fhash = _file_hash(path)

    with open(path, "r", encoding="utf-8-sig") as f:
        first_line = f.readline()
        delimiter = _detect_delimiter(first_line)
        f.seek(0)

        reader = csv.DictReader(f, delimiter=delimiter)
        raw_headers = reader.fieldnames or []
        header_map = {orig: _normalize_header(orig) for orig in raw_headers}

        found_headers = set(header_map.values())
        if "fulfillment-center-id" not in found_headers or "date-time" not in found_headers:
            result["warnings"].append(
                f"Missing required headers. Found: {list(found_headers)}. "
                f"Need at minimum: fulfillment-center-id, date-time"
            )
            return result

        for row_num, raw_row in enumerate(reader, start=2):
            result["rows_total"] += 1
            row = {header_map[k]: v for k, v in raw_row.items() if k in header_map}

            fc_code = (row.get("fulfillment-center-id") or "").strip().upper()
            date_str = row.get("date-time", "")

            if not fc_code or not date_str:
                result["rows_skipped"] += 1
                result["warnings"].append(f"Row {row_num}: missing FC code or date")
                continue

            event_date = _parse_date(date_str)
            if event_date is None:
                result["rows_skipped"] += 1
                result["warnings"].append(f"Row {row_num}: unparseable date '{date_str}'")
                continue

            state_code = fc_to_state(fc_code)
            if state_code is None:
                result["unknown_fcs"].add(fc_code)

            try:
                qty = int(float(row.get("quantity", "0").strip() or "0"))
            except (ValueError, TypeError):
                qty = 0

            event = InventoryEvent(
                source_file=path.name,
                event_date=event_date,
                fc_code=fc_code,
                state_code=state_code,
                asin=(row.get("asin") or "").strip() or None,
                sku=(row.get("sku") or "").strip() or None,
                fnsku=(row.get("fnsku") or "").strip() or None,
                quantity=qty,
                event_type=(row.get("event-type") or "").strip() or None,
                disposition=(row.get("disposition") or "").strip() or None,
                raw_data=row,
            )

            result["events"].append(event)
            result["rows_parsed"] += 1
            if state_code:
                result["states_found"].add(state_code)

    if result["unknown_fcs"]:
        result["warnings"].append(
            f"Unknown FC codes (not mapped to states): {sorted(result['unknown_fcs'])}. "
            f"Add them to config/fc_codes.json."
        )

    result["file_hash"] = fhash
    return result


def ingest_amazon_inventory(file_path: str | Path, dry_run: bool = False) -> dict:
    parsed = parse_amazon_inventory_file(file_path)

    if dry_run or not parsed["events"]:
        return {
            "filename": parsed["filename"],
            "rows_total": parsed["rows_total"],
            "rows_parsed": parsed["rows_parsed"],
            "rows_skipped": parsed["rows_skipped"],
            "states_found": sorted(parsed["states_found"]),
            "unknown_fcs": sorted(parsed["unknown_fcs"]),
            "warnings": parsed["warnings"],
            "dry_run": dry_run,
            "rows_inserted": 0,
        }

    rows = [e.model_dump() for e in parsed["events"]]
    inserted = upsert_rows(
        "inventory_events",
        rows,
        on_conflict="source_file,event_date,fc_code,asin,event_type,quantity",
    )

    log_ingestion(
        filename=parsed["filename"],
        file_type="amazon_inventory",
        file_hash=parsed.get("file_hash"),
        rows_total=parsed["rows_total"],
        rows_inserted=inserted,
        rows_skipped=parsed["rows_skipped"],
        warnings=parsed["warnings"] or None,
    )

    log_audit(
        action="ingest_amazon_inventory",
        category="ingestion",
        details={
            "states_found": sorted(parsed["states_found"]),
            "unknown_fcs": sorted(parsed["unknown_fcs"]),
            "rows_total": parsed["rows_total"],
            "rows_inserted": inserted,
        },
        source_file=parsed["filename"],
        rows_affected=inserted,
    )

    return {
        "filename": parsed["filename"],
        "rows_total": parsed["rows_total"],
        "rows_parsed": parsed["rows_parsed"],
        "rows_skipped": parsed["rows_skipped"],
        "rows_inserted": inserted,
        "states_found": sorted(parsed["states_found"]),
        "unknown_fcs": sorted(parsed["unknown_fcs"]),
        "warnings": parsed["warnings"],
        "dry_run": False,
    }
