"""Entity / remote-seller obligations.

Two things these lock down, both about honesty rather than coverage:
  - a due date is computed from a rule or not shown at all (never guessed)
  - a contested legal position is never auto-scheduled
"""
from datetime import date

import pytest

from src.compliance.entity_obligations import (
    OBLIGATION_TYPES, Obligation, build_obligations, classify_obligations,
    compute_due_date, evaluate_applicability, load_rules,
)

TODAY = date(2026, 8, 20)

PROFILE = {
    "home_state": "MD",
    "entity_type": "LLC",
    "fiscal_year_end": "12-31",
    "foreign_qualified": [{"state": "OK", "qualified_date": None}],
    "enabled_obligations": {},
}


def rule(**kw):
    base = {
        "state_code": "MD", "obligation_type": "entity_annual",
        "form_code": "Form 1", "title": "MD Annual Report",
        "applies_when": "home_state", "frequency": "annual",
        "due_rule": {"kind": "fixed_month_day", "month": 4, "day": 15},
        "confidence": "high", "source": {},
    }
    base.update(kw)
    return base


class TestDueDates:
    def test_fixed_month_day(self):
        r = compute_due_date(rule(), 2026, PROFILE)
        assert r.due_date == date(2026, 4, 15)

    def test_months_after_year_end_lands_after_the_year_closes(self):
        """HI G-49 for tax year 2026 is due 2027-04-20, not 2026-04-20."""
        r = compute_due_date(
            rule(due_rule={"kind": "months_after_year_end", "months": 4, "day": 20}),
            2026, PROFILE)
        assert r.due_date == date(2027, 4, 20)

    def test_anniversary_uses_the_profile_date(self):
        entry = {"state": "OK", "qualified_date": "2021-09-03"}
        r = compute_due_date(
            rule(due_rule={"kind": "anniversary", "anchor": "qualified_date"}),
            2026, PROFILE, entry)
        assert r.due_date == date(2026, 9, 3)

    def test_missing_anniversary_anchor_yields_no_date_not_a_guess(self):
        r = compute_due_date(
            rule(due_rule={"kind": "anniversary", "anchor": "qualified_date"}),
            2026, PROFILE, {"state": "OK", "qualified_date": None})
        assert r.due_date is None
        assert "needs qualified_date" in r.note

    def test_explicit_month_day_overrides_the_anniversary(self):
        entry = {"state": "OK", "qualified_date": "2021-09-03",
                 "annual_due_month_day": "07-01"}
        r = compute_due_date(
            rule(due_rule={"kind": "anniversary", "anchor": "qualified_date"}),
            2026, PROFILE, entry)
        assert r.due_date == date(2026, 7, 1)

    def test_invalid_anchor_does_not_raise(self):
        r = compute_due_date(
            rule(due_rule={"kind": "anniversary", "anchor": "qualified_date"}),
            2026, PROFILE, {"state": "OK", "qualified_date": "not-a-date"})
        assert r.due_date is None

    def test_leap_day_rule_is_clamped(self):
        r = compute_due_date(
            rule(due_rule={"kind": "fixed_month_day", "month": 2, "day": 30}),
            2026, PROFILE)
        assert r.due_date == date(2026, 2, 28)


class TestApplicability:
    def test_home_state_is_scheduled(self):
        a = evaluate_applicability(rule(), PROFILE, set())
        assert a.applies and a.scheduled

    def test_foreign_qualified_is_scheduled(self):
        a = evaluate_applicability(
            rule(state_code="OK", applies_when="foreign_qualified"), PROFILE, set())
        assert a.applies and a.scheduled

    def test_state_not_in_profile_does_not_apply(self):
        a = evaluate_applicability(
            rule(state_code="KY", applies_when="foreign_qualified"), PROFILE, set())
        assert not a.applies

    def test_sales_tax_registration_alone_does_not_create_an_entity_report(self):
        """Being registered to collect KY sales tax is not KY qualification."""
        a = evaluate_applicability(
            rule(state_code="KY", applies_when="foreign_qualified"),
            PROFILE, {"KY"})
        assert not a.applies

    def test_sales_tax_registered_gates_the_get_return(self):
        a = evaluate_applicability(
            rule(state_code="HI", obligation_type="get_excise",
                 applies_when="sales_tax_registered"), PROFILE, {"HI"})
        assert a.applies and a.scheduled

    def test_user_confirmed_applies_but_is_never_scheduled(self):
        """The contested CA 'doing business' position."""
        a = evaluate_applicability(
            rule(state_code="CA", obligation_type="franchise_tax",
                 applies_when="user_confirmed"), PROFILE, {"CA"})
        assert a.applies and not a.scheduled

    def test_override_true_schedules_a_confirmed_position(self):
        p = {**PROFILE, "enabled_obligations": {"CA:franchise_tax": True}}
        a = evaluate_applicability(
            rule(state_code="CA", obligation_type="franchise_tax",
                 applies_when="user_confirmed"), p, set())
        assert a.applies and a.scheduled

    def test_override_false_suppresses_an_otherwise_scheduled_obligation(self):
        p = {**PROFILE, "enabled_obligations": {"MD:entity_annual": False}}
        a = evaluate_applicability(rule(), p, set())
        assert not a.applies


