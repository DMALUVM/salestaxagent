"""Competitor reverse-ASIN KR — reuse, create-missing cap, Exact join, net-new."""
from __future__ import annotations

import inspect
import json
from pathlib import Path

import pytest

from src.soldscope import client as ss
from src.soldscope import competitor_kr as ck
from src.soldscope import sync as syn


ROOT = Path(__file__).resolve().parent.parent
OURS = "B0CLF5B27Y"
LIP = "B0CLHTF8YN"
BALM = "B0DQFKMJFY"
DEO = "B0HBSZ71XQ"
LIP_COMP = "B0DVVDDR6Y"
BALM_COMP = "B0BJMSH4JX"
DEO_COMP = "B0FTS2DC7Y"


def _cfg():
    return json.loads((ROOT / "config" / "soldscope_competitors.json").read_text())


def test_config_lists_30_competitors_and_excludes_our_balm():
    raw = _cfg()
    dash = json.loads((ROOT / "dashboard" / "config" / "soldscope_competitors.json").read_text())
    assert raw["competitors"] == dash["competitors"]
    assert raw["excluded_asins"] == ["B0CLF5B27Y"]
    assert raw["create_missing_max"] == 5
    assert raw["stale_after_days"] == 8
    assert raw["blake_family_cap"] == 5
    assert raw["blake_total_cap"] == 15
    assert raw["max_keywords"] == 80
    assert raw["min_search_volume"] == 1
    assert raw.get("max_keywords") <= 80
    assert raw["blake_require_competitor_on_serp"] is True
    assert "ground beef" in raw["blake_keyword_denylist"]
    assert "eos lotion" in raw["blake_keyword_denylist"]
    assert "sol de janeiro" in raw["blake_keyword_denylist"]
    assert "cerave" in raw["blake_family_denylist"]["balm"]
    assert "eadem" in raw["blake_family_allow"]["lip"]
    assert "deodorant" in raw["blake_family_allow"]["deo"]
    assert "lume.*for women" in raw["blake_soft_watch"]["deo"]
    assert "native" in raw["blake_harvest_brands"]
    for key in (
        "blake_require_competitor_on_serp", "blake_keyword_denylist",
        "blake_family_denylist", "blake_family_allow", "blake_soft_watch",
        "blake_soft_watch_brands", "blake_harvest_brands",
        "blake_moisturizer_requires", "blake_deo_hero_women_first",
    ):
        assert dash[key] == raw[key]
    asins = [c["asin"] for c in raw["competitors"]]
    assert len(asins) == 30
    assert len(set(asins)) == 30
    assert OURS not in asins
    assert LIP not in asins and BALM not in asins and DEO not in asins
    assert {c["family"] for c in raw["competitors"]} == {"lip", "balm", "deo"}
    assert sum(1 for c in raw["competitors"] if c["family"] == "lip") == 10
    assert sum(1 for c in raw["competitors"] if c["family"] == "balm") == 10
    assert sum(1 for c in raw["competitors"] if c["family"] == "deo") == 10
    loaded = ck.load_config()
    assert len(loaded["competitors"]) == 30
    assert OURS in loaded["excluded_asins"]
    assert loaded["create_missing_max"] == 5
    assert loaded["stale_after_days"] == 8
    assert loaded["blake_family_cap"] == 5
    assert loaded["blake_total_cap"] == 15
    assert loaded["max_keywords"] == 80
    assert loaded["min_search_volume"] == 1
    assert loaded["max_aba_sfr"] is None
    assert loaded["blake_require_competitor_on_serp"] is True
    assert "ground beef" in loaded["blake_filters"]["denylist"]
    assert loaded["families"]["lip"]["hero_asin"] == LIP
    assert loaded["families"]["balm"]["hero_asin"] == BALM
    assert loaded["families"]["deo"]["hero_asin"] == DEO
    assert loaded["families"]["lip"]["rt_group_id"] == 3537
    assert loaded["families"]["balm"]["rt_group_id"] == 3553
    assert loaded["families"]["deo"]["rt_group_id"] == 3624


