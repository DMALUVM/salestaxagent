"""Per-order Shopify backfill — full store history, idempotent.

The existing Shopify poll aggregates orders into (state, channel, month) buckets
and discards them, so nothing in the database can answer "how many customers
bought twice". This walks the Admin API order by order and stores each one.

Three properties the caller depends on:

  **Idempotent.** Every page is upserted on `order_id` as it arrives, so a run
  that dies at page 40 of 56 has already committed 39 pages and the next run
  re-writes them harmlessly. There is no staging state to reconcile.

  **Resumable and chatty.** Progress prints per page rather than at the end.
  13,923 orders is ~56 pages; a silent five-minute run is indistinguishable
  from a hung one.

  **Rate-limit aware.** Shopify's REST bucket is 40 with a 2/s leak. On a 429
  it honours Retry-After and retries rather than failing the run.

Scope note: this account has `read_all_orders` (required for anything older than
60 days) but NOT `read_customers`. That is fine — the customer object is embedded
in the order payload under `read_orders`, so no second endpoint is needed. It
does mean Shopify's own `orders_count` / `total_spent` counters arrive null, so
every metric is computed from our own rows. That is the better arrangement
anyway: the arithmetic is auditable and does not drift with Shopify's.
"""
from __future__ import annotations

import hashlib
import logging
import time
from datetime import date, datetime
from typing import Callable

import httpx

log = logging.getLogger(__name__)

API_VERSION = "2024-01"
PAGE_SIZE = 250

# Everything needed for AOV/LTV/repeat/cohort plus the fields the existing
# aggregates key on, so this table can be reconciled against sales_by_state.
ORDER_FIELDS = (
    "id,name,created_at,processed_at,customer,email,currency,"
    "subtotal_price,total_price,total_discounts,total_tax,"
    "financial_status,cancelled_at,test,source_name,shipping_address,refunds"
)


def email_hash(email: str | None) -> str | None:
    """sha256 of the normalised address. Stitches guests; is not an address book."""
    if not email:
        return None
    norm = email.strip().lower()
    if not norm:
        return None
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def customer_key(customer_id, e_hash: str | None, order_id) -> str:
    """Stable identity, degrading most-reliable-first.

    The final fallback is per-ORDER, not a shared "unknown" bucket. Bucketing
    unidentifiable orders together would invent one customer with thousands of
    purchases and make the repeat rate meaningless.
    """
    if customer_id:
        return f"c:{customer_id}"
    if e_hash:
        return f"h:{e_hash}"
    return f"o:{order_id}"


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _refunded(order: dict) -> float:
    """Total refunded across an order's refund transactions."""
    total = 0.0
    for r in order.get("refunds") or []:
        for t in r.get("transactions") or []:
            if str(t.get("kind")) == "refund" and str(t.get("status")) == "success":
                total += _num(t.get("amount"))
    return round(total, 2)


def _local_date(iso: str | None) -> date | None:
    """Calendar day in the Shopify store timezone.

    created_at arrives with an offset already applied by Shopify, but converting
    explicitly means a store timezone change does not silently re-bucket history.
    """
    if not iso:
        return None
    try:
        from src.rules import SHOPIFY_TZ
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).astimezone(
            SHOPIFY_TZ).date()
    except Exception:
        return None


def to_row(order: dict, with_email: bool = False) -> dict | None:
    """One API order → one table row. Pure, so it is testable without a store."""
    oid = order.get("id")
    if not oid:
        return None
    cust = order.get("customer") or {}
    cid = cust.get("id")
    e = order.get("email") or cust.get("email")
    eh = email_hash(e)
    d = _local_date(order.get("created_at"))
    if d is None:
        return None

    addr = order.get("shipping_address") or {}
    source = order.get("source_name") or ""
    try:
        from src.channels import classify_shopify_order
        channel = classify_shopify_order(source, d)
    except Exception:
        channel = "shopify"

    row = {
        "order_id": int(oid),
        "order_name": order.get("name"),
        "created_at": order.get("created_at"),
        "processed_at": order.get("processed_at"),
        "order_date": d.isoformat(),
        "customer_id": int(cid) if cid else None,
        "email_hash": eh,
        "customer_key": customer_key(cid, eh, oid),
        "currency": order.get("currency"),
        "subtotal_price": _num(order.get("subtotal_price")),
        "total_price": _num(order.get("total_price")),
        "total_discounts": _num(order.get("total_discounts")),
        "total_tax": _num(order.get("total_tax")),
        "refunded_amount": _refunded(order),
        "financial_status": order.get("financial_status"),
        "cancelled_at": order.get("cancelled_at"),
        "is_test": bool(order.get("test")),
        "source_name": source,
        "channel": channel,
        "state_code": (addr.get("province_code") or "").upper() or None,
        "country_code": (addr.get("country_code") or "").upper() or None,
        "updated_at": datetime.now().astimezone().isoformat(),
    }
    if with_email:
        row["email"] = e
    return row