class TestBuild:
    def test_review_items_get_no_due_date(self):
        rules = [rule(state_code="CA", obligation_type="franchise_tax",
                      applies_when="user_confirmed")]
        scheduled, review = build_obligations(PROFILE, rules, set(), [2026], TODAY)
        assert scheduled == []
        assert len(review) == 1
        assert "due_date" not in review[0]

    def test_scheduled_obligations_carry_confidence_and_source(self):
        rules = [rule(source={"authority": "SDAT", "citation": "Form 1",
                              "url": "https://dat.maryland.gov/"})]
        scheduled, _ = build_obligations(PROFILE, rules, set(), [2026], TODAY)
        o = scheduled[0]
        assert o.confidence == "high"
        assert o.source_authority == "SDAT"
        assert o.source_url.startswith("https://")

    def test_overdue_and_upcoming_are_computed_from_today(self):
        scheduled, _ = build_obligations(PROFILE, [rule()], set(), [2026, 2027], TODAY)
        by_year = {o.period_label: o for o in scheduled}
        assert by_year["2026"].days_overdue == 127   # 2026-04-15
        assert by_year["2027"].days_until_due == 238


class TestClassify:
    def _ob(self, **kw):
        base = dict(
            state_code="MD", obligation_type="entity_annual", form_code="Form 1",
            title="t", frequency="annual", period_label="2026",
            due_date=date(2026, 4, 15), due_rule_text="", status="open",
            confidence="high", source_authority="", source_citation="",
            source_url="", amount_estimate=300, notes="", basis="", scheduled=True,
            last_reviewed="", days_overdue=127,
        )
        base.update(kw)
        return Obligation(**base)

    def test_stored_settled_status_wins_over_recomputation(self):
        stored = [{"state_code": "MD", "obligation_type": "entity_annual",
                   "period_label": "2026", "status": "filed"}]
        r = classify_obligations([self._ob()], stored, TODAY)
        assert r["overdue"] == []
        assert r["settled"][0].status == "filed"

    @pytest.mark.parametrize("status", ["filed", "not_required", "dismissed"])
    def test_every_settled_status_suppresses_the_alert(self, status):
        stored = [{"state_code": "MD", "obligation_type": "entity_annual",
                   "period_label": "2026", "status": status}]
        r = classify_obligations([self._ob()], stored, TODAY)
        assert r["overdue"] == [] and len(r["settled"]) == 1

    def test_undated_obligations_are_their_own_bucket(self):
        ob = self._ob(due_date=None, days_overdue=None)
        r = classify_obligations([ob], [], TODAY)
        assert r["undated"] == [ob]
        assert r["overdue"] == [] and r["upcoming"] == []


class TestShippedRules:
    """Guards on the seeded rule file itself."""

    def test_no_rule_masquerades_as_a_sales_tax_return(self):
        for r in load_rules():
            assert r["obligation_type"] in OBLIGATION_TYPES
            assert r["obligation_type"] != "sales_tax_return"

    def test_every_rule_has_a_source_and_confidence(self):
        for r in load_rules():
            assert r.get("confidence") in ("high", "medium", "low"), r["state_code"]
            src = r.get("source") or {}
            assert src.get("url", "").startswith("http"), r["state_code"]
            assert src.get("authority"), r["state_code"]

    def test_every_rule_has_a_due_rule_not_a_literal_date(self):
        for r in load_rules():
            due = r.get("due_rule") or {}
            assert due.get("kind") in (
                "fixed_month_day", "months_after_year_end", "anniversary"), r["state_code"]
            assert "due_date" not in r, f"{r['state_code']} hardcodes a date"

    def test_contested_positions_are_review_only(self):
        """CA/TX/NV/KY-LLET must not auto-schedule a fee."""
        contested = {("CA", "franchise_tax"), ("TX", "franchise_tax"),
                     ("NV", "franchise_tax"), ("KY", "franchise_tax")}
        for r in load_rules():
            if (r["state_code"], r["obligation_type"]) in contested:
                assert r["applies_when"] == "user_confirmed", r["state_code"]

    def test_hawaii_rule_is_the_annual_return_only(self):
        """G-45 periodics stay in filing_calendar; only G-49 is added here."""
        hi = [r for r in load_rules() if r["state_code"] == "HI"]
        assert len(hi) == 1
        assert hi[0]["form_code"] == "G-49"
        assert hi[0]["frequency"] == "annual"