def test_load_config_drops_our_balm_even_if_listed(tmp_path, monkeypatch):
    monkeypatch.setattr(ck, "PROJECT_ROOT", tmp_path)
    (tmp_path / "config").mkdir()
    payload = _cfg()
    payload["competitors"].append({"asin": OURS, "family": "balm"})
    payload["competitors"].append({"asin": LIP, "family": "lip"})
    (tmp_path / "config" / "soldscope_competitors.json").write_text(json.dumps(payload))
    loaded = ck.load_config()
    asins = [c["asin"] for c in loaded["competitors"]]
    assert OURS not in asins
    assert LIP not in asins
    assert OURS in loaded["dropped_asins"]


def test_never_creates_rt_or_product_research():
    src = inspect.getsource(ck) + inspect.getsource(ss)
    assert "product-research" not in src
    assert "listing-analyzer" not in src
    assert "rank-tracker/groups" not in inspect.getsource(ck)
    assert "time.sleep" not in inspect.getsource(ck)
    assert "while True" not in inspect.getsource(ck)


def test_competitor_present_requires_asin_equality_not_rank():
    assert ck.competitor_present(
        {"organic_asin": LIP_COMP, "organic_rank": 4}, LIP_COMP,
    )
    assert ck.competitor_present(
        {"sponsored_asin": LIP_COMP, "sponsored_rank": 2}, LIP_COMP,
    )
    assert not ck.competitor_present({"sponsored_rank": 2}, LIP_COMP)
    assert not ck.competitor_present({"organic_rank": 11}, LIP_COMP)
    assert not ck.competitor_present({"organic_rank": 11}, "B0OTHER")
    assert not ck.competitor_present(
        {"organic_asin": "B0OTHER", "organic_rank": 1}, LIP_COMP,
    )
    assert not ck.competitor_present({"organic_rank": 0, "sponsored_rank": None}, LIP_COMP)
    assert not ck.competitor_present({}, LIP_COMP)


def test_already_bidding_is_enabled_exact_only():
    targets = [
        {"keyword_text": "Tallow Lip Balm", "match_type": "exact", "state": "enabled"},
        {"keyword_text": "grass fed tallow", "match_type": "phrase", "state": "enabled"},
        {"keyword_text": "paused exact", "match_type": "exact", "state": "paused"},
    ]
    yes = ck.classify_exact_bidding("tallow lip balm", targets)
    assert yes["already"] is True
    assert yes["already_bidding"] == "Y"
    phrase = ck.classify_exact_bidding("grass fed tallow", targets)
    assert phrase["already"] is False
    assert phrase["already_bidding"] == "N"
    paused = ck.classify_exact_bidding("paused exact", targets)
    assert paused["already"] is False
    elsewhere = ck.classify_exact_bidding(
        "tallow deodorant for men",
        targets,
        extra_exact=["tallow deodorant for men"],
    )
    assert elsewhere["already"] is True


