"""Filing-calendar eligibility: what counts as a real obligation.

These lock the rules that stop the dashboard inventing OVERDUE chips for
periods the user does not owe.
"""
from datetime import date

import pytest

from src.calendar.eligibility import (
    classify_filings, is_open_obligation, obligation_status,
)

TODAY = date(2026, 8, 20)


def filing(**kw):
    base = {
        "state_code": "NV", "period_type": "quarterly", "period_label": "2026-Q1",
        "period_start": "2026-01-01", "period_end": "2026-03-31",
        "due_date": "2026-04-20", "status": "pending",
    }
    base.update(kw)
    return base


def nexus(**kw):
    base = {
        "state_code": "NV", "is_registered": True,
        "registration_date": "2024-01-01", "assigned_frequency": "quarterly",
        "last_filed_through": None,
    }
    base.update(kw)
    return base


class TestRegistrationGate:
    def test_unregistered_state_never_overdue(self):
        """Nexus without registration drives a register action, not a return."""
        why = obligation_status(filing(), nexus(is_registered=False))
        assert why is not None and why.reason == "not_registered"

    def test_null_registration_is_not_registered(self):
        assert not is_open_obligation(filing(), nexus(is_registered=None))

    def test_state_with_no_nexus_row_is_not_registered(self):
        why = obligation_status(filing(), None)
        assert why is not None and why.reason == "not_registered"

    def test_registered_past_due_and_open_is_overdue(self):
        assert is_open_obligation(filing(), nexus())
        r = classify_filings([filing()], [nexus()], TODAY)
        assert len(r["overdue"]) == 1
        assert r["overdue"][0]["days_overdue"] == 122


class TestSettledPeriods:
    @pytest.mark.parametrize("status", ["filed", "not_required"])
    def test_settled_is_never_overdue(self, status):
        why = obligation_status(filing(status=status), nexus())
        assert why is not None and why.reason == "settled"

    def test_filed_stays_filed_after_reclassification(self):
        r = classify_filings([filing(status="filed")], [nexus()], TODAY)
        assert r["overdue"] == [] and r["upcoming"] == []
        assert r["excluded"][0]["excluded_reason"] == "settled"

    def test_late_status_is_still_open(self):
        """`late` was written by older code onto overdue rows — still an obligation."""
        assert is_open_obligation(filing(status="late"), nexus())


class TestFiledThrough:
    def test_period_covered_by_last_filed_through_is_not_overdue(self):
        """The live NV bug: Q1/Q2 2026 both end on or before 2026-06-30."""
        n = nexus(last_filed_through="2026-06-30")
        for label, end, due in (("2026-Q1", "2026-03-31", "2026-04-20"),
                                ("2026-Q2", "2026-06-30", "2026-07-20")):
            why = obligation_status(
                filing(period_label=label, period_end=end, due_date=due), n)
            assert why is not None and why.reason == "filed_through", label

    def test_period_after_filed_through_is_still_owed(self):
        n = nexus(last_filed_through="2026-06-30")
        f = filing(period_label="2026-Q3", period_end="2026-09-30",
                   due_date="2026-10-20")
        assert is_open_obligation(f, n)


class TestFrequencyMismatch:
    def test_stale_cadence_is_superseded(self):
        """NV carried semi_annual rows after moving to quarterly."""
        f = filing(period_type="semi_annual", period_label="2026-H2",
                   period_end="2026-12-31", due_date="2027-01-20")
        why = obligation_status(f, nexus(assigned_frequency="quarterly"))
        assert why is not None and why.reason == "superseded_frequency"

    def test_annual_reconciliation_is_not_superseded(self):
        """Hawaii files G-45 periodics PLUS a G-49 annual return.

        Treating the annual row as a stale duplicate of the semi-annual cadence
        hid a real filing. Only two periodic cadences supersede each other.
        """
        f = filing(state_code="HI", period_type="annual", period_label="2026",
                   period_end="2026-12-31", due_date="2027-01-20")
        n = nexus(state_code="HI", assigned_frequency="semi_annual")
        assert is_open_obligation(f, n)

    def test_no_assigned_frequency_keeps_every_period(self):
        """Without a stated cadence there is nothing to contradict."""
        f = filing(period_type="semi_annual", period_label="2026-H2",
                   period_end="2026-12-31", due_date="2027-01-20")
        assert is_open_obligation(f, nexus(assigned_frequency=None))


