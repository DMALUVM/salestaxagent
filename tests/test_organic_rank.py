"""Organic-rank gating for PPC bid increases.

The rule being protected: do not pay hard for traffic we already own
organically. The gate is one-directional — it restrains increases only, and
must never interfere with cutting waste.
"""
from datetime import date, timedelta

import pytest

from src.amazon_ads.organic_rank import (
    POLICY_CAPPED, POLICY_DISABLED, POLICY_FULL, POLICY_HOLD,
    POLICY_NEEDS_CHECK, POLICY_UNKNOWN_OK, RISK_HIGH, RISK_LOW, RISK_MEDIUM,
    RISK_UNKNOWN, apply_rank_policy, build_rank_info, is_branded, lookup,
    normalize_keyword,
)

TODAY = date(2026, 8, 21)

CFG = {
    "enabled": True,
    "high_bid_threshold": 2.30,
    "rank_1_3_max_increase_pct": 8,
    "rank_4_7_max_increase_pct": 12,
    "stale_after_days": 14,
    "brand_tokens": ["tallowbourn", "tallowbourne", "dr dave", "dr. dave"],
    "default_asin": "B0CLHTF8YN",
}


def rank_row(rank=1, days_ago=1, source="sqp", page=None):
    return {"organic_rank": rank, "page": page, "source": source,
            "as_of": (TODAY - timedelta(days=days_ago)).isoformat()}


class TestNormalization:
    @pytest.mark.parametrize("raw,expected", [
        ("  Tallow  Lip  BALM ", "tallow lip balm"),
        ("Beef Tallow", "beef tallow"),
        ("", ""),
        (None, ""),
    ])
    def test_normalize(self, raw, expected):
        assert normalize_keyword(raw) == expected

    def test_join_matches_regardless_of_casing_and_spacing(self):
        ranks = {("A1", "tallow lip balm"): rank_row(2)}
        info = lookup(ranks, "  Tallow   LIP Balm ", "A1", CFG, TODAY)
        assert info.effective_rank == 2


class TestRankPolicy:
    def test_rank_1_caps_a_15pct_proposal(self):
        """Rank 1 + proposed +15% → capped to the configured +8%."""
        info = build_rank_info(rank_row(1), "tallow balm", CFG, TODAY)
        g = apply_rank_policy(1.00, 1.15, info, CFG)
        assert g.policy == POLICY_CAPPED
        assert g.allowed_bid == 1.08
        assert g.risk == RISK_HIGH

    @pytest.mark.parametrize("rank", [1, 2, 3])
    def test_top_three_are_all_capped(self, rank):
        info = build_rank_info(rank_row(rank), "kw", CFG, TODAY)
        assert apply_rank_policy(2.00, 2.30, info, CFG).policy == POLICY_CAPPED

    def test_rank_1_holds_when_cap_is_zero(self):
        cfg = {**CFG, "rank_1_3_max_increase_pct": 0}
        info = build_rank_info(rank_row(1), "kw", cfg, TODAY)
        g = apply_rank_policy(1.00, 1.15, info, cfg)
        assert g.policy == POLICY_HOLD
        assert g.allowed_bid == 1.00

    def test_rank_5_uses_the_moderate_cap(self):
        info = build_rank_info(rank_row(5), "kw", CFG, TODAY)
        g = apply_rank_policy(1.00, 1.20, info, CFG)
        assert g.policy == POLICY_CAPPED
        assert g.allowed_bid == 1.12
        assert g.risk == RISK_MEDIUM

    def test_rank_10_allows_the_full_increase(self):
        """Rank 10 + proposed +15% → full increase allowed."""
        info = build_rank_info(rank_row(10), "kw", CFG, TODAY)
        g = apply_rank_policy(1.00, 1.15, info, CFG)
        assert g.policy == POLICY_FULL
        assert g.allowed_bid == 1.15
        assert g.risk == RISK_LOW

    def test_a_proposal_inside_the_cap_is_not_reduced(self):
        info = build_rank_info(rank_row(1), "kw", CFG, TODAY)
        g = apply_rank_policy(1.00, 1.03, info, CFG)
        assert g.policy == POLICY_FULL
        assert g.allowed_bid == 1.03

    def test_page_two_with_no_rank_is_low_risk(self):
        info = build_rank_info(rank_row(rank=None, page=2), "kw", CFG, TODAY)
        assert info.effective_rank == 99
        assert apply_rank_policy(1.00, 1.20, info, CFG).policy == POLICY_FULL


