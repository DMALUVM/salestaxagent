"""One Shopify shopper-funnel sync — ShopifyQL + abandoned checkouts.

ONE job. No polling loop, no Ads wait-loop, no Admin UI scrape, no GA4.
A 429 honours Retry-After the same way `shopify_backfill._get` does; that is
rate-limit courtesy, not a wait-for-report poll.

Queries (Admin GraphQL, 2025-10):

  1. Closed funnel by day (28d) — FROM sessions SHOW sessions,
     sessions_with_cart_additions, sessions_that_reached_checkout,
     sessions_that_completed_checkout WHERE human_or_bot_session = 'human'
  2. PDP landings by day — same, WHERE landing_page_type = 'product'
  3. Device × day — GROUP BY session_device_type
  4. Landing-page windows (7d and 28d) — GROUP BY landing_page_path LIMIT 25
  5. abandonedCheckouts created in the last 28d (paginated, capped)

Never Place Order. This module issues queries only — no mutations, no
draftOrderComplete, no orderCreate.

If a query comes back ACCESS_DENIED the counts for that source stay empty
and `shopify_funnel_status.missing_scopes` records exactly what Dave must
grant. We do not invent a number from orders or GA4 to fill the hole.

Jev triage runs on Vercel, not Mini. Mini writes funnel + abandon rows
and stamps `last_stats.silent` / `last_stats.jev` (`vercel_runtime` →
hold_for_review). Iris reads `GET /api/conversion-digest`, which runs
or reuses Jev (`ensureFunnelJevTriage`) against those stats. Cron
`/api/shopify-funnel/jev-triage` is warmup only. Vercel uses
`AI_GATEWAY_API_KEY` and fail-closes to hold_for_review when the key
is absent. Silent → no LLM. Never raises. No Shopify / theme writes.
`AI_GATEWAY_API_KEY` must not live in Mini `.env`.
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta
from typing import Callable

import httpx

from src.shopify_funnel import (
    REQUIRED_PCD,
    REQUIRED_SCOPES,
    REQUIRED_STAFF,
    abandoned_row_from_gql,
    biggest_leak,
    classify_gql_errors,
    funnel_row_from_shopifyql,
    is_material_change,
    merge_pdp_into_daily,
    parse_shopifyql_table,
    recovery_rate,
    snapshot_from_stats,
    sum_daily,
    window_bounds,
)

log = logging.getLogger(__name__)

# ShopifyQL + abandonedCheckouts live on a newer Admin API than the REST
# orders client (2024-01). Keep them separate — do not bump the order
# backfill just to get analytics fields.
GQL_VERSION = "2025-10"
LOOKBACK_DAYS = 28
LANDING_LIMIT = 25
ABANDON_PAGE = 50
ABANDON_MAX_PAGES = 40

SHOPIFYQL_GQL = """
query ShopperFunnelShopifyql($q: String!) {
  shopifyqlQuery(query: $q) {
    tableData {
      columns { name dataType displayName }
      rows
    }
    parseErrors
  }
}
"""

# No abandonedCheckoutUrl (secret recovery token). No customer PII.
ABANDON_GQL = """
query ShopperFunnelAbandoned($first: Int!, $after: String, $q: String!) {
  abandonedCheckouts(
    first: $first
    after: $after
    query: $q
    sortKey: CREATED_AT
    reverse: true
  ) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      name
      createdAt
      updatedAt
      completedAt
      totalPriceSet { shopMoney { amount currencyCode } }
      subtotalPriceSet { shopMoney { amount } }
      lineItems(first: 25) {
        nodes {
          title
          quantity
          sku
          variantTitle
          originalTotalPriceSet { shopMoney { amount } }
          product { id title handle }
        }
      }
    }
  }
}
"""


def _shopifyql(kind: str, since_days: int, extra_where: str = "",
               group: str = "", limit: int | None = None) -> str:
    where = "human_or_bot_session = 'human'"
    if extra_where:
        where = f"{where} AND {extra_where}"
    show = (
        "sessions, sessions_with_cart_additions, "
        "sessions_that_reached_checkout, sessions_that_completed_checkout"
    )
    if kind == "pdp":
        show = "sessions"
    q = (
        f"FROM sessions SHOW {show} "
        f"WHERE {where} "
    )
    if group:
        q += f"GROUP BY {group} "
    if kind != "landing":
        q += "TIMESERIES day "
    q += f"SINCE startOfDay(-{since_days}d) UNTIL today "
    if kind == "landing":
        q += "ORDER BY sessions DESC "
    else:
        q += "ORDER BY day ASC "
    if limit:
        q += f"LIMIT {limit} "
    return " ".join(q.split())


def graphql(query: str, variables: dict | None = None,
            timeout: float = 60) -> dict:
    """POST Admin GraphQL. 429 retries; 401 refreshes once if possible."""
    from src.config import settings
    from src.shopify_auth import auth_headers, auth_headers_with_retry

    shop = settings.shopify_shop_domain
    url = f"https://{shop}/admin/api/{GQL_VERSION}/graphql.json"
    headers = auth_headers()
    payload = {"query": query, "variables": variables or {}}
    resp = None
    for attempt in range(6):
        resp = httpx.post(url, headers=headers, json=payload, timeout=timeout)
        if resp.status_code == 429:
            wait = float(resp.headers.get("Retry-After", 2)) or 2.0
            log.info("Shopify GraphQL 429 — sleeping %.1fs (attempt %d)",
                     wait, attempt + 1)
            time.sleep(wait)
            continue
        if resp.status_code == 401:
            nxt = auth_headers_with_retry(401)
            if nxt is None:
                break
            headers = nxt
            continue
        break
    if resp is None:
        return {"http_status": 0, "error": "no response"}
    body: dict = {}
    try:
        body = resp.json()
    except Exception:
        body = {"error": resp.text[:300]}
    body["http_status"] = resp.status_code
    return body


def _scope_error(body: dict, hint: str) -> dict | None:
    if body.get("http_status") in (401, 403):
        return {
            "error": (
                f"Shopify HTTP {body['http_status']} on {hint}. "
                f"{(body.get('error') or body.get('errors') or '')!s}"[:400]
            ),
            "missing_scopes": classify_gql_errors(body.get("errors") or []),
        }
    errors = body.get("errors") or []
    if errors:
        scopes = classify_gql_errors(errors)
        return {
            "error": "; ".join(str(e.get("message") or e) for e in errors)[:400],
            "missing_scopes": scopes,
        }
    return None


def fetch_shopifyql(ql: str) -> dict:
    body = graphql(SHOPIFYQL_GQL, {"q": ql})
    denied = _scope_error(body, "shopifyqlQuery")
    if denied:
        denied["source"] = "shopifyql"
        return denied
    data = (body.get("data") or {}).get("shopifyqlQuery") or {}
    parse_errors = data.get("parseErrors") or []
    if parse_errors:
        return {"error": "; ".join(str(p) for p in parse_errors)[:400],
                "source": "shopifyql", "parse_errors": parse_errors}
    rows = parse_shopifyql_table(data.get("tableData"))
    return {"rows": rows, "source": "shopifyql"}


def fetch_abandoned(since: date, progress: Callable[[str], None] = log.info) -> dict:
    q = f"created_at:>='{since.isoformat()}'"
    nodes: list[dict] = []
    cursor = None
    pages = 0
    truncated = False
    while pages < ABANDON_MAX_PAGES:
        body = graphql(ABANDON_GQL, {
            "first": ABANDON_PAGE, "after": cursor, "q": q,
        })
        denied = _scope_error(body, "abandonedCheckouts")
        if denied:
            denied["source"] = "abandonedCheckouts"
            return denied
        conn = (body.get("data") or {}).get("abandonedCheckouts")
        if conn is None:
            return {"error": "abandonedCheckouts returned null",
                    "source": "abandonedCheckouts"}
        batch = conn.get("nodes") or []
        nodes.extend(batch)
        pages += 1
        info = conn.get("pageInfo") or {}
        progress(f"  abandoned page {pages}: {len(batch)} (total {len(nodes)})")
        if not info.get("hasNextPage"):
            break
        cursor = info.get("endCursor")
        if not cursor:
            break
    else:
        truncated = True
    return {"nodes": nodes, "pages": pages, "truncated": truncated,
            "source": "abandonedCheckouts"}


def _local_date(iso: str | None) -> str | None:
    if not iso:
        return None
    try:
        from src.rules import SHOPIFY_TZ
        return (datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
                .astimezone(SHOPIFY_TZ).date().isoformat())
    except Exception:
        s = str(iso)
        return s[:10] if len(s) >= 10 else None


def sync(days: int = LOOKBACK_DAYS, dry_run: bool = False,
         progress: Callable[[str], None] = log.info) -> dict:
    """Fetch → transform → upsert. Returns a summary the CLI / scheduler print."""
    from src.config import settings
    from src.db import upsert_rows, get_client
    from src.rules import SHOPIFY_TZ

    if days < 1 or days > 90:
        return {"error": "days must be 1–90"}
    if not settings.shopify_enabled:
        return {"error": "Shopify not configured (SHOPIFY_SHOP_DOMAIN / ACCESS_TOKEN)."}

    missing: list[str] = []
    errors: list[str] = []
    funnel_ok = False
    abandon_ok = False
    daily_rows: list[dict] = []
    split_rows: list[dict] = []
    abandon_rows: list[dict] = []

    progress("ShopifyQL closed funnel (28d, human sessions)")
    closed = fetch_shopifyql(_shopifyql("closed", days))
    if closed.get("error"):
        errors.append(f"funnel: {closed['error']}")
        missing.extend(closed.get("missing_scopes") or [])
        progress(f"  skipped: {closed['error'][:160]}")
    else:
        for raw in closed.get("rows") or []:
            row = funnel_row_from_shopifyql(raw, "all", "")
            if row:
                daily_rows.append(row)
        funnel_ok = True
        progress(f"  {len(daily_rows)} day row(s)")

    progress("ShopifyQL PDP landings (landing_page_type = product)")
    pdp = fetch_shopifyql(_shopifyql("pdp", days, extra_where="landing_page_type = 'product'"))
    if pdp.get("error"):
        errors.append(f"pdp: {pdp['error']}")
        missing.extend(pdp.get("missing_scopes") or [])
        progress(f"  skipped: {pdp['error'][:160]}")
    else:
        pdp_rows = []
        for raw in pdp.get("rows") or []:
            row = funnel_row_from_shopifyql(raw, "all", "")
            if row:
                pdp_rows.append(row)
        daily_rows = merge_pdp_into_daily(daily_rows, pdp_rows)
        progress(f"  {len(pdp_rows)} PDP day row(s)")

    progress("ShopifyQL device split")
    device = fetch_shopifyql(_shopifyql("device", days, group="session_device_type"))
    if device.get("error"):
        errors.append(f"device: {device['error']}")
        missing.extend(device.get("missing_scopes") or [])
        progress(f"  skipped: {device['error'][:160]}")
    else:
        n = 0
        for raw in device.get("rows") or []:
            val = str(raw.get("session_device_type") or raw.get("device") or "").strip()
            if not val:
                continue
            row = funnel_row_from_shopifyql(raw, "device", val)
            if row:
                daily_rows.append(row)
                n += 1
        progress(f"  {n} device-day row(s)")

    today = datetime.now(SHOPIFY_TZ).date()
    for win in (7, 28):
        if win > days:
            continue
        progress(f"ShopifyQL landing pages ({win}d)")
        land = fetch_shopifyql(_shopifyql("landing", win, group="landing_page_path",
                                          limit=LANDING_LIMIT))
        if land.get("error"):
            errors.append(f"landing_{win}: {land['error']}")
            missing.extend(land.get("missing_scopes") or [])
            progress(f"  skipped: {land['error'][:160]}")
            continue
        n = 0
        for raw in land.get("rows") or []:
            path = str(raw.get("landing_page_path") or "").strip()
            if not path:
                continue
            parsed = funnel_row_from_shopifyql({**raw, "day": today.isoformat()})
            if not parsed:
                continue
            split_rows.append({
                "window_days": win,
                "window_end": today.isoformat(),
                "split_kind": "landing_page",
                "split_value": path,
                "sessions": parsed.get("sessions"),
                "pdp_sessions": None,
                "add_to_cart": parsed.get("add_to_cart"),
                "checkout_started": parsed.get("checkout_started"),
                "purchases": parsed.get("purchases"),
                "source": "shopifyql",
            })
            n += 1
        progress(f"  {n} landing row(s)")

    progress("Abandoned checkouts")
    since = today - timedelta(days=days)
    aband = fetch_abandoned(since, progress=progress)
    if aband.get("error"):
        errors.append(f"abandon: {aband['error']}")
        missing.extend(aband.get("missing_scopes") or [])
        progress(f"  skipped: {aband['error'][:160]}")
    else:
        for node in aband.get("nodes") or []:
            d = _local_date(node.get("createdAt"))
            if not d:
                continue
            row = abandoned_row_from_gql(node, d)
            if row:
                abandon_rows.append(row)
        abandon_ok = True
        extra = " (truncated)" if aband.get("truncated") else ""
        progress(f"  {len(abandon_rows)} checkout(s){extra}")

    # Deduplicate missing scopes, keep order.
    seen, missing_u = set(), []
    for s in missing:
        if s not in seen:
            seen.add(s)
            missing_u.append(s)

    # Window used for "did anything change" + status stats: last 7 closed-enough
    # days ending today (today is partial; still the number the card shows).
    start7, end7 = window_bounds(today.isoformat(), 7)
    funnel7 = sum_daily(daily_rows, start7, end7)
    leak = biggest_leak(funnel7)
    abandon7 = recovery_rate(
        [r for r in abandon_rows if start7 <= r["checkout_date"] <= end7])

    prev_stats = None
    try:
        prev = (get_client().table("shopify_funnel_status")
                .select("last_stats")
                .eq("id", 1).limit(1).execute().data or [{}])[0]
        prev_stats = prev.get("last_stats")
    except Exception:
        prev_stats = None
    silent = not is_material_change(snapshot_from_stats(prev_stats), leak, abandon7)

    stats = {
        "funnel_ok": funnel_ok,
        "abandon_ok": abandon_ok,
        "daily_rows": len(daily_rows),
        "split_rows": len(split_rows),
        "abandon_rows": len(abandon_rows),
        "missing_scopes": missing_u,
        "leak": leak,
        "abandon": abandon7,
        "window": {"start": start7, "end": end7, "days": 7},
        "gql_version": GQL_VERSION,
    }

    stats["silent"] = silent
    if dry_run:
        stats["jev"] = maybe_jev_triage(stats, silent)
        return {
            "dry_run": True,
            "funnel_ok": funnel_ok,
            "abandon_ok": abandon_ok,
            "missing_scopes": missing_u,
            "errors": errors,
            "stats": stats,
            "silent": silent,
            "message": _message(funnel_ok, abandon_ok, missing_u, errors, silent, stats),
        }

    write_errors = []
    if daily_rows:
        try:
            upsert_rows("shopify_funnel_daily", daily_rows,
                        on_conflict="metric_date,split_kind,split_value")
        except Exception as e:
            write_errors.append(_table_hint(str(e), "shopify_funnel_daily"))
    if split_rows:
        try:
            upsert_rows("shopify_funnel_splits", split_rows,
                        on_conflict="window_days,window_end,split_kind,split_value")
        except Exception as e:
            write_errors.append(_table_hint(str(e), "shopify_funnel_splits"))
    if abandon_rows:
        try:
            upsert_rows("shopify_abandoned_checkouts", abandon_rows,
                        on_conflict="checkout_id")
        except Exception as e:
            write_errors.append(_table_hint(str(e), "shopify_abandoned_checkouts"))

    stats["jev"] = maybe_jev_triage(stats, silent)

    status_row = {
        "id": 1,
        "last_synced_at": datetime.now(SHOPIFY_TZ).isoformat(),
        "funnel_ok": funnel_ok,
        "abandon_ok": abandon_ok,
        "missing_scopes": missing_u,
        "last_error": "; ".join(errors + write_errors)[:800] or None,
        "last_stats": stats,
        "updated_at": datetime.now(SHOPIFY_TZ).isoformat(),
    }
    try:
        upsert_rows("shopify_funnel_status", [status_row], on_conflict="id")
    except Exception as e:
        write_errors.append(_table_hint(str(e), "shopify_funnel_status"))

    errors.extend(write_errors)
    partial = bool(errors) and (funnel_ok or abandon_ok)
    failed = bool(errors) and not (funnel_ok or abandon_ok)
    msg = _message(funnel_ok, abandon_ok, missing_u, errors, silent, stats)
    out = {
        "funnel_ok": funnel_ok,
        "abandon_ok": abandon_ok,
        "missing_scopes": missing_u,
        "errors": errors,
        "partial": partial,
        "silent": silent,
        "stats": stats,
        "message": msg,
        "required": {
            "scopes": list(REQUIRED_SCOPES),
            "staff": list(REQUIRED_STAFF),
            "protectedCustomerData": list(REQUIRED_PCD),
        },
    }
    if failed:
        out["error"] = errors[0] if errors else "funnel sync failed"
    return out


def jev_items_from_stats(stats: dict) -> list[dict]:
    """Wrap leak + abandon window stats as one pilot item.

    Protocol twin of dashboard/src/lib/funnel-jev-triage.ts. Mini does not
    invoke Jev; Vercel reads these fields from shopify_funnel_status.
    """
    leak = stats.get("leak") or {}
    abandon = stats.get("abandon") or {}
    window = stats.get("window") or {}
    step_from = leak.get("from")
    step_to = leak.get("to")
    metric = None
    if step_from and step_to:
        metric = f"{step_from}->{step_to}"
    elif step_from:
        metric = step_from
    return [{
        "mode": "leak",
        "period": window.get("end"),
        "step": step_from,
        "metric": metric,
        "baseline": None,
        "current": leak.get("lost"),
        "delta_pct": leak.get("rate"),
        "abandon_count": abandon.get("open"),
        "abandon_value": abandon.get("openValue"),
        "evidence": {"leak": leak, "abandon": abandon},
    }]


def jev_decision_from_result(parsed: dict) -> str:
    """pursue if any pursue, else hold if any hold/errors, else skip.

    Empty / unreadable output fails closed to hold.
    """
    if not isinstance(parsed, dict):
        return "hold"
    if parsed.get("pursue"):
        return "pursue"
    if parsed.get("hold") or parsed.get("errors"):
        return "hold"
    if parsed.get("skip"):
        return "skip"
    return "hold"


def maybe_jev_triage(stats: dict, silent: bool) -> dict:
    """Mini post-sync stamp only. Fail closed. Never calls an LLM.

    Jev runs on Vercel (`/api/shopify-funnel/jev-triage`) where
    AI_GATEWAY_API_KEY lives. Mini must not hold that key. Never raises
    into the sync. No Shopify / theme / storefront writes.
    """
    try:
        if silent:
            return {"ran": False, "reason": "silent", "decision": None,
                    "runtime": "vercel"}
        return {
            "ran": False,
            "reason": "vercel_runtime",
            "decision": "hold",
            "severity": "hold_for_review",
            "runtime": "vercel",
            "items": jev_items_from_stats(stats or {}),
        }
    except Exception:
        return {
            "ran": False,
            "reason": "vercel_runtime",
            "decision": "hold",
            "severity": "hold_for_review",
            "runtime": "vercel",
        }


def _table_hint(err: str, table: str) -> str:
    if table in err or "PGRST" in err or "does not exist" in err.lower():
        return (f"{table} missing or unwritable — run "
                f"supabase/migration_shopify_funnel.sql. {err[:180]}")
    return err[:240]


def _message(funnel_ok: bool, abandon_ok: bool, missing: list[str],
             errors: list[str], silent: bool, stats: dict) -> str:
    bits = []
    if funnel_ok:
        bits.append(f"{stats.get('daily_rows', 0)} funnel day-rows")
    else:
        bits.append("funnel unavailable")
    if abandon_ok:
        bits.append(f"{stats.get('abandon_rows', 0)} abandoned")
    else:
        bits.append("abandons unavailable")
    if missing:
        bits.append("grant " + ", ".join(missing))
    if silent:
        bits.append("no material change")
    if errors and not missing:
        bits.append(errors[0][:80])
    return " · ".join(bits)
