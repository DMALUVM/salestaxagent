"""Sales-tax registration decision pack.

Ranks jurisdictions for a registration push, from live data only. The decision
itself is a pure function over already-gathered facts (`decide`), so it can be
tested with fixtures and audited row by row — every row carries the reason and
the confidence that produced it.

Three boundaries this module holds:

1. **Sales tax only.** Entity and business-activity exposure (California's $800,
   Washington's B&O, Oregon's CAT) never drives a sales-tax registration
   recommendation. Those are a different tax, a different agency and a different
   decision; they live in the entity matrix and appear here only as a footnote.

2. **Contested physical nexus is never a silent register_now.** Where the state
   rules say FBA inventory does not (or may not) create nexus, holding stock
   there produces `review_contested`. The conservative-sounding action is not
   automatically the correct one, and registering creates filing obligations
   that are awkward to unwind.

3. **A state without sales tax can never be `register_now`.** Enforced
   structurally by ordering, not by remembering to check.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

# Recommended actions, in the order the UI should present them.
ACTIONS = (
    "register_now",
    "review_contested",
    "monitor",
    "already_registered",
    "no_sales_tax",
)

# `fba_inventory_creates_nexus` values that support acting on inventory alone.
# `unknown_default_true` is the seed default: the repo's stated posture is that
# an unresearched state is assumed to create nexus, which is the conservative
# reading and is why it belongs here rather than with the contested values.
FBA_CREATES_NEXUS = frozenset({"true", "unknown_default_true", "True"})

# Values that mean "do not act on inventory alone". `false` is a positive
# finding that FBA stock does not create nexus; `contested` and `conditional`
# mean the answer depends on facts this system does not hold.
FBA_NEEDS_REVIEW = frozenset({"contested", "conditional"})
FBA_NO_NEXUS = frozenset({"false", "False"})


@dataclass
class StateFacts:
    """Everything the decision needs, already gathered."""
    state_code: str
    has_sales_tax: bool = True
    is_registered: bool = False
    fba_rule: str = "unknown_default_true"
    inventory_events: int = 0
    inventory_first: str | None = None
    inventory_last: str | None = None
    economic_exceeded: bool = False
    economic_pct: float = 0.0
    shopify_sales: float = 0.0
    amazon_sales: float = 0.0
    # Present only so the row can carry a footnote; never an input to `decide`.
    entity_exposure: bool = False

    @property
    def total_relevant_sales(self) -> float:
        return round(self.shopify_sales + self.amazon_sales, 2)

    @property
    def has_inventory(self) -> bool:
        return self.inventory_events > 0


@dataclass
class Decision:
    action: str
    reason: str
    confidence: str
    physical_nexus: str          # "Y" | "N" | "contested"
    economic_nexus: str          # "Y" | "N" | "approaching NN%"


@dataclass
class PlanRow:
    facts: StateFacts
    decision: Decision
    entity_note: str = ""
    residual_risk: str = ""
    extra: dict = field(default_factory=dict)


def _physical_label(f: StateFacts) -> str:
    if not f.has_inventory:
        return "N"
    if f.fba_rule in FBA_CREATES_NEXUS:
        return "Y"
    return "contested"


def _economic_label(f: StateFacts, warn_pct: float) -> str:
    if f.economic_exceeded:
        return "Y"
    if f.economic_pct >= warn_pct:
        return f"approaching {f.economic_pct:.0f}%"
    return "N"


def decide(f: StateFacts, warn_pct: float = 80.0) -> Decision:
    """Recommend an action for one state. Pure — no DB, no clock.

    Order matters and encodes the rules: a state with no sales tax exits before
    any trigger can be evaluated, and registration is checked before triggers so
    an already-registered state never shows up as work to do.
    """
    phys = _physical_label(f)
    econ = _economic_label(f, warn_pct)

    # 1. No sales tax at all — structurally cannot be a registration target.
    if not f.has_sales_tax:
        note = ("no state sales tax"
                + (" (entity/gross-receipts exposure may still exist — see /entity)"
                   if f.entity_exposure else ""))
        return Decision("no_sales_tax", note, "high", phys, econ)

    # 2. Already done.
    if f.is_registered:
        return Decision("already_registered", "already registered to collect",
                        "high", phys, econ)

    # 3. Economic nexus is independent of how inventory is treated, so it wins
    #    over a contested FBA position: the threshold is met either way.
    if f.economic_exceeded:
        return Decision(
            "register_now",
            f"economic threshold exceeded ({f.economic_pct:.0f}% of threshold, "
            f"${f.total_relevant_sales:,.0f} relevant sales)",
            "high", phys, econ)

    # 4. Inventory present, and the state's rule supports acting on it.
    if f.has_inventory and f.fba_rule in FBA_CREATES_NEXUS:
        confidence = "high" if f.fba_rule in ("true", "True") else "medium"
        basis = ("state rule: FBA inventory creates nexus"
                 if f.fba_rule in ("true", "True")
                 else "state rule unresearched — repo default assumes FBA inventory "
                      "creates nexus (conservative)")
        return Decision(
            "register_now",
            f"FBA inventory since {f.inventory_first} "
            f"({f.inventory_events:,} events); {basis}",
            confidence, phys, econ)

    # 5. Inventory present, but the rule says otherwise or is unsettled.
    if f.has_inventory and (f.fba_rule in FBA_NEEDS_REVIEW or f.fba_rule in FBA_NO_NEXUS):
        why = ("state rule says FBA inventory does NOT create nexus"
               if f.fba_rule in FBA_NO_NEXUS
               else f"state rule is {f.fba_rule} — depends on facts not held here")
        return Decision(
            "review_contested",
            f"FBA inventory since {f.inventory_first} "
            f"({f.inventory_events:,} events), but {why}. Confirm with a CPA "
            f"before registering.",
            "medium" if f.fba_rule in FBA_NEEDS_REVIEW else "high", phys, econ)

    # 6. Approaching the threshold.
    if f.economic_pct >= warn_pct:
        return Decision(
            "monitor",
            f"{f.economic_pct:.0f}% of economic threshold "
            f"(${f.total_relevant_sales:,.0f}) — no nexus trigger yet",
            "high", phys, econ)

    return Decision(
        "monitor",
        f"no nexus trigger (${f.total_relevant_sales:,.0f} relevant sales, "
        f"{f.economic_pct:.0f}% of threshold)",
        "high", phys, econ)


# Sort key: work first, then by how much is at stake.
_ACTION_ORDER = {a: i for i, a in enumerate(ACTIONS)}


def sort_rows(rows: list[PlanRow]) -> list[PlanRow]:
    return sorted(
        rows,
        key=lambda r: (
            _ACTION_ORDER.get(r.decision.action, 99),
            -r.facts.total_relevant_sales,
            r.facts.state_code,
        ),
    )


def build_rows(reference_date: date | None = None) -> list[PlanRow]:
    """Gather live facts and decide for every jurisdiction in state_rules."""
    from src.config import load_state_rules, settings
    from src.db import fetch_all
    from src.exports.registration_triage import (
        _gather_inventory_presence, _gather_sales_12m,
    )

    ref = reference_date or date.today()
    rules = load_state_rules().get("states", {})
    inventory = _gather_inventory_presence()
    sales = _gather_sales_12m(ref)
    nexus = {n["state_code"]: n for n in fetch_all("nexus_status")}
    warn_pct = float(settings.economic_nexus_warn_percent)

    entity_states = _entity_exposure_states()

    rows: list[PlanRow] = []
    # Every jurisdiction in the rules file, plus anything that showed up in the
    # data but is missing from the rules — a state with inventory and no rule
    # must not vanish from the plan.
    for sc in sorted(set(rules) | set(inventory) | set(sales) | set(nexus)):
        rule = rules.get(sc, {})
        inv = inventory.get(sc) or {}
        sale = sales.get(sc) or {}
        nx = nexus.get(sc) or {}

        f = StateFacts(
            state_code=sc,
            has_sales_tax=bool(rule.get("has_sales_tax", True)),
            is_registered=nx.get("is_registered") is True,
            fba_rule=str(rule.get("fba_inventory_creates_nexus", "unknown_default_true")),
            inventory_events=int(inv.get("events") or 0),
            inventory_first=inv.get("min_date"),
            inventory_last=inv.get("max_date"),
            economic_exceeded=bool(nx.get("has_economic_nexus")),
            economic_pct=float(nx.get("economic_progress_percent") or 0),
            shopify_sales=float(sale.get("shopify") or 0),
            amazon_sales=float(sale.get("amazon") or 0),
            entity_exposure=sc in entity_states,
        )
        d = decide(f, warn_pct)
        note = ""
        if f.entity_exposure and d.action != "no_sales_tax":
            note = "entity/business-activity exposure also exists — see /entity"
        rows.append(PlanRow(facts=f, decision=d, entity_note=note))

    _attach_residual_risk(rows)
    return sort_rows(rows)


def _entity_exposure_states() -> set[str]:
    """States with a non-sales-tax obligation, for the footnote only.

    Deliberately isolated in its own function so it is obvious this never feeds
    `decide()` — entity exposure is a different tax and a different decision.
    """
    try:
        from src.compliance.state_matrix import obligations
        return {o.state_code for o in obligations()}
    except Exception:
        return set()


def _attach_residual_risk(rows: list[PlanRow]) -> None:
    """Flag that unmapped FC codes could hide inventory in some state.

    An unmapped fulfilment centre produces events with no state, invisible to
    the physical-nexus test. That does not point at any particular state, so it
    is recorded as a global caveat rather than attached to a guess.
    """
    try:
        from src.db import get_client

        client = get_client()
        resp = (client.table("inventory_events").select("id", count="exact")
                .is_("state_code", "null").limit(1).execute())
        n = resp.count or 0
    except Exception:
        return
    if not n:
        return
    msg = (f"{n:,} inventory event(s) have an unmapped FC code and no state — "
           f"a state with stock could be missing from this plan. "
           f"Run `inventory-health`.")
    for r in rows:
        r.residual_risk = msg


def counts_by_action(rows: list[PlanRow]) -> dict[str, int]:
    out = {a: 0 for a in ACTIONS}
    for r in rows:
        out[r.decision.action] = out.get(r.decision.action, 0) + 1
    return out


CSV_COLUMNS = [
    "state", "sales_tax", "already_registered", "physical_nexus",
    "first_inventory_date", "economic_nexus", "shopify_sales", "amazon_sales",
    "total_relevant_sales", "recommended_action", "short_reason", "confidence",
    "entity_note",
]


def to_csv_rows(rows: list[PlanRow]) -> list[list]:
    out = [CSV_COLUMNS]
    for r in rows:
        f, d = r.facts, r.decision
        out.append([
            f.state_code,
            "Y" if f.has_sales_tax else "N",
            "Y" if f.is_registered else "N",
            d.physical_nexus,
            f.inventory_first or "",
            d.economic_nexus,
            f"{f.shopify_sales:.2f}",
            f"{f.amazon_sales:.2f}",
            f"{f.total_relevant_sales:.2f}",
            d.action,
            d.reason,
            d.confidence,
            r.entity_note,
        ])
    return out


def digest_line() -> str | None:
    """One Telegram line, or None when there is nothing to register.

    Deliberately terse and count-only: the plan itself is auditable on /registrations,
    and a digest that lists fifteen states every morning stops being read.
    """
    try:
        rows = build_rows()
    except Exception:
        return None
    c = counts_by_action(rows)
    now = c.get("register_now", 0)
    contested = c.get("review_contested", 0)
    approaching = sum(
        1 for r in rows
        if r.decision.action == "monitor" and r.decision.economic_nexus.startswith("approaching")
    )
    if not (now or contested or approaching):
        return None

    bits = []
    if now:
        top = [r.facts.state_code for r in rows if r.decision.action == "register_now"][:5]
        bits.append(f"{now} to register ({', '.join(top)}{'…' if now > 5 else ''})")
    if contested:
        bits.append(f"{contested} contested — CPA review")
    if approaching:
        bits.append(f"{approaching} approaching threshold")
    return "🗺️ Sales-tax registration: " + " · ".join(bits)
