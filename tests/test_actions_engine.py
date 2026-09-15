"""Closed-day ST rollup + pause-vs-negate for the Actions queue.

The live P0 card Dave saw ("Negate Search Term — tallow chapstick — $56 at
stake — 35 clicks / $56.16 / 0 orders over the last 7 days") was a campaign-
scoped rollup with a vague window and the wrong lever. These tests lock:

  * inclusive LA closed-day window math (never date.today(), never open today)
  * whole-window spend/clicks/orders_14d (not per-day scoring)
  * Exact KW = search term → pause, not negate
  * in-window orders_14d suppress the waste card
  * stale warehouse (ST max < as-of) cannot ship a P0 0-order negate
  * sibling Exact converters downgrade + flag campaign-scope
"""
from datetime import date

from src.amazon_ads.actions_engine import (
    ATTRIBUTION_FIELD,
    _aggregate_terms,
    closed_lookback_window,
    filter_closed_window,
    resolve_zero_order_lever,
    score_search_term_actions,
    sibling_exact_converters,
    terms_equal,
    warehouse_freshness,
)


AS_OF = date(2026, 9, 14)
CAMP = "Orange Lip Balm - SP - Tallow Chapstick - KWs - Exact"
AG = "Ad Group - 9/7/2026 12:19:32.657"
TERM = "tallow chapstick"


def row(**kw):
    base = {
        "date": "2026-09-10",
        "search_term": TERM,
        "campaign_id": "camp-orange",
        "campaign_name": CAMP,
        "ad_group_id": "ag-1",
        "ad_group_name": AG,
        "keyword": TERM,
        "match_type": "EXACT",
        "spend": 0.0,
        "sales_14d": 0.0,
        "orders_14d": 0,
        "clicks": 0,
    }
    base.update(kw)
    return base


def dave_stale_rows():
    """Warehouse check: 2026-09-08..09-13 sums to 35 clicks / $56.16 / 0 orders."""
    # Six closed days, spend split so the window total is exact.
    days = [
        ("2026-09-08", 8, 12.16),
        ("2026-09-09", 6, 9.00),
        ("2026-09-10", 7, 11.00),
        ("2026-09-11", 5, 8.00),
        ("2026-09-12", 5, 8.00),
        ("2026-09-13", 4, 8.00),
    ]
    return [row(date=d, clicks=c, spend=s) for d, c, s in days]


class TestClosedWindowMath:
    def test_seven_closed_days_end_on_as_of(self):
        w = closed_lookback_window(AS_OF, 7)
        assert w["start"] == "2026-09-08"
        assert w["end"] == "2026-09-14"
        assert w["days"] == 7
        assert w["timezone"] == "America/Los_Angeles"
        assert w["closed_days_only"] is True
        assert w["attribution"] == ATTRIBUTION_FIELD

    def test_open_today_and_pre_window_days_are_dropped(self):
        rows = [
            row(date="2026-09-07", clicks=99, spend=99.0),
            row(date="2026-09-08", clicks=1, spend=1.0),
            row(date="2026-09-14", clicks=1, spend=1.0),
            row(date="2026-09-15", clicks=50, spend=50.0),
        ]
        w = closed_lookback_window(AS_OF, 7)
        kept = filter_closed_window(rows, w["start"], w["end"])
        assert [r["date"] for r in kept] == ["2026-09-08", "2026-09-14"]
        agg = _aggregate_terms(kept)
        e = agg[(TERM, "camp-orange")]
        assert e["clicks"] == 2
        assert e["spend"] == 2.0

    def test_daily_bleed_is_summed_before_the_threshold(self):
        """$0.80/day for 7 closed days is $5.60 — one rec, not seven misses."""
        rows = [row(date=f"2026-09-{d:02d}", clicks=2, spend=0.80,
                    keyword="other term", match_type="BROAD",
                    search_term="cheap chapstick")
                for d in range(8, 15)]
        recs = score_search_term_actions(
            rows, target_acos=30, lookback_days=7, as_of=AS_OF,
            st_fresh_through="2026-09-14")
        waste = [r for r in recs if r["type"] == "NEGATE_SEARCH_TERM"]
        assert len(waste) == 1
        assert waste[0]["evidence"]["spend"] == 5.6
        assert waste[0]["evidence"]["clicks"] == 14
        assert waste[0]["evidence"]["orders"] == 0
        assert waste[0]["evidence"]["window"]["start"] == "2026-09-08"
        assert waste[0]["evidence"]["window"]["end"] == "2026-09-14"
        assert "last 7 days" not in waste[0]["evidence"]["why"]
        assert "2026-09-08 → 2026-09-14" in waste[0]["evidence"]["why"]
        assert "orders_14d" in waste[0]["evidence"]["why"]


