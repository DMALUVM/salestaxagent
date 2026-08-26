"""Ship Sidekick 3PL snapshot: pulled_at stamp, carry-forward, no SKU smash."""
from __future__ import annotations

from datetime import datetime, timezone

from src.shipsidekick.client import (
    _carry_forward_missing_instock,
    _parse_inventory_items,
    _snapshot_rows,
    live_3pl_snapshots,
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
