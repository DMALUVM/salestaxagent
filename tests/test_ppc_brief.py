"""PPC Command Brief — formula stability and brief contract.

The brief is pasted into an LLM that is told to reason ONLY from it. That makes
two ordinary-looking bugs severe:

  - a silently omitted section reads as "nothing to worry about here", so every
    section must print an explicit "No data" instead of vanishing;
  - a drifting score makes week-over-week comparison meaningless, so the
    arithmetic is pinned to a golden fixture rather than merely "returning a
    number in range".

No database access here. compute_grade() takes plain numbers precisely so the
formula can be tested without a live account.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.amazon_ads import export_brief
from src.amazon_ads.brief_score import CONFIG, compute_grade, load_config

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "ppc_brief.json"


# A healthy-but-imperfect account. Pinned so a weight change is a deliberate,
# reviewed edit rather than an accident nobody notices until two briefs disagree.
GOLDEN = dict(
    acos=32.0, breakeven_acos=40.0, tacos=12.0,
    waste_spend=300.0, total_spend=3000.0,
    placements={
        "Top of Search": {"spend": 1200.0, "sales": 4000.0},
        "Detail Page": {"spend": 900.0, "sales": 1200.0},
        "Rest of Search": {"spend": 600.0, "sales": 1500.0},
    },
    brand_spend=300.0, non_brand_acos=35.0, non_brand_terms=12,
    rank_coverage_pct=50.0, sqp_age_days=10, ads_age_days=1,
)


def test_score_is_stable_for_fixed_inputs():
    """The same inputs must always produce the same score."""
    a = compute_grade(**GOLDEN)
    b = compute_grade(**GOLDEN)
    assert a.score == b.score
    # Pinned value. If a weight or breakpoint changes this SHOULD fail — bump
    # formula_version and update this number in the same commit.
    # Verified by hand against the config breakpoints, not merely recorded from
    # a run: 87.5/100/80/10.42/100/78.13 weighted 25/15/20/15/10/15 = 76.156,
    # x completeness modifier 0.9933 = 75.649.
    assert round(a.score, 2) == pytest.approx(75.65, abs=0.01), (
        f"score moved to {a.score:.2f} — if intentional, bump formula_version "
        f"in config/ppc_brief.json and update this pin")
    assert a.formula_version == CONFIG["formula_version"]


@pytest.mark.parametrize("mutation,expected", [
    ({"acos": 100.0}, "lower"),      # far above break-even
    ({"waste_spend": 900.0}, "lower"),
    ({"tacos": 40.0}, "lower"),
    ({"acos": 20.0}, "higher"),
    ({"waste_spend": 0.0}, "higher"),
])
def test_score_moves_in_the_right_direction(mutation, expected):
    base = compute_grade(**GOLDEN).score
    moved = compute_grade(**{**GOLDEN, **mutation}).score
    if expected == "lower":
        assert moved < base, f"{mutation} should reduce the score"
    else:
        assert moved > base, f"{mutation} should raise the score"


def test_score_always_within_0_and_100():
    """Including at the absurd extremes, where a linear formula would overshoot."""
    extremes = [
        dict(GOLDEN, acos=0.1, waste_spend=0.0, tacos=8.0, brand_spend=0.0,
             non_brand_acos=1.0, rank_coverage_pct=100.0, sqp_age_days=0,
             ads_age_days=0),
        dict(GOLDEN, acos=900.0, waste_spend=3000.0, tacos=99.0,
             brand_spend=3000.0, non_brand_acos=900.0, rank_coverage_pct=0.0,
             sqp_age_days=400, ads_age_days=400),
    ]
    for e in extremes:
        assert 0.0 <= compute_grade(**e).score <= 100.0


def test_missing_data_is_dropped_not_scored_zero():
    """Absence must not be punished as failure — that is the whole point."""
    without = compute_grade(**{**GOLDEN, "tacos": None})
    assert "tacos_vs_band" in without.dropped
    comp = next(c for c in without.components if c.key == "tacos_vs_band")
    assert comp.score is None
    assert "dropped" in comp.detail.lower()

    # A dropped component renormalises; it must not drag the score toward zero.
    zeroed = compute_grade(**{**GOLDEN, "tacos": 99.0})
    assert without.score > zeroed.score


def test_no_measurable_component_does_not_masquerade_as_a_bad_account():
    g = compute_grade(acos=None, breakeven_acos=None, tacos=None, waste_spend=None,
                      total_spend=0.0, placements={}, brand_spend=None,
                      non_brand_acos=None, non_brand_terms=0,
                      rank_coverage_pct=None, sqp_age_days=None, ads_age_days=None)
    assert g.score == 0.0
    assert len(g.dropped) == 6, "every component should be dropped, none scored"


def test_completeness_only_ever_modifies_within_its_declared_band():
    m = CONFIG["grade"]["completeness_modifier"]
    best = compute_grade(**{**GOLDEN, "rank_coverage_pct": 100.0,
                            "sqp_age_days": 0, "ads_age_days": 0})
    worst = compute_grade(**{**GOLDEN, "rank_coverage_pct": 0.0,
                             "sqp_age_days": 999, "ads_age_days": 999})
    assert best.modifier == pytest.approx(m["max_multiplier"])
    assert worst.modifier == pytest.approx(m["min_multiplier"])
    # It is a modifier, not a component: it can never swing the grade wildly.
    assert best.score - worst.score < best.weighted_before_modifier * 0.11


def test_every_component_reports_its_working():
    for c in compute_grade(**GOLDEN).components:
        assert c.detail.strip(), f"{c.key} must show its arithmetic"
        assert c.label.strip()


def test_weights_sum_to_100():
    total = sum(c["weight"] for c in CONFIG["grade"]["components"].values())
    assert total == 100, f"component weights sum to {total}, not 100"


def test_letters_cover_the_whole_range_descending():
    letters = CONFIG["grade"]["letters"]
    mins = [row["min"] for row in letters]
    assert mins == sorted(mins, reverse=True), "letter bands must descend"
    assert mins[-1] == 0, "the lowest band must catch every score"


def test_config_on_disk_matches_loaded_config():
    assert json.loads(CONFIG_PATH.read_text()) == load_config()


# ── brief contract ───────────────────────────────────────────────────────

def _empty_gathered() -> dict:
    """A window where every feed returned nothing — the worst case for silence."""
    return {
        "as_of": "2026-08-20", "start": "2026-08-14", "days": 7,
        "prior_start": "2026-08-07", "prior_end": "2026-08-13",
        "gaps": [], "by_type": {}, "spend": 0.0, "ad_sales": 0.0, "clicks": 0,
        "orders": 0, "amazon_sales": 0.0, "placements": {}, "placement_spend": 0.0,
        "unallocated": 0.0, "terms": {}, "target_acos": 40.0,
        "target_basis": "breakeven_weighted", "recs": [], "rank_rows": 0,
        "rank_as_of": None, "brand_weeks": [], "outcomes": [], "applied_count": 0,
        "applied_recs": [], "prior": {}, "brand_spend": None, "waste_spend": None,
        "non_brand_rank_eligible": {"spend": 0.0, "sales": 0.0, "terms": 0,
                                    "acos": None},
        "rank_coverage_pct": None,
        "freshness": {"ads_last_sync": None, "ads_age_days": None,
                      "sqp_last_week_end": None, "sqp_age_days": None,
                      "ads_last_date": None},
    }


def test_empty_sections_say_no_data_rather_than_disappearing():
    brief = export_brief.build_brief(_empty_gathered())
    for heading in ("Placement economics", "Search terms", "Organic rank gate",
                    "Branded vs non-branded", "Action plan", "Learning ledger"):
        assert heading in brief, f"section '{heading}' vanished when empty"
    # Every one of those empty sections must carry the marker.
    assert brief.count(export_brief.NO_DATA) >= 6, (
        "an omitted section reads to a model as 'nothing to worry about'")


def test_brief_never_claims_full_category_share():
    d = _empty_gathered()
    d["brand_weeks"] = [{"week_start": "2026-08-09", "branded_purchases": 12,
                         "non_branded_purchases": 345, "branded_mix": 0.034,
                         "non_branded_share_present": 0.0017}]
    brief = export_brief.build_brief(d)
    assert "ASIN view" in brief
    assert "not Brand View parity" in brief


def test_grade_section_shows_the_formula_version_and_working():
    brief = export_brief.build_brief(_empty_gathered())
    assert "Formula version" in brief
    assert CONFIG["formula_version"] in brief
    assert "completeness modifier" in brief.lower()


def test_action_plan_excludes_rank_blocked_raises():
    """A raise the gate is holding must never be emitted as 'raise bid'."""
    d = _empty_gathered()
    d["recs"] = [
        {"priority": "P2", "type": "INCREASE_BID", "entity_name": "held term",
         "status": "open", "impact_estimate": 50.0, "campaign_name": "C",
         "suggested_action": "Raise bid to $3.00",
         "evidence": {"needs_rank_check": True, "campaign_id": "1"}},
        {"priority": "P2", "type": "INCREASE_BID", "entity_name": "capped term",
         "status": "open", "impact_estimate": 40.0, "campaign_name": "C",
         "suggested_action": "Raise bid to $2.00",
         "evidence": {"rank_policy_applied": "capped", "campaign_id": "1"}},
        {"priority": "P0", "type": "ADD_NEGATIVE", "entity_name": "waste term",
         "status": "open", "impact_estimate": 90.0, "campaign_name": "C",
         "suggested_action": "Add as exact negative",
         "evidence": {"spend": 90.0, "orders": 0, "campaign_id": "1"}},
    ]
    plan = export_brief._action_plan(d, 15)
    names = [a["title"] for a in plan]
    assert any("waste term" in n for n in names)
    assert not any("held term" in n or "capped term" in n for n in names), (
        "rank-blocked raises must not appear as actions")

    brief = export_brief.build_brief(d)
    assert "Raises the gate is blocking" in brief
    assert "held term" in brief, "blocked raises must still be VISIBLE, just not actions"


def test_action_plan_only_draws_from_stored_recommendations():
    """No action may be synthesised — each must trace to a recommendation row."""
    d = _empty_gathered()
    assert export_brief._action_plan(d, 15) == []


def test_action_plan_is_p0_first_and_capped():
    d = _empty_gathered()
    d["recs"] = [
        {"priority": "P3", "type": "ADD_NEGATIVE", "entity_name": f"t{i}",
         "status": "open", "impact_estimate": 1.0, "campaign_name": "C",
         "suggested_action": "x", "evidence": {"campaign_id": "1"}}
        for i in range(30)
    ] + [{"priority": "P0", "type": "ADD_NEGATIVE", "entity_name": "urgent",
          "status": "open", "impact_estimate": 5.0, "campaign_name": "C",
          "suggested_action": "x", "evidence": {"campaign_id": "1"}}]
    plan = export_brief._action_plan(d, CONFIG["action_plan"]["max_actions"])
    assert len(plan) == CONFIG["action_plan"]["max_actions"]
    assert plan[0]["priority"] == "P0"


def test_every_action_carries_a_campaign_and_a_risk():
    d = _empty_gathered()
    d["recs"] = [{"priority": "P0", "type": "ADD_NEGATIVE", "entity_name": "t",
                  "status": "open", "impact_estimate": 5.0,
                  "campaign_name": "Brand Exact", "suggested_action": "negate",
                  "evidence": {"campaign_id": "abc123", "spend": 40.0}}]
    a = export_brief._action_plan(d, 15)[0]
    assert "abc123" in a["where"] and "Brand Exact" in a["where"]
    assert a["risk"].strip() and a["evidence"].strip()


def test_manager_questions_are_questions_not_claims():
    qs = export_brief._manager_questions(_populated(), compute_grade(**GOLDEN))
    assert 5 <= len(qs) <= 12, f"expected 5-12 questions, got {len(qs)}"
    for q in qs:
        assert "?" in q, f"not a question: {q}"


def test_an_empty_brief_asks_few_questions_rather_than_generic_ones():
    """With no data there is nothing to ask a manager ABOUT.

    Padding to a minimum count would mean emitting exactly the ungrounded,
    generic questions the policy exists to prevent.
    """
    qs = export_brief._manager_questions(_empty_gathered(), compute_grade(**GOLDEN))
    assert len(qs) < CONFIG["question_policy"]["min_questions"]
    blob = " ".join(qs).lower()
    for banned in CONFIG["question_policy"]["banned_keywords"]:
        assert banned not in blob


def test_prompt_wrapper_carries_every_hard_rule_and_output_section():
    prompt = export_brief.build_prompt("BRIEF BODY")
    for rule in CONFIG["receiving_model_rules"]:
        # The first clause is enough to prove the rule survived into the wrapper.
        assert rule.split(".")[0] in prompt, f"missing rule: {rule[:50]}"
    for section in CONFIG["required_output_sections"]:
        assert section in prompt, f"missing output section: {section}"
    assert "insufficient evidence" in prompt
    assert "BRIEF BODY" in prompt


def test_wrapper_forbids_outside_knowledge_explicitly():
    prompt = export_brief.build_prompt("x")
    low = prompt.lower()
    assert "only this brief" in low
    assert "do not invent" in low or "do not estimate" in low


@pytest.mark.parametrize("typ,must_contain", [
    ("NEGATE_SEARCH_TERM", "no attributed return"),
    ("WASTED_SPEND_ROLLUP", "no attributed return"),
    ("REDUCE_BID", "break-even"),
    ("ADJUST_TOS_MODIFIER", "one setting per campaign"),
    ("HARVEST_SEARCH_TERM", "already proven"),
    ("INCREASE_BID", "incremental volume"),
])
def test_risk_line_matches_the_action_direction(typ, must_contain):
    """A negate must not be described with the risk of skipping a bid RAISE.

    The first version matched an exact allow-list of type names that this
    account does not use, so every NEGATE_SEARCH_TERM fell through to the
    growth branch and told the operator that failing to negate a waste term
    would "leave incremental volume unclaimed" — the opposite of the truth.
    """
    risk = export_brief._risk_for(typ, {"spend": 28.96})
    assert must_contain in risk, f"{typ} produced: {risk}"


def test_negate_risk_does_not_borrow_growth_language():
    for typ in ("NEGATE_SEARCH_TERM", "WASTED_SPEND_ROLLUP", "REDUCE_BID"):
        risk = export_brief._risk_for(typ, {"spend": 10.0})
        assert "incremental volume" not in risk, f"{typ} used growth phrasing"


def test_every_stored_action_type_has_a_specific_risk():
    """No live type may fall through to the generic branch."""
    generic = export_brief._risk_for("SOMETHING_UNKNOWN", {})
    for typ in ("INCREASE_BID", "HARVEST_SEARCH_TERM", "REDUCE_BID",
                "NEGATE_SEARCH_TERM", "WASTED_SPEND_ROLLUP", "ADJUST_TOS_MODIFIER"):
        assert export_brief._risk_for(typ, {}) != generic, (
            f"{typ} has no specific risk line")


# ── output format contract ───────────────────────────────────────────────

def _populated() -> dict:
    """A window with enough of everything to exercise every table."""
    d = _empty_gathered()
    d["by_type"] = {"SP": {"spend": 2800.0, "sales": 6830.0, "clicks": 1800},
                    "SB": {"spend": 203.85, "sales": 662.84, "clicks": 100}}
    d["spend"], d["ad_sales"], d["amazon_sales"] = 3010.34, 7520.84, 21965.40
    d["prior"] = {"spend": 2802.38, "sales": 7515.67, "orders": 513, "clicks": 1963}
    d["placements"] = {"Detail Page": {"spend": 426.68, "sales": 673.54, "clicks": 200}}
    d["placement_spend"], d["unallocated"] = 426.68, 2583.66
    d["terms"] = {
        "waste term": {"term": "waste term", "spend": 28.96, "sales": 0.0,
                       "orders": 0, "clicks": 20, "branded": False, "rank": None,
                       "campaigns": {"1": {"name": "GG - Asin Offense", "spend": 28.96}}},
        "good term": {"term": "good term", "spend": 213.20, "sales": 866.68,
                      "orders": 59, "clicks": 150, "branded": False, "rank": 99,
                      "campaigns": {"2": {"name": "SP KW Exact", "spend": 213.20}}},
        "split term": {"term": "split term", "spend": 251.22, "sales": 300.0,
                       "orders": 5, "clicks": 90, "branded": False, "rank": 5,
                       "campaigns": {"3": {"name": "A" * 60, "spend": 200.0},
                                     "4": {"name": "B camp", "spend": 51.22}}},
    }
    d["recs"] = [
        {"priority": "P0", "type": "NEGATE_SEARCH_TERM", "entity_name": "waste term",
         "status": "open", "impact_estimate": 28.96, "campaign_name": "GG - Asin Offense",
         "ad_group_id": 999, "suggested_action": "In Campaign Manager, open campaign "
         '"GG - Asin Offense" → Negative keywords. It has spent $28.96 with 0 orders.',
         "evidence": {"campaign_id": "1", "spend": 28.96, "orders": 0,
                      "ad_groups": ["Asin Offense"], "why": "zero orders"}},
        {"priority": "P1", "type": "INCREASE_BID", "entity_name": "good term",
         "status": "open", "impact_estimate": 40.0, "campaign_name": "SP KW Exact",
         "suggested_action": "Raise the bid to $1.59.",
         "evidence": {"campaign_id": "2", "spend": 213.2, "sales": 866.68,
                      "orders": 59, "acos": 24.6, "organic_rank": 99,
                      "rank_policy_applied": "full_increase", "ad_groups": ["Exact"],
                      "why": "59 orders at 25% ACOS"}},
        {"priority": "P2", "type": "INCREASE_BID", "entity_name": "held term",
         "status": "open", "impact_estimate": 10.0, "campaign_name": "C",
         "suggested_action": "Raise bid",
         "evidence": {"campaign_id": "5", "needs_rank_check": True,
                      "proposed_bid_before_rank_gate": 2.55, "suggested_bid": 2.22}},
    ]
    d["gaps"] = ["No SD rows for this window — Seller Central totals include it.",
                 "No recorded outcomes yet. Until applied actions are marked…",
                 "Only 2 week(s) of SQP stored — brand-mix trend is not reliable."]
    d["rank_coverage_pct"] = 22.0
    return d


def _tables_in(section: str) -> int:
    return sum(1 for ln in section.splitlines() if ln.strip().startswith("| ---"))


def _section(brief: str, heading: str) -> str:
    start = brief.index(heading)
    nxt = brief.find("\n## ", start + 1)
    return brief[start: nxt if nxt > -1 else len(brief)]


def test_body_sections_appear_in_the_fixed_order():
    brief = export_brief.build_brief(_populated())
    order = ["## 0. Data freshness", "## 1. Performance grade",
             "## 2. Account economics", "## 3. Placement economics",
             "## 4. Search terms", "## 5. Organic rank gate",
             "## 6. Branded vs non-branded", "## 7. Action plan",
             "## 8. Learning ledger", "## 9. Questions for the PPC manager",
             "## 10. Known gaps"]
    positions = [brief.index(h) for h in order]
    assert positions == sorted(positions), "sections are out of contract order"


@pytest.mark.parametrize("heading", [
    "## 0. Data freshness", "## 1. Performance grade", "## 2. Account economics",
    "## 3. Placement economics", "## 4. Search terms", "## 5. Organic rank gate",
    "## 7. Action plan", "## 10. Known gaps",
])
def test_each_section_renders_at_least_one_markdown_table(heading):
    brief = export_brief.build_brief(_populated())
    assert _tables_in(_section(brief, heading)) >= 1, f"{heading} has no table"


def test_action_plan_is_two_tables_with_the_agreed_columns():
    brief = export_brief.build_brief(_populated())
    plan = _section(brief, "## 7. Action plan")
    assert "### P0 — stop the bleeding" in plan
    assert "### P1 — raises and placement modifiers" in plan
    for col in ("| # |", "Type", "Term", "Campaign", "Campaign ID", "Ad group",
                "Seller Central step", "Evidence"):
        assert col in plan, f"action table missing column {col}"
    assert _tables_in(plan) == 2, "expected exactly a P0 and a P1 table"


def test_action_rows_carry_the_campaign_id_and_ad_group():
    plan = export_brief._action_plan(_populated(), 15)
    p0 = next(a for a in plan if a["priority"] == "P0")
    assert p0["campaign_id"] == "1"
    assert p0["ad_group"] == "Asin Offense", "ad group lives in evidence['ad_groups']"
    assert "Negative keywords" in p0["step"]


def test_table_cells_escape_pipes_so_a_row_cannot_be_corrupted():
    """A campaign name containing '|' would otherwise add phantom columns."""
    d = _populated()
    d["recs"][0]["campaign_name"] = "SP | TBL | Exact"
    row = export_brief._action_plan(d, 15)[0]
    assert "\\|" in row["campaign"]
    assert row["campaign"].count("|") == row["campaign"].count("\\|")


def test_step_text_does_not_repeat_the_campaign_or_the_evidence():
    plan = export_brief._action_plan(_populated(), 15)
    step = next(a for a in plan if a["priority"] == "P0")["step"]
    assert "GG - Asin Offense" not in step, "campaign has its own column"
    assert "It has spent" not in step, "evidence has its own column"


def test_gaps_are_a_ranked_table_with_the_loop_first():
    d = _populated()
    ranked = export_brief._ranked_gaps(d)
    assert "outcomes" in ranked[0]["gap"].lower(), (
        "an unclosed learning loop outranks a thin SQP history: it makes every "
        "recommendation rules-only rather than weakening one section")
    assert all(g["blocks"] for g in ranked)
    assert _tables_in(_section(export_brief.build_brief(d), "## 10. Known gaps")) == 1


# ── section 9 question policy ────────────────────────────────────────────

def test_questions_are_within_the_allowed_count():
    qs = export_brief._manager_questions(_populated(), compute_grade(**GOLDEN))
    policy = CONFIG["question_policy"]
    assert policy["min_questions"] <= len(qs) <= policy["max_questions"], len(qs)


def test_questions_contain_no_banned_topics():
    """These are real questions — but not for a PPC manager, and not in this brief.

    Asking them invites the receiving model to treat the answer as new evidence
    and reason past the data it was given.
    """
    qs = export_brief._manager_questions(_populated(), compute_grade(**GOLDEN))
    blob = " ".join(qs).lower()
    for banned in CONFIG["question_policy"]["banned_keywords"]:
        assert banned not in blob, f"banned topic '{banned}' appeared in section 9"


def test_questions_also_absent_from_the_rendered_section():
    section = _section(export_brief.build_brief(_populated()),
                       "## 9. Questions for the PPC manager").lower()
    for banned in CONFIG["question_policy"]["banned_keywords"]:
        assert banned not in section, f"banned topic '{banned}' rendered in section 9"


def test_every_question_cites_something_from_this_brief():
    """A question the brief cannot ground gets answered from imagination."""
    d = _populated()
    qs = export_brief._manager_questions(d, compute_grade(**GOLDEN))
    campaigns = {c["name"] for t in d["terms"].values()
                 for c in t["campaigns"].values()}
    anchors = ({t for t in d["terms"]} | campaigns
               | {"Detail Page", "ads-mark", "SB", "SD", "P0", "rank"})
    for q in qs:
        assert any(a[:20] in q for a in anchors) or "$" in q or "%" in q, (
            f"question cites nothing from the brief: {q}")


def test_questions_are_questions():
    for q in export_brief._manager_questions(_populated(), compute_grade(**GOLDEN)):
        assert q.rstrip().endswith("?"), f"not a question: {q}"


def test_campaign_names_are_never_truncated_without_an_ellipsis():
    """A silently cut name reads as real and is searched for in vain."""
    qs = export_brief._manager_questions(_populated(), compute_grade(**GOLDEN))
    long_name = "A" * 60
    cited = [q for q in qs if "A" * 30 in q]
    for q in cited:
        assert long_name in q or "…" in q, f"name cut with no ellipsis: {q}"


# ── wrapper additions ────────────────────────────────────────────────────

def test_wrapper_demands_tables_and_checklist_sections():
    p = export_brief.build_prompt("BODY")
    low = p.lower()
    assert "markdown tables" in low or "tables" in low
    assert "ordered checklist" in low
    assert "campaign id" in low, "Section B must carry ids through to the output"


def test_wrapper_scopes_manager_questions_to_execution():
    p = export_brief.build_prompt("BODY").lower()
    assert "execution only" in p or "execution" in p
    for banned in ("budget ceiling", "inventory", "seasonality", "creative"):
        assert banned in p, (
            "the wrapper must NAME the banned topics to suppress them; "
            f"'{banned}' is not mentioned")
