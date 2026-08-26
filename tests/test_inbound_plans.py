"""Tests for inbound v2024 fallback when v0 returns empty."""
from __future__ import annotations

from src.inventory.inbound_shipments import sync_inbound_shipments


def test_sync_falls_back_to_v2024_when_v0_empty(monkeypatch):
    def fake_v0(*args, **kwargs):
        return {"ShipmentData": []}

    v2024_rows = {
        "plans_scanned": 1,
        "ship_rows": [{
            "shipment_id": "FBA1234ABCD",
            "shipment_status": "CLOSED",
            "destination_fc": "PHX3",
            "units_shipped": 100,
            "units_received": 100,
            "receive_days": 18,
            "receive_days_basis": "shipped_to_received",
            "raw": {"source": "inbound_v2024"},
        }],
        "item_rows": [{
            "shipment_id": "FBA1234ABCD",
            "sku": "SKU1",
            "quantity_shipped": 100,
            "quantity_received": 100,
        }],
        "dry_run": True,
    }

    monkeypatch.setattr("src.inventory.inbound_shipments._get_shipments_page", fake_v0)
    monkeypatch.setattr("src.inventory.inbound_shipments._existing_by_id", lambda: {})
    monkeypatch.setattr(
        "src.inventory.inbound_plans.sync_inbound_plans_v2024",
        lambda **kwargs: v2024_rows,
    )

    result = sync_inbound_shipments(dry_run=True)
    assert result["v0_shipments"] == 0
    assert result["v2024_plans"] == 1
    assert result["shipments_found"] == 1
