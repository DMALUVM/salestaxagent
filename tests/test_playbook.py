"""PPC playbook: metrics in, ordered decisions out.

Two properties matter most: waste is cut before growth is funded, and a term
capped for BRAND is never conflated with one capped for organic RANK — those
are different decisions with different follow-ups.
"""
import pytest

from src.amazon_ads.playbook import (
    P0, P1, P2, P3, TOP_N, brand_actions, build_playbook, discovery_actions,
    growth_actions, is_rank_blocked_raise, placement_actions, rec_to_action,
    top_n_playbook, waste_actions,
)


def rec(name="kw", policy="full_increase", branded=False, needs=False,
        impact=100.0, rtype="INCREASE_BID", proposed=1.20, suggested=1.20):
    return {"entity_name": name, "type": rtype, "impact": impact,
            "evidence": {"rank_policy_applied": policy, "rank_branded": branded,
                         "needs_rank_check": needs,
                         "proposed_bid_before_rank_gate": proposed,
                         "suggested_bid": suggested}}


class TestPlacementActions:
    def test_high_acos_placement_is_p0_bid_down(self):
        a = placement_actions([{"placement": "Detail Page on-Amazon",
                                "spend": 426.68, "sales": 677.0}], 36.9)
        assert len(a) == 1 and a[0].priority == P0
        assert "Bid down" in a[0].title and "Detail Page" in a[0].title

    def test_zero_sales_placement_is_a_cut(self):
        a = placement_actions([{"placement": "Off Amazon", "spend": 120.0,
                                "sales": 0.0}], 36.9)
        assert a[0].priority == P0 and "Cut" in a[0].title
        assert a[0].impact == 120.0

    def test_a_placement_at_target_is_left_alone(self):
        assert placement_actions([{"placement": "Top of Search on-Amazon",
                                   "spend": 1353.06, "sales": 4000.0}], 36.9) == []

    def test_tiny_spend_is_not_actioned(self):
        """One unlucky click is not a placement decision."""
        assert placement_actions([{"placement": "Off Amazon", "spend": 0.78,
                                   "sales": 0.0}], 36.9) == []

    def test_excess_is_measured_against_the_target(self):
        a = placement_actions([{"placement": "DP", "spend": 100.0,
                                "sales": 100.0}], 25.0)
        assert a[0].impact == pytest.approx(75.0)


class TestBrandVsRankCaps:
    def test_branded_and_rank_capped_are_separate_cards(self):
        """'chap stick' is capped for rank, not brand — never merge them."""
        recs = [rec("tallowbourne", policy="capped", branded=True),
                rec("chap stick", policy="capped", branded=False)]
        out = brand_actions(recs)
        assert len(out) == 2
        titles = " | ".join(a.title for a in out)
        assert "Defend brand" in titles and "rank for organically" in titles

    def test_a_generic_term_is_never_called_a_brand_term(self):
        out = brand_actions([rec("chap stick", policy="capped", branded=False)])
        assert len(out) == 1
        assert "brand" not in out[0].title.lower()
        assert out[0].evidence["reason"] == "organic_rank"

    def test_brand_card_mentions_both_eras(self):
        out = brand_actions([rec("tallowbourne", policy="capped", branded=True)])
        assert "Primal Essence" in out[0].why

    def test_brand_is_never_a_growth_action(self):
        out = brand_actions([rec("tallowbourne", policy="capped", branded=True)])
        assert out[0].priority == P1
        assert "not conquest" in out[0].do or "cheap coverage" in out[0].do

    def test_uncapped_terms_produce_no_brand_card(self):
        assert brand_actions([rec("kw", policy="full_increase")]) == []


class TestGrowthActions:
    def test_gated_raises_are_p2(self):
        out = growth_actions([rec("kw1"), rec("kw2")])
        assert out[0].priority == P2 and "passed both gates" in out[0].title

    def test_needs_rank_check_is_p3_and_manual(self):
        out = growth_actions([rec("kw", policy="needs_rank_check", needs=True)])
        assert out[0].priority == P3
        assert "Do not auto-apply" in out[0].do

    def test_impact_sums_the_underlying_recommendations(self):
        out = growth_actions([rec("a", impact=50.0), rec("b", impact=25.0)])
        assert out[0].impact == pytest.approx(75.0)


class TestWasteActions:
    def test_negatives_are_p0(self):
        out = waste_actions([rec(rtype="ADD_NEGATIVE", impact=40.0)])
        assert out[0].priority == P0

    def test_bid_increases_are_not_waste(self):
        assert waste_actions([rec(rtype="INCREASE_BID")]) == []


class TestDiscoveryActions:
    def test_over_band_discovery_is_flagged(self):
        out = discovery_actions([{"role": "discovery", "budgetSharePct": 42.0,
                                  "spend": 1000.0,
                                  "targetSharePct": {"min": 15, "max": 30}}])
        assert out[0].priority == P3
        assert "42%" in out[0].title and "30%" in out[0].title

    def test_in_band_discovery_is_quiet(self):
        assert discovery_actions([{"role": "discovery", "budgetSharePct": 22.0,
                                   "spend": 1000.0,
                                   "targetSharePct": {"min": 15, "max": 30}}]) == []

    def test_the_advice_is_to_harvest_not_to_spend_more(self):
        out = discovery_actions([{"role": "discovery", "budgetSharePct": 45.0,
                                  "spend": 500.0,
                                  "targetSharePct": {"max": 30}}])
        assert "harvest" in out[0].do.lower() or "convert proven" in out[0].do

    def test_other_roles_are_ignored(self):
        assert discovery_actions([{"role": "profit", "budgetSharePct": 90.0,
                                   "spend": 1.0}]) == []


