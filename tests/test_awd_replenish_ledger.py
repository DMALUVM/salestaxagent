"""Ledger fallback for AWD replenishment lead time."""
from __future__ import annotations

from datetime import datetime, timezone

from src.inventory.awd_replenishments import _compute_replenish_days, _ledger_any_fc_receipts


def test_ledger_any_fc_receipts_finds_sellable(monkeypatch):
    monkeypatch.setattr(
        "src.inventory.awd_replenishments.fetch_all",
        lambda table: [
            {
                "sku": "SKU1",
                "event_date": "2026-03-10",
                "event_type": "receipts",
                "quantity": 50,
                "disposition": "sellable",
                "fc_code": "PHX3",
            }
        ] if table == "inventory_events" else [],
    )
    start = datetime(2026, 3, 1, tzinfo=timezone.utc)
    recv, sellable = _ledger_any_fc_receipts(["SKU1"], start)
    assert recv is not None
    assert sellable is not None
    assert sellable.day == 10


def test_compute_replenish_days_uses_ledger_when_no_fba_link(monkeypatch):
    monkeypatch.setattr(
        "src.inventory.awd_replenishments._ledger_any_fc_receipts",
        lambda skus, start: (
            datetime(2026, 3, 5, tzinfo=timezone.utc),
            datetime(2026, 3, 12, tzinfo=timezone.utc),
        ),
    )
    order = {
        "status": "SUCCESS",
        "confirmedOn": "2026-03-01T00:00:00Z",
        "updatedAt": "2026-03-20T00:00:00Z",
        "outboundShipments": [{"shipmentId": "repl-ship-abc", "shipmentStatus": "IN_TRANSIT"}],
        "shippedProducts": [{"sku": "SKU1", "quantity": 100}],
    }
    days, basis = _compute_replenish_days(order, {})
    assert days == 11
    assert basis == "ledger_shipped_to_sellable"


def test_compute_ignores_same_day_ledger_and_uses_success(monkeypatch):
    monkeypatch.setattr(
        "src.inventory.awd_replenishments._ledger_any_fc_receipts",
        lambda skus, start: (
            datetime(2026, 3, 1, tzinfo=timezone.utc),
            datetime(2026, 3, 1, tzinfo=timezone.utc),
        ),
    )
    order = {
        "status": "SUCCESS",
        "confirmedOn": "2026-03-01T00:00:00Z",
        "updatedAt": "2026-03-08T00:00:00Z",
        "outboundShipments": [{"shipmentId": "repl-ship-abc", "shipmentStatus": "IN_TRANSIT"}],
        "shippedProducts": [{"sku": "SKU1", "quantity": 100}],
    }
    days, basis = _compute_replenish_days(order, {})
    assert days == 7
    assert basis == "shipped_to_success"
