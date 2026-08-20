"""Registration-aware Telegram digest sections.

Given nexus rows + calendar rows + flags, the digest must count only decisions
that are genuinely outstanding — not every state with nexus.
"""
from datetime import date

from src.alerts.digest_sections import build_sections, render_sections

TODAY = date(2026, 8, 20)


def nx(sc, **kw):
    base = {
        "state_code": sc, "is_registered": False,
        "has_physical_nexus": False, "has_economic_nexus": False,
        "compliance_resolved": False, "compliance_hidden": False,
        "registration_date": None, "assigned_frequency": None,
        "last_filed_through": None,
    }
    base.update(kw)
    return base


def fc(sc, label, due, **kw):
    base = {
        "state_code": sc, "period_type": "quarterly", "period_label": label,
        "period_end": due, "due_date": due, "status": "pending",
    }
    base.update(kw)
    return base


class TestActionNeeded:
    def test_registered_nexus_states_are_not_action_needed(self):
        """The noise source: 21 registered states counted as needing action."""
        rows = [nx(f"S{i}", is_registered=True, has_physical_nexus=True)
                for i in range(21)]
        s = build_sections(rows, [], [], TODAY)
        assert s.action_needed_states == []
        assert len(s.registered_nexus) == 21

    def test_registered_over_economic_threshold_is_monitoring_not_action(self):
        rows = [nx("NV", is_registered=True, has_economic_nexus=True)]
        s = build_sections(rows, [], [], TODAY)
        assert s.econ_exceeded_registered == ["NV"]
        assert s.econ_exceeded_unregistered == []
        assert s.action_needed_states == []

    def test_unregistered_nexus_is_action_needed(self):
        s = build_sections([nx("CA", has_physical_nexus=True)], [], [], TODAY)
        assert s.action_needed_states == ["CA"]

    def test_dismissed_state_drops_out_of_the_count(self):
        rows = [nx("CA", has_physical_nexus=True, compliance_resolved=True),
                nx("FL", has_physical_nexus=True, compliance_hidden=True)]
        s = build_sections(rows, [], [], TODAY)
        assert s.action_needed_states == []
        assert s.unregistered_nexus_dismissed == ["CA", "FL"]

    def test_registered_state_with_real_overdue_is_action_needed(self):
        rows = [nx("TX", is_registered=True, registration_date="2020-01-01",
                   assigned_frequency="quarterly")]
        s = build_sections(rows, [fc("TX", "2026-Q1", "2026-04-20")], [], TODAY)
        assert s.action_needed_states == ["TX"]
        assert len(s.overdue) == 1

    def test_critical_franchise_flag_is_action_needed(self):
        flags = [{"state_code": "TX", "status": "open", "severity": "critical",
                  "flag_type": "franchise_tax"}]
        s = build_sections([], [], flags, TODAY)
        assert s.action_needed_states == ["TX"]

    def test_warning_flags_are_counted_not_listed_as_actions(self):
        flags = [{"state_code": "MI", "status": "open", "severity": "warning"}]
        s = build_sections([], [], flags, TODAY)
        assert s.action_needed_states == []
        assert s.warning_flag_count == 1

    def test_resolved_flags_are_ignored(self):
        flags = [{"state_code": "TX", "status": "resolved", "severity": "critical"}]
        s = build_sections([], [], flags, TODAY)
        assert s.critical_flags == []


class TestFilingsAreRegistrationGated:
    def test_unregistered_state_contributes_no_filings(self):
        """RI/WV/NC must not appear unless is_registered is true."""
        rows = [nx("RI", has_physical_nexus=True)]
        s = build_sections(rows, [fc("RI", "2026-Q1", "2026-04-20")], [], TODAY)
        assert s.overdue == [] and s.upcoming == []

    def test_filed_through_suppresses_overdue(self):
        """The live NV case reaching Telegram."""
        rows = [nx("NV", is_registered=True, registration_date="2024-01-01",
                   assigned_frequency="quarterly", last_filed_through="2026-06-30")]
        filings = [fc("NV", "2026-Q1", "2026-04-20", period_end="2026-03-31"),
                   fc("NV", "2026-Q2", "2026-07-20", period_end="2026-06-30")]
        s = build_sections(rows, filings, [], TODAY)
        assert s.overdue == []

    def test_upcoming_window_is_bounded(self):
        rows = [nx("TX", is_registered=True, registration_date="2020-01-01",
                   assigned_frequency="quarterly")]
        filings = [fc("TX", "2026-Q3", "2026-10-20"),   # 61d out
                   fc("TX", "2026-Q2b", "2026-09-01")]  # 12d out
        s = build_sections(rows, filings, [], TODAY, upcoming_within_days=45)
        assert [f["period_label"] for f in s.upcoming] == ["2026-Q2b"]


class TestRender:
    def test_quiet_day_says_so_instead_of_listing_noise(self):
        out = "\n".join(render_sections(build_sections([], [], [], TODAY), TODAY))
        assert "No outstanding actions" in out

    def test_registered_states_never_get_a_register_cta(self):
        rows = [nx("NV", is_registered=True, has_economic_nexus=True)]
        out = "\n".join(render_sections(build_sections(rows, [], [], TODAY), TODAY))
        assert "not registered" not in out
        assert "filing on schedule" in out

    def test_long_state_lists_are_truncated(self):
        rows = [nx(f"S{i}", has_physical_nexus=True) for i in range(20)]
        out = "\n".join(render_sections(build_sections(rows, [], [], TODAY), TODAY))
        assert "more" in out
        # The whole digest stays short even with 20 outstanding states.
        assert len(out.splitlines()) < 12
