"""Import monthly Amazon ad spend from Seller Central / Ads Console files.

Ads Reporting v3 only keeps ~95 days (this account: 2026-05-21 → present).
Earlier months stay ads-unknown unless a file is dropped here.

Accepted:
  - SKU Economics (Reports → SKU Economics). Must be Monthly aggregation
    or one calendar month per file. A single custom range spanning many
    months is one lump and is refused.
  - Ads Console campaign report with a Date column (daily rows land on
    ads_campaigns_daily as campaign_type=IMPORT).
"""
from __future__ import annotations

import csv
import io
import re
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

from src.db import log_audit, log_ingestion, upsert_rows

SOURCE_SKU_ECON = "sku_economics"
SOURCE_ADS_CONSOLE = "ads_console"
IMPORT_CAMPAIGN_TYPE = "IMPORT"

_AD_HEADER_FRAGMENTS = (
    "sponsored products ad fee",
    "sponsored brands ad fee",
    "sponsored display ad fee",
    "advertising cost",
    "advertising spend",
    "ad spend",
    "ppc spend",
    "total advertising",
    "ads cost",
    "cost of advertising",
)

_SKU_ECON_ID_HEADERS = (
    "msku", "merchant sku", "child asin", "fnsku", "parent asin",
    "seller sku",
)

_START_HEADERS = (
    "start date", "amazon store start date", "start date of amazon store",
    "period start", "report start date", "start",
)
_END_HEADERS = (
    "end date", "amazon store end date", "end date of amazon store",
    "period end", "report end date", "end",
)
_MONTH_HEADERS = ("month", "year month", "year-month", "reporting month")


def _norm(header: str) -> str:
    return re.sub(r"[\s_\-/]+", " ", (header or "").strip().strip('"').lower()).strip()


def _money(value: object) -> float:
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return round(float(value), 2)
    text = str(value).strip()
    if not text or text in {".", "-", "—", "n/a", "na"}:
        return 0.0
    neg = text.startswith("(") and text.endswith(")")
    text = text.replace("$", "").replace(",", "").replace("(", "").replace(")", "").strip()
    try:
        amount = float(text)
    except ValueError:
        return 0.0
    return round(-amount if neg else amount, 2)


def _parse_date(value: object) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value).strip()
    if not text:
        return None
    if isinstance(value, float) or re.fullmatch(r"\d+(\.0+)?", text):
        try:
            # Excel serial (openpyxl sometimes yields int/float)
            n = int(float(text))
            if 20000 < n < 80000:
                return date(1899, 12, 30) + timedelta(days=n)
        except ValueError:
            pass
    for fmt in (
        "%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d",
        "%b %Y", "%B %Y", "%Y-%m", "%b-%y", "%b-%Y",
    ):
        try:
            parsed = datetime.strptime(text, fmt)
            if fmt in ("%Y-%m", "%b %Y", "%B %Y", "%b-%y", "%b-%Y"):
                return parsed.replace(day=1).date()
            return parsed.date()
        except ValueError:
            continue
    if re.fullmatch(r"\d{4}-\d{2}", text):
        return date.fromisoformat(f"{text}-01")
    return None


def _month_end(d: date) -> date:
    if d.month == 12:
        return d.replace(day=31)
    return date(d.year, d.month + 1, 1) - timedelta(days=1)


def _lookup(normalized: list[str]) -> dict[str, int]:
    return {name: i for i, name in enumerate(normalized)}


def _first_idx(lookup: dict[str, int], names: tuple[str, ...]) -> int | None:
    for name in names:
        if name in lookup:
            return lookup[name]
    return None


def _ad_fee_indexes(normalized: list[str]) -> list[int]:
    out: list[int] = []
    for i, name in enumerate(normalized):
        if any(frag in name for frag in _AD_HEADER_FRAGMENTS):
            out.append(i)
    return out


def is_sku_economics_report(headers: list[str]) -> bool:
    names = [_norm(h) for h in headers]
    has_ad = bool(_ad_fee_indexes(names))
    has_id = any(n in names for n in _SKU_ECON_ID_HEADERS)
    has_sales = any("ordered product sales" in n or n in {"sales", "ordered sales"} for n in names)
    return has_ad and (has_id or has_sales)