class TestCalendarOverlap:
    """The same real filing must not be tracked in both calendars unnoticed."""

    def _ob(self, **kw):
        base = dict(
            state_code="HI", obligation_type="get_excise", form_code="G-49",
            title="", frequency="annual", period_label="2026",
            due_date=date(2027, 4, 20), due_rule_text="", status="open",
            confidence="high", source_authority="", source_citation="",
            source_url="", amount_estimate=None, notes="", basis="",
            scheduled=True, last_reviewed="",
        )
        base.update(kw)
        return Obligation(**base)

    def test_overlapping_annual_period_is_reported(self):
        from src.compliance.entity_obligations import find_calendar_overlap
        filings = [{"state_code": "HI", "period_type": "annual",
                    "period_label": "2026", "due_date": "2027-01-20",
                    "status": "pending"}]
        out = find_calendar_overlap([self._ob()], filings)
        assert len(out) == 1
        assert out[0]["entity_form"] == "G-49"
        # The two dates disagree — the sales-tax calendar's generic annual rule
        # produced Jan 20, but the G-49 is due April 20.
        assert out[0]["calendar_due"] != out[0]["entity_due"]

    def test_periodic_rows_are_not_flagged_as_overlap(self):
        from src.compliance.entity_obligations import find_calendar_overlap
        filings = [{"state_code": "HI", "period_type": "semi_annual",
                    "period_label": "2026-H1", "due_date": "2026-07-20",
                    "status": "pending"}]
        assert find_calendar_overlap([self._ob()], filings) == []

    def test_settled_calendar_rows_are_not_flagged(self):
        from src.compliance.entity_obligations import find_calendar_overlap
        filings = [{"state_code": "HI", "period_type": "annual",
                    "period_label": "2026", "due_date": "2027-01-20",
                    "status": "not_required"}]
        assert find_calendar_overlap([self._ob()], filings) == []


class TestRemoteSellerRelevance:
    """Only filings a remote seller can actually owe.

    A remote seller registers for SALES TAX in many states but is rarely
    foreign-qualified in them. Entity annual reports follow qualification, not
    sales-tax registration, so every state rule here must stay dormant until
    the profile places the entity there.
    """

    def test_state_rules_do_not_fire_without_qualification(self):
        """DE/FL/CA-SOI are templates: inert until the user qualifies there."""
        profile = {"home_state": "MD", "foreign_qualified": [{"state": "OK"}],
                   "enabled_obligations": {}}
        # Registered for sales tax essentially everywhere — the planned state.
        everywhere = {"DE", "FL", "CA", "KY", "TX", "NV", "HI", "MD", "OK"}
        scheduled, _ = build_obligations(profile, load_rules(), everywhere,
                                         [2026], TODAY)
        states = {o.state_code for o in scheduled}
        assert "DE" not in states, "Delaware fired on sales-tax registration alone"
        assert "FL" not in states
        assert {"MD", "OK"} <= states

    def test_qualifying_in_a_state_activates_its_rule_with_no_code_change(self):
        profile = {"home_state": "MD",
                   "foreign_qualified": [{"state": "FL"}],
                   "enabled_obligations": {}}
        scheduled, _ = build_obligations(profile, load_rules(), set(), [2026], TODAY)
        fl = [o for o in scheduled if o.state_code == "FL"]
        assert len(fl) == 1
        assert fl[0].due_date == date(2026, 5, 1)


class TestWildcardFallback:
    def test_wildcard_covers_a_state_with_no_specific_rule(self):
        profile = {"home_state": "MD",
                   "foreign_qualified": [{"state": "WY", "qualified_date": "2024-03-10"}],
                   "enabled_obligations": {}}
        scheduled, _ = build_obligations(profile, load_rules(), set(), [2026], TODAY)
        wy = [o for o in scheduled if o.state_code == "WY"]
        assert len(wy) == 1
        assert wy[0].confidence == "low"       # honest about being a placeholder
        assert wy[0].due_date == date(2026, 3, 10)

    def test_wildcard_does_not_duplicate_a_specific_rule(self):
        """OK's real Annual Certificate must not be shadowed by the placeholder.

        The two carry different obligation_types (foreign_llc_report vs
        entity_annual) but describe the same annual registration filing.
        """
        profile = {"home_state": "MD",
                   "foreign_qualified": [{"state": "OK", "qualified_date": "2025-02-25"}],
                   "enabled_obligations": {}}
        scheduled, _ = build_obligations(profile, load_rules(), set(), [2026], TODAY)
        ok = [o for o in scheduled if o.state_code == "OK"]
        assert len(ok) == 1
        assert ok[0].form_code == "Annual Certificate"

    def test_wildcard_never_applies_to_the_home_state(self):
        profile = {"home_state": "MD", "foreign_qualified": [], "enabled_obligations": {}}
        scheduled, _ = build_obligations(profile, load_rules(), set(), [2026], TODAY)
        md = [o for o in scheduled if o.state_code == "MD"]
        assert len(md) == 1 and md[0].form_code == "Form 1"


