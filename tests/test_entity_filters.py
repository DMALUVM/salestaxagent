"""Horizon and scope filters for the entity obligation list."""
from datetime import date

import pytest

from src.compliance.entity_filters import (
    DEFAULT_HORIZON_DAYS, filter_view, horizon_days, scope_states,
    within_horizon,
)
from src.compliance.entity_obligations import Obligation

TODAY = date(2026, 8, 20)


def ob(state="MD", due=None, label="2026", **kw):
    base = dict(
        state_code=state, obligation_type="entity_annual", form_code="Form 1",
        title="", frequency="annual", period_label=label, due_date=due,
        due_rule_text="", status="open", confidence="high",
        source_authority="", source_citation="", source_url="",
        amount_estimate=None, notes="", basis="", scheduled=True,
        last_reviewed="",
    )
    base.update(kw)
    o = Obligation(**base)
    if due:
        delta = (due - TODAY).days
        if delta < 0:
            o.days_overdue = -delta
        else:
            o.days_until_due = delta
    return o


class TestHorizonDays:
    def test_default_is_twelve_months(self):
        assert DEFAULT_HORIZON_DAYS == 365
        assert horizon_days(None) == 365

    @pytest.mark.parametrize("key,expected", [("12m", 365), ("24m", 730), ("all", None)])
    def test_known_keys(self, key, expected):
        assert horizon_days(key) == expected

    def test_unknown_key_falls_back_to_default(self):
        assert horizon_days("nonsense") == 365


class TestWithinHorizon:
    def test_inside_the_window(self):
        assert within_horizon(date(2027, 4, 20), TODAY, 365)   # 243d

    def test_outside_the_window(self):
        """HI G-49 2027 is 609 days out — the clutter the user complained about."""
        assert not within_horizon(date(2028, 4, 20), TODAY, 365)

    def test_visible_at_twenty_four_months(self):
        assert within_horizon(date(2028, 4, 20), TODAY, 730)

    def test_overdue_is_always_included(self):
        assert within_horizon(date(2020, 1, 1), TODAY, 365)

    def test_all_horizon_includes_everything(self):
        assert within_horizon(date(2099, 1, 1), TODAY, None)

    def test_exactly_on_the_boundary_is_included(self):
        assert within_horizon(TODAY + __import__("datetime").timedelta(days=365),
                              TODAY, 365)

    def test_no_due_date_is_never_hidden(self):
        """A missing date is a gap to fill, not a deadline to defer."""
        assert within_horizon(None, TODAY, 365)


class TestScopeStates:
    REG = {"HI", "NV", "TX"}

    def test_all_scope_has_no_restriction(self):
        assert scope_states("all", self.REG, "MD", {"OK"}) is None

    def test_home_and_foreign_only(self):
        assert scope_states("home_foreign", self.REG, "MD", {"OK"}) == {"MD", "OK"}

    def test_registered_unions_home_and_foreign(self):
        """MD/OK must never vanish just because they are not sales-tax states."""
        got = scope_states("registered", self.REG, "MD", {"OK"})
        assert got == {"HI", "NV", "TX", "MD", "OK"}

    def test_multiple_foreign_states(self):
        got = scope_states("home_foreign", set(), "MD", {"OK", "CA", "FL"})
        assert got == {"MD", "OK", "CA", "FL"}

    def test_missing_home_state_is_tolerated(self):
        assert scope_states("home_foreign", set(), None, {"OK"}) == {"OK"}


class TestFilterView:
    def _view(self):
        return {
            "overdue": [ob("MD", date(2026, 4, 15))],
            "upcoming": [
                ob("MD", date(2027, 4, 15), "2027"),          # 238d
                ob("HI", date(2027, 4, 20), "2026"),          # 243d
                ob("HI", date(2028, 4, 20), "2027"),          # 609d
            ],
            "undated": [ob("OK", None)],
            "settled": [],
            "review": [{"state_code": "CA"}, {"state_code": "TX"}],
        }

    def test_default_horizon_hides_the_2028_row(self):
        r = filter_view(self._view(), TODAY)
        labels = [(o.state_code, o.due_date) for o in r["upcoming"]]
        assert (date(2028, 4, 20)) not in [d for _, d in labels]
        assert r["hidden_by_horizon"] == 1

    def test_default_horizon_keeps_the_2027_rows(self):
        r = filter_view(self._view(), TODAY)
        assert len(r["upcoming"]) == 2

    def test_twenty_four_months_reveals_it(self):
        r = filter_view(self._view(), TODAY, horizon="24m")
        assert len(r["upcoming"]) == 3
        assert r["hidden_by_horizon"] == 0

    def test_overdue_survives_every_horizon(self):
        for h in ("12m", "24m", "all"):
            assert len(filter_view(self._view(), TODAY, horizon=h)["overdue"]) == 1

    def test_counts_respect_the_horizon(self):
        r = filter_view(self._view(), TODAY)
        assert r["counts"]["upcoming"] == 2
        assert r["counts"]["overdue"] == 1

    def test_registered_scope_keeps_home_and_foreign(self):
        r = filter_view(self._view(), TODAY, horizon="all", scope="registered",
                        registered={"HI"}, home_state="MD", foreign_states={"OK"})
        states = {o.state_code for o in r["overdue"] + r["upcoming"] + r["undated"]}
        assert states == {"MD", "HI", "OK"}

    def test_home_foreign_scope_drops_registered_only_states(self):
        r = filter_view(self._view(), TODAY, horizon="all", scope="home_foreign",
                        registered={"HI"}, home_state="MD", foreign_states={"OK"})
        states = {o.state_code for o in r["overdue"] + r["upcoming"] + r["undated"]}
        assert "HI" not in states
        assert states == {"MD", "OK"}

    def test_scope_filters_review_items_too(self):
        r = filter_view(self._view(), TODAY, scope="home_foreign",
                        home_state="MD", foreign_states={"OK"})
        assert r["review"] == []

    def test_undated_rows_ignore_the_horizon(self):
        r = filter_view(self._view(), TODAY, horizon="12m")
        assert len(r["undated"]) == 1

    def test_metadata_is_reported_back(self):
        r = filter_view(self._view(), TODAY, horizon="24m", scope="registered")
        assert r["horizon"] == "24m" and r["horizon_days"] == 730
        assert r["scope"] == "registered"