def _get(url: str, headers: dict, params: dict | None) -> httpx.Response:
    """GET with Shopify rate-limit courtesy. 429 is expected, not exceptional."""
    for attempt in range(6):
        resp = httpx.get(url, headers=headers, params=params, timeout=60)
        if resp.status_code != 429:
            return resp
        wait = float(resp.headers.get("Retry-After", 2)) or 2.0
        log.info("Shopify 429 — sleeping %.1fs (attempt %d)", wait, attempt + 1)
        time.sleep(wait)
    return resp


def backfill(since: date | None = None, with_email: bool = False,
             max_pages: int | None = None,
             progress: Callable[[str], None] = log.info) -> dict:
    """Walk every order and upsert it. Returns a summary dict.

    `since` limits to created_at >= that date; omit it for full store history.
    """
    from src.config import settings
    from src.db import upsert_rows
    from src.shopify_auth import auth_headers

    if not settings.shopify_enabled:
        return {"error": "Shopify not configured (SHOPIFY_SHOP_DOMAIN / ACCESS_TOKEN)."}

    base = f"https://{settings.shopify_shop_domain}/admin/api/{API_VERSION}/orders.json"
    headers = auth_headers()
    params: dict | None = {
        "status": "any", "limit": PAGE_SIZE, "fields": ORDER_FIELDS,
    }
    if since:
        params["created_at_min"] = f"{since.isoformat()}T00:00:00Z"

    url: str | None = base
    pages = written = skipped = 0
    first_date: str | None = None
    last_date: str | None = None

    while url:
        resp = _get(url, headers, params if url == base else None)
        if resp.status_code != 200:
            return {"error": f"Shopify API {resp.status_code}: {resp.text[:300]}",
                    "pages": pages, "written": written}

        orders = resp.json().get("orders", [])
        rows = []
        for o in orders:
            r = to_row(o, with_email=with_email)
            if r is None:
                skipped += 1
                continue
            rows.append(r)
            d = r["order_date"]
            first_date = d if first_date is None or d < first_date else first_date
            last_date = d if last_date is None or d > last_date else last_date

        if rows:
            # Upsert per page, not at the end: a run that dies mid-way has
            # already committed everything it fetched, and re-running is a
            # no-op over that range rather than a rollback problem.
            try:
                upsert_rows("shopify_orders", rows, on_conflict="order_id")
            except Exception as e:
                msg = str(e)
                if "shopify_orders" in msg:
                    return {"error": "Table shopify_orders is missing — run "
                                     "supabase/migration_shopify_orders.sql.",
                            "pages": pages, "written": written}
                return {"error": msg[:300], "pages": pages, "written": written}
            written += len(rows)

        pages += 1
        progress(f"  page {pages}: {len(rows)} orders  (total {written:,}"
                 + (f", {first_date} → {last_date}" if first_date else "") + ")")

        if max_pages and pages >= max_pages:
            progress(f"  stopping at --max-pages {max_pages}")
            break

        link = resp.headers.get("link", "")
        url = None
        if 'rel="next"' in link:
            for part in link.split(","):
                if 'rel="next"' in part:
                    url = part.split("<")[1].split(">")[0]
                    break

    return {"pages": pages, "written": written, "skipped": skipped,
            "first_date": first_date, "last_date": last_date,
            "with_email": with_email}


def load_orders(include_test: bool = False) -> list[dict]:
    """Every stored order, paginated. Metrics run over this."""
    from src.db import get_client

    client = get_client()
    rows: list[dict] = []
    off = 0
    while True:
        # ORDER BY reaches order_id: thousands of rows share a date, and an
        # ambiguous boundary silently drops and duplicates across pages.
        p = (client.table("shopify_orders")
             .select("order_id,order_date,customer_key,customer_id,subtotal_price,"
                     "total_price,refunded_amount,cancelled_at,is_test,channel,"
                     "financial_status")
             .order("order_date").order("order_id")
             .range(off, off + 999).execute().data) or []
        rows.extend(p)
        if len(p) < 1000:
            break
        off += 1000
    if not include_test:
        rows = [r for r in rows if not r.get("is_test")]
    return rows
