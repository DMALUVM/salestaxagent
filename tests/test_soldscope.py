"""SoldScope v1 — param building, empty RT, 402 stop, upsert idempotency."""
from __future__ import annotations

import inspect
import json
from datetime import date
from pathlib import Path

import pytest

from src.soldscope import client as ss
from src.soldscope import sync as syn


HEROES = ("B0CLHTF8YN", "B0DQFKMJFY", "B0HBSZ71XQ")
ROOT = Path(__file__).resolve().parent.parent


def test_config_heroes_are_asin_title_parents_only():
    titles = json.loads((ROOT / "config" / "asin_titles.json").read_text())
    parents = {k for k in titles if not k.startswith("_")}
    cfg = json.loads((ROOT / "config" / "soldscope.json").read_text())
    assert set(cfg["asins"]) == set(HEROES) == parents
    assert cfg["marketplace"] == "US"
    assert int(cfg["days"]) == 90
    assert cfg["rank_tracker"]["create_groups"] is False
    loaded = syn.load_config()
    assert loaded["asins"] == list(HEROES)
    assert loaded["rank_tracker"]["create_groups"] is False


def test_client_param_building_days_required_except_price():
    sales = ss.build_sales_history_params(
        marketplace="US", asin="B0CLHTF8YN", days=90)
    bsr = ss.build_bsr_history_params(
        marketplace="US", asin="B0DQFKMJFY", days=90)
    price = ss.build_price_history_params(
        marketplace="US", asin="B0HBSZ71XQ")
    assert sales == {"marketplace": "US", "asin": "B0CLHTF8YN", "days": 90}
    assert bsr == {"marketplace": "US", "asin": "B0DQFKMJFY", "days": 90}
    assert price == {"marketplace": "US", "asin": "B0HBSZ71XQ"}
    assert "days" not in price
    with pytest.raises(ss.SoldScopeError, match="days"):
        ss.build_sales_history_params(marketplace="US", asin="X", days=-1)


def test_observe_only_refuses_writes_and_discovery():
    for method, path in [
        ("POST", "/rank-tracker/groups"),
        ("POST", "/rank-tracker/groups/1/phrases-list"),
        ("POST", "/product-research/products"),
        ("GET", "/product-research/products"),
        ("GET", "/listing-analyzer/processes"),
        ("GET", "/keyword-research/searches"),
        ("DELETE", "/rank-tracker/groups"),
        ("PUT", "/rank-tracker/tags/1"),
    ]:
        with pytest.raises(ss.SoldScopeError, match="Refusing"):
            ss.assert_read_only(method, path)
    ss.assert_read_only("GET", "/auth/check")
    ss.assert_read_only("GET", "/common/sales-history")
    ss.assert_read_only("GET", "/rank-tracker/groups")
    ss.assert_read_only("GET", "/rank-tracker/groups/12/products/7/phrases/v2")


def test_no_wait_loops_or_retries_in_client():
    src = inspect.getsource(ss)
    assert "time.sleep" not in src
    assert "while True" not in src
    assert "retry" not in src.lower() or "do not retry" in src.lower()
    assert ss.OBSERVE_ONLY is True


class _Resp:
    def __init__(self, status, payload=None, headers=None, text=""):
        self.status_code = status
        self._payload = payload
        self.headers = headers or {}
        self.text = text or ("" if payload is None else json.dumps(payload))
        self.content = self.text.encode() if self.text else b""

    def json(self):
        return self._payload


def test_402_stops_without_retry(monkeypatch):
    calls = []

    def fake_get(url, headers=None, params=None, timeout=None):
        calls.append({"url": url, "params": params})
        return _Resp(
            402,
            {"message": "API requests limit exceeded"},
            headers={
                "X-API-RateLimit-Remaining": "0",
                "X-API-RateLimit-Limit": "1000",
                "X-API-RateLimit-Reset": "2026-10-01",
            },
            text='{"message":"API requests limit exceeded"}',
        )

    monkeypatch.setattr(ss, "api_token", lambda: "test-token")
    monkeypatch.setattr(ss.httpx, "get", fake_get)
    with pytest.raises(ss.QuotaExceeded) as ei:
        ss.get_sales_history(marketplace="US", asin="B0CLHTF8YN", days=90)
    assert ei.value.remaining == "0"
    assert len(calls) == 1
    assert "sales-history" in calls[0]["url"]
    assert calls[0]["params"]["days"] == 90


def test_404_history_is_empty_not_retry(monkeypatch):
    calls = []

    def fake_get(url, headers=None, params=None, timeout=None):
        calls.append(url)
        return _Resp(404, text="not found")

    monkeypatch.setattr(ss, "api_token", lambda: "test-token")
    monkeypatch.setattr(ss.httpx, "get", fake_get)
    body = ss.get_sales_history(marketplace="US", asin="B0CLHTF8YN", days=90)
    assert body == {}
    assert len(calls) == 1


