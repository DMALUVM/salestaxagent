from __future__ import annotations

from datetime import date, timedelta

from src.db import fetch_all, upsert_rows, update_row, log_audit
from src.config import settings
from src.calendar.eligibility import (
    PRESERVED_STATUSES,
    SETTLED_STATUSES,
    _as_iso,
    classify_filings,
)
from src.rules import agent_today


def generate_filing_entries(state_code: str, frequency: str, year: int,
                            due_day: int = 20) -> list[dict]:
    entries = []

    if frequency == "monthly":
        for month in range(1, 13):
            period_start = date(year, month, 1)
            if month == 12:
                period_end = date(year, 12, 31)
                due_month = 1
                due_year = year + 1
            else:
                period_end = date(year, month + 1, 1) - timedelta(days=1)
                due_month = month + 1
                due_year = year

            due_date = _safe_date(due_year, due_month, due_day)
            label = f"{year}-{month:02d}"

            entries.append({
                "state_code": state_code,
                "period_type": "monthly",
                "period_label": label,
                "period_start": period_start,
                "period_end": period_end,
                "due_date": due_date,
                "status": "pending",
            })

    elif frequency == "quarterly":
        quarters = [
            ("Q1", 1, 3, 4),
            ("Q2", 4, 6, 7),
            ("Q3", 7, 9, 10),
            ("Q4", 10, 12, 1),
        ]
        for label_suffix, start_month, end_month, due_month_offset in quarters:
            period_start = date(year, start_month, 1)
            if end_month == 12:
                period_end = date(year, 12, 31)
            else:
                period_end = date(year, end_month + 1, 1) - timedelta(days=1)

            due_year = year + 1 if due_month_offset < start_month else year
            due_date = _safe_date(due_year, due_month_offset, due_day)
            label = f"{year}-{label_suffix}"

            entries.append({
                "state_code": state_code,
                "period_type": "quarterly",
                "period_label": label,
                "period_start": period_start,
                "period_end": period_end,
                "due_date": due_date,
                "status": "pending",
            })

    elif frequency == "semi_annual":
        halves = [
            ("H1", 1, 6, 7),   # Jan-Jun, due July
            ("H2", 7, 12, 1),  # Jul-Dec, due January next year
        ]
        for label_suffix, start_month, end_month, due_month in halves:
            period_start = date(year, start_month, 1)
            if end_month == 12:
                period_end = date(year, 12, 31)
            else:
                period_end = date(year, end_month + 1, 1) - timedelta(days=1)

            due_year = year + 1 if due_month < start_month else year
            due_date = _safe_date(due_year, due_month, due_day)
            label = f"{year}-{label_suffix}"

            entries.append({
                "state_code": state_code,
                "period_type": "semi_annual",
                "period_label": label,
                "period_start": period_start,
                "period_end": period_end,
                "due_date": due_date,
                "status": "pending",
            })

    elif frequency == "annual":
        entries.append({
            "state_code": state_code,
            "period_type": "annual",
            "period_label": str(year),
            "period_start": date(year, 1, 1),
            "period_end": date(year, 12, 31),
            "due_date": _safe_date(year + 1, 1, due_day),
            "status": "pending",
        })

    elif frequency == "casual":
        entries.append({
            "state_code": state_code,
            "period_type": "casual",
            "period_label": str(year),
            "period_start": date(year, 1, 1),
            "period_end": date(year, 12, 31),
            "due_date": _safe_date(year + 1, 1, due_day),
            "status": "pending",
        })

    return entries


def _safe_date(year: int, month: int, day: int) -> date:
    import calendar
    max_day = calendar.monthrange(year, month)[1]
    return date(year, month, min(day, max_day))