def test_levers_and_net_new_actionable():
    assert ck.suggest_lever(
        already_exact=False, present=True, family_fit=True, opportunity=210,
    ) == "harvest_exact"
    assert ck.suggest_lever(
        already_exact=False, present=True, family_fit=True, opportunity=40,
    ) == "watch"
    assert ck.suggest_lever(
        already_exact=True, present=True, family_fit=True, opportunity=900,
    ) == "skip"
    assert ck.suggest_lever(
        already_exact=False, present=False, family_fit=True, opportunity=900,
    ) == "skip"
    assert ck.suggest_lever(
        already_exact=False, present=True, family_fit=True, opportunity=900,
        soft_watch=True,
    ) == "watch"

    rows = ck.build_competitor_outliers({
        "kr_rows": [
            {
                "competitor_asin": LIP_COMP, "family": "lip",
                "keyword": "grass fed tallow lip", "search_volume": 400,
                "opportunity_score": 220, "organic_asin": LIP_COMP,
                "organic_rank": 6, "as_of": "2026-09-11",
            },
            {
                "competitor_asin": LIP_COMP, "family": "lip",
                "keyword": "tallow lip balm", "search_volume": 8000,
                "opportunity_score": 500, "organic_asin": LIP_COMP,
                "organic_rank": 2, "as_of": "2026-09-11",
            },
            {
                "competitor_asin": BALM_COMP, "family": "balm",
                "keyword": "long tail tallow", "search_volume": 90,
                "opportunity_score": 40, "sponsored_asin": BALM_COMP,
                "sponsored_rank": 8, "as_of": "2026-09-11",
            },
            {
                "competitor_asin": OURS, "family": "balm",
                "keyword": "should drop", "opportunity_score": 900,
                "organic_asin": OURS, "organic_rank": 1, "as_of": "2026-09-11",
            },
            {
                "competitor_asin": DEO_COMP, "family": "deo",
                "keyword": "no presence", "opportunity_score": 800, "as_of": "2026-09-11",
            },
        ],
        "targets": [
            {"keyword_text": "tallow lip balm", "match_type": "exact", "state": "enabled"},
        ],
        "rank_rows": [
            {"asin": LIP, "phrase": "grass fed tallow lip", "organic_position": 14,
             "as_of": "2026-09-11", "group_id": 3537},
        ],
    })
    by_kw = {r["keyword"]: r for r in rows}
    assert "should drop" not in by_kw
    assert "no presence" not in by_kw
    harvest = by_kw["grass fed tallow lip"]
    assert harvest["already_bidding"] == "N"
    assert harvest["suggested_lever"] == "harvest_exact"
    assert harvest["our_hero_family"] == "lip"
    assert harvest["our_organic_rank"] == 14
    assert by_kw["tallow lip balm"]["already_bidding"] == "Y"
    assert by_kw["tallow lip balm"]["suggested_lever"] == "skip"
    assert by_kw["long tail tallow"]["suggested_lever"] == "watch"

    prev = [r for r in rows if r["keyword"] == "grass fed tallow lip"]
    current = rows + [{
        "keyword": "new outlier balm",
        "keyword_normalized": "new outlier balm",
        "competitor_asin": BALM_COMP,
        "our_hero_family": "balm",
        "suggested_lever": "harvest_exact",
        "already_bidding": "N",
    }]
    net = ck.net_new_actionable(current, prev)
    assert [r["keyword"] for r in net] == ["new outlier balm"]
    assert ck.digest_should_ping(net) is True
    assert ck.digest_should_ping([]) is False
    assert ck.net_new_actionable(prev, prev) == []


@pytest.fixture(autouse=True)
def _empty_kr_cache(monkeypatch):
    """Default: no warehouse snapshot so existing sync tests stay SoldScope-path."""
    monkeypatch.setattr(ck, "load_cached_kr", lambda: [])


def test_reuse_saved_search_does_not_create(monkeypatch):
    created: list[str] = []

    monkeypatch.setattr(ck, "token_present", lambda: True)
    monkeypatch.setattr(ck, "check_auth", lambda: {"account": {"id": 1}})
    monkeypatch.setattr(
        ck, "collect_saved_kr_search_ids",
        lambda **k: {LIP_COMP: 17990, BALM_COMP: 11},
    )
    monkeypatch.setattr(
        ck, "create_single_asin_search",
        lambda **k: created.append(k["asin"]) or {"data": {"id": 1}},
    )
    monkeypatch.setattr(ck, "collect_kr_results", lambda sid, cap: [
        {"keyword": "tallow lip balm organic", "searchVolume": 300,
         "opportunityScore": 180, "organicRank": 5,
         "abaSearchFrequencyRank": 88, "cpc": 1.2},
    ])

    r = ck.sync_competitor_kr(dry_run=True, create_missing=False)
    assert created == []
    assert r["status"] == "success"
    assert LIP_COMP in r["reused"]
    assert r["counts"]["competitor_kr"] >= 1
    assert OURS not in r["asins"]