def is_ads_console_campaign_report(headers: list[str]) -> bool:
    names = set(_norm(h) for h in headers)
    has_date = "date" in names
    has_spend = "spend" in names or "cost" in names
    has_campaign = "campaign name" in names or "campaign id" in names
    return has_date and has_spend and has_campaign


def detect_ads_spend_report(headers: list[str]) -> str | None:
    if is_sku_economics_report(headers):
        return SOURCE_SKU_ECON
    if is_ads_console_campaign_report(headers):
        return SOURCE_ADS_CONSOLE
    return None


def _read_tabular(path: Path) -> tuple[list[str], list[list[object]]]:
    suffix = path.suffix.lower()
    if suffix in {".xlsx", ".xlsm"}:
        import openpyxl
        wb = openpyxl.load_workbook(str(path), data_only=True, read_only=True)
        try:
            ws = wb.active
            rows = [list(r) for r in ws.iter_rows(values_only=True)]
        finally:
            wb.close()
        header_idx = _header_row_index(rows)
        if header_idx is None:
            return [], []
        headers = ["" if c is None else str(c) for c in rows[header_idx]]
        body = [list(r) for r in rows[header_idx + 1:] if any(c not in (None, "") for c in r)]
        return headers, body

    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    first = raw.split("\n", 1)[0]
    delim = "\t" if "\t" in first and first.count("\t") >= first.count(",") else ","
    reader = csv.reader(io.StringIO(raw), delimiter=delim)
    rows = list(reader)
    header_idx = _header_row_index(rows)
    if header_idx is None:
        return [], []
    headers = ["" if c is None else str(c) for c in rows[header_idx]]
    body = [list(r) for r in rows[header_idx + 1:] if any(str(c or "").strip() for c in r)]
    return headers, body


def _header_row_index(rows: list[list[object]]) -> int | None:
    for i, row in enumerate(rows[:20]):
        headers = ["" if c is None else str(c) for c in row]
        if detect_ads_spend_report(headers):
            return i
    return None


def parse_sku_economics_monthly(headers: list[str], rows: list[list[object]]) -> dict:
    names = [_norm(h) for h in headers]
    lookup = _lookup(names)
    ad_idxs = _ad_fee_indexes(names)
    start_idx = _first_idx(lookup, _START_HEADERS)
    end_idx = _first_idx(lookup, _END_HEADERS)
    month_idx = _first_idx(lookup, _MONTH_HEADERS)
    spend_by_month: dict[str, float] = defaultdict(float)
    skipped = 0
    wide_span = 0
    warnings: list[str] = []

    for row in rows:
        cells = list(row) + [""] * (len(names) - len(row))
        start = _parse_date(cells[start_idx]) if start_idx is not None else None
        end = _parse_date(cells[end_idx]) if end_idx is not None else None
        if start is None and month_idx is not None:
            start = _parse_date(cells[month_idx])
        if start is None:
            skipped += 1
            continue
        if end is None:
            end = _month_end(start.replace(day=1))
        span = (end - start).days + 1
        if span > 32:
            wide_span += 1
            continue
        ads = sum(_money(cells[i]) for i in ad_idxs)
        ym = start.replace(day=1)
        spend_by_month[ym.isoformat()] += ads

    if wide_span and not spend_by_month:
        warnings.append(
            f"{wide_span} row(s) span more than one month. Re-export SKU Economics "
            "with Monthly aggregation (or one calendar month per file)."
        )
    elif wide_span:
        warnings.append(
            f"Skipped {wide_span} row(s) whose date range spans more than one month."
        )

    months = []
    for start_iso, spend in sorted(spend_by_month.items()):
        start = date.fromisoformat(start_iso)
        months.append({
            "period_start": start_iso,
            "period_end": _month_end(start).isoformat(),
            "spend": round(spend, 2),
            "source": SOURCE_SKU_ECON,
        })
    return {
        "kind": SOURCE_SKU_ECON,
        "months": months,
        "rows_parsed": len(rows) - skipped - wide_span,
        "rows_skipped": skipped + wide_span,
        "warnings": warnings,
    }