def populate_calendar_for_registered_states(year: int | None = None) -> dict:
    """Generate filing_calendar rows for all registered states.

    Creates entries for the given year.  If year is None, generates for
    both the current year and the next year so the calendar always has
    upcoming periods visible.
    """
    current_year = date.today().year
    years = [year] if year else [current_year, current_year + 1]

    nexus_records = fetch_all("nexus_status")
    registered = [r for r in nexus_records if r.get("is_registered")]

    if not registered:
        return {"message": "No registered states found.", "states_populated": [], "entries_created": 0}

    from src.config import load_state_rules
    rules_data = load_state_rules()
    state_rules = rules_data.get("states", {})

    total_created = 0
    states_populated = set()

    # Rows whose status must survive the upsert. The generated entries all
    # write status="pending", so without this a filed / not_required period
    # would reopen as an OVERDUE chip, and a late row would flip back to
    # pending the next night — the original bug that left due_date-past
    # rows looking current. Preserved periods are dropped from the write
    # entirely rather than rewritten with their existing status.
    settled_keys = {
        (r.get("state_code"), r.get("period_type"), r.get("period_label"))
        for r in fetch_all("filing_calendar")
        if str(r.get("status") or "") in PRESERVED_STATUSES
    }
    preserved = 0

    for record in registered:
        sc = record["state_code"]
        frequency = record.get("assigned_frequency")
        if not frequency:
            rule = state_rules.get(sc, {})
            frequency = rule.get("filing_frequency_default", "quarterly")

        due_day = state_rules.get(sc, {}).get("typical_due_day", 20)

        for yr in years:
            entries = generate_filing_entries(sc, frequency, yr, due_day)
            kept = [e for e in entries
                    if (e["state_code"], e["period_type"], e["period_label"])
                    not in settled_keys]
            preserved += len(entries) - len(kept)
            if kept:
                inserted = upsert_rows(
                    "filing_calendar", kept,
                    on_conflict="state_code,period_type,period_label",
                )
                total_created += inserted
                states_populated.add(sc)

    log_audit(
        action="populate_filing_calendar",
        category="calendar",
        details={"years": years, "states": sorted(states_populated),
                 "entries_created": total_created,
                 "settled_preserved": preserved},
    )

    return {
        "years": years,
        "states_populated": sorted(states_populated),
        "entries_created": total_created,
        "settled_preserved": preserved,
    }


def generate_filings_for_state(state_code: str, frequency: str, due_day: int = 20) -> int:
    """Generate filing_calendar rows for a single state (current + next year).

    Called when a state is newly registered via the dashboard.
    Uses upsert so it's safe to call repeatedly.
    """
    current_year = date.today().year
    total = 0
    for yr in [current_year, current_year + 1]:
        entries = generate_filing_entries(state_code, frequency, yr, due_day)
        if entries:
            total += upsert_rows(
                "filing_calendar", entries,
                on_conflict="state_code,period_type,period_label",
            )
    return total


def get_upcoming_deadlines(days_ahead: int | None = None) -> list[dict]:
    """Return upcoming + overdue filing deadlines for real obligations only.

    Eligibility lives in src/calendar/eligibility.py so this, the dashboard and
    the Telegram digest cannot drift apart. A period is surfaced only when the
    state is registered, the period falls after registration, it is not covered
    by last_filed_through, it matches the state's current filing frequency, and
    the user has not settled it.
    """
    if days_ahead is None:
        days_ahead = settings.alert_days_before_deadline

    today = agent_today()
    cutoff = today + timedelta(days=days_ahead)
    cutoff_iso = cutoff.isoformat()

    result = classify_filings(
        fetch_all("filing_calendar", order="due_date"),
        fetch_all("nexus_status"),
        today,
    )

    overdue = [dict(f, status="late") for f in result["overdue"]]
    upcoming = [f for f in result["upcoming"]
                if str(f.get("due_date")) <= cutoff_iso]
    return overdue + upcoming


def mark_overdue_filings(today: date | None = None, *,
                         dry_run: bool = False) -> dict:
    """Persist pending → late when due_date is before today in AGENT_TZ.

    This is the write that `_run_deadline_check` used to skip: it classified
    overdue rows in memory (and even stamped status="late" on the returned
    dicts) but never updated filing_calendar, so SQL `status='late'` stayed 0
    and reminder_sent stayed false.

    `filed` and `not_required` are never touched. Already-late rows stay late.
    `reminder_sent` is set on newly flipped rows so the existing daily
    Telegram digest can treat them as already-noted — no new alert stack.
    """
    stamp = today or agent_today()
    today_iso = stamp.isoformat()

    flipped: list[dict] = []
    already_late = 0
    skipped_settled = 0

    for row in fetch_all("filing_calendar", order="due_date"):
        status = str(row.get("status") or "pending")
        due = _as_iso(row.get("due_date"))
        past_due = bool(due and due < today_iso)

        if status in SETTLED_STATUSES:
            if past_due:
                skipped_settled += 1
            continue
        if status == "late":
            already_late += 1
            continue
        if status != "pending" or not past_due:
            continue
        flipped.append(row)

    if not dry_run:
        for row in flipped:
            filters = (
                {"id": row["id"]}
                if row.get("id")
                else {"state_code": row.get("state_code"),
                      "period_type": row.get("period_type"),
                      "period_label": row.get("period_label")}
            )
            update_row(
                "filing_calendar",
                filters,
                {"status": "late", "reminder_sent": True},
            )
        if flipped:
            log_audit(
                action="mark_overdue_filings",
                category="calendar",
                details={"today": today_iso,
                         "flipped": len(flipped),
                         "states": sorted({r.get("state_code") for r in flipped})},
                rows_affected=len(flipped),
            )

    return {
        "today": today_iso,
        "dry_run": dry_run,
        "flipped": len(flipped),
        "already_late": already_late,
        "skipped_settled": skipped_settled,
        "changes": [
            {"state_code": r.get("state_code"),
             "period_type": r.get("period_type"),
             "period_label": r.get("period_label"),
             "due_date": _as_iso(r.get("due_date")),
             "from_status": r.get("status") or "pending"}
            for r in flipped
        ],
    }