def test_create_missing_cap_default_five(monkeypatch):
    created: list[str] = []

    monkeypatch.setattr(ck, "token_present", lambda: True)
    monkeypatch.setattr(ck, "check_auth", lambda: {"account": {"id": 1}})
    monkeypatch.setattr(ck, "collect_saved_kr_search_ids", lambda **k: {})

    def create(**kwargs):
        created.append(kwargs["asin"])
        return {"data": {"id": 100 + len(created), "searchType": 0}}

    monkeypatch.setattr(ck, "create_single_asin_search", create)
    monkeypatch.setattr(ck, "collect_kr_results", lambda *a, **k: [])

    r = ck.sync_competitor_kr(dry_run=True, create_missing=True)
    assert len(created) == 5
    assert r["create_cap"] == 5
    assert len(r["created"]) == 5
    assert len(r["missing"]) == 25
    assert any("cap 5" in n for n in r["notes"])
    assert "product-research" not in " ".join(r["notes"]).lower()

    created.clear()
    r2 = ck.sync_competitor_kr(dry_run=True, create_missing=True, max_create=2)
    assert len(created) == 2
    assert r2["create_cap"] == 2


def test_create_missing_false_never_posts(monkeypatch):
    monkeypatch.setattr(ck, "token_present", lambda: True)
    monkeypatch.setattr(ck, "check_auth", lambda: {"account": {"id": 1}})
    monkeypatch.setattr(ck, "collect_saved_kr_search_ids", lambda **k: {})
    monkeypatch.setattr(
        ck, "create_single_asin_search",
        lambda **k: (_ for _ in ()).throw(AssertionError("POST without flag")),
    )
    r = ck.sync_competitor_kr(dry_run=True, create_missing=False)
    assert r["created"] == []
    assert len(r["missing"]) == 30
    assert ck.EMPTY_SNAPSHOT_NOTE in r["notes"]
    assert any("--create-missing" in n for n in r["notes"])


def test_402_on_create_stops_without_retry(monkeypatch):
    created: list[str] = []

    monkeypatch.setattr(ck, "token_present", lambda: True)
    monkeypatch.setattr(ck, "check_auth", lambda: {"account": {"id": 1}})
    monkeypatch.setattr(ck, "collect_saved_kr_search_ids", lambda **k: {})

    def create(**kwargs):
        created.append(kwargs["asin"])
        raise ss.QuotaExceeded("quota", remaining="0")

    monkeypatch.setattr(ck, "create_single_asin_search", create)
    r = ck.sync_competitor_kr(dry_run=True, create_missing=True)
    assert created == [ck.load_config()["competitors"][0]["asin"]]
    assert r["quota_remaining"] == "0"
    assert any("402" in n for n in r["notes"])
    assert r["status"] == "fail"


def test_kr_row_parser_maps_verified_fields():
    rows = ck.competitor_kr_rows_from_payload(
        [{
            "keyword": "Tallow Lip Balm Organic",
            "searchVolume": 420,
            "abaSearchFrequencyRank": 77,
            "organicAsin": "b0dvvddr6y",
            "organicRank": 3,
            "sponsoredAsin": "b0dvvddr6y",
            "sponsoredRank": 1,
            "sponsoredProducts": 8,
            "opportunityScore": 190,
            "cpc": 1.35,
            "matchTypes": ["EXACT", "PHRASE"],
        }, {
            "keyword": "tallow lip balm organic",
            "searchVolume": 1,
        }],
        competitor_asin=LIP_COMP,
        family="lip",
        marketplace="US",
        search_id=42,
        pulled_at="2026-09-11T12:00:00+00:00",
        as_of="2026-09-11",
    )
    assert len(rows) == 1
    row = rows[0]
    assert row["keyword_normalized"] == "tallow lip balm organic"
    assert row["aba_search_frequency_rank"] == 77
    assert row["organic_asin"] == LIP_COMP
    assert row["sponsored_rank"] == 1
    assert row["match_types"] == "EXACT,PHRASE"
    assert row["family"] == "lip"