def parse_ads_console_daily(headers: list[str], rows: list[list[object]]) -> dict:
    names = [_norm(h) for h in headers]
    lookup = _lookup(names)
    date_idx = lookup.get("date")
    spend_idx = lookup.get("spend")
    if spend_idx is None:
        spend_idx = lookup.get("cost")
    name_idx = lookup.get("campaign name")
    id_idx = lookup.get("campaign id")
    if date_idx is None or spend_idx is None:
        return {
            "kind": SOURCE_ADS_CONSOLE,
            "daily": [], "months": [],
            "rows_parsed": 0, "rows_skipped": len(rows),
            "warnings": ["Ads Console file has no Date/Spend columns."],
        }

    daily: list[dict] = []
    skipped = 0
    for row in rows:
        cells = list(row) + [""] * (len(names) - len(row))
        day = _parse_date(cells[date_idx])
        if day is None:
            skipped += 1
            continue
        name = str(cells[name_idx] if name_idx is not None else "").strip() or "imported"
        raw_id = str(cells[id_idx] if id_idx is not None else "").strip()
        campaign_id = f"csv:{raw_id or name}:{day.isoformat()}"
        daily.append({
            "date": day.isoformat(),
            "campaign_id": campaign_id[:120],
            "campaign_name": name[:200],
            "campaign_type": IMPORT_CAMPAIGN_TYPE,
            "spend": _money(cells[spend_idx]),
        })

    spend_by_month: dict[str, float] = defaultdict(float)
    for r in daily:
        spend_by_month[r["date"][:7] + "-01"] += r["spend"]
    months = []
    for start_iso, spend in sorted(spend_by_month.items()):
        start = date.fromisoformat(start_iso)
        months.append({
            "period_start": start_iso,
            "period_end": _month_end(start).isoformat(),
            "spend": round(spend, 2),
            "source": SOURCE_ADS_CONSOLE,
        })
    return {
        "kind": SOURCE_ADS_CONSOLE,
        "daily": daily,
        "months": months,
        "rows_parsed": len(daily),
        "rows_skipped": skipped,
        "warnings": [],
    }


def peek_ads_spend_headers(file_path: str | Path) -> list[str]:
    headers, _rows = _read_tabular(Path(file_path))
    return headers


def ingest_amazon_ads_spend(file_path: str | Path, dry_run: bool = False) -> dict:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    headers, rows = _read_tabular(path)
    kind = detect_ads_spend_report(headers)
    if kind == SOURCE_SKU_ECON:
        parsed = parse_sku_economics_monthly(headers, rows)
    elif kind == SOURCE_ADS_CONSOLE:
        parsed = parse_ads_console_daily(headers, rows)
    else:
        return {
            "filename": path.name,
            "report_type": "amazon_ads_spend",
            "kind": None,
            "rows_total": len(rows),
            "rows_parsed": 0,
            "rows_inserted": 0,
            "months": 0,
            "warnings": ["Not a SKU Economics or Ads Console campaign report."],
        }

    months = list(parsed.get("months") or [])
    daily = list(parsed.get("daily") or [])
    for m in months:
        m["filename"] = path.name
    warnings = list(parsed.get("warnings") or [])

    inserted = 0
    if not dry_run:
        if months:
            inserted += upsert_rows(
                "ads_monthly_spend", months, on_conflict="period_start",
            )
        if daily:
            seen: dict[tuple, dict] = {}
            for r in daily:
                seen[(r["date"], r["campaign_id"])] = r
            inserted += upsert_rows(
                "ads_campaigns_daily", list(seen.values()),
                on_conflict="date,campaign_id",
            )
        log_ingestion(
            filename=path.name,
            file_type="amazon_ads",
            rows_total=len(rows),
            rows_inserted=inserted,
            rows_skipped=int(parsed.get("rows_skipped") or 0),
            warnings=warnings or None,
        )
        log_audit(
            action="ingest_amazon_ads_spend",
            category="ingestion",
            details={
                "filename": path.name,
                "kind": kind,
                "months": [m["period_start"] for m in months],
                "spend": round(sum(m["spend"] for m in months), 2),
            },
            rows_affected=inserted,
        )

    return {
        "filename": path.name,
        "report_type": "amazon_ads_spend",
        "kind": kind,
        "rows_total": len(rows),
        "rows_parsed": int(parsed.get("rows_parsed") or 0),
        "rows_skipped": int(parsed.get("rows_skipped") or 0),
        "rows_inserted": inserted,
        "months": len(months),
        "month_starts": [m["period_start"] for m in months],
        "total_spend": round(sum(m["spend"] for m in months), 2),
        "warnings": warnings,
        "dry_run": dry_run,
    }
