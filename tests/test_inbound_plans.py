"""Tests for inbound sync when v0 returns empty."""
from __future__ import annotations

from src.inventory.inbound_shipments import sync_inbound_shipments


def test_sync_does_not_call_v2024_when_v0_empty(monkeypatch):
    def fake_v0(*args, **kwargs):
        return {"ShipmentData": []}

    def boom(**kwargs):
        raise AssertionError("v2024 inbound plans must not be called")

    monkeypatch.setattr("src.inventory.inbound_shipments._get_shipments_page", fake_v0)
    monkeypatch.setattr("src.inventory.inbound_shipments._existing_by_id", lambda: {})
    monkeypatch.setattr("src.inventory.inbound_shipments._fba_ids_from_awd_replenishments", lambda extra=None: [])
    monkeypatch.setattr(
        "src.inventory.inbound_plans.sync_inbound_plans_v2024",
        boom,
    )

    result = sync_inbound_shipments(dry_run=True)
    assert result["v0_shipments"] == 0
    assert result["v2024_skipped"] is True
    assert result["shipments_found"] == 0