def test_kr_row_parser_drops_zero_and_missing_volume():
    rows = ck.competitor_kr_rows_from_payload(
        [
            {"keyword": "has traffic", "searchVolume": 400, "organicRank": 2},
            {"keyword": "zero traffic", "searchVolume": 0, "organicRank": 1},
            {"keyword": "missing volume", "organicRank": 1},
            {"keyword": "null volume", "searchVolume": None, "organicRank": 1},
        ],
        competitor_asin=LIP_COMP,
        family="lip",
        marketplace="US",
        search_id=18838,
        pulled_at="2026-09-11T12:00:00+00:00",
        as_of="2026-09-11",
    )
    assert [r["keyword"] for r in rows] == ["has traffic"]
    assert ck.has_real_traffic({"search_volume": 0}) is False
    assert ck.has_real_traffic({"searchVolume": None}) is False
    assert ck.has_real_traffic({"search_volume": 1}) is True


def test_outliers_and_blake_drop_zero_volume():
    payload = {
        "kr_rows": [
            {
                "competitor_asin": LIP_COMP, "family": "lip",
                "keyword": "zero traffic phrase", "search_volume": 0,
                "opportunity_score": 900, "organic_asin": LIP_COMP,
                "organic_rank": 1, "as_of": "2026-09-11",
            },
            {
                "competitor_asin": LIP_COMP, "family": "lip",
                "keyword": "no volume phrase",
                "opportunity_score": 900, "organic_asin": LIP_COMP,
                "organic_rank": 1, "as_of": "2026-09-11",
            },
            {
                "competitor_asin": LIP_COMP, "family": "lip",
                "keyword": "real traffic lip", "search_volume": 400,
                "opportunity_score": 220, "organic_asin": LIP_COMP,
                "organic_rank": 4, "as_of": "2026-09-11",
            },
        ],
    }
    outliers = ck.build_competitor_outliers(payload)
    assert [r["keyword"] for r in outliers] == ["real traffic lip"]
    surface = ck.build_blake_competitor_surface(payload)
    assert [r["keyword"] for r in surface] == ["real traffic lip"]
    assert all(r["already_bidding"] == "N" for r in surface)


def test_hero_weekly_sync_does_not_post_competitor_kr():
    src = inspect.getsource(syn.sync_weekly)
    assert "sync_competitor_kr" not in src
    assert "soldscope_competitor_kr" not in src


def test_weekly_job_is_reuse_only_and_cli_gates_create():
    from src import main as main_mod

    src = inspect.getsource(main_mod)
    assert "soldscope_competitor_kr_sync" in src
    assert "soldscope-competitor-kr" in src
    runner = inspect.getsource(main_mod._run_soldscope_competitor_kr_sync)
    assert "create_missing=False" in runner
    assert "create_missing=True" not in runner
    assert "--create-missing" in src
    assert "max-create" in src


def _kw_row(asin, family, keyword, *, opp=200, vol=400, as_of="2026-09-11", search_id=99,
            organic_asin=None, sponsored_asin=None):
    return {
        "competitor_asin": asin,
        "family": family,
        "keyword": keyword,
        "keyword_normalized": keyword,
        "search_volume": vol,
        "opportunity_score": opp,
        "organic_asin": organic_asin if organic_asin is not None else asin,
        "organic_rank": 4,
        "sponsored_asin": sponsored_asin,
        "as_of": as_of,
        "search_id": search_id,
        "marketplace": "US",
    }


