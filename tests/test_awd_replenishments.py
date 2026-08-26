"""Tests for AWD replenishment and lead-time comparison."""
from __future__ import annotations

from src.inventory.awd_replenishments import _compute_replenish_days, median_replenish_days
from src.inventory.leadtime_summary import _group_inbound_batches


def test_compute_replenish_days_from_linked_fba_shipment():
    order = {
        "confirmedOn": "2026-07-01T10:00:00Z",
        "status": "SUCCESS",
        "outboundShipments": [{"shipmentId": "FBA123", "shipmentStatus": "CLOSED"}],
    }
    fba = {
        "FBA123": {
            "shipment_status": "CLOSED",
            "closed_at": "2026-07-20T10:00:00Z",
        },
    }
    days = _compute_replenish_days(order, fba)
    assert days == 19


def test_median_replenish_days(monkeypatch):
    orders = [
        {"order_id": "A", "order_status": "SUCCESS", "replenish_days": 16,
         "completed_at": "2026-08-01"},
        {"order_id": "B", "order_status": "SUCCESS", "replenish_days": 22,
         "completed_at": "2026-07-01"},
        {"order_id": "C", "order_status": "EXECUTING", "replenish_days": 5,
         "completed_at": None},
    ]

    def fake_fetch(table):
        if table == "inventory_awd_replenishments":
            return orders
        return []

    monkeypatch.setattr("src.inventory.awd_replenishments.fetch_all", fake_fetch)
    med, n = median_replenish_days(limit=5)
    assert med == 19
    assert n == 2


def test_group_inbound_batches_optimized_vs_single():
    ships = [
        {"shipment_status": "CLOSED", "receive_days": 18, "created_at": "2026-08-01T10:00:00Z",
         "destination_fc": "PHX3"},
        {"shipment_status": "CLOSED", "receive_days": 21, "created_at": "2026-08-01T11:00:00Z",
         "destination_fc": "ONT8"},
        {"shipment_status": "CLOSED", "receive_days": 19, "created_at": "2026-08-01T12:00:00Z",
         "destination_fc": "MDW2"},
        {"shipment_status": "CLOSED", "receive_days": 25, "created_at": "2026-07-15T10:00:00Z",
         "destination_fc": "PHX3"},
    ]
    optimized, single = _group_inbound_batches(ships)
    assert 18 in optimized and 21 in optimized and 19 in optimized
    assert single == [25]
