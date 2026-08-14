"""Tests for the filing calendar generation (no DB required)."""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest


class TestFilingCalendarGeneration:
    def test_monthly_entries(self):
        from src.calendar.filing_calendar import generate_filing_entries
        entries = generate_filing_entries("TX", "monthly", 2026, due_day=20)
        assert len(entries) == 12
        assert entries[0]["period_label"] == "2026-01"
        assert entries[0]["period_start"] == date(2026, 1, 1)
        assert entries[0]["period_end"] == date(2026, 1, 31)
        assert entries[0]["due_date"] == date(2026, 2, 20)

    def test_quarterly_entries(self):
        from src.calendar.filing_calendar import generate_filing_entries
        entries = generate_filing_entries("CA", "quarterly", 2026, due_day=30)
        assert len(entries) == 4
        assert entries[0]["period_label"] == "2026-Q1"
        assert entries[0]["period_start"] == date(2026, 1, 1)
        assert entries[0]["period_end"] == date(2026, 3, 31)

    def test_annual_entry(self):
        from src.calendar.filing_calendar import generate_filing_entries
        entries = generate_filing_entries("WY", "annual", 2026, due_day=20)
        assert len(entries) == 1
        assert entries[0]["period_label"] == "2026"
        assert entries[0]["period_start"] == date(2026, 1, 1)
        assert entries[0]["period_end"] == date(2026, 12, 31)
        assert entries[0]["due_date"] == date(2027, 1, 20)

    def test_due_day_clamped_to_month_end(self):
        from src.calendar.filing_calendar import generate_filing_entries
        entries = generate_filing_entries("TX", "monthly", 2026, due_day=31)
        feb_entry = [e for e in entries if e["period_label"] == "2026-01"][0]
        assert feb_entry["due_date"].day <= 28

    def test_all_entries_pending(self):
        from src.calendar.filing_calendar import generate_filing_entries
        entries = generate_filing_entries("NY", "quarterly", 2026)
        for entry in entries:
            assert entry["status"] == "pending"


class TestFCCodeCoverage:
    def test_major_states_covered(self):
        from src.config import load_fc_codes
        fc_map = load_fc_codes()
        states_covered = set(fc_map.values())
        major_fba_states = {"TX", "CA", "PA", "NJ", "OH", "IN", "KY", "TN", "FL", "GA", "IL", "WA"}
        for state in major_fba_states:
            assert state in states_covered, f"Major FBA state {state} missing from FC codes"

    def test_no_empty_mappings(self):
        from src.config import load_fc_codes
        fc_map = load_fc_codes()
        for code, state in fc_map.items():
            assert code.strip(), f"Empty FC code found"
            assert len(state) == 2, f"Invalid state code for {code}: {state}"
            assert state.isalpha(), f"Non-alpha state code for {code}: {state}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