def test_blake_surface_excludes_exact_y_caps_family_and_total():
    lip_rows = [
        _kw_row(LIP_COMP, "lip", f"lip balm kw {i}", opp=400 - i)
        for i in range(20)
    ]
    already = _kw_row(LIP_COMP, "lip", "tallow lip balm", opp=900)
    balm_rows = [
        _kw_row(BALM_COMP, "balm", f"tallow body balm {i}", opp=300 - i)
        for i in range(6)
    ]
    deo_rows = [
        _kw_row(DEO_COMP, "deo", f"tallow deodorant {i}", opp=250 - i)
        for i in range(6)
    ]
    ours = _kw_row(OURS, "balm", "our balm kw", opp=999)
    surface = ck.build_blake_competitor_surface({
        "kr_rows": lip_rows + [already, ours] + balm_rows + deo_rows,
        "targets": [
            {"keyword_text": "tallow lip balm", "match_type": "exact", "state": "enabled"},
        ],
        "family_cap": 5,
        "total_cap": 15,
    })
    assert all(r["already_bidding"] == "N" for r in surface)
    assert all(r["suggested_lever"] != "skip" for r in surface)
    assert "tallow lip balm" not in {r["keyword"] for r in surface}
    assert all(r["competitor_asin"] != OURS for r in surface)
    assert sum(1 for r in surface if r["our_hero_family"] == "lip") == 5
    assert sum(1 for r in surface if r["our_hero_family"] == "balm") == 5
    assert sum(1 for r in surface if r["our_hero_family"] == "deo") == 5
    assert len(surface) == 15


def test_blake_surface_drops_last_week_keywords():
    current = [
        _kw_row(LIP_COMP, "lip", "repeat lip", opp=220, as_of="2026-09-11"),
        _kw_row(LIP_COMP, "lip", "brand new lip", opp=210, as_of="2026-09-11"),
    ]
    previous = [
        _kw_row(LIP_COMP, "lip", "repeat lip", opp=220, as_of="2026-09-04"),
    ]
    surface = ck.build_blake_competitor_surface({
        "kr_rows": current,
        "previous_kr_rows": previous,
    })
    assert [r["keyword"] for r in surface] == ["brand new lip"]


def test_fresh_cache_skips_soldscope_entirely(monkeypatch):
    listed = []
    fetched = []
    created = []
    today = "2026-09-11"
    cache = [
        _kw_row(c["asin"], c["family"], f"cached {c['asin']}", as_of=today)
        for c in ck.load_config()["competitors"]
    ]
    monkeypatch.setattr(ck, "load_cached_kr", lambda: cache)
    monkeypatch.setattr(ck, "date", type("D", (), {
        "today": staticmethod(lambda: __import__("datetime").date(2026, 9, 11)),
        "fromisoformat": __import__("datetime").date.fromisoformat,
    }))
    monkeypatch.setattr(
        ck, "collect_saved_kr_search_ids",
        lambda **k: listed.append(k) or {},
    )
    monkeypatch.setattr(
        ck, "collect_kr_results",
        lambda *a, **k: fetched.append(a) or [],
    )
    monkeypatch.setattr(
        ck, "create_single_asin_search",
        lambda **k: created.append(k) or {"data": {"id": 1}},
    )
    monkeypatch.setattr(
        ck, "token_present",
        lambda: (_ for _ in ()).throw(AssertionError("token on cache-fresh week")),
    )

    r = ck.sync_competitor_kr(dry_run=True, create_missing=False)
    assert listed == []
    assert fetched == []
    assert created == []
    assert r["status"] == "success"
    assert len(r["cached"]) == 30
    assert r["reused"] == []
    assert any("cache_fresh" in n for n in r["notes"])


def test_one_stale_asin_gets_without_list_or_post(monkeypatch):
    fetched = []
    listed = []
    created = []
    cfg = ck.load_config()
    stale = cfg["competitors"][0]
    cache = []
    for c in cfg["competitors"]:
        as_of = "2026-08-01" if c["asin"] == stale["asin"] else "2026-09-11"
        cache.append(_kw_row(
            c["asin"], c["family"], f"kw {c['asin']}",
            as_of=as_of, search_id=555 if c["asin"] == stale["asin"] else 99,
        ))
    monkeypatch.setattr(ck, "load_cached_kr", lambda: cache)
    monkeypatch.setattr(ck, "date", type("D", (), {
        "today": staticmethod(lambda: __import__("datetime").date(2026, 9, 11)),
        "fromisoformat": __import__("datetime").date.fromisoformat,
    }))
    monkeypatch.setattr(ck, "token_present", lambda: True)
    monkeypatch.setattr(ck, "check_auth", lambda: {"account": {"id": 1}})
    monkeypatch.setattr(
        ck, "collect_saved_kr_search_ids",
        lambda **k: listed.append(k) or {},
    )
    monkeypatch.setattr(ck, "collect_kr_results", lambda sid, cap: fetched.append(sid) or [
        {"keyword": "stale refresh kw", "searchVolume": 200,
         "opportunityScore": 180, "organicRank": 3},
    ])
    monkeypatch.setattr(
        ck, "create_single_asin_search",
        lambda **k: created.append(k) or {"data": {"id": 1}},
    )

    r = ck.sync_competitor_kr(dry_run=True, create_missing=False)
    assert listed == []
    assert created == []
    assert fetched == [555]
    assert stale["asin"] in r["reused"]
    assert len(r["cached"]) == 29