def audit_filing_calendar(today: date | None = None) -> dict:
    """Explain every calendar row: live obligation, or excluded and why.

    Read-only. This is what makes a vanished OVERDUE chip checkable rather
    than something the user has to take on faith.
    """
    return classify_filings(
        fetch_all("filing_calendar", order="due_date"),
        fetch_all("nexus_status"),
        today or agent_today(),
    )


def cleanup_filing_calendar(dry_run: bool = True, today: date | None = None) -> dict:
    """Settle calendar rows that are not real obligations.

    Open rows that fail the eligibility rules are set to `not_required` with
    the reason recorded in filed_notes, so they stop producing chips and the
    nightly rebuild does not recreate them (settled periods are preserved).

    Rows are never deleted: the row is the evidence for why a period was
    dismissed, and `not_required` is reversible where a delete is not.
    Already-settled rows are left completely alone.
    """
    result = audit_filing_calendar(today)
    stamp = (today or agent_today()).isoformat()

    changes = []
    for row in result["excluded"]:
        if row["excluded_reason"] == "settled":
            continue  # already resolved — nothing to do
        changes.append({
            "state_code": row.get("state_code"),
            "period_type": row.get("period_type"),
            "period_label": row.get("period_label"),
            "due_date": str(row.get("due_date")),
            "from_status": row.get("status"),
            "reason": row["excluded_reason"],
            "detail": row["excluded_detail"],
        })

    if not dry_run:
        for c in changes:
            update_row(
                "filing_calendar",
                {"state_code": c["state_code"],
                 "period_type": c["period_type"],
                 "period_label": c["period_label"]},
                {"status": "not_required",
                 "filed_notes": f"auto-cleanup {stamp}: {c['reason']} — {c['detail']}"},
            )
        if changes:
            log_audit(
                action="cleanup_filing_calendar",
                category="calendar",
                details={"settled": len(changes),
                         "reasons": sorted({c["reason"] for c in changes})},
            )

    return {
        "dry_run": dry_run,
        "changed": len(changes),
        "changes": changes,
        "still_overdue": len(result["overdue"]),
        "still_upcoming": len(result["upcoming"]),
    }


def mark_filing_not_required(state_code: str, period_label: str,
                             reason: str | None = None) -> dict | None:
    """Mark a period as not owed — a genuine exemption or a false positive.

    The filing_calendar CHECK constraint allows pending/filed/late/not_required
    only, so both cases land on `not_required` and the user's stated reason is
    kept in filed_notes rather than invented as a status the DB would reject.
    """
    note = reason or "marked not required by user"
    result = update_row(
        "filing_calendar",
        {"state_code": state_code, "period_label": period_label},
        {"status": "not_required", "filed_notes": note},
    )
    if result:
        log_audit(
            action="mark_filing_not_required",
            category="calendar",
            details={"period_label": period_label, "reason": note},
            state_code=state_code,
        )
    return result


def mark_filing_complete(state_code: str, period_label: str,
                         amount: float | None = None, notes: str | None = None,
                         is_zero_return: bool = False) -> dict | None:
    updates = {
        "status": "filed",
        "filed_date": date.today(),
        "is_zero_return": is_zero_return,
    }
    if amount is not None:
        updates["filed_amount"] = amount
    if notes:
        updates["filed_notes"] = notes

    result = update_row(
        "filing_calendar",
        {"state_code": state_code, "period_label": period_label},
        updates,
    )

    if result:
        log_audit(
            action="mark_filing_complete",
            category="calendar",
            details={
                "period_label": period_label,
                "amount": amount,
                "is_zero_return": is_zero_return,
            },
            state_code=state_code,
        )

    return result
