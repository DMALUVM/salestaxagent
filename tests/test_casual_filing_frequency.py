"""Casual filing frequency: first-class assigned value, no periodic calendar."""
from src.calendar.eligibility import obligation_status
from src.calendar.filing_calendar import generate_filing_entries


def test_generate_casual_inserts_zero_periodic_rows():
    rows = generate_filing_entries("UT", "casual", 2026, due_day=20)
    assert rows == []


def test_generate_unknown_frequency_is_also_noop():
    assert generate_filing_entries("UT", "not_a_real_freq", 2026) == []


def test_generate_quarterly_unchanged():
    rows = generate_filing_entries("UT", "quarterly", 2026, due_day=20)
    assert len(rows) == 4
    assert all(r["period_type"] == "quarterly" for r in rows)


def test_casual_supersedes_leftover_monthly_periods():
    why = obligation_status(
        {
            "state_code": "UT",
            "period_type": "monthly",
            "period_label": "2026-08",
            "period_end": "2026-08-31",
            "due_date": "2026-09-20",
            "status": "pending",
        },
        {
            "state_code": "UT",
            "is_registered": True,
            "assigned_frequency": "casual",
        },
    )
    assert why is not None
    assert why.reason == "superseded_frequency"


def test_compute_next_due_skips_casual():
    from src.alerts.telegram_policy import compute_next_due

    assert compute_next_due("2026-06-30", "casual", 20) is None
    quarterly = compute_next_due("2026-06-30", "quarterly", 20)
    assert quarterly is not None
    assert quarterly["due_date"] == "2026-10-20"


def test_annual_still_coexists_with_periodic_cadence():
    """Hawaii-style yearly reconciliation is not a leftover periodic."""
    why = obligation_status(
        {
            "state_code": "HI",
            "period_type": "annual",
            "period_label": "2026",
            "period_end": "2026-12-31",
            "due_date": "2027-01-20",
            "status": "pending",
        },
        {
            "state_code": "HI",
            "is_registered": True,
            "assigned_frequency": "quarterly",
        },
    )
    assert why is None