def test_warehouse_search_id_blocks_second_post(monkeypatch):
    created = []
    cfg = ck.load_config()
    first = cfg["competitors"][0]
    cache = [ck.make_sentinel_row(
        competitor_asin=first["asin"],
        family=first["family"],
        marketplace="US",
        search_id=777,
        pulled_at="2026-09-01T00:00:00+00:00",
        as_of="2026-09-01",
    )]
    monkeypatch.setattr(ck, "load_cached_kr", lambda: cache)
    monkeypatch.setattr(ck, "token_present", lambda: True)
    monkeypatch.setattr(ck, "check_auth", lambda: {"account": {"id": 1}})
    monkeypatch.setattr(ck, "collect_saved_kr_search_ids", lambda **k: {})
    monkeypatch.setattr(ck, "collect_kr_results", lambda sid, cap: [
        {"keyword": "from existing search", "searchVolume": 100,
         "opportunityScore": 150, "organicRank": 2},
    ] if sid == 777 else [])
    monkeypatch.setattr(
        ck, "create_single_asin_search",
        lambda **k: created.append(k["asin"]) or {"data": {"id": 1}},
    )

    r = ck.sync_competitor_kr(dry_run=True, create_missing=True)
    assert first["asin"] not in created
    assert first["asin"] in r["reused"]
    assert len(created) == 5  # remaining missing ASINs still fill up to the run cap


def test_serp_match_kept_rank_only_and_wrong_asin_dropped():
    kept = ck.build_competitor_outliers({
        "kr_rows": [
            _kw_row(LIP_COMP, "lip", "eadem lip balm", opp=220,
                    organic_asin=LIP_COMP),
            _kw_row(LIP_COMP, "lip", "native lip balm", opp=210,
                    organic_asin="", sponsored_asin=LIP_COMP),
            _kw_row(LIP_COMP, "lip", "rank only lip balm", opp=900,
                    organic_asin=""),
            {
                **_kw_row(LIP_COMP, "lip", "wrong asin lip balm", opp=800),
                "organic_asin": "B0OTHERASIN",
                "organic_rank": 1,
            },
        ],
    })
    by_kw = {r["keyword"]: r for r in kept}
    assert "eadem lip balm" in by_kw
    assert "native lip balm" in by_kw
    assert "rank only lip balm" not in by_kw
    assert "wrong asin lip balm" not in by_kw
    surface = ck.build_blake_competitor_surface({
        "kr_rows": [
            _kw_row(LIP_COMP, "lip", "eadem lip balm", opp=220),
            {**_kw_row(LIP_COMP, "lip", "rank only lip", opp=900), "organic_asin": None},
        ],
    })
    assert [r["keyword"] for r in surface] == ["eadem lip balm"]


