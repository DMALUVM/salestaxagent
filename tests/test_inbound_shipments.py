"""Tests for FBA inbound shipment sync query params and refresh policy."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from src.inventory.inbound_shipments import (
    OPEN_REFRESH_STATUSES,
    _date_range_chunks,
    _open_refresh_ids,
    _shipments_query_params,
    sync_inbound_shipments,
)
from src.rules import SPAPI_MAX_CHUNK_DAYS


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


def test_date_range_chunks_newest_first_cover_180d_lookback():
    end = datetime(2026, 8, 30, 10, 30, tzinfo=timezone.utc)
    start = end - timedelta(days=180)
    chunks = _date_range_chunks(start, end)
    assert len(chunks) == 6
    assert chunks[0][1] == end
    assert chunks[-1][0] == start
    for after, before in chunks:
        assert (before - after) <= timedelta(days=SPAPI_MAX_CHUNK_DAYS)
    for i in range(len(chunks) - 1):
        assert chunks[i][1] >= chunks[i + 1][1]
        assert chunks[i + 1][1] == chunks[i][0]


def test_open_refresh_ids_skip_closed_and_already_seen():
    existing = {
        "FBA19MW1LJ4V": {"shipment_status": "IN_TRANSIT"},
        "FBA19N77Q087": {"shipment_status": "WORKING"},
        "FBASHIPPED": {"shipment_status": "SHIPPED"},
        "FBARECV": {"shipment_status": "RECEIVING"},
        "FBAOLD": {"shipment_status": "CLOSED"},
        "FBACAN": {"shipment_status": "CANCELLED"},
    }
    ids = _open_refresh_ids(existing, {"FBASHIPPED"})
    assert ids == ["FBA19MW1LJ4V", "FBA19N77Q087", "FBARECV"]
    assert "CLOSED" not in OPEN_REFRESH_STATUSES


def _patch_empty_date_range(monkeypatch, existing, *, by_id=None, items=None):
    monkeypatch.setattr(
        "src.inventory.inbound_shipments._get_shipments_page",
        lambda *a, **k: {"ShipmentData": []},
    )
    monkeypatch.setattr(
        "src.inventory.inbound_shipments._existing_by_id",
        lambda: existing,
    )
    monkeypatch.setattr(
        "src.inventory.inbound_shipments._fba_ids_from_awd_replenishments",
        lambda extra=None: [],
    )
    by_id_calls: list[list[str]] = []

    def fake_by_id(ids):
        by_id_calls.append(list(ids))
        return by_id(ids) if callable(by_id) else list(by_id or [])

    monkeypatch.setattr(
        "src.inventory.inbound_shipments._get_shipments_by_ids",
        fake_by_id,
    )
    monkeypatch.setattr(
        "src.inventory.inbound_shipments._get_shipment_items",
        items or (lambda sid: []),
    )
    monkeypatch.setattr(
        "src.inventory.inbound_shipments._get_transport_details",
        lambda sid: None,
    )
    return by_id_calls


def test_empty_date_range_refreshes_open_ids_and_stamps_synced_at(monkeypatch):
    existing = {
        "FBA19MW1LJ4V": {
            "shipment_id": "FBA19MW1LJ4V",
            "shipment_status": "IN_TRANSIT",
            "units_shipped": 45,
            "synced_at": "2026-08-26T00:00:00+00:00",
        },
        "FBA19N77Q087": {
            "shipment_id": "FBA19N77Q087",
            "shipment_status": "WORKING",
            "units_shipped": 540,
            "synced_at": "2026-08-28T12:11:00+00:00",
        },
        "FBAOLD": {
            "shipment_id": "FBAOLD",
            "shipment_status": "CLOSED",
            "units_shipped": 10,
            "synced_at": "2026-07-01T00:00:00+00:00",
        },
    }
    units = {"FBA19MW1LJ4V": 45, "FBA19N77Q087": 540}

    def fake_by_id(ids):
        return [
            {
                "ShipmentId": sid,
                "ShipmentStatus": existing[sid]["shipment_status"],
                "LastUpdatedDate": "2026-08-30T10:00:00Z",
            }
            for sid in ids
        ]

    def fake_items(sid):
        qty = units[sid]
        return [{"SellerSKU": "DDPE0001Shop", "QuantityShipped": qty, "QuantityReceived": 0}]

    by_id_calls = _patch_empty_date_range(
        monkeypatch, existing, by_id=fake_by_id, items=fake_items,
    )
    captured: list[dict] = []

    def fake_upsert(table, rows, on_conflict=None):
        if table == "inventory_inbound_shipments":
            captured.extend(rows)
        return len(rows)

    monkeypatch.setattr("src.inventory.inbound_shipments.upsert_rows", fake_upsert)

    result = sync_inbound_shipments(days_back=180, dry_run=False)
    assert result.get("skipped") is not True
    assert result["v0_shipments"] == 0
    assert result["open_ids_refreshed"] == 2
    assert result["shipments_found"] == 2
    assert result["rows_upserted"] == 2
    assert by_id_calls
    assert set(by_id_calls[0]) == {"FBA19MW1LJ4V", "FBA19N77Q087"}
    by_id = {r["shipment_id"]: r for r in captured}
    assert set(by_id) == {"FBA19MW1LJ4V", "FBA19N77Q087"}
    assert by_id["FBA19MW1LJ4V"]["units_shipped"] == 45
    assert by_id["FBA19N77Q087"]["units_shipped"] == 540
    assert by_id["FBA19MW1LJ4V"]["synced_at"] > existing["FBA19MW1LJ4V"]["synced_at"]
    assert by_id["FBA19N77Q087"]["synced_at"] > existing["FBA19N77Q087"]["synced_at"]


def test_true_empty_no_open_ids_still_skips(monkeypatch):
    _patch_empty_date_range(monkeypatch, existing={})
    result = sync_inbound_shipments(days_back=180, dry_run=True)
    assert result["skipped"] is True
    assert "0 inbound" in result["skip_reason"]
    assert result["shipments_found"] == 0
    assert result["open_ids_refreshed"] == 0
    assert result["v2024_skipped"] is True


def test_closed_only_existing_does_not_invent_rows_when_date_range_empty(monkeypatch):
    existing = {
        "FBAOLD": {
            "shipment_id": "FBAOLD",
            "shipment_status": "CLOSED",
            "units_shipped": 10,
        },
    }
    by_id_calls = _patch_empty_date_range(monkeypatch, existing)
    result = sync_inbound_shipments(days_back=180, dry_run=True)
    assert by_id_calls == []
    assert result["skipped"] is True
    assert result["shipments_found"] == 0


def test_missing_amazon_payload_does_not_invent_zero_unit_rows(monkeypatch):
    existing = {
        "FBA19MW1LJ4V": {
            "shipment_id": "FBA19MW1LJ4V",
            "shipment_status": "IN_TRANSIT",
            "units_shipped": 45,
        },
    }
    by_id_calls = _patch_empty_date_range(monkeypatch, existing, by_id=[])
    captured: list[dict] = []

    def fake_upsert(table, rows, on_conflict=None):
        captured.extend(rows)
        return len(rows)

    monkeypatch.setattr("src.inventory.inbound_shipments.upsert_rows", fake_upsert)

    result = sync_inbound_shipments(days_back=180, dry_run=False)
    assert by_id_calls == [["FBA19MW1LJ4V"]]
    assert captured == []
    assert result["skipped"] is True
    assert result["shipments_found"] == 0
    assert result.get("rows_upserted", 0) == 0


def test_itemless_amazon_payload_keeps_prior_units_not_zero(monkeypatch):
    existing = {
        "FBA19MW1LJ4V": {
            "shipment_id": "FBA19MW1LJ4V",
            "shipment_status": "IN_TRANSIT",
            "units_shipped": 45,
            "units_received": 0,
        },
    }

    def fake_by_id(ids):
        return [{"ShipmentId": "FBA19MW1LJ4V", "ShipmentStatus": "IN_TRANSIT"}]

    _patch_empty_date_range(monkeypatch, existing, by_id=fake_by_id, items=lambda sid: [])
    captured: list[dict] = []

    def fake_upsert(table, rows, on_conflict=None):
        if table == "inventory_inbound_shipments":
            captured.extend(rows)
        return len(rows)

    monkeypatch.setattr("src.inventory.inbound_shipments.upsert_rows", fake_upsert)

    result = sync_inbound_shipments(days_back=180, dry_run=False)
    assert result.get("skipped") is not True
    assert captured[0]["units_shipped"] == 45
    assert captured[0]["units_shipped"] != 0
    assert captured[0]["synced_at"]


def test_sync_date_range_requests_chunked_newest_first(monkeypatch):
    calls: list[tuple[datetime, datetime | None, str | None]] = []

    def fake_page(after, before, next_token):
        calls.append((after, before, next_token))
        return {"ShipmentData": []}

    monkeypatch.setattr("src.inventory.inbound_shipments._get_shipments_page", fake_page)
    monkeypatch.setattr("src.inventory.inbound_shipments._existing_by_id", lambda: {})
    monkeypatch.setattr(
        "src.inventory.inbound_shipments._fba_ids_from_awd_replenishments",
        lambda extra=None: [],
    )

    result = sync_inbound_shipments(days_back=180, dry_run=True)
    assert result["date_range_chunks"] >= 6
    assert len(calls) >= 6
    for after, before, token in calls:
        assert token is None
        assert before is not None
        assert (before - after) <= timedelta(days=SPAPI_MAX_CHUNK_DAYS)
    assert all(calls[i][1] >= calls[i + 1][1] for i in range(len(calls) - 1))
    span = calls[0][1] - calls[-1][0]
    assert span >= timedelta(days=179)
