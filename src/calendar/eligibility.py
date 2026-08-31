"""Which filing_calendar rows are real obligations.

One place decides what "open", "overdue" and "upcoming" mean, so the dashboard
chips, the Telegram digest and the CLI cannot disagree. Everything here is a
pure function over rows already fetched — no DB, no clock of its own.

The rules are about DATA STATUS, not tax law. A period is surfaced only when
the user's own recorded state says an obligation exists: they registered in
that state, the period falls after that registration, they have not already
filed through it, and they have not marked it settled. Nexus alone never
produces a filing chip — it produces a "register / review" action, which is a
different question with a different answer.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

# Statuses that mean "this period needs nothing further from the user".
# `not_required` is the terminal state for both "genuinely not owed" and
# "dismissed false positive" — the filing_calendar CHECK constraint allows
# pending/filed/late/not_required only, so the distinction is recorded in
# filed_notes rather than invented as a status the database would reject.
SETTLED_STATUSES = frozenset({"filed", "not_required"})

# Statuses that still represent an open obligation. `late` is written by
# mark_overdue_filings onto pending rows whose due_date has passed; it is
# treated as open, not as a separate kind of thing.
OPEN_STATUSES = frozenset({"pending", "late"})

# Statuses the nightly calendar rebuild must never overwrite back to pending.
# `late` is still an open obligation — it is listed here only so populate
# cannot silently reopen an overdue row as pending.
PRESERVED_STATUSES = SETTLED_STATUSES | {"late"}

# Recurring within-year cadences. Two different ones covering the same months
# are a duplicate; `annual` is deliberately excluded because a yearly
# reconciliation return legitimately coexists with a periodic cadence.
PERIODIC_TYPES = frozenset({"monthly", "quarterly", "semi_annual"})


@dataclass(frozen=True)
class Ineligible:
    """Why a calendar row is not a live obligation."""
    reason: str
    detail: str


def _as_iso(value) -> str:
    """Dates arrive as `date` from Python and as ISO strings from PostgREST."""
    if value is None:
        return ""
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def obligation_status(filing: dict, nexus: dict | None) -> Ineligible | None:
    """None if this row is a live obligation, else why it is not.

    `nexus` is the nexus_status row for the same state, or None if the state
    has no nexus record at all.
    """
    state = filing.get("state_code", "?")
    status = str(filing.get("status") or "pending")

    if status in SETTLED_STATUSES:
        return Ineligible("settled", f"status={status}")

    # ── Registration gate ───────────────────────────────────────
    # Sales-tax returns are owed because the user registered to collect, not
    # because they crossed a threshold. An unregistered state with nexus needs
    # a decision ("should I register?"), and presenting that as an overdue
    # return both misstates the situation and buries the actual next step.
    if nexus is None:
        return Ineligible("not_registered", "no nexus_status row for this state")
    if nexus.get("is_registered") is not True:
        return Ineligible("not_registered", "is_registered is not true")

    period_end = _as_iso(filing.get("period_end")) or _as_iso(filing.get("due_date"))

    # ── Pre-registration periods ────────────────────────────────
    # A period that closed before the user registered was never theirs to file.
    reg_date = _as_iso(nexus.get("registration_date"))
    if reg_date and period_end and period_end < reg_date:
        return Ineligible("pre_registration",
                          f"period ended {period_end}, registered {reg_date}")

    # ── Already filed through ───────────────────────────────────
    # nexus_status.last_filed_through is the user's own high-water mark. The
    # Python deadline query has always honoured it; the dashboard did not,
    # which is why filed periods still rendered as OVERDUE chips.
    filed_through = _as_iso(nexus.get("last_filed_through"))
    if filed_through and period_end and period_end <= filed_through:
        return Ineligible("filed_through",
                          f"period ended {period_end}, filed through {filed_through}")

    # ── Superseded cadence ──────────────────────────────────────
    # The calendar upserts on (state, period_type, period_label), so changing a
    # state's frequency leaves the old cadence's rows behind forever. The state
    # then carries two overlapping sets covering the same months, and filing
    # one leaves the other looking unfiled. Only the current cadence is live.
    #
    # This applies ONLY between two periodic cadences. An `annual` row
    # alongside a periodic cadence is NOT a leftover — several states require a
    # yearly reconciliation on top of periodic returns (Hawaii's G-49 annual
    # GET return sits on top of the G-45 periodics exactly this way). Excluding
    # a real annual return is a worse failure than showing one extra row, so
    # annual is never treated as superseded.
    freq = nexus.get("assigned_frequency")
    period_type = filing.get("period_type")
    if (freq and period_type and period_type != freq
            and period_type in PERIODIC_TYPES and freq in PERIODIC_TYPES):
        return Ineligible("superseded_frequency",
                          f"period_type={period_type}, state files {freq}")
    # Casual has no periodic calendar. Leftover monthly/quarterly/semi_annual
    # rows after a frequency change are not live obligations.
    if freq == "casual" and period_type in PERIODIC_TYPES:
        return Ineligible("superseded_frequency",
                          f"period_type={period_type}, state files casual")

    return None


def is_open_obligation(filing: dict, nexus: dict | None) -> bool:
    """True if this row is a real, unsettled filing obligation."""
    return obligation_status(filing, nexus) is None


def classify_filings(filings: list[dict], nexus_rows: list[dict],
                     today: date) -> dict:
    """Split calendar rows into overdue / upcoming / excluded.

    Returns dicts, not just counts, so callers can render the same set the
    audit explains. `excluded` carries the reason per row, which is what makes
    a disappearing OVERDUE chip auditable instead of mysterious.
    """
    by_state = {n.get("state_code"): n for n in nexus_rows}
    today_iso = today.isoformat()

    overdue: list[dict] = []
    upcoming: list[dict] = []
    excluded: list[dict] = []

    for f in filings:
        why = obligation_status(f, by_state.get(f.get("state_code")))
        if why is not None:
            excluded.append({**f, "excluded_reason": why.reason,
                             "excluded_detail": why.detail})
            continue

        due = _as_iso(f.get("due_date"))
        if due and due < today_iso:
            overdue.append({**f, "days_overdue": (today - date.fromisoformat(due)).days})
        else:
            upcoming.append({**f, "days_until_due": (date.fromisoformat(due) - today).days
                             if due else None})

    overdue.sort(key=lambda r: _as_iso(r.get("due_date")))
    upcoming.sort(key=lambda r: _as_iso(r.get("due_date")))
    return {"overdue": overdue, "upcoming": upcoming, "excluded": excluded}