class TestPreRegistration:
    def test_period_before_registration_is_excluded(self):
        f = filing(period_label="2023-Q1", period_end="2023-03-31",
                   due_date="2023-04-20")
        why = obligation_status(f, nexus(registration_date="2024-01-01"))
        assert why is not None and why.reason == "pre_registration"


class TestClassify:
    def test_upcoming_and_overdue_are_separated(self):
        rows = [
            filing(period_label="2026-Q1", due_date="2026-04-20"),
            filing(period_label="2026-Q3", period_end="2026-09-30",
                   due_date="2026-10-20"),
        ]
        r = classify_filings(rows, [nexus()], TODAY)
        assert [f["period_label"] for f in r["overdue"]] == ["2026-Q1"]
        assert [f["period_label"] for f in r["upcoming"]] == ["2026-Q3"]

    def test_every_excluded_row_carries_a_reason(self):
        rows = [filing(status="filed"), filing(period_label="X")]
        r = classify_filings(rows, [nexus(is_registered=False)], TODAY)
        assert len(r["excluded"]) == 2
        assert all(x.get("excluded_reason") for x in r["excluded"])

    def test_dates_may_arrive_as_date_objects(self):
        """PostgREST returns ISO strings; direct Python callers pass dates."""
        f = filing(period_end=date(2026, 3, 31), due_date=date(2026, 4, 20))
        r = classify_filings([f], [nexus()], TODAY)
        assert len(r["overdue"]) == 1


class TestRebuildPreservesSettled:
    """The nightly rebuild must never reopen a period the user settled.

    The upsert writes status="pending" on every generated period, so without
    the settled-key filter a filed or not_required period would silently
    reopen and reappear as an OVERDUE chip the user had already dealt with.
    """

    def test_settled_periods_are_not_rewritten(self, monkeypatch):
        import src.calendar.filing_calendar as fc

        existing = [
            {"state_code": "NV", "period_type": "quarterly",
             "period_label": "2026-Q1", "status": "not_required"},
            {"state_code": "NV", "period_type": "quarterly",
             "period_label": "2026-Q2", "status": "filed"},
            {"state_code": "NV", "period_type": "quarterly",
             "period_label": "2026-Q3", "status": "pending"},
            {"state_code": "NV", "period_type": "quarterly",
             "period_label": "2026-Q4", "status": "late"},
        ]
        nexus = [{"state_code": "NV", "is_registered": True,
                  "assigned_frequency": "quarterly"}]

        def fake_fetch_all(table, *a, **kw):
            return {"filing_calendar": existing, "nexus_status": nexus}.get(table, [])

        written: list[dict] = []
        monkeypatch.setattr(fc, "fetch_all", fake_fetch_all)
        monkeypatch.setattr(fc, "upsert_rows",
                            lambda t, rows, on_conflict=None: written.extend(rows) or len(rows))
        monkeypatch.setattr(fc, "log_audit", lambda **kw: None)

        result = fc.populate_calendar_for_registered_states(year=2026)

        labels = {r["period_label"] for r in written}
        assert "2026-Q1" not in labels, "not_required period was reopened"
        assert "2026-Q2" not in labels, "filed period was reopened"
        assert "2026-Q4" not in labels, "late period was reset to pending"
        assert "2026-Q3" in labels, "an open period should still be refreshed"
        assert result["settled_preserved"] == 3

    def test_only_registered_states_get_periods(self, monkeypatch):
        import src.calendar.filing_calendar as fc

        nexus = [{"state_code": "CA", "is_registered": False,
                  "assigned_frequency": "quarterly"},
                 {"state_code": "TX", "is_registered": True,
                  "assigned_frequency": "quarterly"}]

        written: list[dict] = []
        monkeypatch.setattr(fc, "fetch_all",
                            lambda t, *a, **kw: nexus if t == "nexus_status" else [])
        monkeypatch.setattr(fc, "upsert_rows",
                            lambda t, rows, on_conflict=None: written.extend(rows) or len(rows))
        monkeypatch.setattr(fc, "log_audit", lambda **kw: None)

        fc.populate_calendar_for_registered_states(year=2026)
        assert {r["state_code"] for r in written} == {"TX"}


