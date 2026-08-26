"""Tests for inventory rate / lead-time calibration."""
from __future__ import annotations

from datetime import date, timedelta

from src.inventory.rate_signals import implied_rate, _agreement
from src.inventory.inbound_shipments import median_receive_days
from src.inventory.snapshots_daily import append_daily_snapshots, fba_on_hand


def test_fba_on_hand_sums_components():
    row = {
        "fulfillable": 100,
        "reserved": 10,
        "researching": 5,
        "unfulfillable": 2,
    }
    assert fba_on_hand(row) == 117


def test_agreement_ok_within_threshold():
    status, div = _agreement(10.0, 11.0)
    assert status == "ok"
    assert div is not None and div <= 25


def test_agreement_investigate_when_divergent():
    status, div = _agreement(10.0, 22.0)
    assert status == "investigate"
    assert div == 120.0


def test_implied_rate_from_daily_snapshots(monkeypatch):
    sku = "TESTSKU"
    today = date.today()
    d0 = today - timedelta(days=14)
    d1 = today
    daily = [
        {
            "sku": sku,
            "snapshot_date": d0.isoformat(),
            "total_quantity": 1000,
        },
        {
            "sku": sku,
            "snapshot_date": d1.isoformat(),
            "total_quantity": 860,
        },
    ]

    def fake_fetch(table):
        if table == "inventory_snapshots_daily":
            return daily
        if table == "inventory_events":
            return []
        return []

    monkeypatch.setattr("src.inventory.rate_signals.fetch_all", fake_fetch)
    rate = implied_rate(sku, 14, today)
    assert rate is not None
    assert 9.0 <= rate <= 11.0  # 140 units / 14 days


def test_median_receive_days(monkeypatch):
    ships = [
        {"shipment_id": "A", "shipment_status": "CLOSED", "receive_days": 19,
         "closed_at": "2026-08-01"},
        {"shipment_id": "B", "shipment_status": "CLOSED", "receive_days": 23,
         "closed_at": "2026-07-01"},
        {"shipment_id": "C", "shipment_status": "WORKING", "receive_days": 5,
         "closed_at": None},
    ]

    def fake_fetch(table):
        if table == "inventory_inbound_shipments":
            return ships
        return []

    monkeypatch.setattr("src.inventory.inbound_shipments.fetch_all", fake_fetch)
    med, n = median_receive_days(limit=5)
    assert med == 21
    assert n == 2