def test_hard_skip_and_family_allow_drop_noise():
    rows = [
        _kw_row(LIP_COMP, "lip", "eos lotion", opp=900),
        _kw_row(LIP_COMP, "lip", "sol de janeiro", opp=880),
        _kw_row(BALM_COMP, "balm", "ground beef", opp=870),
        _kw_row(BALM_COMP, "balm", "heavy cream", opp=860),
        _kw_row(BALM_COMP, "balm", "beef tallow for cooking", opp=850),
        _kw_row(BALM_COMP, "balm", "tallow for cooking", opp=840),
        _kw_row(DEO_COMP, "deo", "perfume", opp=830),
        _kw_row(DEO_COMP, "deo", "body mist", opp=820),
        _kw_row(DEO_COMP, "deo", "shampoo", opp=810),
        _kw_row(BALM_COMP, "balm", "neosporin", opp=800),
        _kw_row(BALM_COMP, "balm", "cerave moisturizer", opp=790),
        _kw_row(BALM_COMP, "balm", "la roche posay moisturizer", opp=780),
        _kw_row(BALM_COMP, "balm", "olay moisturizer", opp=770),
        _kw_row(LIP_COMP, "lip", "face cream", opp=760),
        _kw_row(LIP_COMP, "lip", "eos lip balm", opp=200),
        _kw_row(BALM_COMP, "balm", "grass fed tallow body balm", opp=180),
        _kw_row(DEO_COMP, "deo", "native deodorant", opp=170),
        _kw_row(BALM_COMP, "balm", "moisturizer skin for men", opp=120),
    ]
    outliers = ck.build_competitor_outliers({"kr_rows": rows})
    surface = ck.build_blake_competitor_surface({"kr_rows": rows})
    kept = {r["keyword"] for r in outliers}
    assert kept == {
        "eos lip balm",
        "grass fed tallow body balm",
        "native deodorant",
        "moisturizer skin for men",
    }
    assert kept == {r["keyword"] for r in surface}
    assert "eos lotion" not in kept
    assert "ground beef" not in kept
    assert "cerave moisturizer" not in kept
    assert ck.classify_family_fit("eos lotion", "lip")["fit"] is False
    assert ck.classify_family_fit("eos lip balm", "lip")["fit"] is True
    assert ck.classify_family_fit("cerave moisturizer", "balm")["fit"] is False
    assert ck.classify_family_fit("tallow deodorant", "deo")["fit"] is True
    assert ck.classify_family_fit("face cream", "lip")["fit"] is False


def test_soft_watch_never_harvest_exact():
    lume = _kw_row(DEO_COMP, "deo", "lume deodorant for women", opp=500)
    body = _kw_row(BALM_COMP, "balm", "tree hut tallow body butter", opp=400)
    harvest = _kw_row(LIP_COMP, "lip", "blistex lip balm", opp=300)
    outliers = ck.build_competitor_outliers({"kr_rows": [lume, body, harvest]})
    by_kw = {r["keyword"]: r for r in outliers}
    assert by_kw["lume deodorant for women"]["suggested_lever"] == "watch"
    assert by_kw["tree hut tallow body butter"]["suggested_lever"] == "watch"
    assert by_kw["blistex lip balm"]["suggested_lever"] == "harvest_exact"
    surface = ck.build_blake_competitor_surface({"kr_rows": [lume, body, harvest]})
    assert {r["keyword"]: r["suggested_lever"] for r in surface} == {
        "lume deodorant for women": "watch",
        "tree hut tallow body butter": "watch",
        "blistex lip balm": "harvest_exact",
    }
    fit = ck.classify_family_fit("lume unscented deodorant for women", "deo")
    assert fit["fit"] is True
    assert fit["soft_watch"] is True


def test_harvest_brand_bias_outranks_higher_opp_generic():
    generic = _kw_row(LIP_COMP, "lip", "generic lip balm phrase", opp=400, vol=9000)
    ranked = _kw_row(LIP_COMP, "lip", "eadem lip balm", opp=150, vol=400)
    outliers = ck.build_competitor_outliers({"kr_rows": [generic, ranked]})
    assert [r["keyword"] for r in outliers] == ["eadem lip balm", "generic lip balm phrase"]
    assert outliers[0]["harvest_bias"] is True
    surface = ck.build_blake_competitor_surface({
        "kr_rows": [generic, ranked],
        "family_cap": 1,
        "total_cap": 1,
    })
    assert [r["keyword"] for r in surface] == ["eadem lip balm"]
