"""Brand classification, weekly rollups, and the PPC brand gate.

Mirrors the manual Branded Market Share Tracker. The load-bearing property is
that classification errs toward NON-branded: a false positive caps bids on the
generic head terms we are trying to win, which is the expensive mistake.
"""
import pytest

from src.amazon_ads.brand_rollup import (
    Bucket, callouts, rollup_weeks, top_opportunities,
)
from src.amazon_ads.brand_terms import classify, is_branded, load_rules, normalize


class TestNormalization:
    @pytest.mark.parametrize("raw,expected", [
        ("Dr. Dave's", "dr dave s"),
        ("  TALLOWBOURN   Lip  Balm ", "tallowbourn lip balm"),
        ("dr dave’s primal essence", "dr dave s primal essence"),
        ("", ""),
    ])
    def test_normalize(self, raw, expected):
        assert normalize(raw) == expected


class TestClassification:
    @pytest.mark.parametrize("q", [
        "tallowbourn", "Tallowbourn lip balm", "tallowbourne balm",
        "tallowborn", "tallow bourne balm", "dr dave", "dr. dave's",
        "dr daves primal essence", "primal essence", "doctor dave lip",
    ])
    def test_branded_queries(self, q):
        assert is_branded(q), q

    @pytest.mark.parametrize("q", [
        "beef tallow lip balm", "tallow", "tallow lip balm", "chap stick",
        "grass fed tallow", "organic chapstick", "beeswax lip balm",
        "tallow balm for face",
    ])
    def test_generic_queries_are_not_branded(self, q):
        """The expensive mistake: capping bids on category head terms."""
        assert not is_branded(q), q

    def test_substring_collision_does_not_classify(self):
        """'tallow' is inside 'tallowbourn' — substring matching would fail here."""
        assert not is_branded("beef tallow lip balm")
        assert is_branded("tallowbourn lip balm")

    def test_phrase_requires_whole_words(self):
        """'dr davenport' must not match the phrase 'dr dave'."""
        assert not is_branded("dr davenport lip balm")
        assert is_branded("dr dave lip balm")

    def test_generic_components_alone_are_not_branded(self):
        for q in ("dave", "primal", "essence", "primal lip balm", "essence balm"):
            assert not is_branded(q), q

    def test_classify_reports_the_matching_rule(self):
        c = classify("Tallowbourn Lip Balm")
        assert c["branded"] is True
        assert c["matched_rule"] == "tallowbourn"
        assert c["normalized"] == "tallowbourn lip balm"

    def test_empty_query(self):
        assert not is_branded("") and not is_branded(None)


def row(query, branded, ours, market, week="2026-08-09", asin="A1", clicks=0,
        market_clicks=0):
    return {"query_normalized": query, "is_branded": branded,
            "asin_purchases": ours, "total_purchases": market,
            "asin_clicks": clicks, "total_clicks": market_clicks,
            "asin_impressions": 0, "total_impressions": 0,
            "week_start": week, "asin": asin}


