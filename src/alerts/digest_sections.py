"""Registration-aware digest sections.

Pure functions: nexus rows + calendar rows + franchise flags → the sections a
Telegram digest renders. No DB, no clock, no network, so the whole thing is
testable and the dashboard, CLI and Telegram can be checked against each other.

The point is to say only what the user's own data supports. Nexus is not an
obligation to file; registration is. A state the user already registered in
does not need a "go register" nudge, and a period covered by their own
last_filed_through is not overdue. Nothing here decides what is owed under any
state's law — it reports what the recorded data says and what decision, if
any, is still outstanding.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from src.calendar.eligibility import classify_filings


def _has_nexus(n: dict) -> bool:
    return bool(n.get("has_physical_nexus") or n.get("has_economic_nexus"))


def _is_registered(n: dict) -> bool:
    # PostgREST returns real booleans, but older rows and CSV imports have been
    # seen carrying "true"/1, so accept those rather than silently treating a
    # registered state as unregistered and nagging the user to register again.
    v = n.get("is_registered")
    return v is True or v == "true" or v == 1


def _dismissed(n: dict) -> bool:
    """The user already made a call on this state."""
    return bool(n.get("compliance_resolved") or n.get("compliance_hidden"))


@dataclass
class DigestSections:
    """Everything a digest needs, already filtered and counted."""
    # Nexus, split by whether a decision is still outstanding
    registered_nexus: list[str] = field(default_factory=list)
    unregistered_nexus_open: list[str] = field(default_factory=list)
    unregistered_nexus_dismissed: list[str] = field(default_factory=list)

    # Economic threshold, split by registration
    econ_exceeded_registered: list[str] = field(default_factory=list)
    econ_exceeded_unregistered: list[str] = field(default_factory=list)
    econ_approaching_unregistered: list[str] = field(default_factory=list)
    econ_approaching_registered: list[str] = field(default_factory=list)

    # Filings — registered states with real open periods only
    overdue: list[dict] = field(default_factory=list)
    upcoming: list[dict] = field(default_factory=list)

    critical_flags: list[dict] = field(default_factory=list)
    warning_flag_count: int = 0

    # Entity / franchise / foreign-qualification obligations. A separate bucket
    # from `overdue`/`upcoming` above, which are sales-tax returns only — an
    # entity fee must never render as an overdue sales-tax remittance.
    entity_overdue: list = field(default_factory=list)
    entity_upcoming: list = field(default_factory=list)
    entity_needs_profile: list = field(default_factory=list)

    @property
    def action_needed_states(self) -> list[str]:  # noqa: D401
        """States where a human decision is genuinely outstanding.

        Three kinds, and nothing else:
          - nexus but not registered, and the user has not resolved/hidden it
          - registered with a real overdue return
          - a critical franchise/entity flag

        Deliberately NOT counted: registered states that merely have nexus or
        crossed an economic threshold. They are already handled — the standing
        answer is "keep filing on schedule" — and counting them is what turned
        this line into a 20-state number the user learned to ignore.
        """
        states = set(self.unregistered_nexus_open)
        states.update(f.get("state_code") for f in self.overdue if f.get("state_code"))
        states.update(f.get("state_code") for f in self.critical_flags if f.get("state_code"))
        # A missed entity filing is a real, dated obligation the user accepted
        # by being registered or qualified there, so it counts too.
        states.update(o.state_code for o in self.entity_overdue if o.state_code)
        return sorted(s for s in states if s)


def build_sections(nexus_rows: list[dict], filing_rows: list[dict],
                   franchise_flags: list[dict], today: date,
                   econ_approaching: list[str] | None = None,
                   upcoming_within_days: int = 45,
                   entity_view: dict | None = None) -> DigestSections:
    """Assemble the digest sections from raw table rows."""
    s = DigestSections()
    approaching = set(econ_approaching or [])

    for n in nexus_rows:
        sc = n.get("state_code")
        if not sc:
            continue
        registered = _is_registered(n)

        if _has_nexus(n):
            if registered:
                s.registered_nexus.append(sc)
            elif _dismissed(n):
                s.unregistered_nexus_dismissed.append(sc)
            else:
                s.unregistered_nexus_open.append(sc)

        if n.get("has_economic_nexus"):
            (s.econ_exceeded_registered if registered
             else s.econ_exceeded_unregistered).append(sc)

        if sc in approaching:
            (s.econ_approaching_registered if registered
             else s.econ_approaching_unregistered).append(sc)

    for lst in (s.registered_nexus, s.unregistered_nexus_open,
                s.unregistered_nexus_dismissed, s.econ_exceeded_registered,
                s.econ_exceeded_unregistered, s.econ_approaching_registered,
                s.econ_approaching_unregistered):
        lst.sort()

    # Filings use the same eligibility rules as the dashboard chips and the
    # CLI audit, so the three can never disagree about what is overdue.
    cls = classify_filings(filing_rows, nexus_rows, today)
    s.overdue = cls["overdue"]
    s.upcoming = [f for f in cls["upcoming"]
                  if (f.get("days_until_due") or 0) <= upcoming_within_days]

    # Entity obligations, computed by src/compliance/entity_obligations.py.
    # Passed in rather than fetched so this stays a pure function.
    if entity_view:
        s.entity_overdue = list(entity_view.get("overdue") or [])
        s.entity_upcoming = [o for o in (entity_view.get("upcoming") or [])
                             if (o.days_until_due or 0) <= upcoming_within_days]
        s.entity_needs_profile = list(entity_view.get("undated") or [])

    open_flags = [f for f in franchise_flags if f.get("status") == "open"]
    s.critical_flags = [f for f in open_flags if f.get("severity") == "critical"]
    s.warning_flag_count = sum(1 for f in open_flags if f.get("severity") == "warning")

    return s


def _state_list(states: list[str], limit: int = 8) -> str:
    """Render a state list compactly — never a wall of codes."""
    if len(states) <= limit:
        return ", ".join(states)
    return f"{', '.join(states[:limit])} +{len(states) - limit} more"


def render_sections(s: DigestSections, today: date) -> list[str]:
    """Render the sections as Telegram HTML lines.

    Every line either states a fact from the data or names a decision the user
    still has to make. Sections with nothing to say are omitted entirely —
    silence is the correct output for a quiet day.
    """
    parts: list[str] = []

    # ── Filings: registered states with real open periods only ──
    if s.overdue:
        parts.append("")
        parts.append("<b>🚨 Overdue sales-tax filings:</b>")
        for f in s.overdue[:5]:
            parts.append(f"  {f.get('state_code')} {f.get('period_label')} — "
                         f"due {f.get('due_date')} ({f.get('days_overdue')}d late)")
        if len(s.overdue) > 5:
            parts.append(f"  +{len(s.overdue) - 5} more")

    if s.upcoming:
        nxt = " · ".join(
            f"{f.get('state_code')} {f.get('period_label')} ({f.get('days_until_due')}d)"
            for f in s.upcoming[:3]
        )
        parts.append(f"📅 Sales tax next due: {nxt}")

    # ── Entity & other filings — explicitly NOT sales tax ──
    if s.entity_overdue or s.entity_upcoming or s.entity_needs_profile:
        parts.append("")
        parts.append("<b>🏢 Entity &amp; other filings</b> <i>(not sales tax)</i>")
        for o in s.entity_overdue[:4]:
            parts.append(f"  ⚠️ {o.state_code} {o.form_code} {o.period_label} — "
                         f"due {o.due_date} ({o.days_overdue}d late) [{o.confidence}]")
        for o in s.entity_upcoming[:4]:
            parts.append(f"  {o.state_code} {o.form_code} {o.period_label} — "
                         f"due {o.due_date} ({o.days_until_due}d) [{o.confidence}]")
        if s.entity_needs_profile:
            # One line per distinct obligation, not per year — the same missing
            # profile date blocks every year at once.
            distinct = sorted({f"{o.state_code} {o.form_code}"
                               for o in s.entity_needs_profile})
            parts.append(f"  <i>needs a date in entity_profile.json before it can "
                         f"be scheduled: {', '.join(distinct[:3])}</i>")

    # ── Registration decisions still outstanding ──
    if s.unregistered_nexus_open:
        parts.append(
            f"📋 Nexus, not registered: {len(s.unregistered_nexus_open)} — "
            f"{_state_list(s.unregistered_nexus_open)}")
        if s.econ_exceeded_unregistered:
            parts.append(
                f"   ↳ economic threshold crossed: "
                f"{_state_list(s.econ_exceeded_unregistered)} — review registration")

    # ── Registered states: monitoring, not a call to register ──
    if s.registered_nexus:
        line = f"✅ Registered with nexus: {len(s.registered_nexus)}"
        if s.econ_exceeded_registered:
            line += (f" ({len(s.econ_exceeded_registered)} over economic threshold — "
                     f"filing on schedule)")
        parts.append(line)

    if s.econ_approaching_unregistered:
        parts.append(f"📈 Approaching threshold, not registered: "
                     f"{_state_list(s.econ_approaching_unregistered)}")

    # ── Entity/franchise obligations, kept separate from sales tax ──
    if s.critical_flags:
        for f in s.critical_flags[:3]:
            parts.append(f"🏛️ {f.get('state_code')}: {(f.get('flag_type') or 'entity tax')}"
                         f" — {(f.get('recommended_action') or 'review with CPA')[:70]}")
        if len(s.critical_flags) > 3:
            parts.append(f"🏛️ +{len(s.critical_flags) - 3} more critical flags")
    if s.warning_flag_count:
        parts.append(f"⚠️ {s.warning_flag_count} warning flag(s) — see dashboard")

    # ── The one number worth reading ──
    an = s.action_needed_states
    if an:
        parts.append("")
        parts.append(f"⚡ <b>Action needed: {len(an)}</b> — {_state_list(an)}")
    else:
        parts.append("")
        parts.append("✅ <b>No outstanding actions.</b>")

    if s.unregistered_nexus_dismissed:
        parts.append(f"<i>({len(s.unregistered_nexus_dismissed)} state(s) "
                     f"previously reviewed and dismissed — not counted)</i>")

    return parts
