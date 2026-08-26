"""Successful inventory-sync must advance Amazon pull timestamps.

inventory_snapshots / inventory_awd / inventory_restock / inventory_planning
default snapshot_at / pulled_at on INSERT only. Upsert-on-sku without an
explicit stamp left those columns frozen at first insert (2026-08-17) while
the job reported success.
"""
from __future__ import annotations

from datetime import datetime, timezone

from src.inventory.awd import _awd_inventory_rows
from src.inventory.sync import (
    _aggregate_fba_summaries,
    _parse_planning,
    _parse_restock,
    _stamp_now,
)


STAMP = datetime(2026, 8, 26, 23, 10, tzinfo=timezone.utc)
STAMP_ISO = STAMP.isoformat()


def _fba_item(sku="DDPE0001Shop", fulfillable=12, inbound_shipped=4):
    return {
        "sellerSku": sku,
        "asin": "B00TEST",
        "fnSku": "X00",
        "productName": "Unscented 3pk",
        "totalQuantity": fulfillable + inbound_shipped,
        "inventoryDetails": {
            "fulfillableQuantity": fulfillable,
            "inboundWorkingQuantity": 0,
            "inboundShippedQuantity": inbound_shipped,
            "inboundReceivingQuantity": 0,
            "reservedQuantity": {"totalReservedQuantity": 1},
            "researchingQuantity": {"totalResearchingQuantity": 0},
            "unfulfillableQuantity": {"totalUnfulfillableQuantity": 0},
        },
    }


def test_stamp_now_writes_field_even_when_qty_unchanged():
    rows = [{"sku": "DDPE0001Shop", "fulfillable": 12}]
    stamped = _stamp_now(rows, "snapshot_at", now=STAMP)
    assert stamped[0]["fulfillable"] == 12
    assert stamped[0]["snapshot_at"] == STAMP_ISO


def test_fba_upsert_payload_includes_fresh_snapshot_at():
    rows = _stamp_now(_aggregate_fba_summaries([_fba_item()]), "snapshot_at", now=STAMP)
    assert len(rows) == 1
    assert rows[0]["sku"] == "DDPE0001Shop"
    assert rows[0]["fulfillable"] == 12
    assert rows[0]["inbound_shipped"] == 4
    assert rows[0]["snapshot_at"] == STAMP_ISO


def test_same_fba_quantities_still_bump_snapshot_at():
    first = _stamp_now(_aggregate_fba_summaries([_fba_item()]), "snapshot_at", now=STAMP)
    later = datetime(2026, 8, 27, 10, 30, tzinfo=timezone.utc)
    second = _stamp_now(_aggregate_fba_summaries([_fba_item()]), "snapshot_at", now=later)
    assert first[0]["fulfillable"] == second[0]["fulfillable"]
    assert first[0]["inbound_shipped"] == second[0]["inbound_shipped"]
    assert second[0]["snapshot_at"] > first[0]["snapshot_at"]


def test_awd_upsert_payload_includes_fresh_pulled_at():
    rows = _awd_inventory_rows(
        [{
            "sku": "DDPE0001Shop",
            "totalOnhandQuantity": 80,
            "totalInboundQuantity": 20,
            "inventoryDetails": {"replenishmentQuantity": 5},
        }],
        pulled_at=STAMP,
    )
    assert rows[0]["awd_on_hand"] == 80
    assert rows[0]["awd_inbound"] == 20
    assert rows[0]["pulled_at"] == STAMP_ISO


def test_restock_upsert_payload_includes_fresh_pulled_at():
    tsv = (
        "merchant-sku\tasin\trecommended-replenishment-qty\tdays-of-supply\n"
        "DDPE0001Shop\tB00TEST\t40\t18\n"
    )
    rows = _stamp_now(_parse_restock(tsv), "pulled_at", now=STAMP)
    assert rows[0]["sku"] == "DDPE0001Shop"
    assert rows[0]["recommended_qty"] == 40
    assert rows[0]["days_of_supply"] == 18.0
    assert rows[0]["pulled_at"] == STAMP_ISO


def test_planning_upsert_payload_includes_fresh_pulled_at():
    tsv = (
        "sku\tasin\tavailable\tweeks-of-cover-t30\n"
        "DDPE0001Shop\tB00TEST\t12\t2.5\n"
    )
    rows = _stamp_now(_parse_planning(tsv), "pulled_at", now=STAMP)
    assert rows[0]["sku"] == "DDPE0001Shop"
    assert rows[0]["available"] == 12
    assert rows[0]["pulled_at"] == STAMP_ISO


def test_sync_success_implies_amazon_timestamps_advance():
    """Row builders used by a successful inventory-sync always emit now()."""
    fba = _stamp_now(_aggregate_fba_summaries([_fba_item()]), "snapshot_at", now=STAMP)
    awd = _awd_inventory_rows(
        [{"sku": "DDPE0002Shop", "totalOnhandQuantity": 3, "totalInboundQuantity": 0}],
        pulled_at=STAMP,
    )
    restock = _stamp_now(
        _parse_restock("merchant-sku\nDDPE0003Shop\n"),
        "pulled_at",
        now=STAMP,
    )
    planning = _stamp_now(
        _parse_planning("sku\nDDPE0004Shop\n"),
        "pulled_at",
        now=STAMP,
    )
    assert fba[0]["snapshot_at"] == STAMP_ISO
    assert awd[0]["pulled_at"] == STAMP_ISO
    assert restock[0]["pulled_at"] == STAMP_ISO
    assert planning[0]["pulled_at"] == STAMP_ISO
