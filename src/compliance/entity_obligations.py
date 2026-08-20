"""Entity, foreign-qualification and excise obligations — not sales tax.

These are the filings a business owes because of what the ENTITY is and where
it is qualified, not because it collected tax from a buyer: Maryland's annual
report, Oklahoma's foreign-LLC annual certificate, California's $800 LLC tax,
Hawaii's G-49 annual GET return. They are kept in their own table and their own
UI section so an entity fee can never render as an overdue sales-tax remittance.

Two hard rules, both about not overstating what is known:

1. **Due dates are computed from a rule, never stored as a guess.** A rule that
   needs a date the profile does not have (Oklahoma's anniversary needs the
   qualification date) produces an obligation with `due_date = None` and a note
   saying what is missing. It does not produce an invented date.

2. **A contested legal position is never auto-scheduled.** Whether FBA
   inventory makes an LLC "doing business" in California is a real dispute.
   Rules whose `applies_when` is `user_confirmed` surface as review items until
   the user turns them on in the profile. What gets scheduled automatically is
   limited to obligations that follow from facts the user has stated: this is
   my home state, I am foreign-qualified here, I am registered here.

Nothing in this module decides what is legally owed. It reports what the
recorded profile plus a sourced rule imply, with a confidence tag attached.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

log = logging.getLogger(__name__)

CONFIG_DIR = Path(__file__).resolve().parents[2] / "config"
PROFILE_PATH = CONFIG_DIR / "entity_profile.json"
RULES_PATH = CONFIG_DIR / "seed_entity_obligations.json"

# Obligation buckets. Deliberately disjoint from the sales-tax calendar: a row
# here is never a "sales tax return", and `sales_tax_return` is not a value any
# rule may use.
OBLIGATION_TYPES = (
    "entity_annual",      # secretary-of-state annual report / annual fee
    "franchise_tax",      # franchise / privilege / gross-receipts entity tax
    "foreign_llc_report", # foreign-qualification annual certificate
    "get_excise",         # gross-excise regimes (HI GET) beyond the periodic return
    "other_local",
)

SETTLED_STATUSES = frozenset({"filed", "not_required", "dismissed"})


# ── Config loading ──────────────────────────────────────────────

def load_profile(path: Path | None = None) -> dict:
    """Read the entity profile. Missing file is not fatal — it means unconfigured."""
    p = path or PROFILE_PATH
    try:
        with open(p) as f:
            return json.load(f)
    except FileNotFoundError:
        log.warning("No entity profile at %s — entity obligations disabled", p)
        return {}


def load_rules(path: Path | None = None) -> list[dict]:
    p = path or RULES_PATH
    try:
        with open(p) as f:
            return json.load(f).get("obligations", [])
    except FileNotFoundError:
        log.warning("No entity obligation rules at %s", p)
        return []


# ── Due-date computation ────────────────────────────────────────

def _safe_date(year: int, month: int, day: int) -> date:
    import calendar
    return date(year, month, min(day, calendar.monthrange(year, month)[1]))


@dataclass
class DueDateResult:
    due_date: date | None
    note: str = ""


def compute_due_date(rule: dict, year: int, profile: dict,
                     state_entry: dict | None = None) -> DueDateResult:
    """Apply a due_rule for a given year.

    Returns `due_date=None` plus a note when the profile is missing the date an
    anniversary rule anchors on. A missing input yields a visible gap, never a
    fabricated deadline.
    """
    due = rule.get("due_rule") or {}
    kind = due.get("kind")

    if kind == "fixed_month_day":
        return DueDateResult(_safe_date(year, int(due["month"]), int(due["day"])))

    if kind == "months_after_year_end":
        # `year` is the TAX year the obligation covers, so the due date lands
        # after that year closes. For a calendar-year filer, Hawaii's G-49 for
        # tax year 2026 is due 2027-04-20 — not 2026-04-20, which would be the
        # reconciliation for the year before.
        fye = str(profile.get("fiscal_year_end") or "12-31")
        try:
            fye_month, fye_day = (int(x) for x in fye.split("-"))
        except ValueError:
            fye_month = 12
        months = int(due.get("months", 4))
        day = int(due.get("day", 15))
        month = fye_month + months
        target_year = year
        while month > 12:
            month -= 12
            target_year += 1
        return DueDateResult(_safe_date(target_year, month, day))

    if kind == "anniversary":
        anchor_field = due.get("anchor", "formation_date")
        anchor = (state_entry or {}).get(anchor_field) or profile.get(anchor_field)
        # An explicit fixed date on the profile entry wins over the anniversary.
        override = (state_entry or {}).get("annual_due_month_day")
        if override:
            try:
                m, d = (int(x) for x in str(override).split("-"))
                return DueDateResult(_safe_date(year, m, d))
            except ValueError:
                pass
        if not anchor:
            return DueDateResult(
                None,
                f"needs {anchor_field} in the profile — anniversary date unknown, "
                f"so no due date is shown rather than a guessed one",
            )
        try:
            a = date.fromisoformat(str(anchor))
        except ValueError:
            return DueDateResult(None, f"{anchor_field} is not a valid date: {anchor!r}")
        return DueDateResult(_safe_date(year, a.month, a.day))

    return DueDateResult(None, f"unrecognised due_rule kind: {kind!r}")


# ── Applicability ───────────────────────────────────────────────

@dataclass
class Applicability:
    applies: bool
    scheduled: bool          # True → a dated obligation; False → review only
    basis: str               # why it applies (or why it does not)


def _foreign_entry(profile: dict, state: str) -> dict | None:
    for e in profile.get("foreign_qualified") or []:
        if str(e.get("state", "")).upper() == state:
            return e
    return None


def evaluate_applicability(rule: dict, profile: dict,
                           registered_states: set[str]) -> Applicability:
    """Decide whether a rule applies, and whether it may be scheduled.

    `enabled_obligations` overrides win in both directions: an explicit false
    suppresses an obligation the rules would schedule, and an explicit true is
    the only way a `user_confirmed` rule becomes a dated obligation.
    """
    state = rule.get("state_code", "")
    otype = rule.get("obligation_type", "")
    key = f"{state}:{otype}"
    override = (profile.get("enabled_obligations") or {}).get(key)

    if override is False:
        return Applicability(False, False, f"disabled in profile ({key})")
    if override is True:
        return Applicability(True, True, f"explicitly enabled in profile ({key})")

    conditions = [rule.get("applies_when"), rule.get("also_applies_when")]
    home = str(profile.get("home_state") or "").upper()

    for cond in conditions:
        if cond == "home_state" and state == home:
            return Applicability(True, True, f"{state} is the home state")
        if cond == "foreign_qualified" and _foreign_entry(profile, state):
            return Applicability(True, True, f"foreign-qualified in {state}")
        if cond == "sales_tax_registered" and state in registered_states:
            return Applicability(True, True, f"registered to collect in {state}")

    if "user_confirmed" in conditions:
        # The contested cases. Surfaced for review, never scheduled, until the
        # user records a decision in enabled_obligations.
        return Applicability(
            True, False,
            f"needs confirmation — set enabled_obligations['{key}'] = true "
            f"once a CPA confirms it applies",
        )

    return Applicability(False, False,
                         f"profile does not place the entity in {state}")


# ── Building obligations ────────────────────────────────────────

@dataclass
class Obligation:
    state_code: str
    obligation_type: str
    form_code: str
    title: str
    frequency: str
    period_label: str
    due_date: date | None
    due_rule_text: str
    status: str
    confidence: str
    source_authority: str
    source_citation: str
    source_url: str
    amount_estimate: float | None
    notes: str
    basis: str
    scheduled: bool
    last_reviewed: str
    due_note: str = ""
    days_until_due: int | None = None
    days_overdue: int | None = None

    def key(self) -> tuple[str, str, str]:
        return (self.state_code, self.obligation_type, self.period_label)


def build_obligations(profile: dict, rules: list[dict],
                      registered_states: set[str], years: list[int],
                      today: date) -> tuple[list[Obligation], list[dict]]:
    """Return (scheduled obligations, review items).

    Review items are rules that apply to the entity's situation but turn on a
    legal position the user has not confirmed. They carry the rule's reasoning
    and source so the user can take them to a CPA — they never get a due date.
    """
    scheduled: list[Obligation] = []
    review: list[dict] = []

    for rule in rules:
        state = rule.get("state_code", "")
        app = evaluate_applicability(rule, profile, registered_states)
        if not app.applies:
            continue

        src = rule.get("source") or {}
        if not app.scheduled:
            review.append({
                "state_code": state,
                "obligation_type": rule.get("obligation_type"),
                "form_code": rule.get("form_code"),
                "title": rule.get("title"),
                "confidence": rule.get("confidence"),
                "confidence_note": rule.get("confidence_note"),
                "amount_estimate": rule.get("amount_estimate"),
                "reason": app.basis,
                "source_authority": src.get("authority"),
                "source_citation": src.get("citation"),
                "source_url": src.get("url"),
                "notes": rule.get("notes"),
            })
            continue

        entry = _foreign_entry(profile, state)
        for year in years:
            res = compute_due_date(rule, year, profile, entry)
            ob = Obligation(
                state_code=state,
                obligation_type=rule.get("obligation_type", "other_local"),
                form_code=rule.get("form_code", ""),
                title=rule.get("title", ""),
                frequency=rule.get("frequency", "annual"),
                period_label=str(year),
                due_date=res.due_date,
                due_rule_text=rule.get("due_rule_text", ""),
                status="open",
                confidence=rule.get("confidence", "low"),
                source_authority=src.get("authority", ""),
                source_citation=src.get("citation", ""),
                source_url=src.get("url", ""),
                amount_estimate=rule.get("amount_estimate"),
                notes=rule.get("notes", ""),
                basis=app.basis,
                scheduled=True,
                last_reviewed=rule.get("last_reviewed", ""),
                due_note=res.note,
            )
            if ob.due_date:
                delta = (ob.due_date - today).days
                if delta < 0:
                    ob.days_overdue = -delta
                else:
                    ob.days_until_due = delta
            scheduled.append(ob)

    scheduled.sort(key=lambda o: (o.due_date or date.max, o.state_code))
    review.sort(key=lambda r: str(r.get("state_code")))
    return scheduled, review


def classify_obligations(obligations: list[Obligation], stored: list[dict],
                         today: date) -> dict:
    """Merge computed obligations with stored per-period status.

    Stored status always wins: once the user marks a period filed, not_required
    or dismissed, recomputing the calendar must not reopen it.
    """
    by_key = {
        (r.get("state_code"), r.get("obligation_type"), r.get("period_label")): r
        for r in stored
    }

    overdue: list[Obligation] = []
    upcoming: list[Obligation] = []
    settled: list[Obligation] = []
    undated: list[Obligation] = []

    for ob in obligations:
        row = by_key.get(ob.key())
        if row and str(row.get("status") or "") in SETTLED_STATUSES:
            ob.status = str(row.get("status"))
            settled.append(ob)
            continue
        if ob.due_date is None:
            undated.append(ob)
        elif ob.days_overdue is not None:
            overdue.append(ob)
        else:
            upcoming.append(ob)

    return {"overdue": overdue, "upcoming": upcoming,
            "settled": settled, "undated": undated}


# ── Persistence ─────────────────────────────────────────────────
#
# The rules stay the source of truth for WHAT is owed and WHEN; the table
# stores the user's decision about each period. So a sync writes rows for
# obligations that do not exist yet, refreshes the computed fields on rows the
# user has not settled, and never touches a settled row's status.

TABLE = "compliance_obligations"


def _table_missing(e: Exception) -> bool:
    msg = str(e)
    return TABLE in msg and ("schema cache" in msg or "does not exist" in msg)


def fetch_stored() -> list[dict]:
    """Stored obligation rows, or [] if the migration has not been run."""
    from src.db import get_client
    try:
        return (get_client().table(TABLE).select("*").execute().data) or []
    except Exception as e:
        if _table_missing(e):
            log.info("%s missing — run supabase/migration_entity_obligations.sql "
                     "to persist entity obligations", TABLE)
            return []
        raise


def sync_obligations(obligations: list[Obligation], dry_run: bool = False) -> dict:
    """Upsert computed obligations, preserving any status the user set."""
    from src.db import get_client, upsert_rows

    stored = fetch_stored()
    by_key = {
        (r.get("state_code"), r.get("obligation_type"), r.get("period_label")): r
        for r in stored
    }

    rows, preserved = [], 0
    for ob in obligations:
        existing = by_key.get(ob.key())
        if existing and str(existing.get("status") or "") in SETTLED_STATUSES:
            # The user has decided this period. Recomputing must not reopen it,
            # and must not overwrite the note explaining why it was closed.
            preserved += 1
            continue
        rows.append({
            "state_code": ob.state_code,
            "obligation_type": ob.obligation_type,
            "form_code": ob.form_code,
            "title": ob.title,
            "frequency": ob.frequency,
            "period_label": ob.period_label,
            "due_date": ob.due_date.isoformat() if ob.due_date else None,
            "due_rule_text": ob.due_rule_text,
            "status": existing.get("status") if existing else "open",
            "confidence": ob.confidence,
            "source_authority": ob.source_authority,
            "source_citation": ob.source_citation,
            "source_url": ob.source_url,
            "amount_estimate": ob.amount_estimate,
            "notes": ob.notes,
            "last_reviewed": ob.last_reviewed or None,
        })

    if dry_run or not rows:
        return {"dry_run": dry_run, "written": 0, "would_write": len(rows),
                "settled_preserved": preserved}

    try:
        written = upsert_rows(
            TABLE, rows,
            on_conflict="state_code,obligation_type,period_label")
    except Exception as e:
        if _table_missing(e):
            return {"dry_run": False, "written": 0, "would_write": len(rows),
                    "settled_preserved": preserved,
                    "skipped": "table missing: run migration_entity_obligations.sql"}
        raise
    return {"dry_run": False, "written": written, "would_write": len(rows),
            "settled_preserved": preserved}


def mark_obligation(state_code: str, obligation_type: str, period_label: str,
                    status: str, notes: str | None = None) -> dict | None:
    """Record the user's decision on one obligation period."""
    from datetime import date as _date
    from src.db import get_client, log_audit

    if status not in SETTLED_STATUSES and status != "open":
        raise ValueError(f"status must be open or one of {sorted(SETTLED_STATUSES)}")

    updates = {"status": status, "user_notes": notes}
    if status == "filed":
        updates["filed_date"] = _date.today().isoformat()

    try:
        resp = (get_client().table(TABLE).update(updates)
                .eq("state_code", state_code)
                .eq("obligation_type", obligation_type)
                .eq("period_label", period_label)
                .execute())
    except Exception as e:
        if _table_missing(e):
            raise RuntimeError(
                "compliance_obligations table missing — run "
                "supabase/migration_entity_obligations.sql first") from e
        raise

    rows = resp.data or []
    if rows:
        log_audit(action="mark_entity_obligation", category="compliance",
                  details={"obligation_type": obligation_type,
                           "period_label": period_label, "status": status},
                  state_code=state_code)
    return rows[0] if rows else None


