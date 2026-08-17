from __future__ import annotations

import csv
import hashlib
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import httpx

from src.config import settings
from src.db import delete_rows, upsert_rows, log_ingestion, log_audit
from src.models.schema import SalesByState

US_STATE_CODES = {
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
}

STATE_NAME_TO_CODE = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR",
    "california": "CA", "colorado": "CO", "connecticut": "CT", "delaware": "DE",
    "florida": "FL", "georgia": "GA", "hawaii": "HI", "idaho": "ID",
    "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
    "massachusetts": "MA", "michigan": "MI", "minnesota": "MN",
    "mississippi": "MS", "missouri": "MO", "montana": "MT", "nebraska": "NE",
    "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
    "new mexico": "NM", "new york": "NY", "north carolina": "NC",
    "north dakota": "ND", "ohio": "OH", "oklahoma": "OK", "oregon": "OR",
    "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT",
    "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
    "district of columbia": "DC",
}


def _normalize_state(value: str) -> str | None:
    v = value.strip().upper()
    if v in US_STATE_CODES:
        return v
    lower = value.strip().lower()
    return STATE_NAME_TO_CODE.get(lower)


def _parse_date(value: str) -> date | None:
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(value.strip().split("+")[0].split("-0")[0][:19],
                                     fmt[:min(len(fmt), 19)]).date()
        except (ValueError, IndexError):
            continue
    try:
        return datetime.fromisoformat(value.strip()).date()
    except (ValueError, TypeError):
        return None


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _month_end(d: date) -> date:
    if d.month == 12:
        return d.replace(month=12, day=31)
    return date(d.year, d.month + 1, 1) - timedelta(days=1)


# ---------------------------------------------------------------------------
# CSV parser
# ---------------------------------------------------------------------------


