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

2. **Contested / carve-out / partial physical nexus is never a silent
   register_now.** Tess citation packets (2026-09-11) are SoT for FBA inventory.
   Documented carve-outs (IL/NY) and partial packets (MO/AL/MS/AZ) never become
   `register_now` from inventory alone. `unknown_default_true` is not a
   researched assert.

3. **A state without sales tax can never be `register_now`.** Enforced
   structurally by ordering, not by remembering to check.

Avalara/GT/STI seed in `fba_nexus_posture.json` must not override Tess packets.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

# Recommended actions, in the order the UI should present them.
ACTIONS = (
    "register_now",
    "needs_statute_review",
    "review_contested",
    "monitor",
    "already_registered",
    "no_sales_tax",
)

TESS_PACKET_DATE = "2026-09-11"

# Documented `true` in state_rules (CA/WA/MI). `unknown_default_true` is NOT
# an assert — it is a repo default and must not quiet-register.
FBA_CREATES_NEXUS = frozenset({"true", "True"})

# Values that mean "do not act on inventory alone". `false` is a positive
# finding that FBA stock does not create nexus; `contested` and `conditional`
# mean the answer depends on facts this system does not hold.
FBA_NEEDS_REVIEW = frozenset({"contested", "conditional"})
FBA_NO_NEXUS = frozenset({"false", "False"})
FBA_UNKNOWN = frozenset({"unknown_default_true", ""})


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
    # Tess citation packet (2026-09-11). Empty documentation_status = no packet.
    documentation_status: str = ""
    tess_posture: str = ""
    tess_confidence: str = ""
    tess_citation: str = ""
    tess_packet_date: str = ""

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
    physical_nexus: str          # "Y" | "N" | "contested" | "flagged"
    economic_nexus: str          # "Y" | "N" | "approaching NN%"
    documentation_status: str = "unknown"   # documented | partial | unknown
    citation: str = ""
    packet_date: str = ""
    authority_source: str = "none"          # tess_packet | state_rule | unknown_default | economic | none


@dataclass
class PlanRow:
    facts: StateFacts
    decision: Decision
    entity_note: str = ""
    residual_risk: str = ""
    extra: dict = field(default_factory=dict)


def _has_tess_packet(f: StateFacts) -> bool:
    return f.documentation_status in ("documented", "partial")


def _packet_date(f: StateFacts) -> str:
    return f.tess_packet_date or TESS_PACKET_DATE


def _physical_label(f: StateFacts) -> str:
    if not f.has_inventory:
        return "N"
    if f.documentation_status == "documented" and f.tess_posture == "asserts":
        return "Y"
    if f.documentation_status == "documented" and f.tess_posture == "carve_out":
        return "contested"
    if f.documentation_status == "partial":
        return "flagged"
    if f.fba_rule in FBA_CREATES_NEXUS:
        return "Y"
    if f.fba_rule in FBA_NO_NEXUS or f.fba_rule in FBA_NEEDS_REVIEW:
        return "contested"
    return "flagged"


