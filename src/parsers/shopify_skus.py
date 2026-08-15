"""Shopify line-item ingest → sales_by_sku (monthly grain).

Pulls order line items from Shopify Admin API, aggregates by
(sku, state_code, month) and upserts to sales_by_sku.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta

import httpx

from src.config import settings
from src.db import delete_rows, upsert_rows, log_ingestion, log_audit
from src.sku_normalize import normalize_sku

US_STATE_CODES = {
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN",
    "IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV",
    "NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN",
    "TX","UT","VT","VA","WA","WV","WI","WY","DC",
}

SOURCE = "shopify_api"


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _month_end(d: date) -> date:
    if d.month == 12:
        return d.replace(month=12, day=31)
    return date(d.year, d.month + 1, 1) - timedelta(days=1)


def _parse_date(value: str) -> date | None:
    try:
        return datetime.fromisoformat(value).date()
    except (ValueError, TypeError):
        return None


def fetch_shopify_skus() -> dict:
    """Pull all Shopify orders with line items, aggregate to monthly SKU rows."""
    if not settings.shopify_enabled:
        return {"error": "Shopify not configured"}

    from src.shopify_auth import auth_headers
    base_url = f"https://{settings.shopify_shop_domain}/admin/api/2024-01/orders.json"
    headers = auth_headers()
    params = {
        "status": "any",
        "limit": 250,
        "fields": "id,name,created_at,financial_status,line_items,shipping_address,refunds",
    }

    all_orders = []
    url = base_url

    while url:
        resp = httpx.get(url, headers=headers, params=params if url == base_url else None, timeout=30)
        if resp.status_code != 200:
            return {"error": f"Shopify API {resp.status_code}: {resp.text[:300]}"}
        data = resp.json()
        all_orders.extend(data.get("orders", []))
        link_header = resp.headers.get("link", "")
        url = None
        if 'rel="next"' in link_header:
            for part in link_header.split(","):
                if 'rel="next"' in part:
                    url = part.split("<")[1].split(">")[0]
                    break

    # Key: (sku, state_code, month_start)
    agg: dict[tuple, dict] = defaultdict(lambda: {
        "units": 0, "gross_sales": 0.0, "refund_units": 0, "refund_sales": 0.0,
        "order_ids": set(), "title": None,
    })

    for order in all_orders:
        addr = order.get("shipping_address") or {}
        state = (addr.get("province_code") or "").upper()
        country = (addr.get("country_code") or "").upper()
        if country != "US":
            state = "XX"
        elif state not in US_STATE_CODES:
            state = "XX"

        order_date = _parse_date(order.get("created_at", ""))
        if not order_date:
            continue
        month = _month_start(order_date)
        order_id = order.get("id")

        for li in order.get("line_items", []):
            raw_sku = (li.get("sku") or "").strip()
            if not raw_sku:
                raw_sku = f"SHOPIFY-{li.get('product_id', 'unknown')}"
            sku = normalize_sku(raw_sku)

            key = (sku, state, month)
            b = agg[key]
            b["units"] += li.get("quantity", 0)
            b["gross_sales"] += float(li.get("price", 0)) * li.get("quantity", 1)
            b["order_ids"].add(order_id)
            title = li.get("title")
            if title and (not b["title"] or len(title) > len(b["title"])):
                b["title"] = title

        # Process refunds
        for refund in order.get("refunds", []):
            for rli in refund.get("refund_line_items", []):
                li = rli.get("line_item", {})
                raw_sku = (li.get("sku") or "").strip()
                if not raw_sku:
                    raw_sku = f"SHOPIFY-{li.get('product_id', 'unknown')}"
                sku = normalize_sku(raw_sku)
                key = (sku, state, month)
                b = agg[key]
                b["refund_units"] += rli.get("quantity", 0)
                b["refund_sales"] += float(rli.get("subtotal", 0))

    # Build rows
    rows = []
    all_states = set()
    for (sku, state, month_start), b in agg.items():
        all_states.add(state)
        rows.append({
            "channel": "shopify",
            "sku": sku,
            "asin": None,
            "product_title": b["title"],
            "state_code": state,
            "period_start": month_start.isoformat(),
            "period_end": _month_end(month_start).isoformat(),
            "units": b["units"],
            "gross_sales": round(b["gross_sales"], 2),
            "net_sales": round(b["gross_sales"] - b["refund_sales"], 2),
            "refund_units": b["refund_units"],
            "refund_sales": round(b["refund_sales"], 2),
            "order_count": len(b["order_ids"]),
            "source": SOURCE,
        })

    # Delete old shopify SKU rows then upsert
    delete_rows("sales_by_sku", {"channel": "shopify", "source": SOURCE})

    inserted = upsert_rows(
        "sales_by_sku", rows,
        on_conflict="channel,sku,state_code,period_start,source",
    )

    log_ingestion(
        filename="shopify_skus_api",
        file_type="shopify_api",
        rows_total=len(all_orders),
        rows_inserted=inserted,
    )
    log_audit(
        action="fetch_shopify_skus",
        category="ingestion",
        details={
            "orders": len(all_orders),
            "sku_rows": len(rows),
            "states": len(all_states),
        },
        rows_affected=inserted,
    )

    unique_skus = len(set(r["sku"] for r in rows))
    return {
        "orders_fetched": len(all_orders),
        "sku_rows": len(rows),
        "unique_skus": unique_skus,
        "rows_inserted": inserted,
    }