class TestUnknownRank:
    def test_high_bid_needs_a_manual_check(self):
        """Rank unknown + bid $2.50 → needs_rank_check."""
        info = build_rank_info(None, "beef tallow balm", CFG, TODAY)
        g = apply_rank_policy(2.00, 2.50, info, CFG)
        assert g.policy == POLICY_NEEDS_CHECK
        assert g.needs_manual_check is True
        assert g.allowed_bid == 2.00      # not raised
        assert g.risk == RISK_UNKNOWN

    def test_low_bid_is_allowed_with_a_note(self):
        """Rank unknown + bid $1.20 → allowed, flagged rank_unknown."""
        info = build_rank_info(None, "beef tallow balm", CFG, TODAY)
        g = apply_rank_policy(1.00, 1.20, info, CFG)
        assert g.policy == POLICY_UNKNOWN_OK
        assert g.allowed_bid == 1.20
        assert g.needs_manual_check is False

    def test_exactly_at_the_threshold_needs_a_check(self):
        info = build_rank_info(None, "kw", CFG, TODAY)
        assert apply_rank_policy(2.00, 2.30, info, CFG).policy == POLICY_NEEDS_CHECK


class TestBrandedQueries:
    def test_brand_token_with_no_rank_row_gets_top3_policy(self):
        """We almost always rank #1 for our own name."""
        info = build_rank_info(None, "tallowbourn lip balm", CFG, TODAY)
        assert info.branded is True
        assert info.effective_rank == 1
        g = apply_rank_policy(1.00, 1.15, info, CFG)
        assert g.policy == POLICY_CAPPED
        assert g.risk == RISK_HIGH

    @pytest.mark.parametrize("kw", [
        "tallowbourn", "TALLOWBOURNE balm", "dr dave tallow", "dr. dave lip",
    ])
    def test_all_brand_tokens_match(self, kw):
        assert is_branded(kw, CFG["brand_tokens"])

    def test_a_generic_query_is_not_branded(self):
        assert not is_branded("beef tallow lip balm", CFG["brand_tokens"])

    def test_real_rank_data_overrides_the_brand_assumption(self):
        info = build_rank_info(rank_row(12), "tallowbourn balm", CFG, TODAY)
        assert info.branded is True
        assert info.effective_rank == 12          # data wins
        assert apply_rank_policy(1.00, 1.20, info, CFG).policy == POLICY_FULL


class TestStaleness:
    def test_rank_older_than_the_window_gates_as_unknown(self):
        """Stale rank (>14d) → treated as unknown for gating."""
        info = build_rank_info(rank_row(1, days_ago=20), "beef tallow", CFG, TODAY)
        assert info.stale is True
        assert info.rank == 1              # still shown
        assert info.effective_rank is None  # but not trusted
        g = apply_rank_policy(2.00, 2.50, info, CFG)
        assert g.policy == POLICY_NEEDS_CHECK

    def test_fresh_rank_is_used(self):
        info = build_rank_info(rank_row(1, days_ago=13), "kw", CFG, TODAY)
        assert info.stale is False and info.effective_rank == 1

    def test_a_stale_branded_query_still_gets_the_brand_assumption(self):
        info = build_rank_info(rank_row(1, days_ago=90), "tallowbourn balm", CFG, TODAY)
        assert info.stale is True
        assert info.effective_rank == 1

    def test_an_unparseable_date_is_treated_as_stale(self):
        info = build_rank_info({"organic_rank": 1, "as_of": "not-a-date"},
                               "kw", CFG, TODAY)
        assert info.stale is True


class TestGateNeverBlocksWasteCutting:
    def test_a_bid_decrease_passes_untouched_at_rank_1(self):
        """Cutting spend on a query we rank #1 for is the RIGHT move."""
        info = build_rank_info(rank_row(1), "kw", CFG, TODAY)
        g = apply_rank_policy(2.00, 1.00, info, CFG)
        assert g.allowed_bid == 1.00
        assert g.policy == POLICY_FULL

    def test_an_unchanged_bid_passes(self):
        info = build_rank_info(rank_row(1), "kw", CFG, TODAY)
        assert apply_rank_policy(1.50, 1.50, info, CFG).allowed_bid == 1.50

    def test_a_zero_current_bid_is_not_gated(self):
        """No CPC baseline means no percentage cap to apply."""
        info = build_rank_info(rank_row(1), "kw", CFG, TODAY)
        assert apply_rank_policy(0.0, 1.20, info, CFG).allowed_bid == 1.20

    def test_disabling_gating_passes_everything_through(self):
        cfg = {**CFG, "enabled": False}
        info = build_rank_info(rank_row(1), "kw", cfg, TODAY)
        g = apply_rank_policy(1.00, 5.00, info, cfg)
        assert g.policy == POLICY_DISABLED and g.allowed_bid == 5.00


class TestRiskLabels:
    @pytest.mark.parametrize("rank,expected", [
        (1, RISK_HIGH), (3, RISK_HIGH), (4, RISK_MEDIUM), (7, RISK_MEDIUM),
        (8, RISK_LOW), (50, RISK_LOW),
    ])
    def test_bands(self, rank, expected):
        assert build_rank_info(rank_row(rank), "kw", CFG, TODAY).risk == expected

    def test_no_data_is_unknown(self):
        assert build_rank_info(None, "beef tallow", CFG, TODAY).risk == RISK_UNKNOWN