class TestMarkOverdueFilings:
    """deadline_check must persist pending → late; it used to only print."""

    TODAY = date(2026, 8, 22)

    def _rows(self):
        return [
            filing(state_code="CT", period_type="monthly",
                   period_label="2026-07", period_end="2026-07-31",
                   due_date="2026-08-20", status="pending"),
            filing(state_code="MI", period_type="monthly",
                   period_label="2026-07", period_end="2026-07-31",
                   due_date="2026-08-20", status="pending"),
            filing(state_code="VA", period_type="monthly",
                   period_label="2026-07", period_end="2026-07-31",
                   due_date="2026-08-20", status="filed"),
            filing(state_code="NC", period_type="monthly",
                   period_label="2026-07", period_end="2026-07-31",
                   due_date="2026-08-20", status="not_required"),
            filing(state_code="PA", period_type="monthly",
                   period_label="2026-07", period_end="2026-07-31",
                   due_date="2026-08-20", status="late"),
            filing(state_code="SC", period_type="monthly",
                   period_label="2026-08", period_end="2026-08-31",
                   due_date="2026-09-20", status="pending"),
            filing(state_code="CT", period_type="monthly",
                   period_label="2026-08", period_end="2026-08-31",
                   due_date=self.TODAY.isoformat(), status="pending"),
        ]

    def test_flips_pending_past_due_only(self, monkeypatch):
        import src.calendar.filing_calendar as fc

        updates: list[tuple] = []
        monkeypatch.setattr(fc, "fetch_all", lambda *a, **kw: self._rows())
        monkeypatch.setattr(
            fc, "update_row",
            lambda table, filters, updates_dict: updates.append(
                (filters, updates_dict)) or {"ok": True})
        monkeypatch.setattr(fc, "log_audit", lambda **kw: None)

        result = fc.mark_overdue_filings(today=self.TODAY)

        flipped = {(c["state_code"], c["period_label"]) for c in result["changes"]}
        assert flipped == {("CT", "2026-07"), ("MI", "2026-07")}
        assert result["flipped"] == 2
        assert result["already_late"] == 1
        assert result["skipped_settled"] == 2
        assert result["today"] == "2026-08-22"

        for _filters, body in updates:
            assert body == {"status": "late", "reminder_sent": True}

    def test_dry_run_does_not_write(self, monkeypatch):
        import src.calendar.filing_calendar as fc

        monkeypatch.setattr(fc, "fetch_all", lambda *a, **kw: self._rows())
        monkeypatch.setattr(
            fc, "update_row",
            lambda *a, **kw: (_ for _ in ()).throw(AssertionError("wrote")))
        monkeypatch.setattr(fc, "log_audit", lambda **kw: None)

        result = fc.mark_overdue_filings(today=self.TODAY, dry_run=True)
        assert result["flipped"] == 2
        assert result["dry_run"] is True

    def test_due_today_stays_pending(self, monkeypatch):
        import src.calendar.filing_calendar as fc

        rows = [filing(due_date="2026-08-22", status="pending")]
        monkeypatch.setattr(fc, "fetch_all", lambda *a, **kw: rows)
        monkeypatch.setattr(fc, "update_row", lambda *a, **kw: None)
        monkeypatch.setattr(fc, "log_audit", lambda **kw: None)

        result = fc.mark_overdue_filings(today=self.TODAY)
        assert result["flipped"] == 0
        assert result["changes"] == []
