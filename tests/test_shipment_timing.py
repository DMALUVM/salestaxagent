"""Tests for ship → receive timing helpers."""
from __future__ import annotations

from datetime import datetime, timezone

from src.inventory.shipment_timing import (
    compute_receive_days,
    transport_shipped_date,
    update_shipped_at,
)


def test_compute_receive_days_prefers_shipped_to_prime():
    shipped = datetime(2026, 7, 1, tzinfo=timezone.utc)
    prime = datetime(2026, 7, 18, tzinfo=timezone.utc)
    days, basis = compute_receive_days(shipped, None, prime, None, None)
    assert days == 17
    assert basis == "shipped_to_prime"


def test_compute_receive_days_shipped_to_received():
    shipped = datetime(2026, 7, 1, tzinfo=timezone.utc)
    recv = datetime(2026, 7, 21, tzinfo=timezone.utc)
    days, basis = compute_receive_days(shipped, recv, None, None, None)
    assert days == 20
    assert basis == "shipped_to_received"


def test_update_shipped_at_on_status_transition():
    updated = datetime(2026, 8, 5, tzinfo=timezone.utc)
    dt = update_shipped_at(
        {"shipment_status": "WORKING"},
        "SHIPPED",
        updated,
        None,
        None,
    )
    assert dt == updated


def test_transport_pickup_date():
    payload = {
        "TransportContent": {
            "TransportDetails": {
                "PartneredLtlData": {
                    "PreviewPickupDate": "Wed Feb 15 00:00:00 GMT 2023",
                },
            },
        },
    }
    dt = transport_shipped_date(payload)
    assert dt is not None
    assert dt.year == 2023 and dt.month == 2 and dt.day == 15
