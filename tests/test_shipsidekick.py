"""Ship Sidekick 3PL snapshot: pulled_at stamp, carry-forward, no SKU smash."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from src.shipsidekick.client import (
    _3pl_sync_outcome,
    _carry_forward_missing_instock,
    _catalog_skus_from_products,
    _omitted_catalog_skus,
    _parse_inventory_items,
    _snapshot_rows,
    live_3pl_snapshots,
    sync_3pl,
)


def _item(sku="SKU-1", available=12):
    return {
        "sku": sku,
        "product_name": "Tallow balm",
        "available": available,
        "committed": 1,
        "reserved": 0,
        "incoming": 4,
        "damaged": 0,
        "warehouse": "3PL-A",
        "raw": "{}",
    }


def _api_item(sku: str, title: str, available: int, *, requires_shipping: bool = True):
    return {
        "availableQuantity": available,
        "committedQuantity": 0,
        "reservedQuantity": 0,
        "incomingQuantity": 0,
        "damagedQuantity": 0,
        "warehouseId": "wh-1",
        "warehouse": {"name": "Excel3PL"},
        "productVariant": {
            "sku": sku,
            "title": title,
            "requiresShipping": requires_shipping,
        },
    }


def test_snapshot_rows_stamp_pulled_at_on_every_row():
    stamp = "2026-08-22T18:00:00+00:00"
    rows = _snapshot_rows([_item("A"), _item("B")], pulled_at=stamp)
    assert [r["sku"] for r in rows] == ["A", "B"]
    assert all(r["pulled_at"] == stamp for r in rows)


def test_snapshot_rows_default_pulled_at_is_utc_now():
    before = datetime.now(timezone.utc)
    rows = _snapshot_rows([_item()])
    after = datetime.now(timezone.utc)
    assert len(rows) == 1
    pulled = datetime.fromisoformat(rows[0]["pulled_at"])
    assert pulled.tzinfo is not None
    assert before <= pulled <= after


def test_parse_keeps_similar_sku_codes_distinct():
    items = _parse_inventory_items([
        _api_item("SKU-A1", "Product A1", 100),
        _api_item("SKU-A19", "Product A19", 50),
        _api_item("SKU-B", "Product B", 10),
    ])
    by_sku = {i["sku"]: i["available"] for i in items}
    assert by_sku["SKU-A1"] == 100
    assert by_sku["SKU-A19"] == 50
    assert set(by_sku) == {"SKU-A1", "SKU-A19", "SKU-B"}


def test_parse_does_not_rewrite_sku_digits():
    items = _parse_inventory_items([
        _api_item("SKU-A1", "Product A1", 10),
    ])
    assert [i["sku"] for i in items] == ["SKU-A1"]


def test_parse_keeps_instock_when_requires_shipping_false():
    items = _parse_inventory_items([
        _api_item("SKU-PHYS", "Physical", 80, requires_shipping=False),
        _api_item("SKU-GIFT", "Gift card", 0, requires_shipping=False),
    ])
    by_sku = {i["sku"]: i["available"] for i in items}
    assert by_sku["SKU-PHYS"] == 80
    assert "SKU-GIFT" not in by_sku


def test_carry_forward_keeps_every_omitted_instock_sku():
    feed = [_item("SKU-KEEP", 40)]
    prior = [
        {"sku": "SKU-ALPHA", "product_name": "Alpha", "available": 11,
         "committed": 0, "reserved": 0, "incoming": 0, "damaged": 0,
         "warehouse": "WH", "pulled_at": "2026-08-17T13:13:32+00:00"},
        {"sku": "SKU-BETA", "product_name": "Beta", "available": 22,
         "committed": 0, "reserved": 0, "incoming": 0, "damaged": 0,
         "warehouse": "WH", "pulled_at": "2026-08-17T13:13:32+00:00"},
        {"sku": "SKU-GAMMA", "product_name": "Gamma", "available": 33,
         "committed": 0, "reserved": 0, "incoming": 0, "damaged": 0,
         "warehouse": "WH", "pulled_at": "2026-08-17T13:13:32+00:00"},
        {"sku": "SKU-ZERO", "product_name": "Zero", "available": 0, "incoming": 0,
         "pulled_at": "2026-08-17T13:13:32+00:00"},
    ]
    merged = _carry_forward_missing_instock(feed, prior)
    by_sku = {i["sku"]: i["available"] for i in merged}
    assert by_sku["SKU-KEEP"] == 40
    assert by_sku["SKU-ALPHA"] == 11
    assert by_sku["SKU-BETA"] == 22
    assert by_sku["SKU-GAMMA"] == 33
    assert "SKU-ZERO" not in by_sku


def test_carry_forward_does_not_override_feed_zero():
    feed = [_item("SKU-A", 0)]
    prior = [{"sku": "SKU-A", "available": 99, "incoming": 0}]
    merged = _carry_forward_missing_instock(feed, prior)
    assert len(merged) == 1
    assert merged[0]["available"] == 0


def test_carry_forward_does_not_smash_similar_sku_codes():
    feed = [_item("SKU-A19", 50)]
    prior = [{"sku": "SKU-A1", "available": 100, "incoming": 0}]
    merged = _carry_forward_missing_instock(feed, prior)
    by_sku = {i["sku"]: i["available"] for i in merged}
    assert by_sku["SKU-A1"] == 100
    assert by_sku["SKU-A19"] == 50


def test_live_snapshots_include_stale_instock_and_latest_zeros():
    rows = [
        {"sku": "SKU-A19", "available": 50, "incoming": 0, "pulled_at": "2026-08-26T10:35:01+00:00"},
        {"sku": "SKU-ZERO", "available": 0, "incoming": 0, "pulled_at": "2026-08-26T10:35:01+00:00"},
        {"sku": "SKU-A1", "available": 100, "incoming": 0, "pulled_at": "2026-08-17T13:13:32+00:00"},
        {"sku": "SKU-GONE", "available": 0, "incoming": 0, "pulled_at": "2026-08-17T13:13:32+00:00"},
    ]
    live = live_3pl_snapshots(rows)
    by_sku = {r["sku"]: r["available"] for r in live}
    assert by_sku["SKU-A1"] == 100
    assert by_sku["SKU-A19"] == 50
    assert by_sku["SKU-ZERO"] == 0
    assert "SKU-GONE" not in by_sku


def _product(sku: str, *, tracks: bool | None = True, extra_variants: list | None = None):
    variant = {"sku": sku}
    if tracks is not None:
        variant["tracksInventory"] = tracks
    variants = [variant]
    if extra_variants:
        variants.extend(extra_variants)
    return {"title": sku, "productVariants": variants}


def test_catalog_skus_include_tracked_and_unspecified():
    skus = _catalog_skus_from_products([
        _product("DDPE0001Shop", tracks=True),
        _product("DDPE0002Shop", tracks=None),
        _product("GIFT-CARD", tracks=False),
        {"title": "No sku", "productVariants": [{"sku": "", "tracksInventory": True}]},
    ])
    assert skus == ["DDPE0001Shop", "DDPE0002Shop"]
    assert "GIFT-CARD" not in skus


def test_catalog_skus_from_flat_variant_row():
    skus = _catalog_skus_from_products([
        {"sku": "DDPE0003Shop", "tracksInventory": True},
    ])
    assert skus == ["DDPE0003Shop"]


def test_get_catalog_skus_paginates_products(monkeypatch):
    from src.shipsidekick import client as sk

    calls: list[str] = []

    class FakeResp:
        def __init__(self, body, status_code=200):
            self.status_code = status_code
            self.text = ""
            self._body = body

        def json(self):
            return self._body

    pages = [
        FakeResp({
            "data": [_product("DDPE0001Shop")],
            "hasMore": True,
            "nextCursor": "c2",
        }),
        FakeResp({
            "data": [_product("DDPE0002Shop"), _product("GIFT", tracks=False)],
            "hasMore": False,
        }),
    ]

    def fake_get(url, headers=None, params=None, timeout=30):
        calls.append(url)
        return pages.pop(0)

    monkeypatch.setattr(sk, "_headers", lambda: {"Authorization": "Bearer x"})
    monkeypatch.setattr(sk.httpx, "get", fake_get)
    skus = sk.get_catalog_skus()
    assert skus == ["DDPE0001Shop", "DDPE0002Shop"]
    assert all("/api/v1/products" in u for u in calls)
    assert len(calls) == 2


def test_omitted_catalog_skus_are_feed_gaps():
    feed = [_item("DDPE0002Shop", 10), _item("DDPE0003Shop", 20)]
    catalog = ["DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"]
    assert _omitted_catalog_skus(feed, catalog) == ["DDPE0001Shop", "DDPE0004Shop"]


def test_3pl_outcome_partial_when_instock_or_lip_balm_omitted():
    prior = [{"sku": "DDPE0001Shop", "available": 1594, "incoming": 0}]
    status, msg = _3pl_sync_outcome(
        ["DDPE0001Shop"], prior, {"ddpe0001shop": 1594},
    )
    assert status == "partial"
    assert msg == "3PL omitted catalog SKUs: DDPE0001Shop (carried 1594)"

    status, msg = _3pl_sync_outcome(["DDPE0004Shop"], [], {})
    assert status == "partial"
    assert "DDPE0004Shop" in msg

    status, msg = _3pl_sync_outcome(["OTHER-SKU"], [], {})
    assert status == "success"
    assert msg == ""

    status, msg = _3pl_sync_outcome(
        ["OTHER-SKU"],
        [{"sku": "OTHER-SKU", "available": 12, "incoming": 0}],
        {"other-sku": 12},
    )
    assert status == "partial"
    assert "OTHER-SKU (carried 12)" in msg


def test_parse_duplicate_variants_keep_highest_available():
    items = _parse_inventory_items([
        _api_item("DDPE0002Shop", "Peppermint live", 80),
        _api_item("DDPE0002Shop", "Peppermint zero", 0),
        _api_item("DDPE0003Shop", "Orange live", 40),
        _api_item("DDPE0003Shop", "Orange zero", 0),
    ])
    by_sku = {i["sku"]: i["available"] for i in items}
    assert by_sku["DDPE0002Shop"] == 80
    assert by_sku["DDPE0003Shop"] == 40


def test_sync_3pl_omitted_ddpe0001_is_partial_and_still_upserts(monkeypatch):
    """Feed drops unscented; catalog + prior 1594 must not look like success."""
    feed = [
        _item("DDPE0002Shop", 80),
        _item("DDPE0003Shop", 40),
        _item("DDPE0004Shop", 25),
    ]
    catalog = ["DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"]
    prior = [{
        "sku": "DDPE0001Shop",
        "product_name": "Unscented 3pk",
        "available": 1594,
        "committed": 0,
        "reserved": 0,
        "incoming": 0,
        "damaged": 0,
        "warehouse": "Excel3PL",
        "pulled_at": "2026-09-02T12:00:00+00:00",
    }]
    written: list[dict] = []

    monkeypatch.setattr(
        "src.shipsidekick.client.get_inventory", lambda: list(feed),
    )
    monkeypatch.setattr(
        "src.shipsidekick.client.get_catalog_skus", lambda: list(catalog),
    )
    monkeypatch.setattr(
        "src.shipsidekick.client.fetch_all", lambda table: list(prior),
    )

    def fake_upsert(table, rows, on_conflict="sku"):
        assert table == "inventory_3pl_snapshots"
        written.extend(rows)
        return len(rows)

    monkeypatch.setattr("src.shipsidekick.client.upsert_rows", fake_upsert)
    monkeypatch.setattr("src.shipsidekick.client.log_ingestion", lambda **k: None)

    result = sync_3pl()
    by_sku = {r["sku"]: r for r in written}

    assert set(by_sku) >= {"DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"}
    assert by_sku["DDPE0002Shop"]["available"] == 80
    assert result["omitted_skus"] == ["DDPE0001Shop"]
    assert result["status"] == "partial"
    assert result["status"] != "success"
    assert "DDPE0001Shop (carried 1594)" in result["message"]
    assert "3PL omitted catalog SKUs" in result["message"]
    assert "DDPE0001Shop" in result["carried_forward"]
    assert by_sku["DDPE0001Shop"]["available"] == 1594
    raw = json.loads(by_sku["DDPE0001Shop"]["raw"])
    assert raw["carried_forward"] is True


def test_run_3pl_sync_records_partial_not_quiet_success(monkeypatch):
    from src import main as mainmod

    finishes: list[tuple] = []
    monkeypatch.setattr("src.db.job_start", lambda name: "run-3pl")
    monkeypatch.setattr(
        "src.db.job_finish",
        lambda run_id, status="success", message=None, stats=None: finishes.append(
            (run_id, status, message)
        ),
    )
    monkeypatch.setattr(
        "src.shipsidekick.client.sync_3pl",
        lambda: {
            "rows_total": 4,
            "rows_inserted": 4,
            "status": "partial",
            "message": "4 SKUs, 4 upserted — 3PL omitted catalog SKUs: DDPE0001Shop (carried 1594)",
            "omitted_skus": ["DDPE0001Shop"],
        },
    )
    mainmod._run_3pl_sync()
    assert finishes
    assert finishes[0][1] == "partial"
    assert "DDPE0001Shop (carried 1594)" in (finishes[0][2] or "")