class TestBiennial:
    PROFILE = {"home_state": "MD",
               "foreign_qualified": [{"state": "CA", "qualified_date": "2025-06-10"}],
               "enabled_obligations": {}}

    def test_biennial_generates_only_every_other_year(self):
        scheduled, _ = build_obligations(self.PROFILE, load_rules(), set(),
                                         [2025, 2026, 2027, 2028], TODAY)
        years = sorted(o.period_label for o in scheduled
                       if o.state_code == "CA" and o.obligation_type == "entity_annual")
        assert years == ["2025", "2027"]

    def test_biennial_without_an_anchor_generates_nothing(self):
        """No qualification date → no invented cycle."""
        p = {**self.PROFILE, "foreign_qualified": [{"state": "CA"}]}
        scheduled, _ = build_obligations(p, load_rules(), set(), [2026, 2027], TODAY)
        assert [o for o in scheduled
                if o.state_code == "CA" and o.obligation_type == "entity_annual"] == []

    def test_ca_statement_of_information_is_not_the_franchise_tax(self):
        """Two different CA obligations: SOI is scheduled, $800 stays review-only."""
        scheduled, review = build_obligations(self.PROFILE, load_rules(), set(),
                                              [2025], TODAY)
        types = {o.obligation_type for o in scheduled if o.state_code == "CA"}
        assert types == {"entity_annual"}
        assert any(r["state_code"] == "CA" and r["obligation_type"] == "franchise_tax"
                   for r in review)


class TestPruneDisabled:
    """Turning a contested obligation off must stop it looking scheduled."""

    def _stored(self, state, otype, label, status="open"):
        return {"id": f"{state}-{label}", "state_code": state,
                "obligation_type": otype, "period_label": label,
                "form_code": "F", "status": status}

    def test_rows_for_a_disabled_obligation_are_removed(self, monkeypatch):
        import src.compliance.entity_obligations as eo

        stored = [self._stored("CA", "franchise_tax", "2026"),
                  self._stored("MD", "entity_annual", "2026")]
        deleted = []

        class FakeQ:
            def delete(self):
                return self

            def eq(self, col, val):
                deleted.append(val)
                return self

            def execute(self):
                return type("R", (), {"data": []})()

        monkeypatch.setattr(eo, "fetch_stored", lambda: stored)
        monkeypatch.setattr(eo, "log_audit", lambda **k: None, raising=False)
        monkeypatch.setattr(
            "src.db.get_client",
            lambda: type("C", (), {"table": lambda self, t: FakeQ()})())
        monkeypatch.setattr("src.db.log_audit", lambda **k: None)

        md = Obligation(
            state_code="MD", obligation_type="entity_annual", form_code="Form 1",
            title="", frequency="annual", period_label="2026",
            due_date=date(2026, 4, 15), due_rule_text="", status="open",
            confidence="high", source_authority="", source_citation="",
            source_url="", amount_estimate=None, notes="", basis="",
            scheduled=True, last_reviewed="")

        r = eo.prune_disabled([md])
        assert r["removed"] == 1
        assert deleted == ["CA-2026"]

    def test_settled_rows_survive_being_disabled(self, monkeypatch):
        """A filing you actually made is a record, not a schedule entry."""
        import src.compliance.entity_obligations as eo

        stored = [self._stored("CA", "franchise_tax", "2026", status="filed")]
        monkeypatch.setattr(eo, "fetch_stored", lambda: stored)
        r = eo.prune_disabled([], dry_run=True)
        assert r["removed"] == 0
        assert r["kept_settled"] == 1

    def test_nothing_to_prune_is_a_no_op(self, monkeypatch):
        import src.compliance.entity_obligations as eo
        monkeypatch.setattr(eo, "fetch_stored", lambda: [])
        assert eo.prune_disabled([])["removed"] == 0