class TestWeeklyRollup:
    ROWS = [
        row("tallowbourn lip balm", True, 60, 80),
        row("beef tallow lip balm", False, 45, 900),
        row("organic chapstick", False, 5, 600),
    ]

    def test_branded_and_non_branded_purchases(self):
        w = rollup_weeks(self.ROWS)[0]
        assert w.branded.purchases == 60
        assert w.non_branded.purchases == 50
        assert w.total_purchases == 110

    def test_branded_mix_is_of_our_own_purchases(self):
        w = rollup_weeks(self.ROWS)[0]
        assert w.branded_mix == pytest.approx(60 / 110)
        assert w.non_branded_mix == pytest.approx(50 / 110)

    def test_share_is_of_market_purchases(self):
        w = rollup_weeks(self.ROWS)[0]
        assert w.branded.share == pytest.approx(60 / 80)
        assert w.non_branded.share == pytest.approx(50 / 1500)

    def test_market_denominator_counted_once_per_query(self):
        """Two ASINs on one query must not double the market denominator."""
        rows = [row("beef tallow lip balm", False, 30, 900, asin="A1"),
                row("beef tallow lip balm", False, 15, 900, asin="A2")]
        w = rollup_weeks(rows)[0]
        assert w.non_branded.purchases == 45        # ours sums
        assert w.non_branded.market_purchases == 900  # market does not
        assert w.non_branded.share == pytest.approx(45 / 900)

    def test_weeks_are_ordered_oldest_first(self):
        rows = [row("q", False, 1, 10, week="2026-08-16"),
                row("q", False, 1, 10, week="2026-08-02")]
        assert [w.week_start for w in rollup_weeks(rows)] == \
            ["2026-08-02", "2026-08-16"]

    def test_zero_market_yields_none_not_a_division_error(self):
        w = rollup_weeks([row("q", False, 0, 0)])[0]
        assert w.non_branded.share is None

    def test_no_purchases_yields_no_mix(self):
        w = rollup_weeks([row("q", False, 0, 500)])[0]
        assert w.branded_mix is None

    def test_rows_without_a_week_are_ignored(self):
        assert rollup_weeks([{"week_start": "", "is_branded": False}]) == []

    def test_as_dict_shape(self):
        d = rollup_weeks(self.ROWS)[0].as_dict()
        for k in ("branded_purchases", "non_branded_purchases", "branded_mix",
                  "branded_share", "non_branded_share"):
            assert k in d


class TestOpportunities:
    ROWS = [
        row("tallowbourn lip balm", True, 60, 80),
        row("beef tallow lip balm", False, 45, 900),
        row("organic chapstick", False, 5, 600),
        row("niche term", False, 1, 4),
    ]

    def test_branded_queries_are_excluded(self):
        qs = [o.query for o in top_opportunities(self.ROWS)]
        assert "tallowbourn lip balm" not in qs

    def test_ranked_by_purchases_left_on_the_table(self):
        qs = [o.query for o in top_opportunities(self.ROWS)]
        assert qs[0] == "beef tallow lip balm"   # 855 unclaimed vs 595

    def test_high_share_queries_are_not_opportunities(self):
        """We already win these — nothing to go after."""
        rows = [row("won query", False, 90, 100)]
        assert top_opportunities(rows, max_share=0.10) == []

    def test_rank_band_is_attached_when_known(self):
        ranks = {"beef tallow lip balm": {"organic_rank": 99}}
        o = next(o for o in top_opportunities(self.ROWS, ranks=ranks)
                 if o.query == "beef tallow lip balm")
        assert o.rank_band == 99

    def test_only_the_latest_week_is_used(self):
        rows = [row("old", False, 1, 5000, week="2026-08-02"),
                row("new", False, 1, 100, week="2026-08-09")]
        assert [o.query for o in top_opportunities(rows)] == ["new"]

    def test_empty_input(self):
        assert top_opportunities([]) == []


class TestCallouts:
    def test_high_branded_mix_is_called_out(self):
        weeks = rollup_weeks([row("tallowbourn", True, 90, 100),
                              row("generic", False, 10, 5000)])
        text = " ".join(callouts(weeks))
        assert "branded queries" in text

    def test_tiny_non_brand_share_is_called_out(self):
        weeks = rollup_weeks([row("tallowbourn", True, 90, 100),
                              row("generic", False, 10, 5000)])
        assert any("uncaptured" in c for c in callouts(weeks))

    def test_no_data_says_so(self):
        assert "No SQP weeks" in callouts([])[0]

    def test_week_over_week_movement(self):
        weeks = rollup_weeks([
            row("tallowbourn", True, 50, 100, week="2026-08-02"),
            row("generic", False, 50, 5000, week="2026-08-02"),
            row("tallowbourn", True, 90, 100, week="2026-08-09"),
            row("generic", False, 10, 5000, week="2026-08-09"),
        ])
        assert any("week over week" in c for c in callouts(weeks))