def current_view(today: date | None = None, years: list[int] | None = None) -> dict:
    """Everything the CLI, digest and dashboard need, computed once."""
    from src.db import fetch_all

    ref = today or date.today()
    yrs = years or [ref.year, ref.year + 1]
    profile = load_profile()
    rules = load_rules()
    registered = {n["state_code"] for n in fetch_all("nexus_status")
                  if n.get("is_registered") is True}

    scheduled, review = build_obligations(profile, rules, registered, yrs, ref)
    buckets = classify_obligations(scheduled, fetch_stored(), ref)
    return {"profile": profile, "review": review, **buckets}


def find_calendar_overlap(obligations: list[Obligation],
                          filing_rows: list[dict]) -> list[dict]:
    """Periods represented in BOTH filing_calendar and the entity obligations.

    Hawaii is the live case: the G-49 annual GET return is a named entity-level
    obligation here, and the sales-tax calendar also carries an `annual` row for
    the same year. Both are the same real filing, so one of them has to go —
    but which one is the user's call, not this module's. Report the overlap and
    let them settle it with `filing-mark`; deleting rows on a guess would be
    worse than a visible duplicate.
    """
    entity_years = {
        (o.state_code, o.period_label) for o in obligations
        if o.frequency == "annual"
    }
    out = []
    for f in filing_rows:
        if str(f.get("status") or "") in ("filed", "not_required"):
            continue
        if f.get("period_type") != "annual":
            continue
        key = (f.get("state_code"), str(f.get("period_label")))
        if key in entity_years:
            match = next(o for o in obligations if (o.state_code, o.period_label) == key)
            out.append({
                "state_code": f.get("state_code"),
                "period_label": f.get("period_label"),
                "calendar_due": str(f.get("due_date")),
                "entity_form": match.form_code,
                "entity_due": match.due_date.isoformat() if match.due_date else None,
            })
    return out