def parse_shopify_csv(file_path: str | Path) -> dict:
    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {path}")

    # Key: (state_code, month_start_date)
    monthly_agg: dict[tuple[str, date], dict] = defaultdict(lambda: {
        "order_count": 0, "gross_sales": 0.0, "tax_collected": 0.0,
        "orders_seen": set(),
    })

    warnings = []
    rows_total = 0
    rows_skipped = 0

    with open(path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        headers = [h.strip() for h in (reader.fieldnames or [])]

        province_col = None
        for candidate in ("Shipping Province Code", "Shipping Province",
                          "Province Code", "Province", "State"):
            for h in headers:
                if h.strip().lower() == candidate.lower():
                    province_col = h
                    break
            if province_col:
                break

        if not province_col:
            warnings.append(f"No state/province column found. Headers: {headers}")
            return {"rows_total": 0, "warnings": warnings, "sales": []}

        for row_num, row in enumerate(reader, start=2):
            rows_total += 1

            state_raw = row.get(province_col, "").strip()
            state_code = _normalize_state(state_raw) if state_raw else None
            if not state_code:
                rows_skipped += 1
                continue

            country = row.get("Shipping Country", "").strip().upper()
            if country and country != "US":
                rows_skipped += 1
                continue

            order_name = row.get("Name", f"row-{row_num}").strip()
            order_date = None
            for date_col in ("Created at", "Created At", "Date"):
                if date_col in row and row[date_col]:
                    order_date = _parse_date(row[date_col])
                    if order_date:
                        break
            if not order_date:
                order_date = date.today()

            month_key = _month_start(order_date)
            agg = monthly_agg[(state_code, month_key)]

            if order_name not in agg["orders_seen"]:
                agg["orders_seen"].add(order_name)
                agg["order_count"] += 1

                subtotal = 0.0
                for col in ("Subtotal", "Total", "Lineitem price"):
                    try:
                        subtotal = float(row.get(col, "0").replace(",", "").strip() or "0")
                        if subtotal > 0:
                            break
                    except ValueError:
                        continue
                agg["gross_sales"] += subtotal

                try:
                    tax = float(row.get("Taxes", "0").replace(",", "").strip() or "0")
                except ValueError:
                    tax = 0.0
                agg["tax_collected"] += tax

    sales = []
    for (state_code, month_start_date), agg in monthly_agg.items():
        period_end = _month_end(month_start_date)
        sales.append(SalesByState(
            state_code=state_code,
            channel="shopify",
            period_start=month_start_date,
            period_end=period_end,
            order_count=agg["order_count"],
            gross_sales=round(agg["gross_sales"], 2),
            net_sales=round(agg["gross_sales"], 2),
            tax_collected=round(agg["tax_collected"], 2),
            source=path.name,
        ))

    return {
        "filename": path.name,
        "rows_total": rows_total,
        "rows_skipped": rows_skipped,
        "warnings": warnings,
        "sales": sales,
    }


def ingest_shopify_csv(file_path: str | Path, dry_run: bool = False) -> dict:
    parsed = parse_shopify_csv(file_path)

    if dry_run or not parsed["sales"]:
        return {
            "filename": parsed.get("filename", ""),
            "rows_total": parsed["rows_total"],
            "states_found": sorted(set(s.state_code for s in parsed["sales"])),
            "total_orders": sum(s.order_count for s in parsed["sales"]),
            "total_sales": round(sum(s.gross_sales for s in parsed["sales"]), 2),
            "warnings": parsed["warnings"],
            "dry_run": dry_run,
            "rows_inserted": 0,
        }

    rows = [s.model_dump() for s in parsed["sales"]]
    inserted = upsert_rows(
        "sales_by_state", rows,
        on_conflict="state_code,channel,period_start,period_end",
    )

    log_ingestion(
        filename=parsed.get("filename", "shopify_csv"),
        file_type="shopify_orders",
        rows_total=parsed["rows_total"],
        rows_inserted=inserted,
        rows_skipped=parsed["rows_skipped"],
        warnings=parsed["warnings"] or None,
    )

    return {
        "filename": parsed.get("filename", ""),
        "rows_total": parsed["rows_total"],
        "states_found": sorted(set(s.state_code for s in parsed["sales"])),
        "total_orders": sum(s.order_count for s in parsed["sales"]),
        "total_sales": round(sum(s.gross_sales for s in parsed["sales"]), 2),
        "warnings": parsed["warnings"],
        "rows_inserted": inserted,
        "dry_run": False,
    }


# ---------------------------------------------------------------------------
# API fetcher
# ---------------------------------------------------------------------------


def fetch_shopify_orders_api(since_date: date | None = None) -> dict:
    if not settings.shopify_enabled:
        return {"error": "Shopify API not configured. Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET in .env"}

    from src.shopify_auth import auth_headers, auth_headers_with_retry
    base_url = f"https://{settings.shopify_shop_domain}/admin/api/2024-01/orders.json"
    headers = auth_headers()

    params = {
        "status": "any",
        "limit": 250,
        "fields": "id,name,created_at,financial_status,total_price,subtotal_price,"
                   "total_tax,shipping_address",
    }
    if since_date:
        params["created_at_min"] = since_date.isoformat() + "T00:00:00Z"

    all_orders = []
    url = base_url
    retried = False

    while url:
        resp = httpx.get(url, headers=headers, params=params if url == base_url else None, timeout=30)
        if resp.status_code == 401 and not retried:
            new_headers = auth_headers_with_retry(401)
            if new_headers:
                headers = new_headers
                retried = True
                continue  # retry same URL with fresh token
        if resp.status_code != 200:
            return {"error": f"Shopify API error {resp.status_code}: {resp.text[:500]}"}

        data = resp.json()
        orders = data.get("orders", [])
        all_orders.extend(orders)

        link_header = resp.headers.get("link", "")
        url = None
        if 'rel="next"' in link_header:
            for part in link_header.split(","):
                if 'rel="next"' in part:
                    url = part.split("<")[1].split(">")[0]
                    break

    # Aggregate by (state, month) — same granularity as amazon_spapi
    monthly_agg: dict[tuple[str, date], dict] = defaultdict(lambda: {
        "order_count": 0, "gross_sales": 0.0, "tax_collected": 0.0,
    })

    for order in all_orders:
        addr = order.get("shipping_address") or {}
        province_code = addr.get("province_code", "")
        country_code = addr.get("country_code", "")

        if country_code != "US" or not province_code:
            continue

        state_code = province_code.upper()
        if state_code not in US_STATE_CODES:
            continue

        order_date = _parse_date(order.get("created_at", ""))
        if not order_date:
            continue

        month_key = _month_start(order_date)
        agg = monthly_agg[(state_code, month_key)]
        agg["order_count"] += 1
        agg["gross_sales"] += float(order.get("subtotal_price", 0) or 0)
        agg["tax_collected"] += float(order.get("total_tax", 0) or 0)

    sales = []
    all_states: set[str] = set()
    for (state_code, month_start_date), agg in monthly_agg.items():
        period_end = _month_end(month_start_date)
        all_states.add(state_code)
        sales.append(SalesByState(
            state_code=state_code,
            channel="shopify",
            period_start=month_start_date,
            period_end=period_end,
            order_count=agg["order_count"],
            gross_sales=round(agg["gross_sales"], 2),
            net_sales=round(agg["gross_sales"], 2),
            tax_collected=round(agg["tax_collected"], 2),
            source="shopify_api",
        ))

    # Delete old shopify rows for states we're about to replace.
    # This cleans up legacy all-time aggregate rows that predate
    # the monthly-granularity change.
    for sc in all_states:
        delete_rows("sales_by_state", {"state_code": sc, "channel": "shopify"})

    rows = [s.model_dump() for s in sales]
    inserted = upsert_rows(
        "sales_by_state", rows,
        on_conflict="state_code,channel,period_start,period_end",
    )

    log_ingestion(
        filename="shopify_api",
        file_type="shopify_api",
        rows_total=len(all_orders),
        rows_inserted=inserted,
    )

    log_audit(
        action="fetch_shopify_orders",
        category="ingestion",
        details={
            "orders_fetched": len(all_orders),
            "states": sorted(all_states),
            "monthly_periods": len(sales),
            "since_date": since_date.isoformat() if since_date else None,
        },
        rows_affected=inserted,
    )

    return {
        "orders_fetched": len(all_orders),
        "states_found": sorted(all_states),
        "total_orders": sum(a["order_count"] for a in monthly_agg.values()),
        "total_sales": round(sum(a["gross_sales"] for a in monthly_agg.values()), 2),
        "monthly_periods": len(sales),
        "rows_inserted": inserted,
    }
