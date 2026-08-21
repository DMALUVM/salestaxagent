"""50-state + DC entity / business-activity matrix.

The load-bearing property is that `not_researched` never masquerades as a
clean bill of health. 38 unexamined jurisdictions rendered as "nothing
required" would be worse than having no matrix at all.
"""
import json

import pytest

from src.compliance.state_matrix import (
    MODES, STATUSES, counts, load_matrix, obligations,
    remote_seller_exposure, states_with_status,
)

ALL_51 = 51


class TestCoverage:
    def test_every_state_plus_dc_is_present(self):
        m = load_matrix()
        assert len(m["jurisdictions"]) == ALL_51
        assert "DC" in m["jurisdictions"]

    def test_every_jurisdiction_has_a_valid_status(self):
        for st, row in load_matrix()["jurisdictions"].items():
            assert row["status"] in STATUSES, st

    def test_statuses_partition_the_set(self):
        c = counts()
        assert sum(c["by_status"].values()) == ALL_51


class TestNotResearchedIsNotNone:
    def test_no_state_is_claimed_verified_none_without_evidence(self):
        """Nothing has been affirmatively cleared, so this must be empty."""
        assert states_with_status("verified_none") == []

    def test_not_researched_rows_carry_an_explicit_disclaimer(self):
        m = load_matrix()
        for st in states_with_status("not_researched", m):
            note = m["jurisdictions"][st].get("note", "")
            assert "NOT" in note and "nothing required" in note, st

    def test_not_researched_rows_have_no_obligations(self):
        m = load_matrix()
        for st in states_with_status("not_researched", m):
            assert not m["jurisdictions"][st]["obligations"], st

    def test_the_status_vocabulary_documents_the_distinction(self):
        sv = load_matrix()["_metadata"]["status_values"]
        assert "MUST NOT" in sv["not_researched"]


class TestVerifiedRows:
    def test_every_verified_state_has_at_least_one_obligation(self):
        m = load_matrix()
        for st in states_with_status("verified_applies", m):
            assert m["jurisdictions"][st]["obligations"], st

    @pytest.mark.parametrize("field", ["name", "trigger", "confidence", "source_url", "mode"])
    def test_every_obligation_is_fully_specified(self, field):
        for o in obligations():
            assert getattr(o, field), f"{o.state_code} missing {field}"

    def test_every_source_is_an_official_url(self):
        for o in obligations():
            assert o.source_url.startswith("https://"), o.state_code

    def test_modes_and_confidence_are_from_the_vocabulary(self):
        for o in obligations():
            assert o.mode in MODES, o.state_code
            assert o.confidence in ("high", "medium", "low"), o.state_code

    def test_the_named_gross_receipts_patterns_are_covered(self):
        """The states the user called out by name."""
        have = {o.state_code for o in obligations()}
        for st in ("WA", "OH", "OR", "TX", "NV", "TN", "DE", "CA"):
            assert st in have, f"{st} missing from the matrix"


class TestNoInventedSoSReports:
    def test_qualification_obligations_only_exist_for_real_registrations(self):
        """No annual report may be asserted from sales-tax registration alone.

        Every qualification-triggered row must belong to a state the entity is
        actually formed or qualified in, or be a dormant template — never a
        state that merely appears in nexus_status.
        """
        qual = [o for o in obligations() if o.from_qualification_only]
        # Each must trace back to a rule in seed_entity_obligations, whose own
        # applies_when gating is what enforces this.
        for o in qual:
            assert o.rule_ref.startswith("seed_entity_obligations:"), o.state_code

    def test_no_obligation_is_triggered_by_sales_tax_registration_alone_except_get(self):
        """Hawaii's GET is the sole legitimate case, and it is not an SoS report."""
        trig = [o for o in obligations() if o.trigger == "sales-tax registration"]
        assert {o.state_code for o in trig} == {"HI"}
        assert all("Excise" in o.name for o in trig)


class TestExposureView:
    def test_exposure_drops_qualification_only_rows(self):
        exp = remote_seller_exposure()
        assert all(o.trigger != "qualification" for o in exp)

    def test_exposure_keeps_the_gross_receipts_taxes(self):
        states = {o.state_code for o in remote_seller_exposure()}
        for st in ("WA", "OH", "OR", "TX", "DE", "CA"):
            assert st in states, st

    def test_contested_taxes_are_review_only(self):
        """None of these may be auto-scheduled."""
        by = {(o.state_code, o.name): o for o in obligations()}
        for (st, name), o in by.items():
            if st in ("CA", "TX", "NV", "KY", "WA", "OH", "OR", "TN") and "annual report" not in name.lower():
                if o.trigger != "qualification":
                    assert o.is_review_only, f"{st} {name} must be review-only"
