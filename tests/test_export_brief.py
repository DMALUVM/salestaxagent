"""The full PPC brief: complete, honest about scope, and free of invention.

Two properties matter. The brief must carry the evidence the recommendations
were actually built from — not a summary the model has to guess around — and it
must state what is NOT known so the model says "insufficient evidence" instead
of estimating.
"""
import pytest

from src.amazon_ads.export_brief import build_brief, build_prompt


def base(**kw):
    d = {
        "as_of": "2026-08-20", "start": "2026-08-14", "days": 7, "gaps": [],
        "spend": 3010.34, "ad_sales": 7520.84, "clicks": 1924, "orders": 508,
        "amazon_sales": 21965.40,
        "by_type": {"SP": {"spend": 2800.73, "sales": 6830.02, "clicks": 1800},
                    "SB": {"spend": 203.85, "sales": 662.84, "clicks": 120}},
        "placements": {"Detail Page on-Amazon": {"spend": 426.68, "sales": 673.54,
                                                 "clicks": 300}},
        "placement_spend": 426.68, "unallocated": 2583.66,
        "terms": {}, "target_acos": 36.9, "target_basis": "breakeven_weighted",
        "recs": [], "rank_rows": 881, "rank_as_of": "2026-08-15",
        "brand_weeks": [], "outcomes": [], "applied_count": 0,
    }
    d.update(kw)
    return d


class TestCompleteness:
    def test_every_major_section_is_present(self):
        b = build_brief(base())
        for heading in ("Data freshness", "Performance grade",
                        "Account economics", "Placement economics",
                        "Organic rank gate", "Action plan",
                        "Learning ledger", "Questions for the PPC manager"):
            assert heading in b, heading

    def test_break_even_is_explained_not_just_stated(self):
        b = build_brief(base())
        assert "36.9%" in b and "COGS" in b
        assert "a sale loses money" in b

    def test_ad_product_split_is_itemised(self):
        b = build_brief(base())
        assert "SP" in b and "SB" in b and "2,800.73" in b

    def test_placement_verdict_flags_over_break_even(self):
        b = build_brief(base())
        assert "OVER" in b   # DP at 63% vs 36.9% target

    def test_actions_carry_their_reasoning_and_economics(self):
        rec = {"priority": "P1", "type": "INCREASE_BID", "entity_name": "kw",
               "campaign_name": "C", "suggested_action": "Raise it",
               "impact_estimate": 120.0,
               "evidence": {"why": "converts under target", "cpc": 1.5,
                            "spend": 50.0, "sales": 200.0, "orders": 4, "acos": 25,
                            "rank_policy_applied": "full_increase",
                            "cannibalization_risk": "low", "organic_rank": 99}}
        b = build_brief(base(recs=[rec]))
        assert "converts under target" in b
        assert "Organic rank gate" in b and "full_increase" in b

    def test_multi_campaign_overlap_is_surfaced(self):
        terms = {"chapstick": {"term": "chapstick", "spend": 251.22, "sales": 685.51,
                               "orders": 48, "clicks": 100, "match_types": set(),
                               "campaigns": {"1": {"name": "A", "spend": 242.19},
                                             "2": {"name": "B", "spend": 9.03}}}}
        b = build_brief(base(terms=terms))
        assert "more than one campaign" in b
        assert "bidding against itself" in b


class TestHonesty:
    def test_rank_is_described_as_a_band_not_a_position(self):
        b = build_brief(base())
        assert "BAND" in b
        assert "not a measured serp position" in b.lower()
        assert "publishes no organic rank" in b  # Advertising API, however phrased

    def test_sqp_scope_gap_is_stated_with_the_brand_data(self):
        weeks = [{"week_start": "2026-08-09", "branded_purchases": 12,
                  "non_branded_purchases": 345, "branded_mix": 0.03,
                  "non_branded_share_present": 0.0026}]
        b = build_brief(base(brand_weeks=weeks))
        assert "not Brand View parity" in b
        assert "trend is reliable" in b.lower()

    def test_unallocated_spend_is_explained_not_hidden(self):
        b = build_brief(base())
        assert "sponsored products only" in b.lower()
        assert "expected, not missing data" in b

    def test_gaps_are_rendered_as_constraints(self):
        b = build_brief(base(gaps=["No SD rows for this window."]))
        assert "Known gaps" in b
        assert "State these as limits" in b
        assert "No SD rows" in b

    def test_the_as_of_rule_is_stated(self):
        b = build_brief(base())
        assert "America/Los_Angeles" in b
        assert "Today is still accruing" in b


class TestLearningLedger:
    def test_an_empty_loop_is_reported_as_not_yet_learning(self):
        b = build_brief(base())
        assert "loop is not closed" in b
        assert "RULES-BASED ONLY" in b

    def test_it_names_the_command_that_closes_the_loop(self):
        b = build_brief(base())
        assert "ads-mark" in b

    def test_measured_outcomes_are_summarised_when_present(self):
        b = build_brief(base(outcomes=[{"action_type": "NEGATE_SEARCH_TERM"}],
                             applied_count=3))
        assert "Outcomes measured" in b
        assert "NEGATE_SEARCH_TERM" in b

    def test_outcomes_are_labelled_observational(self):
        b = build_brief(base(outcomes=[{"action_type": "X"}]))
        assert "Observational, not causal" in b
        assert "no holdout" in b


class TestPrompt:
    def test_the_model_is_constrained_to_the_brief(self):
        p = build_prompt("BRIEF")
        assert "Use ONLY" in p
        assert "insufficient evidence" in p
        assert "Do not invent" in p

    def test_the_standing_constraints_are_restated(self):
        p = build_prompt("BRIEF")
        assert "defend line, never a growth lever" in p
        assert "stay held" in p and "do not recommend raising" in p

    def test_it_asks_what_data_would_improve_next_week(self):
        assert "Data gaps to close" in build_prompt("BRIEF")

    def test_the_brief_is_embedded(self):
        assert "BRIEF" in build_prompt("BRIEF")
