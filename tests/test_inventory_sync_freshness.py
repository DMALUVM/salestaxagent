"""Successful inventory-sync must advance Amazon pull timestamps.

inventory_snapshots / inventory_awd / inventory_restock / inventory_planning
default snapshot_at / pulled_at on INSERT only. Upsert-on-sku without an
explicit stamp left those columns frozen at first insert (2026-08-17) while
the job reported success.
"""
from __future__ import annotations

from datetime import datetime, timezone

from src.inventory.awd import _awd_inventory_rows
from src.inventory.freshness import (
    WAREHOUSE_STAMP_FIELDS,
    collect_skip_reasons,
    skip_empty,
    stamp_now,
)
from src.inventory.snapshots_daily import append_daily_snapshots
from src.inventory.sync import (
    _aggregate_fba_summaries,
    _parse_planning,
    _parse_restock,
    _stamp_now,
)


STAMP = datetime(2026, 8, 26, 23, 10, tzinfo=timezone.utc)
STAMP_ISO = STAMP.isoformat()


def _fba_item(sku="SKU-A", fulfillable=12, inbound_shipped=4):
    return {
        "sellerSku": sku,
        "asin": "B00TEST",
        "fnSku": "X00",
        "productName": "Test product",
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
    rows = [{"sku": "SKU-A", "fulfillable": 12}]
    stamped = _stamp_now(rows, "snapshot_at", now=STAMP)
    assert stamped[0]["fulfillable"] == 12
    assert stamped[0]["snapshot_at"] == STAMP_ISO


def test_fba_upsert_payload_includes_fresh_snapshot_at():
    rows = _stamp_now(_aggregate_fba_summaries([_fba_item()]), "snapshot_at", now=STAMP)
    assert len(rows) == 1
    assert rows[0]["sku"] == "SKU-A"
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


def test_awd_zero_on_hand_row_is_kept_as_zero():
    rows = _awd_inventory_rows(
        [{
            "sku": "DDPE0001Shop",
            "totalOnhandQuantity": 0,
            "totalInboundQuantity": 0,
            "inventoryDetails": {"availableDistributableQuantity": 0},
        }],
        pulled_at=STAMP,
    )
    assert len(rows) == 1
    assert rows[0]["awd_on_hand"] == 0
    assert rows[0]["sku"] == "DDPE0001Shop"


def test_awd_upsert_payload_includes_fresh_pulled_at():
    rows = _awd_inventory_rows(
        [{
            "sku": "SKU-A",
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
        "SKU-A\tB00TEST\t40\t18\n"
    )
    rows = _stamp_now(_parse_restock(tsv), "pulled_at", now=STAMP)
    assert rows[0]["sku"] == "SKU-A"
    assert rows[0]["recommended_qty"] == 40
    assert rows[0]["days_of_supply"] == 18.0
    assert rows[0]["pulled_at"] == STAMP_ISO


def test_planning_upsert_payload_includes_fresh_pulled_at():
    tsv = (
        "sku\tasin\tavailable\tweeks-of-cover-t30\n"
        "SKU-A\tB00TEST\t12\t2.5\n"
    )
    rows = _stamp_now(_parse_planning(tsv), "pulled_at", now=STAMP)
    assert rows[0]["sku"] == "SKU-A"
    assert rows[0]["available"] == 12
    assert rows[0]["pulled_at"] == STAMP_ISO


def test_sync_success_implies_amazon_timestamps_advance():
    """Row builders used by a successful inventory-sync always emit now()."""
    fba = _stamp_now(_aggregate_fba_summaries([_fba_item()]), "snapshot_at", now=STAMP)
    awd = _awd_inventory_rows(
        [{"sku": "SKU-B", "totalOnhandQuantity": 3, "totalInboundQuantity": 0}],
        pulled_at=STAMP,
    )
    restock = _stamp_now(
        _parse_restock("merchant-sku\nSKU-C\n"),
        "pulled_at",
        now=STAMP,
    )
    planning = _stamp_now(
        _parse_planning("sku\nSKU-D\n"),
        "pulled_at",
        now=STAMP,
    )
    assert fba[0]["snapshot_at"] == STAMP_ISO
    assert awd[0]["pulled_at"] == STAMP_ISO
    assert restock[0]["pulled_at"] == STAMP_ISO
    assert planning[0]["pulled_at"] == STAMP_ISO


def test_warehouse_contract_covers_daily_inventory_tables():
    required = {
        "inventory_snapshots",
        "inventory_awd",
        "inventory_restock",
        "inventory_planning",
        "inventory_awd_replenishments",
        "inventory_awd_replenishment_items",
        "inventory_inbound_shipments",
        "inventory_inbound_shipment_items",
        "inventory_awd_inbound_shipments",
        "inventory_3pl_snapshots",
        "inventory_sku_signals",
        "inventory_leadtime_summary",
        "inventory_snapshots_daily",
    }
    assert required <= set(WAREHOUSE_STAMP_FIELDS)


def test_shipment_and_item_upserts_stamp_synced_at():
    ships = stamp_now(
        [{"shipment_id": "FBA1", "shipment_status": "CLOSED"}],
        "synced_at",
        now=STAMP,
    )
    items = stamp_now(
        [{"shipment_id": "FBA1", "sku": "SKU-A", "quantity_shipped": 10}],
        "synced_at",
        now=STAMP,
    )
    assert ships[0]["synced_at"] == STAMP_ISO
    assert items[0]["synced_at"] == STAMP_ISO
    assert WAREHOUSE_STAMP_FIELDS["inventory_inbound_shipment_items"] == "synced_at"
    assert WAREHOUSE_STAMP_FIELDS["inventory_awd_replenishment_items"] == "synced_at"


def test_signals_leadtime_daily_stamp_equivalent_last_synced():
    signals = stamp_now([{"sku": "SKU-A", "as_of_date": "2026-08-26"}], "updated_at", now=STAMP)
    lead = stamp_now([{"as_of_date": "2026-08-26", "fba_receive_n": 2}], "updated_at", now=STAMP)
    daily = stamp_now(
        [{"sku": "SKU-A", "snapshot_date": "2026-08-26", "fba_on_hand": 12}],
        "recorded_at",
        now=STAMP,
    )
    assert signals[0]["updated_at"] == STAMP_ISO
    assert lead[0]["updated_at"] == STAMP_ISO
    assert daily[0]["recorded_at"] == STAMP_ISO


def test_empty_sync_is_explicit_skip_never_silent_stale():
    empty = {"rows_total": 0, "rows_inserted": 0, **skip_empty("amazon returned 0 FBA summaries")}
    assert empty["skipped"] is True
    assert "amazon returned 0" in empty["skip_reason"]
    reasons = collect_skip_reasons({
        "fba_summaries": empty,
        "awd": {"rows_total": 7, "rows_inserted": 7},
        "errors": [],
    })
    assert reasons == ["fba_summaries: amazon returned 0 FBA summaries"]


def test_append_daily_snapshots_stamps_recorded_at(monkeypatch):
    captured: list[dict] = []

    def fake_upsert(table, rows, on_conflict=None):
        captured.extend(rows)
        return len(rows)

    monkeypatch.setattr("src.inventory.snapshots_daily.upsert_rows", fake_upsert)
    out = append_daily_snapshots([
        {"sku": "SKU-A", "fulfillable": 12, "reserved": 0,
         "researching": 0, "unfulfillable": 0, "total_quantity": 12,
         "inbound_working": 0, "inbound_shipped": 4, "inbound_receiving": 0},
    ])
    assert out["rows"] == 1
    assert captured[0]["recorded_at"]
    assert captured[0]["snapshot_date"]
    assert captured[0]["inbound_total"] == 4
