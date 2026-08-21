"""Horizon and scope filtering for entity obligations.

Pure functions, mirrored in dashboard/src/lib/entity-filters.ts so the CLI and
the page cannot disagree about what "next 12 months" means.

Two independent filters:

**Horizon** — how far ahead to look. A 2028 obligation is real and worth
generating for planning, but it is not something to act on today, and letting
it sit in the same list as a live deadline is what makes the list stop being
read. Overdue items are ALWAYS included regardless of horizon: something you
have already missed does not become less relevant with age.

**Scope** — which states to show. Sales-tax registration and entity
qualification are different things (registering to collect tax in a state does
not create an annual-report obligation there), so scope is about which set of
states the user wants to look at, not about what is owed.
"""
from __future__ import annotations

from datetime import date, timedelta

# 12 months. Long enough that an annual filing always appears well before it is
# due; short enough that next year's copy of the same filing stays out of the
# way until it is worth thinking about.
DEFAULT_HORIZON_DAYS = 365

HORIZONS: dict[str, int | None] = {
    "12m": 365,
    "24m": 730,
    "all": None,   # no upper bound
}

SCOPES = ("all", "registered", "home_foreign")


def horizon_days(key: str | None) -> int | None:
    """Days for a horizon key. Unknown keys fall back to the default."""
    if key is None:
        return DEFAULT_HORIZON_DAYS
    if key in HORIZONS:
        return HORIZONS[key]
    return DEFAULT_HORIZON_DAYS


def scope_states(scope: str, registered: set[str], home_state: str | None,
                 foreign_states: set[str]) -> set[str] | None:
    """States a scope admits, or None for "no restriction".

    `registered` deliberately UNIONS home + foreign-qualified rather than
    replacing them. The user's home state and the states they are actually
    qualified in are where their non-negotiable entity filings live; hiding
    Maryland because it is not in the sales-tax registration list would drop a
    real obligation from view to satisfy a filter label. The union is the
    documented behaviour, not an accident.
    """
    base = set(foreign_states)
    if home_state:
        base.add(home_state)

    if scope == "registered":
        return registered | base
    if scope == "home_foreign":
        return base
    return None  # "all"


def within_horizon(due: date | None, today: date, days: int | None) -> bool:
    """Is this due date inside the horizon?

    An obligation with no due date (its rule needs a profile date the user has
    not supplied) is never filtered out by horizon — it is a gap to fill, not a
    deadline to schedule, and hiding it would bury the thing that needs doing.
    """
    if due is None:
        return True
    if days is None:
        return True
    if due < today:
        return True            # overdue is always in scope
    return (due - today).days <= days


def filter_view(view: dict, today: date, horizon: str | None = None,
                scope: str = "all", registered: set[str] | None = None,
                home_state: str | None = None,
                foreign_states: set[str] | None = None) -> dict:
    """Apply horizon + scope to a `current_view()` result.

    Returns the same bucket shape plus `counts` and `hidden_by_horizon`, so the
    UI can say how many rows the filter is holding back instead of silently
    shrinking the list.
    """
    days = horizon_days(horizon)
    allowed = scope_states(scope, registered or set(), home_state,
                           foreign_states or set())

    def keep_scope(state: str) -> bool:
        return allowed is None or state in allowed

    overdue = [o for o in view.get("overdue", []) if keep_scope(o.state_code)]
    settled = [o for o in view.get("settled", []) if keep_scope(o.state_code)]
    undated = [o for o in view.get("undated", []) if keep_scope(o.state_code)]

    upcoming_in_scope = [o for o in view.get("upcoming", []) if keep_scope(o.state_code)]
    upcoming = [o for o in upcoming_in_scope
                if within_horizon(o.due_date, today, days)]
    hidden = len(upcoming_in_scope) - len(upcoming)

    review = [r for r in view.get("review", [])
              if keep_scope(r.get("state_code", ""))]

    return {
        "overdue": overdue,
        "upcoming": upcoming,
        "undated": undated,
        "settled": settled,
        "review": review,
        "hidden_by_horizon": hidden,
        "horizon": horizon or "12m",
        "horizon_days": days,
        "scope": scope,
        "counts": {
            "overdue": len(overdue),
            "upcoming": len(upcoming),
            "undated": len(undated),
            "settled": len(settled),
            "review": len(review),
        },
    }
