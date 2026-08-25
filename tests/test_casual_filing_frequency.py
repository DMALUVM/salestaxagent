"""Casual filing frequency support."""
from src.calendar.eligibility import obligation_status


def test_casual_supersedes_monthly_periods():
    why = obligation_status(
        {
            "state_code": "IA",
            "period_type": "monthly",
            "period_label": "2026-08",
            "period_end": "2026-08-31",
            "due_date": "2026-09-20",
            "status": "pending",
        },
        {
            "state_code": "IA",
            "is_registered": True,
            "assigned_frequency": "casual",
        },
    )
    assert why is not None
    assert why.reason == "superseded_frequency"


def test_generate_casual_calendar_entry():
    from src.calendar.filing_calendar import generate_filing_entries

    rows = generate_filing_entries("IA", "casual", 2026, due_day=20)
    assert len(rows) == 1
    assert rows[0]["period_type"] == "casual"
    assert rows[0]["period_label"] == "2026"
