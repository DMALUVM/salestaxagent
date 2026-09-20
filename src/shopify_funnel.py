"""Shopify shopper-funnel math — drop-off, recovery, abandon mix.

Pure functions over stored rows. No API, no database: the sync writes raw
ShopifyQL / abandoned-checkout counts, and everything an operator sees is
recomputed here (and in the dashboard twin `dashboard/src/lib/shopify-funnel.ts`).

DEFINITIONS
-----------
Closed funnel (ShopifyQL `sessions` schema, human sessions only):

  sessions → add_to_cart → checkout_started → purchases

  add_to_cart      = sessions_with_cart_additions
  checkout_started = sessions_that_reached_checkout
  purchases        = sessions_that_completed_checkout

These four are a closed funnel: each step is a subset of the previous.

PDP is NOT in that closed funnel. `pdp_sessions` is sessions whose
`landing_page_type` is product — they *landed* on a PDP. Shoppers can add
to cart from a collection, so add_to_cart can exceed pdp_sessions. When
that happens drop-off is reported as null with `nested=false`, never as a
negative leak invented to force a staircase.

A missing count (None) means Shopify did not return that metric — scope
missing, parse error, or the query was not run. It is never replaced with 0.
Zero is a real measurement.

Drop-off rate from A → B = (A − B) / A when A > 0 and both are present
and B ≤ A. Otherwise null.

Biggest leak is the closed-funnel step that lost the most *sessions*
(count, not rate). A 90% drop on 10 sessions is not the leak if 800
sessions died on the previous step.

Recovery rate = recovered checkouts ÷ checkouts in the window.
Recovered = `completed_at` is set (Shopify's own completion timestamp).

Abandoned $ = sum of total_price on checkouts that are NOT recovered.
We do not invent a value from line items when total_price is missing —
those rows contribute to count but not to $.

Jev is not wired. `stub_triage_severity` is a fail-closed placeholder:
unknown → hold_for_review. Do not call an LLM from the sync.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Iterable


CLOSED_STEPS: tuple[tuple[str, str], ...] = (
    ("sessions", "Sessions"),
    ("add_to_cart", "Added to cart"),
    ("checkout_started", "Reached checkout"),
    ("purchases", "Purchased"),
)

# PDP is shown beside the closed funnel and labelled as a landing mix.
PDP_STEP = ("pdp_sessions", "Landed on PDP")

WINDOW_DAYS = (7, 28)

# Stub thresholds only. TODO(jev): replace with the classifier.
STUB_NEEDS_EYES_MIN = 40.0
STUB_NOISE_MAX = 8.0

# "Nothing material changed" — silent job log when both hold.
MATERIAL_LEAK_COUNT = 3
MATERIAL_RATE_PP = 2.0
MATERIAL_ABANDON_COUNT = 3
MATERIAL_ABANDON_VALUE = 40.0


def _num(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def as_int(v) -> int | None:
    """Parse a ShopifyQL / JSON count. None stays None — never coerced to 0."""
    n = _num(v)
    if n is None:
        return None
    return int(n)


def as_money(v) -> float | None:
    n = _num(v)
    if n is None:
        return None
    return round(n, 2)


def drop_off(prev: int | None, curr: int | None) -> dict:
    """One step. `nested` is false when curr > prev (PDP vs ATC, etc.)."""
    if prev is None or curr is None:
        return {
            "lost": None, "rate": None, "conversion": None,
            "nested": None, "present": False,
        }
    nested = curr <= prev
    if prev <= 0:
        return {
            "lost": 0 if nested else None,
            "rate": None,
            "conversion": None,
            "nested": nested,
            "present": True,
        }
    if not nested:
        return {
            "lost": None,
            "rate": None,
            "conversion": round(curr / prev, 4),
            "nested": False,
            "present": True,
        }
    lost = prev - curr
    return {
        "lost": lost,
        "rate": round(lost / prev, 4),
        "conversion": round(curr / prev, 4),
        "nested": True,
        "present": True,
    }


def conversion_rate(start: int | None, end: int | None) -> float | None:
    if start is None or end is None or start <= 0:
        return None
    return round(end / start, 4)


@dataclass
class FunnelCounts:
    sessions: int | None = None
    pdp_sessions: int | None = None
    add_to_cart: int | None = None
    checkout_started: int | None = None
    purchases: int | None = None

    def as_dict(self) -> dict:
        return {
            "sessions": self.sessions,
            "pdpSessions": self.pdp_sessions,
            "addToCart": self.add_to_cart,
            "checkoutStarted": self.checkout_started,
            "purchases": self.purchases,
        }

    def get(self, key: str) -> int | None:
        return getattr(self, key)


def sum_daily(rows: Iterable[dict], start: str, end: str) -> FunnelCounts:
    """Sum split_kind='all' rows in [start, end]. Missing stays missing.

    A day that has sessions=10 and add_to_cart=null contributes 10 to sessions
    and does not turn the window add_to_cart into 0.
    """
    acc = {k: None for k in (
        "sessions", "pdp_sessions", "add_to_cart", "checkout_started", "purchases")}
    for r in rows:
        if str(r.get("split_kind") or "all") != "all":
            continue
        d = str(r.get("metric_date") or "")
        if d < start or d > end:
            continue
        for k in acc:
            v = as_int(r.get(k))
            if v is None:
                continue
            acc[k] = (acc[k] or 0) + v
    return FunnelCounts(**acc)


def steps_of(counts: FunnelCounts, include_pdp: bool = True) -> list[dict]:
    """Ordered steps for the card. PDP is omitted when the count is missing."""
    out = []
    out.append(_step("sessions", "Sessions", counts.sessions))
    if include_pdp and counts.pdp_sessions is not None:
        out.append(_step("pdp_sessions", "Landed on PDP", counts.pdp_sessions,
                         note="Landing page was a product page. Not a closed-funnel gate."))
    out.append(_step("add_to_cart", "Added to cart", counts.add_to_cart))
    out.append(_step("checkout_started", "Reached checkout", counts.checkout_started))
    out.append(_step("purchases", "Purchased", counts.purchases))
    return out


def _step(key: str, label: str, count: int | None, note: str | None = None) -> dict:
    return {"key": key, "label": label, "count": count, "note": note}


def drop_off_path(steps: list[dict]) -> list[dict]:
    """Drop-off between consecutive *displayed* steps."""
    out = []
    for i in range(1, len(steps)):
        a, b = steps[i - 1], steps[i]
        d = drop_off(a["count"], b["count"])
        out.append({
            "from": a["key"], "fromLabel": a["label"],
            "to": b["key"], "toLabel": b["label"],
            **d,
        })
    return out


def closed_drop_off(counts: FunnelCounts) -> list[dict]:
    """Drop-off along the official four-step closed funnel only."""
    steps = [_step(k, lab, counts.get(k)) for k, lab in CLOSED_STEPS]
    return drop_off_path(steps)


def biggest_leak(counts: FunnelCounts) -> dict | None:
    """Largest session-count loss on the closed funnel. None if uncomputable."""
    leaks = [d for d in closed_drop_off(counts)
             if d.get("nested") and d.get("lost") is not None]
    if not leaks:
        return None
    leaks.sort(key=lambda d: (-int(d["lost"]), -float(d["rate"] or 0)))
    top = leaks[0]
    return {
        "from": top["from"],
        "fromLabel": top["fromLabel"],
        "to": top["to"],
        "toLabel": top["toLabel"],
        "lost": top["lost"],
        "rate": top["rate"],
    }


def window_bounds(end: str, days: int) -> tuple[str, str]:
    if days not in WINDOW_DAYS:
        raise ValueError(f"window days must be 7 or 28, got {days}")
    end_d = date.fromisoformat(end)
    start = end_d - timedelta(days=days - 1)
    return start.isoformat(), end


def metric_date_of(raw) -> str | None:
    """ShopifyQL TIMESERIES day → YYYY-MM-DD."""
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    # '2026-09-18' or '2026-09-18T00:00:00'
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    return None


def parse_shopifyql_table(table: dict | None) -> list[dict]:
    """Normalise shopifyqlQuery.tableData.rows to a list of dicts."""
    if not table:
        return []
    rows = table.get("rows")
    if rows is None:
        return []
    if isinstance(rows, str):
        import json
        try:
            rows = json.loads(rows)
        except ValueError:
            return []
    out = []
    for r in rows:
        if isinstance(r, dict):
            out.append(r)
        elif isinstance(r, list):
            cols = [c.get("name") for c in (table.get("columns") or [])]
            out.append({cols[i]: r[i] for i in range(min(len(cols), len(r)))})
    return out


def funnel_row_from_shopifyql(raw: dict, split_kind: str = "all",
                              split_value: str = "") -> dict | None:
    d = metric_date_of(raw.get("day") or raw.get("metric_date"))
    if not d:
        return None
    return {
        "metric_date": d,
        "split_kind": split_kind,
        "split_value": split_value,
        "sessions": as_int(raw.get("sessions")),
        "pdp_sessions": as_int(raw.get("pdp_sessions")),
        "add_to_cart": as_int(
            raw.get("sessions_with_cart_additions")
            if "sessions_with_cart_additions" in raw
            else raw.get("add_to_cart")),
        "checkout_started": as_int(
            raw.get("sessions_that_reached_checkout")
            if "sessions_that_reached_checkout" in raw
            else raw.get("checkout_started")),
        "purchases": as_int(
            raw.get("sessions_that_completed_checkout")
            if "sessions_that_completed_checkout" in raw
            else raw.get("purchases")),
        "source": "shopifyql",
    }


def merge_pdp_into_daily(daily: list[dict], pdp_rows: list[dict]) -> list[dict]:
    """Attach pdp_sessions onto split_kind='all' rows by date."""
    by_date = {r["metric_date"]: r for r in daily if r.get("split_kind") == "all"}
    for p in pdp_rows:
        d = p.get("metric_date")
        if not d:
            continue
        if d in by_date:
            by_date[d]["pdp_sessions"] = p.get("sessions")
        else:
            by_date[d] = {
                "metric_date": d, "split_kind": "all", "split_value": "",
                "sessions": None, "pdp_sessions": p.get("sessions"),
                "add_to_cart": None, "checkout_started": None, "purchases": None,
                "source": "shopifyql",
            }
    # Preserve any non-all rows the caller already built.
    others = [r for r in daily if r.get("split_kind") != "all"]
    return sorted(by_date.values(), key=lambda r: r["metric_date"]) + others


def gid_numeric(gid: str | None) -> str | None:
    if not gid:
        return None
    return str(gid).rsplit("/", 1)[-1] or None


def money_bag_amount(node: dict | None, field: str) -> float | None:
    if not node:
        return None
    bag = node.get(field) or {}
    shop = bag.get("shopMoney") or {}
    return as_money(shop.get("amount"))


def line_items_from_gql(node: dict) -> list[dict]:
    conn = node.get("lineItems") or {}
    items = conn.get("nodes") or []
    out = []
    for it in items:
        product = it.get("product") or {}
        out.append({
            "title": it.get("title") or product.get("title"),
            "quantity": as_int(it.get("quantity")) or 0,
            "sku": it.get("sku"),
            "variantTitle": it.get("variantTitle"),
            "handle": product.get("handle"),
            "productId": gid_numeric(product.get("id")),
            "amount": money_bag_amount(it, "originalTotalPriceSet"),
        })
    return out


def abandoned_row_from_gql(node: dict, checkout_date: str) -> dict | None:
    gid = node.get("id")
    if not gid:
        return None
    items = line_items_from_gql(node)
    completed = node.get("completedAt")
    total = money_bag_amount(node, "totalPriceSet")
    recovered = bool(completed)
    severity, note = stub_triage_severity(total, recovered)
    return {
        "checkout_id": gid,
        "checkout_name": node.get("name"),
        "created_at": node.get("createdAt"),
        "updated_at": node.get("updatedAt"),
        "completed_at": completed,
        "checkout_date": checkout_date,
        "total_price": total,
        "subtotal_price": money_bag_amount(node, "subtotalPriceSet"),
        "currency": ((node.get("totalPriceSet") or {}).get("shopMoney") or {}).get(
            "currencyCode"),
        "recovered": recovered,
        "line_items": items,
        "line_items_qty": sum(i["quantity"] for i in items),
        "triage_severity": severity,
        "triage_source": "stub",
        "triage_note": note,
    }


def stub_triage_severity(total: float | None, recovered: bool) -> tuple[str, str]:
    """Fail-closed stub. TODO(jev): classify after sync; do not call an LLM here."""
    if recovered:
        return "noise", "Recovered — no action. Stub until Jev is wired."
    if total is None:
        return ("hold_for_review",
                "Amount missing; fail closed. TODO(jev): replace this stub.")
    if total >= STUB_NEEDS_EYES_MIN:
        return ("needs_eyes",
                f"${total:.2f} abandon ≥ ${STUB_NEEDS_EYES_MIN:.0f}. Stub until Jev.")
    if total < STUB_NOISE_MAX:
        return ("noise",
                f"${total:.2f} abandon < ${STUB_NOISE_MAX:.0f}. Stub until Jev.")
    return ("hold_for_review",
            f"${total:.2f} mid-value; hold for review. TODO(jev): replace this stub.")


def recovery_rate(rows: list[dict]) -> dict:
    n = len(rows)
    recovered = sum(1 for r in rows if r.get("recovered"))
    open_rows = [r for r in rows if not r.get("recovered")]
    value = 0.0
    value_known = 0
    for r in open_rows:
        amt = as_money(r.get("total_price"))
        if amt is None:
            continue
        value += amt
        value_known += 1
    return {
        "count": n,
        "recovered": recovered,
        "open": n - recovered,
        "recoveryRate": round(recovered / n, 4) if n else None,
        "openValue": round(value, 2),
        "openValueKnown": value_known,
        "openValueMissing": (n - recovered) - value_known,
    }


def top_abandoned_products(rows: list[dict], limit: int = 10) -> list[dict]:
    """Line-item mix of *open* (not recovered) checkouts. No invented titles."""
    buckets: dict[str, dict] = {}
    for r in rows:
        if r.get("recovered"):
            continue
        for it in r.get("line_items") or []:
            title = (it.get("title") or "").strip()
            if not title:
                continue
            key = it.get("handle") or title
            b = buckets.get(key) or {
                "key": key, "title": title, "handle": it.get("handle"),
                "quantity": 0, "amount": 0.0, "amountKnown": 0, "checkouts": 0,
            }
            b["quantity"] += int(it.get("quantity") or 0)
            amt = as_money(it.get("amount"))
            if amt is not None:
                b["amount"] += amt
                b["amountKnown"] += 1
            b["checkouts"] += 1
            buckets[key] = b
    out = []
    for b in buckets.values():
        out.append({
            "key": b["key"],
            "title": b["title"],
            "handle": b["handle"],
            "quantity": b["quantity"],
            "amount": round(b["amount"], 2),
            "checkouts": b["checkouts"],
        })
    out.sort(key=lambda x: (-x["amount"], -x["quantity"], x["title"]))
    return out[:limit]


def filter_abandoned(rows: list[dict], start: str, end: str) -> list[dict]:
    return [r for r in rows if start <= str(r.get("checkout_date") or "") <= end]


def device_window(rows: Iterable[dict], start: str, end: str) -> list[dict]:
    buckets: dict[str, FunnelCounts] = defaultdict(FunnelCounts)
    for r in rows:
        if str(r.get("split_kind") or "") != "device":
            continue
        d = str(r.get("metric_date") or "")
        if d < start or d > end:
            continue
        key = str(r.get("split_value") or "unknown")
        b = buckets[key]
        for field_name in ("sessions", "pdp_sessions", "add_to_cart",
                           "checkout_started", "purchases"):
            v = as_int(r.get(field_name))
            if v is None:
                continue
            cur = getattr(b, field_name)
            setattr(b, field_name, (cur or 0) + v)
    out = []
    for name, c in buckets.items():
        out.append({"device": name, **c.as_dict(),
                    "leak": biggest_leak(c)})
    out.sort(key=lambda x: (-(x["sessions"] or 0), x["device"]))
    return out


@dataclass
class PreviousSnapshot:
    leak_from: str | None = None
    leak_to: str | None = None
    leak_lost: int | None = None
    leak_rate: float | None = None
    abandon_open: int | None = None
    abandon_value: float | None = None


def is_material_change(prev: PreviousSnapshot | None, leak: dict | None,
                       abandon: dict) -> bool:
    """True when the operator should notice. False → silent log line."""
    if prev is None:
        return True
    if leak and (leak.get("from") != prev.leak_from or leak.get("to") != prev.leak_to):
        return True
    if leak and prev.leak_lost is not None and leak.get("lost") is not None:
        if abs(int(leak["lost"]) - int(prev.leak_lost)) >= MATERIAL_LEAK_COUNT:
            return True
    if leak and prev.leak_rate is not None and leak.get("rate") is not None:
        if abs(float(leak["rate"]) - float(prev.leak_rate)) * 100 >= MATERIAL_RATE_PP:
            return True
    if prev.abandon_open is not None:
        if abs(int(abandon.get("open") or 0) - int(prev.abandon_open)) >= MATERIAL_ABANDON_COUNT:
            return True
    if prev.abandon_value is not None:
        if abs(float(abandon.get("openValue") or 0) - float(prev.abandon_value)) >= MATERIAL_ABANDON_VALUE:
            return True
    # First-ever leak (or first-ever disappear) is material.
    if (leak is None) != (prev.leak_from is None):
        return True
    return False


def snapshot_from_stats(stats: dict | None) -> PreviousSnapshot | None:
    if not stats:
        return None
    leak = stats.get("leak") or {}
    abandon = stats.get("abandon") or {}
    if not leak and not abandon:
        return None
    return PreviousSnapshot(
        leak_from=leak.get("from"),
        leak_to=leak.get("to"),
        leak_lost=as_int(leak.get("lost")),
        leak_rate=_num(leak.get("rate")),
        abandon_open=as_int(abandon.get("open")),
        abandon_value=as_money(abandon.get("openValue")),
    )


def classify_gql_errors(errors: list[dict]) -> list[str]:
    """Map GraphQL error text to the grant Dave has to click. No guesses."""
    found: list[str] = []
    for e in errors or []:
        msg = str(e.get("message") or "")
        ext = str((e.get("extensions") or {}).get("code") or "")
        blob = f"{msg} {ext}".lower()
        if "read_reports" in blob:
            found.append("read_reports")
        if "read_orders" in blob:
            found.append("read_orders")
        if "manage_abandoned_checkouts" in blob or "view_abandoned_checkouts" in blob:
            found.append("manage_abandoned_checkouts")
        if "protected customer" in blob or "level 2" in blob:
            found.append("protected_customer_data_level_2")
        if "access denied" in blob and "shopifyqlquery" in blob and "read_reports" not in found:
            found.append("read_reports")
        if "access denied" in blob and "abandonedcheckouts" in blob:
            if "read_orders" not in found:
                found.append("read_orders")
            if "manage_abandoned_checkouts" not in found:
                found.append("manage_abandoned_checkouts")
    # Preserve order, unique.
    out, seen = [], set()
    for s in found:
        if s not in seen:
            seen.add(s)
            out.append(s)
    return out


# Dave greenlit 2026-09-20: custom app "Sales Tax Agent" may take the
# minimum READ set for funnel + abandoned checkouts. Admin UI owner click
# — Mini / this repo cannot apply scopes. No writes, no theme, no storefront.
MIN_READ_SCOPES = (
    "read_reports",  # ShopifyQL shopifyqlQuery — not on the live token
    "read_orders",   # abandonedCheckouts — already live (2026-09-20 probe)
)
REQUIRED_SCOPES = MIN_READ_SCOPES

# Already on shop b7905e-3. Keep. Do not request extras.
ALREADY_GRANTED_SCOPES = (
    "read_all_orders",
    "read_draft_orders",
    "read_orders",
    "read_products",
)

FORBIDDEN_SCOPES = (
    "write_orders",
    "write_draft_orders",
    "write_products",
    "write_checkouts",
    "write_themes",
    "read_themes",
    "write_theme_code",
    "unauthenticated_read_product_listings",
    "unauthenticated_write_checkouts",
)

REQUIRED_STAFF = (
    "manage_abandoned_checkouts",  # staff permission on the installing user
)

REQUIRED_PCD = (
    "protected_customer_data_level_2",  # ShopifyQL requirement
)


def requested_scopes_are_read_only() -> bool:
    """True when REQUIRED_SCOPES is the greenlit min READ set."""
    if any(s.startswith("write_") or s.startswith("unauthenticated_")
           for s in REQUIRED_SCOPES):
        return False
    if any(s in FORBIDDEN_SCOPES for s in REQUIRED_SCOPES):
        return False
    return tuple(REQUIRED_SCOPES) == MIN_READ_SCOPES
