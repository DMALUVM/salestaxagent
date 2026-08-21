"""Shopify customer metrics — AOV, LTV, repeat rate, cohorts.

Pure functions over order rows. No API, no database: the caller loads rows and
passes them in, so every definition below can be tested against a fixture and
recomputed by hand from the orders table.

SHOPIFY ONLY. Amazon cannot appear in any of these figures — see
`amazon_identity_note()` at the bottom for why, in one place, so nobody has to
reconstruct the reasoning later.

DEFINITIONS, stated once and reused everywhere
----------------------------------------------
**Revenue** = `subtotal_price − refunded_amount`, floored at 0.
  subtotal_price is after discounts and BEFORE tax and shipping — the same basis
  as `sales_by_state.gross_sales`, so these numbers reconcile with the tax
  aggregates instead of competing with them.
  Caveat kept in the open: refunded_amount is the refund TRANSACTION total and
  may include refunded tax, so net revenue is a slight under-estimate.

**Excluded** — test orders, and cancelled orders. Both are stored, so the
  exclusion is auditable rather than a filter applied at fetch time.

**Reconciliation with the tax aggregates.** Summed per month over US orders
  across all three Shopify channels (shopify, shopify_shop, shopify_sub), this
  table matches `sales_by_state.gross_sales` once cancelled orders are added
  back — 2026-08 reconciles to the cent ($5,925.50 + $76.50 cancelled =
  $6,002.00). The residual in other months is cancelled orders and month-boundary
  timing. The two are SUPPOSED to differ by exactly that: the tax aggregate
  counts what was transacted, the customer metrics count what a customer
  actually kept. sales_by_state remains the tax source of truth; nothing here
  feeds nexus or liability.

**Customer** = `customer_key` (see the migration). Guest checkouts sharing an
  email hash are one customer; an order with neither id nor email is its own
  one-order customer and can never be counted as repeat.

**AOV** = revenue ÷ orders, over a window.

**LTV** = total revenue per customer across ALL stored history, not a window.
  Reported as mean and median. Median matters: LTV is right-skewed, and a mean
  alone lets one wholesale-sized order look like typical customer value.

**Repeat rate** = customers with ≥2 orders ÷ customers. It is a property of the
  customers ACQUIRED in a window, not of orders placed in it.

**Cohort** = customers grouped by the month of their first order, tracked by
  month offset. Cumulative revenue per customer at offset N includes months
  0..N. Cohorts too young to have reached offset N report null, never 0 —
  "not yet observed" and "spent nothing" are different facts.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from statistics import median


def _num(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def revenue_of(row: dict) -> float:
    """Net merchandise revenue for one order. The single definition."""
    return max(0.0, _num(row.get("subtotal_price")) - _num(row.get("refunded_amount")))


def paid_of(row: dict) -> float:
    """What the customer actually paid: merchandise + tax + shipping, less refunds.

    Reported alongside net merchandise because Shopify Admin's headline AOV is
    Total sales ÷ orders, which includes tax and shipping. The two bases differ
    by roughly 15% on this store, and an operator comparing one screen to the
    other needs both labelled rather than a single number that matches neither.
    """
    return max(0.0, _num(row.get("total_price")) - _num(row.get("refunded_amount")))


def is_countable(row: dict) -> bool:
    """Test and cancelled orders are stored but never counted."""
    return not row.get("is_test") and not row.get("cancelled_at")


def countable(rows: list[dict]) -> list[dict]:
    return [r for r in rows if is_countable(r)]


def _month(d: str | date) -> str:
    s = d.isoformat() if isinstance(d, date) else str(d)
    return s[:7]


def _months_between(a: str, b: str) -> int:
    ay, am = int(a[:4]), int(a[5:7])
    by, bm = int(b[:4]), int(b[5:7])
    return (by - ay) * 12 + (bm - am)


# ── headline ─────────────────────────────────────────────────────────────

@dataclass
class Summary:
    orders: int = 0
    revenue: float = 0.0
    customers: int = 0
    # Order value — mean and median, on both bases.
    aov: float | None = None              # mean, net merchandise
    aov_median: float | None = None       # median, net merchandise
    aov_paid: float | None = None         # mean, incl. tax + shipping
    aov_paid_median: float | None = None
    # Lifetime value — all customers, then repeaters alone. Both are needed:
    # the all-customer median is ~one order because most people buy once, which
    # says something about acquisition, not about what a customer is worth once
    # they come back.
    ltv_mean: float | None = None
    ltv_median: float | None = None
    ltv_mean_repeat: float | None = None
    ltv_median_repeat: float | None = None
    repeat_customers: int = 0
    repeat_rate: float | None = None
    orders_per_repeater: float | None = None
    revenue_from_repeaters: float = 0.0
    revenue_from_repeaters_pct: float | None = None
    orders_per_customer: float | None = None
    identified_pct: float | None = None
    first_order_date: str | None = None
    last_order_date: str | None = None

    def as_dict(self) -> dict:
        return {
            "orders": self.orders, "revenue": round(self.revenue, 2),
            "customers": self.customers,
            "aov": None if self.aov is None else round(self.aov, 2),
            "aovMedian": None if self.aov_median is None else round(self.aov_median, 2),
            "aovPaid": None if self.aov_paid is None else round(self.aov_paid, 2),
            "aovPaidMedian": None if self.aov_paid_median is None
                             else round(self.aov_paid_median, 2),
            "repeatCustomers": self.repeat_customers,
            "repeatRate": None if self.repeat_rate is None else round(self.repeat_rate, 4),
            "ordersPerRepeater": None if self.orders_per_repeater is None
                                 else round(self.orders_per_repeater, 2),
            "revenueFromRepeaters": round(self.revenue_from_repeaters, 2),
            "revenueFromRepeatersPct": None if self.revenue_from_repeaters_pct is None
                                       else round(self.revenue_from_repeaters_pct, 2),
            "ltvMean": None if self.ltv_mean is None else round(self.ltv_mean, 2),
            "ltvMedian": None if self.ltv_median is None else round(self.ltv_median, 2),
            "ltvMeanRepeat": None if self.ltv_mean_repeat is None
                             else round(self.ltv_mean_repeat, 2),
            "ltvMedianRepeat": None if self.ltv_median_repeat is None
                               else round(self.ltv_median_repeat, 2),
            "interpretation": self.interpretation(),
            "ordersPerCustomer": None if self.orders_per_customer is None
                                 else round(self.orders_per_customer, 2),
            "identifiedPct": None if self.identified_pct is None
                             else round(self.identified_pct, 1),
            "firstOrderDate": self.first_order_date,
            "lastOrderDate": self.last_order_date,
        }

    def interpretation(self) -> str:
        """One line that stops the median from being read as "customer value".

        The all-customer median is ~one order on almost every DTC store, because
        most people buy once. Quoted alone it reads as "our customers are worth
        $13", which is why the operator rejected it as a headline. Value on this
        kind of store concentrates in the minority who return, so the sentence
        names that split explicitly.
        """
        if not self.customers:
            return "No customers in this set."
        if not self.repeat_customers:
            return (f"Every one of {self.customers:,} customers has ordered once. "
                    f"There is no repeat cohort yet, so LTV and AOV are the same "
                    f"number.")
        return (
            f"Median customer is one-time (${self.ltv_median:,.2f} ever, ≈ one order). "
            f"Value concentrates in the {self.repeat_rate * 100:.1f}% who come back: "
            f"they average ${self.ltv_mean_repeat:,.2f} LTV over "
            f"{self.orders_per_repeater:.1f} orders and drive "
            f"{self.revenue_from_repeaters_pct:.0f}% of revenue."
        )


def summarise(rows: list[dict]) -> Summary:
    """Headline metrics over whatever rows are passed in."""
    rows = countable(rows)
    s = Summary()
    if not rows:
        return s

    by_customer: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_customer[str(r.get("customer_key"))].append(r)

    s.orders = len(rows)
    s.revenue = sum(revenue_of(r) for r in rows)
    s.customers = len(by_customer)
    s.orders_per_customer = s.orders / s.customers if s.customers else None

    order_values = [revenue_of(r) for r in rows]
    s.aov = sum(order_values) / len(order_values)
    s.aov_median = median(order_values)
    paid = [paid_of(r) for r in rows]
    if any(paid):
        s.aov_paid = sum(paid) / len(paid)
        s.aov_paid_median = median(paid)

    totals = [sum(revenue_of(r) for r in rs) for rs in by_customer.values()]
    s.ltv_mean = sum(totals) / len(totals) if totals else None
    s.ltv_median = median(totals) if totals else None

    repeaters = [rs for rs in by_customer.values() if len(rs) >= 2]
    s.repeat_customers = len(repeaters)
    s.repeat_rate = s.repeat_customers / s.customers if s.customers else None
    if repeaters:
        rep_totals = [sum(revenue_of(r) for r in rs) for rs in repeaters]
        s.ltv_mean_repeat = sum(rep_totals) / len(rep_totals)
        s.ltv_median_repeat = median(rep_totals)
        s.orders_per_repeater = sum(len(rs) for rs in repeaters) / len(repeaters)
        s.revenue_from_repeaters = sum(rep_totals)
        s.revenue_from_repeaters_pct = (
            s.revenue_from_repeaters / s.revenue * 100 if s.revenue else None)

    # How much of the customer base is a real Shopify account rather than a
    # per-order fallback. A low number caps how much the repeat rate can ever
    # say, so it is reported beside it rather than left implicit.
    identified = sum(1 for k in by_customer if k.startswith("c:"))
    s.identified_pct = identified / s.customers * 100 if s.customers else None

    dates = sorted(str(r.get("order_date")) for r in rows)
    s.first_order_date, s.last_order_date = dates[0], dates[-1]
    return s


def window(rows: list[dict], start: str, end: str) -> list[dict]:
    return [r for r in rows if start <= str(r.get("order_date")) <= end]


# ── trend ────────────────────────────────────────────────────────────────

def monthly(rows: list[dict]) -> list[dict]:
    """Orders, revenue, AOV and new-vs-returning per calendar month.

    "New" is judged against a customer's first order across ALL history, so a
    buyer's first month is the only month they count as new.
    """
    rows = countable(rows)
    first_order: dict[str, str] = {}
    for r in rows:
        k, d = str(r.get("customer_key")), str(r.get("order_date"))
        if k not in first_order or d < first_order[k]:
            first_order[k] = d

    buckets: dict[str, dict] = defaultdict(
        lambda: {"orders": 0, "revenue": 0.0, "new_customers": set(),
                 "returning_orders": 0})
    for r in rows:
        m = _month(str(r.get("order_date")))
        b = buckets[m]
        b["orders"] += 1
        b["revenue"] += revenue_of(r)
        k = str(r.get("customer_key"))
        if _month(first_order[k]) == m and str(r.get("order_date")) == first_order[k]:
            b["new_customers"].add(k)
        elif str(r.get("order_date")) > first_order[k]:
            b["returning_orders"] += 1

    out = []
    for m in sorted(buckets):
        b = buckets[m]
        out.append({
            "month": m, "orders": b["orders"], "revenue": round(b["revenue"], 2),
            "aov": round(b["revenue"] / b["orders"], 2) if b["orders"] else None,
            "newCustomers": len(b["new_customers"]),
            "returningOrders": b["returning_orders"],
        })
    return out


# ── cohorts ──────────────────────────────────────────────────────────────

@dataclass
class Cohort:
    month: str
    customers: int
    revenue_by_offset: dict[int, float] = field(default_factory=dict)
    orders_by_offset: dict[int, int] = field(default_factory=dict)
    max_observed_offset: int = 0


def cohorts(rows: list[dict], max_offset: int = 12,
            today: str | None = None) -> list[dict]:
    """Acquisition cohorts by first-order month, cumulative revenue per customer.

    A cohort that has not yet lived long enough to have an offset-N month
    reports null for it — NOT zero. Zero would read as "these customers stopped
    buying" when the truth is "this month has not happened yet", and that
    mistake makes every young cohort look like a churn cliff.
    """
    rows = countable(rows)
    if not rows:
        return []
    today = today or max(str(r.get("order_date")) for r in rows)
    now_month = _month(today)

    first_order: dict[str, str] = {}
    for r in rows:
        k, d = str(r.get("customer_key")), str(r.get("order_date"))
        if k not in first_order or d < first_order[k]:
            first_order[k] = d

    cohort_of = {k: _month(d) for k, d in first_order.items()}
    members: dict[str, set] = defaultdict(set)
    for k, m in cohort_of.items():
        members[m].add(k)

    rev: dict[tuple[str, int], float] = defaultdict(float)
    ords: dict[tuple[str, int], int] = defaultdict(int)
    for r in rows:
        k = str(r.get("customer_key"))
        c = cohort_of[k]
        off = _months_between(c, _month(str(r.get("order_date"))))
        if 0 <= off <= max_offset:
            rev[(c, off)] += revenue_of(r)
            ords[(c, off)] += 1

    out = []
    for c in sorted(members):
        n = len(members[c])
        observed = _months_between(c, now_month)
        cum = 0.0
        cum_orders = 0
        offsets = []
        for off in range(max_offset + 1):
            if off > observed:
                offsets.append({"offset": off, "cumRevenuePerCustomer": None,
                                "cumOrders": None, "observed": False})
                continue
            cum += rev.get((c, off), 0.0)
            cum_orders += ords.get((c, off), 0)
            offsets.append({
                "offset": off,
                "cumRevenuePerCustomer": round(cum / n, 2) if n else None,
                "cumOrders": cum_orders, "observed": True,
            })
        out.append({"cohort": c, "customers": n,
                    "observedOffsets": min(observed, max_offset),
                    "offsets": offsets})
    return out


def cohort_ltv_at_days(rows: list[dict], days: tuple[int, ...] = (90, 365),
                       today: str | None = None) -> list[dict]:
    """Revenue per customer within N days of THEIR OWN first order.

    Day-based, not month-offset: "LTV at day 90" must mean 90 days from each
    customer's first purchase, otherwise a cohort acquired on the 28th is judged
    on a shorter window than one acquired on the 1st.

    A cohort whose window has not fully elapsed reports null for that horizon.
    Reporting a partial window as a finished number is how a young cohort gets
    mistaken for a declining one.
    """
    from datetime import date as _d

    rows = countable(rows)
    if not rows:
        return []
    today_d = _d.fromisoformat(today or max(str(r.get("order_date")) for r in rows))

    first: dict[str, str] = {}
    for r in rows:
        k, d = str(r.get("customer_key")), str(r.get("order_date"))
        if k not in first or d < first[k]:
            first[k] = d

    members: dict[str, set] = defaultdict(set)
    for k, d in first.items():
        members[_month(d)].add(k)

    # revenue[(cohort_month, horizon)] accumulated across members
    acc: dict[tuple[str, int], float] = defaultdict(float)
    for r in rows:
        k = str(r.get("customer_key"))
        c = _month(first[k])
        delta = (_d.fromisoformat(str(r.get("order_date")))
                 - _d.fromisoformat(first[k])).days
        for h in days:
            if delta <= h:
                acc[(c, h)] += revenue_of(r)

    out = []
    for c in sorted(members):
        n = len(members[c])
        # The cohort's window is complete only when the LAST member acquired in
        # that month has had the full horizon elapse.
        latest_join = max(first[k] for k in members[c])
        elapsed = (today_d - _d.fromisoformat(latest_join)).days
        row = {"cohort": c, "customers": n}
        for h in days:
            row[f"day{h}"] = (round(acc[(c, h)] / n, 2)
                              if n and elapsed >= h else None)
            row[f"day{h}Complete"] = elapsed >= h
        out.append(row)
    return out


def by_year(rows: list[dict]) -> list[dict]:
    """Order value per calendar year.

    Exists because an all-time AOV can answer a question nobody asked. On this
    store 2024 alone is 8,480 of 13,867 orders at $17.89, which drags the
    all-time mean to $23.41 while 2025 runs $34.57 — the figure an operator
    recognises. Showing the years makes that a visible fact about the business
    rather than a number that looks wrong.
    """
    rows = countable(rows)
    buckets: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        buckets[str(r.get("order_date"))[:4]].append(r)
    out = []
    for y in sorted(buckets):
        rs = buckets[y]
        net = [revenue_of(r) for r in rs]
        paid = [paid_of(r) for r in rs]
        out.append({
            "year": y, "orders": len(rs),
            "aov": round(sum(net) / len(net), 2),
            "aovMedian": round(median(net), 2),
            "aovPaid": round(sum(paid) / len(paid), 2),
            "revenue": round(sum(net), 2),
        })
    return out


# ── Amazon ───────────────────────────────────────────────────────────────

def amazon_identity_note() -> dict:
    """Why person-level metrics do not exist for Amazon, and what does.

    Written as data so the dashboard, the CLI and any export state the same
    thing. This is a limitation of what Amazon discloses to a seller, not a gap
    in this repo that a backfill could close.
    """
    return {
        "personLevelAvailable": False,
        "why": [
            "Amazon does not disclose a persistent buyer identity to sellers. "
            "Orders carry an obfuscated, per-order buyer token, not a stable "
            "customer id.",
            "Buyer email is an alias that Amazon rotates and, for most order "
            "types, no longer exposes at all.",
            "There is therefore no key on which two Amazon orders can be joined "
            "to the same person. Repeat rate, LTV and cohorts are not "
            "computable — not merely unbuilt.",
        ],
        "doNotDo": "Do not approximate an Amazon customer by name, address or "
                   "any hash of them. Households share addresses, buyers move, "
                   "and the result would be a fabricated identity presented as a "
                   "measurement.",
        "whatIsAvailable": [
            "Order-level AOV: gross sales ÷ order count from sales_daily, which "
            "is SP-API sourced and already the Pulse figure.",
            "Units per order and product mix, from sales_by_sku.",
        ],
    }


def amazon_aov(sales_daily_rows: list[dict]) -> dict:
    """Order-level AOV for Amazon. No person-level claim is made or implied."""
    gross = sum(_num(r.get("gross_sales")) for r in sales_daily_rows)
    orders = sum(int(r.get("order_count") or 0) for r in sales_daily_rows)
    days = len({str(r.get("sale_date")) for r in sales_daily_rows})
    return {
        "orders": orders, "revenue": round(gross, 2), "days": days,
        "aov": round(gross / orders, 2) if orders else None,
        "basis": "sales_daily (amazon_spapi), America/Los_Angeles closed days",
        "personLevel": False,
    }