class TestBrandGateInteraction:
    """Classification must drive the PPC gate identically."""

    CFG = {"enabled": True, "high_bid_threshold": 2.30,
           "rank_1_3_max_increase_pct": 8, "rank_4_7_max_increase_pct": 12,
           "stale_after_days": 14, "brand_tokens": []}

    def test_a_branded_query_is_capped_without_rank_data(self):
        from datetime import date

        from src.amazon_ads.organic_rank import (
            POLICY_CAPPED, apply_rank_policy, build_rank_info,
        )
        info = build_rank_info(None, "tallowbourn lip balm", self.CFG,
                               date(2026, 8, 21))
        assert info.branded is True
        g = apply_rank_policy(1.00, 1.15, info, self.CFG)
        assert g.policy == POLICY_CAPPED

    def test_a_generic_query_is_not_capped_by_the_brand_rule(self):
        """The regression the shared rules fix: 'tallow' inside 'tallowbourn'."""
        from datetime import date

        from src.amazon_ads.organic_rank import build_rank_info

        info = build_rank_info(None, "beef tallow lip balm", self.CFG,
                               date(2026, 8, 21))
        assert info.branded is False
        assert info.effective_rank is None      # unknown, not assumed rank 1

    def test_explicit_token_list_still_uses_whole_word_matching(self):
        from src.amazon_ads.organic_rank import is_branded as gate_branded
        assert not gate_branded("beef tallow lip balm", ["tallowbourn"])
        assert gate_branded("tallowbourn balm", ["tallowbourn"])


class TestBrandRename:
    """The 2025-10-31 rename must not read as a brand-demand collapse.

    Same ASINs; 'Dr. Dave's Primal Essence' became 'Tallowbourn'. If only the
    current name counted as brand, mix would crater at the boundary and the
    legacy queries would be misfiled as non-brand growth.
    """

    @pytest.mark.parametrize("q", [
        "tallowbourn lip balm", "tallowbourne", "tallowborn balm",
    ])
    def test_current_era_is_branded(self, q):
        assert is_branded(q)

    @pytest.mark.parametrize("q", [
        "dr dave's primal essence tallow balm", "dr daves primal essence",
        "dr. dave's", "primal essence", "doctor dave",
    ])
    def test_legacy_era_is_still_branded(self, q):
        assert is_branded(q), q

    @pytest.mark.parametrize("q", [
        "beef tallow lip balm", "tallow", "dave", "primal", "essence",
    ])
    def test_generics_stay_non_brand_across_both_eras(self, q):
        assert not is_branded(q), q

    def test_era_attribution(self):
        from src.amazon_ads.brand_terms import era_of
        assert era_of("tallowbourn lip balm") == "current"
        assert era_of("dr dave's primal essence") == "legacy"
        assert era_of("primal essence") == "legacy"
        assert era_of("beef tallow lip balm") is None

    def test_rename_metadata_is_recorded(self):
        from src.amazon_ads.brand_terms import brand_history
        h = brand_history()
        assert h["renamed_on"] == "2025-10-31"
        assert "Primal Essence" in h["previous_brand"]
        assert h["current_brand"] == "Tallowbourn"

    def test_both_eras_gate_bids_identically(self):
        """A legacy-brand query must be capped exactly like the new name."""
        from datetime import date

        from src.amazon_ads.organic_rank import (
            POLICY_CAPPED, apply_rank_policy, build_rank_info,
        )
        cfg = {"enabled": True, "high_bid_threshold": 2.30,
               "rank_1_3_max_increase_pct": 8, "rank_4_7_max_increase_pct": 12,
               "stale_after_days": 14, "brand_tokens": []}
        for q in ("tallowbourn lip balm", "dr dave's primal essence"):
            info = build_rank_info(None, q, cfg, date(2026, 8, 21))
            assert info.branded is True, q
            assert apply_rank_policy(1.00, 1.15, info, cfg).policy == POLICY_CAPPED, q
