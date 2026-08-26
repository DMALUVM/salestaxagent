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


def test_parse_keeps_0001_and_00019_distinct():
    items = _parse_inventory_items([
        _api_item("DDPE0001Shop", "3 Pack - Unscented", 1594),
        _api_item("DDPE00019Shop", "Vanilla & Sandalwood", 831),
        _api_item("DDPE0002Shop", "3 Pack - Peppermint", 6448),
    ])
    by_sku = {i["sku"]: i["available"] for i in items}
    assert by_sku["DDPE0001Shop"] == 1594
    assert by_sku["DDPE00019Shop"] == 831
    assert "DDPE00019Shop" in by_sku
    assert set(by_sku) == {"DDPE0001Shop", "DDPE00019Shop", "DDPE0002Shop"}


def test_parse_does_not_rewrite_sku_digits():
    items = _parse_inventory_items([
        _api_item("DDPE0001Shop", "Unscented 3pk", 10),
    ])
    assert [i["sku"] for i in items] == ["DDPE0001Shop"]


def test_parse_keeps_instock_when_requires_shipping_false():
    items = _parse_inventory_items([
        _api_item("DDPE0001Shop", "3 Pack - Unscented", 1594, requires_shipping=False),
        _api_item("GiftCard", "Gift card", 0, requires_shipping=False),
    ])
    by_sku = {i["sku"]: i["available"] for i in items}
    assert by_sku["DDPE0001Shop"] == 1594
    assert "GiftCard" not in by_sku


def test_carry_forward_keeps_omitted_instock_sku():
    feed = [
        _item("DDPE0002Shop", 6448),
        _item("DDPE00019Shop", 831),
    ]
    prior = [
        {
            "sku": "DDPE0001Shop",
            "product_name": "3 Pack - Unscented",
            "available": 1594,
            "committed": 0,
            "reserved": 0,
            "incoming": 0,
            "damaged": 0,
            "warehouse": "Excel3PL",
            "pulled_at": "2026-08-17T13:13:32+00:00",
        },
        {
            "sku": "DDPE0009Shop",
            "product_name": "Rustic Vanilla",
            "available": 0,
            "incoming": 0,
            "pulled_at": "2026-08-17T13:13:32+00:00",
        },
    ]
    merged = _carry_forward_missing_instock(feed, prior)
    by_sku = {i["sku"]: i["available"] for i in merged}
    assert by_sku["DDPE0001Shop"] == 1594
    assert by_sku["DDPE00019Shop"] == 831
    assert by_sku["DDPE0002Shop"] == 6448
    assert "DDPE0009Shop" not in by_sku


def test_carry_forward_does_not_override_feed_zero():
    feed = [_item("DDPE0001Shop", 0)]
    prior = [{"sku": "DDPE0001Shop", "available": 1594, "incoming": 0}]
    merged = _carry_forward_missing_instock(feed, prior)
    assert len(merged) == 1
    assert merged[0]["available"] == 0


def test_carry_forward_does_not_smash_0001_into_00019():
    feed = [_item("DDPE00019Shop", 831)]
    prior = [{"sku": "DDPE0001Shop", "available": 1594, "incoming": 0}]
    merged = _carry_forward_missing_instock(feed, prior)
    by_sku = {i["sku"]: i["available"] for i in merged}
    assert by_sku["DDPE0001Shop"] == 1594
    assert by_sku["DDPE00019Shop"] == 831


def test_live_snapshots_include_stale_instock_and_latest_zeros():
    rows = [
        {"sku": "DDPE00019Shop", "available": 831, "incoming": 0, "pulled_at": "2026-08-26T10:35:01+00:00"},
        {"sku": "DDPE0009Shop", "available": 0, "incoming": 0, "pulled_at": "2026-08-26T10:35:01+00:00"},
        {"sku": "DDPE0001Shop", "available": 1594, "incoming": 0, "pulled_at": "2026-08-17T13:13:32+00:00"},
        {"sku": "GONEShop", "available": 0, "incoming": 0, "pulled_at": "2026-08-17T13:13:32+00:00"},
    ]
    live = live_3pl_snapshots(rows)
    by_sku = {r["sku"]: r["available"] for r in live}
    assert by_sku["DDPE0001Shop"] == 1594
    assert by_sku["DDPE00019Shop"] == 831
    assert by_sku["DDPE0009Shop"] == 0
    assert "GONEShop" not in by_sku