class TestOrdering:
    def test_waste_outranks_growth(self):
        recs = [rec("grow", impact=9999.0),
                rec("neg", rtype="ADD_NEGATIVE", impact=1.0)]
        out = build_playbook(36.9, recs, [], [])
        assert out[0].priority == P0
        assert [a.priority for a in out] == sorted(
            [a.priority for a in out], key=lambda p: {"P0": 0, "P1": 1, "P2": 2, "P3": 3}[p])

    def test_within_a_priority_bigger_impact_first(self):
        pl = [{"placement": "A", "spend": 100.0, "sales": 0.0},
              {"placement": "B", "spend": 500.0, "sales": 0.0}]
        out = [a for a in build_playbook(36.9, [], pl, []) if a.priority == P0]
        assert out[0].evidence["placement"] == "B"

    def test_empty_inputs_produce_no_actions(self):
        assert build_playbook(36.9, [], [], []) == []

    def test_every_action_carries_why_and_do(self):
        recs = [rec("kw"), rec("neg", rtype="ADD_NEGATIVE")]
        for a in build_playbook(36.9, recs, [{"placement": "DP", "spend": 100.0,
                                              "sales": 50.0}], []):
            assert a.why and a.do and a.priority in (P0, P1, P2, P3)


class TestTopN:
    def _open(self, **kw):
        row = rec(**kw)
        row["id"] = kw.get("id", "r-" + row["entity_name"])
        row["status"] = "open"
        row["impact_estimate"] = row["impact"]
        row["suggested_action"] = f"Do {row['entity_name']}"
        return row

    def test_cap_is_ten(self):
        recs = [self._open(name=f"waste-{i}", rtype="NEGATE_SEARCH_TERM",
                           impact=100.0 - i) for i in range(25)]
        out = top_n_playbook(36.9, recs, [], [])
        assert len(out) == TOP_N == 10

    def test_waste_outranks_a_larger_scale(self):
        recs = [
            self._open(name="grow", rtype="INCREASE_BID", impact=9999.0),
            self._open(name="neg", rtype="NEGATE_SEARCH_TERM", impact=12.0,
                       policy=None),
        ]
        recs[0]["priority"] = P1
        recs[1]["priority"] = P0
        recs[0]["evidence"]["rank_policy_applied"] = "full_increase"
        out = top_n_playbook(36.9, recs, [], [])
        assert out[0].priority == P0
        assert "neg" in out[0].title

    def test_placement_cut_is_in_the_top_n(self):
        recs = [self._open(name="grow", rtype="INCREASE_BID", impact=50.0)]
        pl = [{"placement": "Detail Page on-Amazon", "spend": 400.0, "sales": 200.0}]
        out = top_n_playbook(36.9, recs, pl, [])
        assert any("Detail Page" in a.title for a in out)
        assert out[0].priority == P0

    def test_rank_blocked_raise_is_excluded(self):
        blocked = self._open(name="held", policy="capped", branded=True,
                             impact=500.0)
        blocked["type"] = "INCREASE_BID"
        blocked["evidence"]["rank_policy_applied"] = "capped"
        assert is_rank_blocked_raise(blocked)
        waste = self._open(name="neg", rtype="NEGATE_SEARCH_TERM", impact=10.0)
        waste["priority"] = P0
        out = top_n_playbook(36.9, [blocked, waste], [], [])
        assert all("held" not in a.title for a in out)
        assert out[0].evidence.get("entity_name") == "neg" or "neg" in out[0].title

    def test_applied_recs_are_skipped(self):
        r = self._open(name="done", rtype="NEGATE_SEARCH_TERM", impact=80.0)
        r["status"] = "applied"
        r["priority"] = P0
        assert top_n_playbook(36.9, [r], [], []) == []

    def test_rec_to_action_keeps_id_and_impact_estimate(self):
        r = self._open(name="term", rtype="NEGATE_SEARCH_TERM", impact=42.5)
        r["priority"] = P0
        r["evidence"]["why"] = "Spent $42.50 with 0 orders."
        a = rec_to_action(r)
        assert a.rec_id == r["id"]
        assert a.impact == 42.5
        assert a.why.startswith("Spent")
        assert a.as_dict()["rec_id"] == r["id"]

    def test_does_not_emit_more_than_n(self):
        recs = [self._open(name=f"n-{i}", rtype="NEGATE_SEARCH_TERM",
                           impact=10.0) for i in range(8)]
        pl = [{"placement": "A", "spend": 100.0, "sales": 0.0},
              {"placement": "B", "spend": 80.0, "sales": 0.0},
              {"placement": "C", "spend": 60.0, "sales": 0.0}]
        out = top_n_playbook(36.9, recs, pl, [], n=5)
        assert len(out) == 5