def _decision(
    action: str,
    reason: str,
    confidence: str,
    phys: str,
    econ: str,
    *,
    documentation_status: str = "unknown",
    citation: str = "",
    packet_date: str = "",
    authority_source: str = "none",
) -> Decision:
    return Decision(
        action, reason, confidence, phys, econ,
        documentation_status=documentation_status,
        citation=citation,
        packet_date=packet_date,
        authority_source=authority_source,
    )


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
        return _decision("no_sales_tax", note, "high", phys, econ)

    # 2. Already done.
    if f.is_registered:
        return _decision("already_registered", "already registered to collect",
                         "high", phys, econ)

    # 3. Economic nexus is independent of how inventory is treated, so it wins
    #    over a contested FBA position: the threshold is met either way.
    if f.economic_exceeded:
        return _decision(
            "register_now",
            f"economic threshold exceeded ({f.economic_pct:.0f}% of threshold, "
            f"${f.total_relevant_sales:,.0f} relevant sales)",
            "high", phys, econ,
            documentation_status=f.documentation_status or "unknown",
            citation=f.tess_citation,
            packet_date=_packet_date(f) if _has_tess_packet(f) else "",
            authority_source="economic",
        )

    inv_prefix = (
        f"FBA inventory since {f.inventory_first} "
        f"({f.inventory_events:,} events)"
    )

    # 4. Tess packet — SoT for FBA inventory. Documented asserts may
    #    register_now; carve-out and partial never quiet-register.
    if f.has_inventory and _has_tess_packet(f):
        date = _packet_date(f)
        cite = f.tess_citation
        conf = f.tess_confidence or "medium"
        status = f.documentation_status
        if status == "documented" and f.tess_posture == "asserts":
            return _decision(
                "register_now",
                f"{inv_prefix}; documented Tess packet ({date}): "
                f"asserts/{conf} — {cite} [source: tess_packet].",
                conf, phys, econ,
                documentation_status="documented",
                citation=cite,
                packet_date=date,
                authority_source="tess_packet",
            )
        if status == "documented" and f.tess_posture == "carve_out":
            return _decision(
                "review_contested",
                f"{inv_prefix}, but documented Tess packet ({date}): "
                f"carve_out/{conf} — {cite}. MF-only FBA inventory is not a "
                f"silent register_now. Confirm with a CPA before registering.",
                conf, phys, econ,
                documentation_status="documented",
                citation=cite,
                packet_date=date,
                authority_source="tess_packet",
            )
        # partial (AZ contested, or MO/AL/MS asserts-without-FBA-name)
        action = (
            "review_contested" if f.tess_posture == "contested"
            else "needs_statute_review"
        )
        extra = (
            " Fact-specific; confirm with a CPA before registering."
            if f.tess_posture == "contested"
            else ""
        )
        return _decision(
            action,
            f"{inv_prefix}; partial — FBA not named; CPA confirm. "
            f"Tess packet ({date}): {f.tess_posture}/{conf} — {cite} "
            f"[source: tess_packet].{extra}",
            conf, phys, econ,
            documentation_status="partial",
            citation=cite,
            packet_date=date,
            authority_source="tess_packet",
        )

    # 5. Documented state_rules true (no Tess packet) — CA/WA/MI.
    if f.has_inventory and f.fba_rule in FBA_CREATES_NEXUS:
        return _decision(
            "register_now",
            f"{inv_prefix}; documented: FBA inventory creates nexus "
            f"[source: state_rule].",
            "high", phys, econ,
            documentation_status="documented",
            authority_source="state_rule",
        )

    # 6. Inventory present, but the rule says otherwise or is unsettled.
    if f.has_inventory and (f.fba_rule in FBA_NEEDS_REVIEW or f.fba_rule in FBA_NO_NEXUS):
        why = ("state rule says FBA inventory does NOT create nexus"
               if f.fba_rule in FBA_NO_NEXUS
               else f"state rule is {f.fba_rule} — depends on facts not held here")
        return _decision(
            "review_contested",
            f"{inv_prefix}, but {why}. Confirm with a CPA before registering.",
            "medium" if f.fba_rule in FBA_NEEDS_REVIEW else "high",
            phys, econ,
            documentation_status="documented",
            authority_source="state_rule",
        )

    # 7. Inventory + unknown default — never quiet register_now.
    if f.has_inventory:
        return _decision(
            "needs_statute_review",
            f"{inv_prefix}; needs statute review. Insufficient authority "
            f"(unknown_default, not Tess-researched).",
            "low", phys, econ,
            documentation_status="unknown",
            authority_source="unknown_default",
        )

    # 8. Approaching the threshold.
    if f.economic_pct >= warn_pct:
        return _decision(
            "monitor",
            f"{f.economic_pct:.0f}% of economic threshold "
            f"(${f.total_relevant_sales:,.0f}) — no nexus trigger yet",
            "high", phys, econ)

    return _decision(
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
    from src.config import load_fba_inventory_nexus_citations, load_state_rules, settings
    from src.db import fetch_all
    from src.exports.registration_triage import (
        _gather_inventory_presence, _gather_sales_12m,
    )

    ref = reference_date or date.today()
    rules = load_state_rules().get("states", {})
    packets = load_fba_inventory_nexus_citations()
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
        pkt = packets.get(sc) or {}

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
            documentation_status=str(pkt.get("documentation_status") or ""),
            tess_posture=str(pkt.get("posture") or ""),
            tess_confidence=str(pkt.get("confidence") or ""),
            tess_citation=str(pkt.get("short_citation") or ""),
            tess_packet_date=str(pkt.get("packet_date") or ""),
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
    "entity_note", "documentation_status", "citation", "packet_date",
    "authority_source",
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
            d.documentation_status,
            d.citation,
            d.packet_date,
            d.authority_source,
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
    flagged = c.get("needs_statute_review", 0)
    contested = c.get("review_contested", 0)
    approaching = sum(
        1 for r in rows
        if r.decision.action == "monitor" and r.decision.economic_nexus.startswith("approaching")
    )
    if not (now or flagged or contested or approaching):
        return None

    bits = []
    if now:
        top = [r.facts.state_code for r in rows if r.decision.action == "register_now"][:5]
        bits.append(f"{now} to register ({', '.join(top)}{'…' if now > 5 else ''})")
    if flagged:
        bits.append(f"{flagged} need statute review")
    if contested:
        bits.append(f"{contested} contested — CPA review")
    if approaching:
        bits.append(f"{approaching} approaching threshold")
    return "🗺️ Sales-tax registration: " + " · ".join(bits)
