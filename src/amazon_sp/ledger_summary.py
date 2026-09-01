"""GET_LEDGER_SUMMARY_VIEW_DATA ingest — daily ending warehouse balance by FC.

Tax / physical-nexus inventory $ at sku_costs. Not a substitute for the
event-level GET_LEDGER_DETAIL_VIEW_DATA feed that writes inventory_events.
"""
from __future__ import annotations

import csv
import io
from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP

from src.mappers.fc_to_state import fc_to_state
from src.sku_normalize import normalize_sku


def _reports():
    from src.amazon_sp import reports as reports_mod
    return reports_mod


def _db():
    from src import db as db_mod
    return db_mod


def _client():
    from src.amazon_sp.client import request_and_download
    return request_and_download

LEDGER_SUMMARY_REPORT = "GET_LEDGER_SUMMARY_VIEW_DATA"
LEDGER_SUMMARY_OPTIONS = {
    "aggregatedByTimePeriod": "DAILY",
    "aggregateByLocation": "FC",
}

CONFLICT_KEY = "snapshot_date,sku,fc_code,disposition"
UNKNOWN_STATE = "XX"


def _money4(value: float | Decimal) -> float:
    return float(Decimal(str(value)).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP))


def load_sku_costs() -> dict[str, float]:
    """Latest cogs_per_unit per normalized SKU. Missing SKUs are omitted."""
    costs: dict[str, float] = {}
    for row in _db().fetch_all("sku_costs"):
        sku = normalize_sku(row.get("sku"))
        if sku == "UNKNOWN":
            continue
        raw = row.get("cogs_per_unit")
        if raw is None or raw == "":
            continue
        try:
            costs[sku] = float(raw)
        except (TypeError, ValueError):
            continue
    return costs


def parse_ledger_summary(
    content: str,
    costs: dict[str, float] | None = None,
) -> dict:
    """Parse a DAILY / FC ledger-summary report into upsert rows.

    Uses Ending Warehouse Balance (all dispositions still in warehouse).
    Location is the FC code. Unmapped FCs keep state_code=None.
    Missing sku_costs: qty is stored, $ is 0, and the SKU is noted.
    """
    result: dict = {
        "rows_total": 0,
        "rows_parsed": 0,
        "rows_skipped": 0,
        "warnings": [],
        "rows": [],
        "states_found": set(),
        "unknown_fcs": set(),
        "missing_cost_skus": set(),
        "missing_cost_units": 0,
        "total_cogs": 0.0,
        "total_units": 0,
    }
    if not content or not content.strip():
        result["warnings"].append("Empty report")
        return result

    R = _reports()
    first_line = content.split("\n", 1)[0]
    delimiter = R._detect_delimiter(first_line)
    reader = csv.DictReader(
        io.StringIO(content), delimiter=delimiter, quotechar='"',
    )
    if not reader.fieldnames:
        result["warnings"].append("Empty report or no headers")
        return result

    H = R._build_header_lookup(reader.fieldnames)
    loc_key = (
        H.get("location")
        or H.get("fulfillment-center")
        or H.get("fulfillment_center")
        or H.get("fc")
    )
    end_key = (
        H.get("ending-warehouse-balance")
        or H.get("ending_warehouse_balance")
        or H.get("ending-balance")
        or H.get("ending_balance")
    )
    if not loc_key or not end_key:
        result["warnings"].append(
            "Cannot find Location / Ending Warehouse Balance columns. "
            f"Headers: {reader.fieldnames[:8]}"
        )
        return result

    cost_map = costs if costs is not None else {}
    # Last row wins on the upsert key (Amazon can emit dupes in one file).
    seen: dict[tuple, dict] = {}

    for row in reader:
        result["rows_total"] += 1
        fc_code = R._get(
            row, H, "location", "fulfillment-center", "fulfillment_center", "fc",
        ).upper()
        date_str = R._get(row, H, "date")
        if not fc_code or not date_str:
            result["rows_skipped"] += 1
            continue

        snapshot_date = R._parse_date(date_str)
        if not snapshot_date:
            result["rows_skipped"] += 1
            continue

        sku = normalize_sku(R._get(row, H, "msku", "sku", "merchant-sku"))
        if sku == "UNKNOWN":
            result["rows_skipped"] += 1
            continue

        try:
            ending_qty = int(float(
                R._get(row, H, "ending-warehouse-balance",
                     "ending_warehouse_balance", "ending-balance",
                     "ending_balance") or "0"
            ))
        except (ValueError, TypeError):
            result["rows_skipped"] += 1
            continue

        disposition = R._get(row, H, "disposition") or ""
        state_code = fc_to_state(fc_code)
        if state_code is None:
            result["unknown_fcs"].add(fc_code)

        cogs_per_unit = cost_map.get(sku)
        if cogs_per_unit is None:
            cogs_value = 0.0
            if ending_qty != 0:
                result["missing_cost_skus"].add(sku)
                result["missing_cost_units"] += abs(ending_qty)
        else:
            cogs_value = _money4(ending_qty * cogs_per_unit)

        rec = {
            "snapshot_date": snapshot_date.isoformat(),
            "sku": sku,
            "fc_code": fc_code,
            "state_code": state_code,
            "disposition": disposition,
            "ending_qty": ending_qty,
            "cogs_per_unit": cogs_per_unit,
            "cogs_value": cogs_value,
        }
        key = (rec["snapshot_date"], sku, fc_code, disposition)
        seen[key] = rec
        result["rows_parsed"] += 1
        if state_code:
            result["states_found"].add(state_code)

    result["rows"] = list(seen.values())
    result["total_units"] = sum(int(r["ending_qty"]) for r in result["rows"])
    result["total_cogs"] = _money4(sum(float(r["cogs_value"]) for r in result["rows"]))
    if result["unknown_fcs"]:
        result["warnings"].append(
            f"Unknown FC codes: {sorted(result['unknown_fcs'])}. "
            f"Left unmapped (not invented). Add them to config/fc_codes.json."
        )
    if result["missing_cost_skus"]:
        result["warnings"].append(
            f"{len(result['missing_cost_skus'])} SKU(s) missing sku_costs "
            f"({result['missing_cost_units']} units excluded from $)."
        )
    return result


