"""GNO Campaigns API snapshot — observe-only parse + no report wait-loops."""
from __future__ import annotations

import inspect

from src.amazon_ads import campaigns_api as capi


def test_observe_only_refuses_writes():
    for method, path in [
        ("PUT", "/sp/campaigns/list"),
        ("PATCH", "/sp/campaigns"),
        ("DELETE", "/sp/keywords/list"),
        ("POST", "/sp/campaigns"),
        ("POST", "/reporting/reports"),
    ]:
        try:
            capi._assert_list_only(method, path)
        except capi.CampaignsApiError as e:
            assert "observe-only" in str(e)
        else:
            raise AssertionError(f"{method} {path} must be refused")


def test_list_endpoints_are_allowed():
    capi._assert_list_only("POST", "/sp/campaigns/list")
    capi._assert_list_only("POST", "/sp/keywords/list")
    capi._assert_list_only("POST", "/sp/negativeKeywords/list")
    capi._assert_list_only("POST", "/sp/campaignNegativeKeywords/list")
    capi._assert_list_only("GET", "/v2/portfolios")


def test_placement_modifiers_tos_only_shell_is_140_0_0():
    tos, ros, pp = capi.parse_placement_modifiers({
        "dynamicBidding": {
            "strategy": "LEGACY_FOR_SALES",
            "placementBidding": [
                {"placement": "PLACEMENT_TOP", "percentage": 140},
            ],
        },
    })
    assert (tos, ros, pp) == (140.0, 0.0, 0.0)


def test_placement_modifiers_absent_stay_none():
    assert capi.parse_placement_modifiers({}) == (None, None, None)


def test_parse_campaign_joins_portfolio_or_none():
    portfolios = {"111": "Lip", "222": "Deo", "333": "Balm", "444": "Paused"}
    row = capi.parse_campaign_row({
        "campaignId": "9",
        "name": "SP | TBL | B0CLHVCPL5 | EX | tallow lip balm | TOS",
        "state": "ENABLED",
        "budget": {"budget": 25, "budgetType": "DAILY"},
        "portfolioId": 111,
        "dynamicBidding": {
            "placementBidding": [{"placement": "PLACEMENT_TOP", "percentage": 140}],
        },
    }, portfolios)
    assert row["portfolio_name"] == "Lip"
    assert row["daily_budget"] == 25.0
    assert row["tos_modifier_pct"] == 140.0
    assert row["ros_modifier_pct"] == 0.0
    assert row["state"] == "ENABLED"

    none = capi.parse_campaign_row({
        "campaignId": "8", "name": "orphan", "state": "PAUSED",
    }, portfolios)
    assert none["portfolio_name"] == "none"


def test_parse_keyword_and_negative():
    names = {"55": "SP - KW (TOS) - Exact - Tallow Lip Balm KW"}
    kw = capi.parse_keyword_row({
        "keywordId": "k1",
        "campaignId": "55",
        "keywordText": "beef tallow lip balm",
        "matchType": "EXACT",
        "state": "ENABLED",
        "bid": 2.45,
    }, names)
    assert kw["keyword_text"] == "beef tallow lip balm"
    assert kw["bid"] == 2.45
    assert kw["campaign_name"] == names["55"]

    neg = capi.parse_negative_row({
        "keywordId": "n1",
        "campaignId": "55",
        "keywordText": "chapstick",
        "matchType": "EXACT",
        "state": "ENABLED",
    }, names, "campaign")
    assert neg["keyword"] == "chapstick"
    assert neg["level"] == "campaign"


def test_parse_campaign_created_at_from_extended_data():
    epoch_ms = 1_788_796_800_000  # 2026-09-07T16:00:00Z = midday ET
    row = capi.parse_campaign_row({
        "campaignId": "9",
        "name": "SP | TBL | B0CLHVCPL5 | EX | tallow lip balm | TOS",
        "state": "ENABLED",
        "extendedData": {"creationDate": epoch_ms},
    }, {})
    assert row["created_at"].startswith("2026-09-07T16:00:00")

    iso = capi.parse_campaign_created_at({
        "creationDateTime": "2026-09-07T12:00:00-04:00",
    })
    assert iso is not None
    assert "2026-09-07T12:00:00" in iso or "2026-09-07T16:00:00" in iso


def test_merge_created_at_prefers_api_then_existing_then_snapshot():
    snap = "2026-09-08T05:00:00+00:00"
    existing = "2026-09-07T16:00:00+00:00"
    api = "2026-09-07T16:05:00+00:00"
    assert capi.merge_created_at(api, existing, snap) == api
    assert capi.merge_created_at(None, existing, snap) == existing
    assert capi.merge_created_at(None, None, snap) == snap
    # later global midnight must not replace a midday create already stored
    assert capi.merge_created_at(None, existing, "2026-09-07T07:00:00+00:00") == existing


def test_module_has_no_report_poll_or_425_wait():
    src = inspect.getsource(capi)
    assert "reporting/reports" not in src
    assert "poll_report" not in src
    assert "time.sleep" not in src
    assert "wait-loop" in src
    assert "PUT" in src  # refused
    assert capi.OBSERVE_ONLY is True
