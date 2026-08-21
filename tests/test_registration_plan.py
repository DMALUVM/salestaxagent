"""Sales-tax registration prioritisation.

The decision is a pure function, so these fixtures pin the rules that matter:
a state without sales tax can never be a registration target, contested FBA
nexus never becomes a silent register_now, and entity taxes never leak into a
sales-tax recommendation.
"""
import pytest

from src.exports.registration_plan import (
    ACTIONS, PlanRow, StateFacts, counts_by_action, decide, sort_rows,
    to_csv_rows,
)


def facts(**kw) -> StateFacts:
    base = dict(state_code="XX", has_sales_tax=True, is_registered=False,
                fba_rule="unknown_default_true", inventory_events=0,
                inventory_first=None, economic_exceeded=False, economic_pct=0.0,
                shopify_sales=0.0, amazon_sales=0.0)
    base.update(kw)
    return StateFacts(**base)


class TestNoSalesTax:
    @pytest.mark.parametrize("state", ["AK", "DE", "MT", "NH", "OR"])
    def test_never_register_now(self, state):
        """Structural: exits before any trigger can be evaluated."""
        f = facts(state_code=state, has_sales_tax=False, inventory_events=5000,
                  inventory_first="2024-01-01", economic_exceeded=True,
                  economic_pct=400.0)
        assert decide(f).action == "no_sales_tax"

    def test_entity_exposure_is_footnoted_not_promoted(self):
        """Delaware has gross-receipts exposure but still no sales tax."""
        f = facts(state_code="DE", has_sales_tax=False, entity_exposure=True)
        d = decide(f)
        assert d.action == "no_sales_tax"
        assert "/entity" in d.reason


class TestAlreadyRegistered:
    def test_registration_short_circuits_triggers(self):
        f = facts(is_registered=True, economic_exceeded=True,
                  inventory_events=100, inventory_first="2024-01-01")
        assert decide(f).action == "already_registered"

    def test_registered_state_is_not_work_to_do(self):
        rows = [PlanRow(facts(state_code="A", is_registered=True), decide(facts(is_registered=True)))]
        assert counts_by_action(rows)["register_now"] == 0


class TestEconomicNexus:
    def test_exceeded_is_register_now(self):
        f = facts(economic_exceeded=True, economic_pct=145.0, amazon_sales=250_000)
        d = decide(f)
        assert d.action == "register_now"
        assert d.economic_nexus == "Y"
        assert "economic threshold exceeded" in d.reason

    def test_economic_outranks_a_contested_fba_rule(self):
        """The threshold is met regardless of how inventory is treated."""
        f = facts(fba_rule="false", inventory_events=900,
                  inventory_first="2024-01-01", economic_exceeded=True,
                  economic_pct=130.0)
        d = decide(f)
        assert d.action == "register_now"
        assert d.physical_nexus == "contested"

    def test_approaching_is_monitor_with_a_percentage(self):
        f = facts(economic_pct=88.0, amazon_sales=88_000)
        d = decide(f)
        assert d.action == "monitor"
        assert d.economic_nexus == "approaching 88%"

    def test_below_the_warn_band_is_plain_monitor(self):
        d = decide(facts(economic_pct=12.0))
        assert d.action == "monitor"
        assert d.economic_nexus == "N"


class TestPhysicalNexus:
    def test_inventory_with_a_true_rule_is_high_confidence(self):
        f = facts(fba_rule="true", inventory_events=1200, inventory_first="2024-01-01")
        d = decide(f)
        assert d.action == "register_now"
        assert d.confidence == "high"
        assert d.physical_nexus == "Y"

    def test_unresearched_rule_registers_but_only_at_medium_confidence(self):
        """The repo default is conservative; the row must say so."""
        f = facts(fba_rule="unknown_default_true", inventory_events=800,
                  inventory_first="2024-03-01")
        d = decide(f)
        assert d.action == "register_now"
        assert d.confidence == "medium"
        assert "unresearched" in d.reason

    @pytest.mark.parametrize("rule", ["false", "False"])
    def test_rule_saying_no_nexus_is_review_never_register(self, rule):
        """The live NY/IL/AZ/IA/AR case."""
        f = facts(fba_rule=rule, inventory_events=4470, inventory_first="2024-01-01")
        d = decide(f)
        assert d.action == "review_contested"
        assert "does NOT create nexus" in d.reason

    @pytest.mark.parametrize("rule", ["contested", "conditional"])
    def test_unsettled_rules_are_review(self, rule):
        f = facts(fba_rule=rule, inventory_events=50, inventory_first="2025-01-01")
        d = decide(f)
        assert d.action == "review_contested"
        assert d.confidence == "medium"

    def test_no_inventory_means_no_physical_nexus(self):
        assert decide(facts()).physical_nexus == "N"

    def test_contested_never_becomes_register_now_silently(self):
        """Guard the whole class of inputs, not just one example."""
        for rule in ("false", "contested", "conditional"):
            for events in (1, 100, 99_999):
                d = decide(facts(fba_rule=rule, inventory_events=events,
                                 inventory_first="2024-01-01"))
                assert d.action != "register_now", (rule, events)


class TestEntitySeparation:
    def test_entity_exposure_alone_never_triggers_registration(self):
        """CA $800 / WA B&O must not drive a sales-tax recommendation."""
        f = facts(entity_exposure=True)   # no inventory, no economic nexus
        assert decide(f).action == "monitor"

    def test_entity_exposure_does_not_change_the_action(self):
        a = decide(facts(entity_exposure=False, inventory_events=10,
                         inventory_first="2024-01-01"))
        b = decide(facts(entity_exposure=True, inventory_events=10,
                         inventory_first="2024-01-01"))
        assert a.action == b.action and a.confidence == b.confidence


class TestOrdering:
    def test_work_comes_first(self):
        rows = [
            PlanRow(facts(state_code="Z"), decide(facts(state_code="Z", is_registered=True))),
            PlanRow(facts(state_code="Y", amazon_sales=1),
                    decide(facts(state_code="Y", inventory_events=1, inventory_first="2024-01-01"))),
        ]
        assert sort_rows(rows)[0].decision.action == "register_now"

    def test_within_an_action_bigger_exposure_ranks_higher(self):
        small = facts(state_code="S", amazon_sales=1_000, inventory_events=5,
                      inventory_first="2024-01-01")
        big = facts(state_code="B", amazon_sales=500_000, inventory_events=5,
                    inventory_first="2024-01-01")
        rows = [PlanRow(small, decide(small)), PlanRow(big, decide(big))]
        assert [r.facts.state_code for r in sort_rows(rows)] == ["B", "S"]

    def test_action_vocabulary_is_closed(self):
        for rule in ("true", "false", "contested", "conditional", "unknown_default_true"):
            for reg in (True, False):
                for tax in (True, False):
                    d = decide(facts(fba_rule=rule, is_registered=reg,
                                     has_sales_tax=tax, inventory_events=3,
                                     inventory_first="2024-01-01"))
                    assert d.action in ACTIONS


class TestCsv:
    def test_header_and_row_widths_match(self):
        f = facts(state_code="TX", amazon_sales=10.0)
        out = to_csv_rows([PlanRow(f, decide(f))])
        assert len(out) == 2 and len(out[0]) == len(out[1])

    def test_totals_are_the_sum_of_channels(self):
        f = facts(shopify_sales=100.25, amazon_sales=200.75)
        assert f.total_relevant_sales == 301.0