def summarize_state_day(rows: list[dict], snapshot_date: str, state_code: str) -> dict:
    """COGS / units / distinct FCs for one state on one day. Used by tests."""
    cogs = 0.0
    units = 0
    fcs: set[str] = set()
    for r in rows:
        if r.get("snapshot_date") != snapshot_date:
            continue
        if (r.get("state_code") or UNKNOWN_STATE) != state_code:
            continue
        cogs += float(r.get("cogs_value") or 0)
        units += int(r.get("ending_qty") or 0)
        fcs.add(r["fc_code"])
    return {
        "state_code": state_code,
        "snapshot_date": snapshot_date,
        "cogs_value": _money4(cogs),
        "units": units,
        "fc_count": len(fcs),
        "fcs": sorted(fcs),
    }


def peak_by_state(rows: list[dict], year: int) -> list[dict]:
    """Maximum daily COGS per state in `year`, plus current (latest day)."""
    daily: dict[tuple[str, str], dict] = defaultdict(
        lambda: {"cogs": 0.0, "units": 0, "fcs": set()}
    )
    for r in rows:
        day = str(r.get("snapshot_date") or "")[:10]
        if not day.startswith(str(year)):
            continue
        state = r.get("state_code") or UNKNOWN_STATE
        bucket = daily[(state, day)]
        bucket["cogs"] += float(r.get("cogs_value") or 0)
        bucket["units"] += int(r.get("ending_qty") or 0)
        bucket["fcs"].add(r.get("fc_code"))

    if not daily:
        return []

    latest = max(day for _, day in daily)
    peaks: dict[str, dict] = {}
    for (state, day), bucket in daily.items():
        cogs = _money4(bucket["cogs"])
        cur = peaks.get(state)
        if cur is None or cogs > cur["peak_cogs"] or (
            cogs == cur["peak_cogs"] and day > cur["peak_date"]
        ):
            peaks[state] = {
                "state_code": state,
                "peak_cogs": cogs,
                "peak_date": day,
                "current_cogs": 0.0,
                "current_units": 0,
                "current_fc_count": 0,
            }

    for (state, day), bucket in daily.items():
        if day != latest:
            continue
        peaks[state]["current_cogs"] = _money4(bucket["cogs"])
        peaks[state]["current_units"] = bucket["units"]
        peaks[state]["current_fc_count"] = len(bucket["fcs"])

    return sorted(peaks.values(), key=lambda r: r["peak_cogs"], reverse=True)


