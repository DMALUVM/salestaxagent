"""Tests for AWD API client and inbound shipment sync."""
from __future__ import annotations

import pytest

from src.amazon_sp.client import SPAPIError
from src.inventory.awd_client import awd_probe, AWD_ROLE_HINT
from src.inventory.awd_inbound import median_awd_inbound_days, sync_awd_inbound_shipments


def test_awd_get_403_includes_role_hint(monkeypatch):
    class FakeResp:
        status_code = 403
        text = "Access denied"

    monkeypatch.setattr("src.inventory.awd_client.httpx.get", lambda *a, **k: FakeResp())
    monkeypatch.setattr("src.inventory.awd_client._headers", lambda: {})

    from src.inventory.awd_client import awd_get

    with pytest.raises(SPAPIError) as exc:
        awd_get("/inventory")
    assert "Amazon Warehousing and Distribution" in str(exc.value)


def test_awd_probe_all_ok(monkeypatch):
    def fake_get(path, *, params=None, timeout=60):
        if path == "/inventory":
            return {"inventory": [{"sku": "A"}]}
        if path == "/replenishmentOrders":
            return {"orders": []}
        if path == "/inboundShipments":
            return {"shipments": [{"shipmentId": "S1"}]}
        return {}

    monkeypatch.setattr("src.inventory.awd_client.awd_get", fake_get)
    result = awd_probe()
    assert result["all_ok"] is True
    assert result["inventory"]["ok"] is True
    assert result["inbound_shipments"]["sample_count"] == 1


def test_awd_probe_partial_failure(monkeypatch):
    def fake_get(path, *, params=None, timeout=60):
        if path == "/inventory":
            raise SPAPIError(f"403 forbidden. {AWD_ROLE_HINT}")
        return {"orders": []} if path == "/replenishmentOrders" else {"shipments": []}

    monkeypatch.setattr("src.inventory.awd_client.awd_get", fake_get)
    result = awd_probe()
    assert result["all_ok"] is False
    assert result["inventory"]["ok"] is False


def test_sync_awd_inbound_dry_run(monkeypatch):
    page = {
        "shipments": [{
            "shipmentId": "AWD-1",
            "shipmentStatus": "CLOSED",
            "createdAt": "2026-07-01T10:00:00Z",
            "updatedAt": "2026-07-15T10:00:00Z",
        }],
    }
    monkeypatch.setattr("src.inventory.awd_inbound.awd_get", lambda *a, **k: page)
    monkeypatch.setattr("src.inventory.awd_inbound._existing_by_id", lambda: {})

    result = sync_awd_inbound_shipments(dry_run=True)
    assert result["shipments_found"] == 1
    assert result["rows_upserted"] == 0


def test_median_awd_inbound_days(monkeypatch):
    ships = [
        {"shipment_status": "CLOSED", "receive_days": 10,
         "receive_days_basis": "shipped_to_received", "closed_at": "2026-08-01"},
        {"shipment_status": "CLOSED", "receive_days": 14,
         "receive_days_basis": "shipped_to_received", "closed_at": "2026-07-01"},
        {"shipment_status": "CLOSED", "receive_days": 99,
         "receive_days_basis": "created_to_closed_fallback", "closed_at": "2026-06-01"},
    ]

    monkeypatch.setattr(
        "src.inventory.awd_inbound.fetch_all",
        lambda table: ships if table == "inventory_awd_inbound_shipments" else [],
    )
    med, n = median_awd_inbound_days(limit=5)
    assert med == 12
    assert n == 2