def test_empty_rt_groups_is_clean_noop(monkeypatch):
    """0 groups → note, no phrase pulls, no create, success."""
    calls: list[str] = []

    def fake_request(method, path, *, params=None, timeout=45):
        calls.append(path)
        if path == "/auth/check":
            return {"account": {"name": "Tallowbourn"}}, {}
        if path == "/rank-tracker/groups":
            return {"data": [], "meta": {"last_page": 1}}, {}
        return {"data": {"sales": [], "bsr": [], "price": []}}, {}

    monkeypatch.setattr(syn, "token_present", lambda: True)
    monkeypatch.setattr(ss, "request", fake_request)
    monkeypatch.setattr(syn, "check_auth", lambda: {"account": {"name": "Tallowbourn"}})
    monkeypatch.setattr(syn, "get_sales_history",
                        lambda **k: {"data": {"sales": []}})
    monkeypatch.setattr(syn, "get_bsr_history",
                        lambda **k: {"data": {"bsr": []}})
    monkeypatch.setattr(syn, "get_price_history",
                        lambda **k: {"data": {"price": []}})
    monkeypatch.setattr(syn, "list_rank_groups",
                        lambda **k: {"data": [], "meta": {"last_page": 1}})

    def boom(*a, **k):
        raise AssertionError("must not list products/phrases when groups are empty")

    monkeypatch.setattr(syn, "list_group_products", boom)
    monkeypatch.setattr(syn, "list_product_phrases", boom)

    r = syn.sync_weekly(dry_run=True)
    assert r["status"] == "success"
    assert r["history_empty"] is True
    assert r["counts"]["rank"] == 0
    assert syn.RT_EMPTY_NOTE in r["notes"]
    assert syn.EMPTY_HISTORY_NOTE in r["notes"]
    assert r["written"] == {"sales": 0, "bsr": 0, "price": 0, "rank": 0}


def test_missing_token_fails_soft_without_http(monkeypatch):
    monkeypatch.setattr(syn, "token_present", lambda: False)

    def boom(*a, **k):
        raise AssertionError("must not call SoldScope without a token")

    monkeypatch.setattr(syn, "check_auth", boom)
    r = syn.sync_weekly(dry_run=True)
    assert r["status"] == "fail"
    assert "SOLDSCOPE_API_TOKEN" in r["message"]
    assert "missing_token" in r["notes"]


def test_402_during_sync_stops_remaining_asins(monkeypatch):
    seen: list[str] = []

    def sales(**kwargs):
        seen.append(kwargs["asin"])
        if kwargs["asin"] == HEROES[1]:
            raise ss.QuotaExceeded("quota", remaining="0")
        return {"data": {"sales": []}}

    monkeypatch.setattr(syn, "token_present", lambda: True)
    monkeypatch.setattr(syn, "check_auth", lambda: {"account": {"id": 1}})
    monkeypatch.setattr(syn, "get_sales_history", sales)
    monkeypatch.setattr(syn, "get_bsr_history",
                        lambda **k: {"data": {"bsr": []}})
    monkeypatch.setattr(syn, "get_price_history",
                        lambda **k: {"data": {"price": []}})

    def rt_boom(**k):
        raise AssertionError("RT must not run after 402")

    monkeypatch.setattr(syn, "collect_rank_groups", rt_boom)

    r = syn.sync_weekly(dry_run=True)
    assert seen == [HEROES[0], HEROES[1]]
    assert HEROES[2] not in seen
    assert r["status"] == "fail"
    assert r["quota_remaining"] == "0"
    assert any("402" in n for n in r["notes"])


def test_history_parsers_collapse_same_day_and_skip_empty():
    pulled = "2026-09-09T12:00:00+00:00"
    # 2024-01-15 08:00 PT and 20:00 PT → same Amazon calendar day
    morning = 1705334400  # 2024-01-15 08:00-08:00
    evening = 1705377600  # 2024-01-15 20:00-08:00
    sales = syn.sales_rows_from_payload(
        {"data": {"sales": [
            {"value": 4, "time": morning},
            {"value": 9, "time": evening},
        ]}},
        asin="B0CLHTF8YN", marketplace="US", pulled_at=pulled,
    )
    assert len(sales) == 1
    assert sales[0]["date"] == "2024-01-15"
    assert sales[0]["units"] == 9
    assert syn.sales_rows_from_payload(
        {"data": {"sales": []}},
        asin="B0CLHTF8YN", marketplace="US", pulled_at=pulled,
    ) == []
    assert syn.sales_rows_from_payload(
        {}, asin="B0CLHTF8YN", marketplace="US", pulled_at=pulled,
    ) == []


def test_upsert_idempotency_last_write_wins():
    pulled = "2026-09-09T12:00:00+00:00"
    first = syn.sales_rows_from_payload(
        {"data": {"sales": [{"value": 3, "time": 1705334400}]}},
        asin="B0CLHTF8YN", marketplace="US", pulled_at="2026-09-01T00:00:00+00:00",
    )
    second = syn.sales_rows_from_payload(
        {"data": {"sales": [{"value": 11, "time": 1705334400}]}},
        asin="B0CLHTF8YN", marketplace="US", pulled_at=pulled,
    )
    merged = syn.merge_upsert_rows(first, second, syn.SALES_TABLE)
    assert len(merged) == 1
    assert merged[0]["units"] == 11
    assert merged[0]["pulled_at"] == pulled
    keys = [syn.upsert_key(syn.SALES_TABLE, r) for r in first + second]
    assert keys[0] == keys[1]


def test_match_hero_groups_ignores_non_heroes():
    groups = [
        {"id": 1, "asin": "B0CLHTF8YN"},
        {"id": 2, "asin": "B00NOTHERO"},
        {"id": 3, "asin": "b0hbsz71xq"},
    ]
    matched = syn.match_hero_groups(groups, HEROES)
    assert [g["id"] for g in matched] == [1, 3]


def test_price_rows_clip_to_lookback():
    # 2015-01-01 is before a 90d lookback from ~2026
    old = syn.price_rows_from_payload(
        {"data": {"price": [{"value": 12.0, "time": 1420070400}]}},
        asin="B0DQFKMJFY", marketplace="US", pulled_at="now",
        min_date=date(2026, 6, 1),
    )
    assert old == []


def test_sync_module_never_creates_groups_or_product_research():
    src = inspect.getsource(syn) + inspect.getsource(ss)
    assert "product-research" not in src
    assert "listing-analyzer" not in src
    assert "keyword-research" not in src
    assert "create_groups" in inspect.getsource(syn)
    assert syn.load_config()["rank_tracker"]["create_groups"] is False