def fetch_ledger_summary(
    start: date,
    end: date,
    dry_run: bool = False,
    on_poll: callable | None = None,
    costs: dict[str, float] | None = None,
) -> dict:
    """Request DAILY/FC ledger summary, parse, upsert daily rows.

    Windows longer than SPAPI_MAX_CHUNK_DAYS are requested in chunks.
    Never uses GET_LEDGER_DETAIL_VIEW_DATA.
    """
    if LEDGER_SUMMARY_REPORT == "GET_LEDGER_DETAIL_VIEW_DATA":
        raise RuntimeError("ledger summary must not use the detail report")

    R = _reports()
    chunks = R._date_chunks(start, end)
    cost_map = costs if costs is not None else load_sku_costs()

    parsed = {
        "rows_total": 0,
        "rows_parsed": 0,
        "rows_skipped": 0,
        "warnings": [],
        "rows": [],
        "states_found": set(),
        "unknown_fcs": set(),
        "missing_cost_skus": set(),
        "missing_cost_units": 0,
        "total_cogs": 0.0,
        "total_units": 0,
    }
    seen: dict[tuple, dict] = {}

    for i, (c_start, c_end) in enumerate(chunks, 1):
        if on_poll:
            on_poll(f"chunk {i}/{len(chunks)} ({c_start}..{c_end}): requesting", 0)
        content = _client()(
            LEDGER_SUMMARY_REPORT,
            c_start,
            c_end,
            on_poll=on_poll,
            report_options=LEDGER_SUMMARY_OPTIONS,
        )
        part = parse_ledger_summary(content, costs=cost_map)
        parsed["rows_total"] += part["rows_total"]
        parsed["rows_parsed"] += part["rows_parsed"]
        parsed["rows_skipped"] += part["rows_skipped"]
        parsed["warnings"].extend(part["warnings"])
        parsed["states_found"].update(part["states_found"])
        parsed["unknown_fcs"].update(part["unknown_fcs"])
        parsed["missing_cost_skus"].update(part["missing_cost_skus"])
        parsed["missing_cost_units"] += part["missing_cost_units"]
        for rec in part["rows"]:
            key = (rec["snapshot_date"], rec["sku"], rec["fc_code"], rec["disposition"])
            seen[key] = rec
        if on_poll:
            on_poll(
                f"chunk {i}/{len(chunks)}: {part['rows_parsed']:,} rows, "
                f"${part['total_cogs']:,.2f}",
                0,
            )

    rows = list(seen.values())
    parsed["rows"] = rows
    parsed["total_cogs"] = _money4(sum(float(r["cogs_value"]) for r in rows))
    parsed["total_units"] = sum(int(r["ending_qty"]) for r in rows)

    ts = datetime.now(timezone.utc).isoformat()
    for rec in rows:
        rec["ingested_at"] = ts

    summary = {
        "report_type": "ledger_summary",
        "source": R.SOURCE_LABEL,
        "period": f"{start} to {end}",
        "chunks": len(chunks),
        "rows_total": parsed["rows_total"],
        "rows_parsed": parsed["rows_parsed"],
        "rows_skipped": parsed["rows_skipped"],
        "states_found": sorted(parsed["states_found"]),
        "unknown_fcs": sorted(parsed["unknown_fcs"]),
        "missing_cost_skus": sorted(parsed["missing_cost_skus"]),
        "missing_cost_units": parsed["missing_cost_units"],
        "total_cogs": parsed["total_cogs"],
        "total_units": parsed["total_units"],
        "warnings": parsed["warnings"],
        "dry_run": dry_run,
        "rows_inserted": 0,
    }

    if dry_run or not rows:
        return summary

    db = _db()
    inserted = db.upsert_rows(
        "inventory_ledger_summary_daily",
        rows,
        on_conflict=CONFLICT_KEY,
    )
    summary["rows_inserted"] = inserted

    db.log_ingestion(
        filename=f"spapi_ledger_summary_{start}_{end}",
        file_type="amazon_ledger_summary",
        rows_total=parsed["rows_total"],
        rows_inserted=inserted,
        rows_skipped=parsed["rows_skipped"],
        warnings=parsed["warnings"] or None,
    )
    db.log_audit(
        action="fetch_spapi_ledger_summary",
        category="ingestion",
        details={
            "period": f"{start} to {end}",
            "chunks": len(chunks),
            "total_cogs": parsed["total_cogs"],
            "states": sorted(parsed["states_found"]),
            "unknown_fcs": sorted(parsed["unknown_fcs"]),
        },
        rows_affected=inserted,
    )
    return summary
