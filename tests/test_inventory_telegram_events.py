"""Inventory Telegram lines — damaged/unfillable + recent checked-in only."""
from __future__ import annotations

from datetime import date

from src.inventory.telegram_events import (
    build_inventory_alert_lines,
    checked_in_lines,
    damaged_unfillable_lines,
)

TODAY = date(2026, 9, 16)


def test_no_lines_when_nothing_is_wrong():
    assert damaged_unfillable_lines([{"sku": "A", "unfulfillable": 0}]) == []
    assert checked_in_lines(
        [{"shipment_id": "FBA1", "shipment_status": "SHIPPED",
          "units_received": 0, "received_at": None}],
        today=TODAY,
    ) == []
    assert build_inventory_alert_lines(
        [{"sku": "A", "unfulfillable": 0}],
        [{"shipment_id": "FBA1", "shipment_status": "IN_TRANSIT",
          "units_received": 0}],
        today=TODAY,
    ) == []


def test_unfillable_lists_sku_and_qty():
    lines = damaged_unfillable_lines([
        {"sku": "LIP-3", "unfulfillable": 12},
        {"sku": "DEO", "unfulfillable": 3},
        {"sku": "OK", "unfulfillable": 0},
    ])
    text = "\n".join(lines)
    assert "15 u across 2 SKU" in text
    assert "LIP-3: 12 u" in text
    assert "DEO: 3 u" in text
    assert "OK" not in text


def test_checked_in_uses_recent_receive_not_old_closed():
    ships = [
        {"shipment_id": "FBA-NEW", "shipment_status": "CHECKED_IN",
         "units_received": 40, "received_at": "2026-09-16T08:00:00-07:00"},
        {"shipment_id": "FBA-OLD", "shipment_status": "CLOSED",
         "units_received": 500, "received_at": "2026-08-01"},
    ]
    text = "\n".join(checked_in_lines(ships, today=TODAY))
    assert "FBA-NEW" in text and "40 u" in text
    assert "FBA-OLD" not in text


def test_combined_builder_is_silent_without_events():
    assert build_inventory_alert_lines([], [], today=TODAY) == []
