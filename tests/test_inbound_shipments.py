"""Tests for FBA inbound shipment sync query params."""
from __future__ import annotations

from datetime import datetime, timezone

from src.inventory.inbound_shipments import _shipments_query_params


def test_shipments_date_range_includes_status_list():
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    end = datetime(2026, 6, 1, tzinfo=timezone.utc)
    params = dict(_shipments_query_params(start, end, None))
    assert params["QueryType"] == "DATE_RANGE"
    assert "LastUpdatedAfter" in params
    assert "LastUpdatedBefore" in params
    status_vals = [v for k, v in _shipments_query_params(start, end, None) if k == "ShipmentStatusList"]
    assert "CLOSED" in status_vals
    assert "SHIPPED" in status_vals
    assert len(status_vals) >= 5


def test_shipments_next_token_uses_next_token_query_type():
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    params = dict(_shipments_query_params(start, None, "abc123"))
    assert params["QueryType"] == "NEXT_TOKEN"
    assert params["NextToken"] == "abc123"
    assert "ShipmentStatusList" not in params