class TestPauseVsNegate:
    def test_exact_kw_equals_term_is_pause_not_negate(self):
        rows = dave_stale_rows() + [row(date="2026-09-14", clicks=1, spend=1.0)]
        recs = score_search_term_actions(
            rows, target_acos=30, lookback_days=7, as_of=AS_OF,
            st_fresh_through="2026-09-14")
        waste = [r for r in recs if r["type"] in
                 ("PAUSE_KEYWORD", "NEGATE_SEARCH_TERM", "REVIEW_SEARCH_TERM")]
        assert len(waste) == 1
        assert waste[0]["type"] == "PAUSE_KEYWORD"
        assert waste[0]["evidence"]["action_type"] == "pause_keyword"
        assert waste[0]["priority"] == "P0"
        assert "pause" in waste[0]["suggested_action"].lower()
        assert "Negative exact" in waste[0]["suggested_action"]
        assert "Do not add a Negative exact" in waste[0]["suggested_action"]
        assert waste[0]["entity_name"] == TERM
        assert CAMP in waste[0]["evidence"]["why"]
        assert AG in waste[0]["evidence"]["why"]

    def test_broad_term_still_negates(self):
        rows = [row(date="2026-09-10", clicks=20, spend=20.0,
                    keyword="tallow", match_type="BROAD",
                    search_term="tallow chapstick cheap")]
        recs = score_search_term_actions(
            rows, target_acos=30, lookback_days=7, as_of=AS_OF,
            st_fresh_through="2026-09-14")
        waste = [r for r in recs if r["type"] == "NEGATE_SEARCH_TERM"]
        assert len(waste) == 1
        assert waste[0]["evidence"]["action_type"] == "negate_exact"
        assert "Negative exact" in waste[0]["suggested_action"]
        assert "pause" not in waste[0]["suggested_action"].lower()

    def test_in_window_orders_suppress_waste(self):
        rows = dave_stale_rows() + [
            row(date="2026-09-14", clicks=2, spend=3.0, orders_14d=1, sales_14d=14.0),
        ]
        recs = score_search_term_actions(
            rows, target_acos=30, lookback_days=7, as_of=AS_OF,
            st_fresh_through="2026-09-14")
        types = {r["type"] for r in recs}
        assert "PAUSE_KEYWORD" not in types
        assert "NEGATE_SEARCH_TERM" not in types
        assert "REVIEW_SEARCH_TERM" not in types

    def test_resolve_lever_matches_bleeders(self):
        assert resolve_zero_order_lever(TERM, TERM, {"exact"}) == "pause_keyword"
        assert resolve_zero_order_lever("Tallow  Chapstick", TERM, ["EXACT"]) == "pause_keyword"
        assert resolve_zero_order_lever("tallow", TERM, {"broad"}) == "negate_exact"
        assert terms_equal(" Tallow   Chapstick ", "tallow chapstick")


class TestStaleAndSiblings:
    def test_stale_zero_order_is_review_not_p0_negate(self):
        recs = score_search_term_actions(
            dave_stale_rows(), target_acos=30, lookback_days=7, as_of=AS_OF,
            st_fresh_through="2026-09-13")
        review = [r for r in recs if r["type"] == "REVIEW_SEARCH_TERM"]
        assert review, recs
        assert review[0]["priority"] == "P2"
        assert review[0]["evidence"]["verified"] is False
        assert review[0]["evidence"]["stale"] is True
        assert review[0]["evidence"]["intended_lever"] == "pause_keyword"
        assert "UNVERIFIED" in review[0]["evidence"]["why"]
        assert "2026-09-08 → 2026-09-14" in review[0]["evidence"]["why"]
        assert "Do not" in review[0]["suggested_action"]
        assert not any(r["type"] == "NEGATE_SEARCH_TERM" and r["priority"] == "P0"
                       for r in recs)
        assert not any(r["type"] == "PAUSE_KEYWORD" for r in recs)
        assert review[0]["evidence"]["spend"] == 56.16
        assert review[0]["evidence"]["clicks"] == 35

    def test_warehouse_freshness_flags_lag(self):
        fresh = warehouse_freshness(dave_stale_rows(), "2026-09-14")
        assert fresh["st_fresh_through"] == "2026-09-13"
        assert fresh["st_stale"] is True
        caught_up = warehouse_freshness(
            dave_stale_rows() + [row(date="2026-09-14")], "2026-09-14")
        assert caught_up["st_stale"] is False

    def test_sibling_exact_converters_downgrade_and_flag(self):
        rows = dave_stale_rows() + [row(date="2026-09-14", clicks=1, spend=1.0)]
        rows += [
            row(date="2026-09-10", campaign_id="camp-peppermint",
                campaign_name="Peppermint Lip Balm - SP - Tallow Chapstick - KWs - Exact",
                clicks=10, spend=12.0, orders_14d=2, sales_14d=28.0),
            row(date="2026-09-11", campaign_id="camp-assorted",
                campaign_name="Assorted - SP - Tallow Chapstick - KWs - Exact",
                clicks=8, spend=9.0, orders_14d=1, sales_14d=14.0),
        ]
        recs = score_search_term_actions(
            rows, target_acos=30, lookback_days=7, as_of=AS_OF,
            st_fresh_through="2026-09-14")
        pause = [r for r in recs if r["type"] == "PAUSE_KEYWORD"]
        assert len(pause) == 1
        assert pause[0]["priority"] == "P1"
        assert pause[0]["evidence"]["converts_elsewhere"] is True
        siblings = pause[0]["evidence"]["sibling_campaigns"]
        assert any("Peppermint" in s for s in siblings)
        assert any("Assorted" in s for s in siblings)
        assert "Converts elsewhere" in pause[0]["evidence"]["why"]
        assert "campaign-scoped only" in pause[0]["evidence"]["why"]

    def test_sibling_helper_ignores_same_campaign_and_non_exact(self):
        agg = _aggregate_terms([
            row(date="2026-09-10", clicks=10, spend=10.0, orders_14d=0),
            row(date="2026-09-10", campaign_id="camp-broad",
                campaign_name="Broad tallow", match_type="BROAD",
                keyword="tallow", clicks=5, spend=5.0, orders_14d=3,
                sales_14d=40.0),
        ])
        assert sibling_exact_converters(agg, TERM, "camp-orange") == []
