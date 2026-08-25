"""Warehouse snapshot export/restore round-trip (mocked DB)."""
from __future__ import annotations

import gzip
import json
from datetime import datetime, timezone

import pytest

from src.maintenance.warehouse_snapshot import (
    SNAPSHOT_FORMAT,
    export_snapshot,
    restore_snapshot,
    validate_snapshot,
)


@pytest.fixture
def table_config(tmp_path):
    cfg = {
        "version": 1,
        "tables": [
            {"name": "sku_costs", "on_conflict": "sku", "restore_order": 1},
            {"name": "ads_monthly_spend", "on_conflict": "period_start", "restore_order": 2},
        ],
    }
    path = tmp_path / "tables.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    return path


def test_export_and_restore_round_trip(monkeypatch, table_config):
    warehouse = {
        "sku_costs": [{"sku": "A", "unit_cost": 1.5}],
        "ads_monthly_spend": [
            {
                "period_start": "2026-03-01",
                "period_end": "2026-03-31",
                "spend": 100,
                "source": "test",
            },
        ],
    }
    upserted: list[tuple[str, list, str | None]] = []

    def fake_fetch(table, filters=None, order=None):
        return list(warehouse.get(table, []))

    def fake_upsert(table, rows, on_conflict=None, batch_size=500):
        upserted.append((table, rows, on_conflict))
        warehouse[table] = rows
        return len(rows)

    monkeypatch.setattr("src.maintenance.warehouse_snapshot.fetch_all", fake_fetch)
    monkeypatch.setattr("src.maintenance.warehouse_snapshot.upsert_rows", fake_upsert)
    monkeypatch.setattr("src.maintenance.warehouse_snapshot.log_audit", lambda *a, **k: None)

    snap = export_snapshot(table_config)
    assert snap["format"] == SNAPSHOT_FORMAT
    assert snap["table_meta"]["sku_costs"]["row_count"] == 1

    # Gzip encode/decode path
    raw = json.dumps(snap).encode("utf-8")
    gz = gzip.compress(raw)
    from src.maintenance.warehouse_snapshot import _parse_snapshot_bytes

    parsed = _parse_snapshot_bytes(gz)
    validate_snapshot(parsed)

    result = restore_snapshot(parsed, table_config)
    assert result["total_upserted"] == 2
    assert len(upserted) == 2
    assert upserted[0][2] == "sku"


def test_validate_rejects_unknown_format():
    with pytest.raises(ValueError, match="Unknown snapshot"):
        validate_snapshot({"format": "other", "version": 1, "tables": {}})


def test_restore_dry_run_counts(monkeypatch, table_config):
    snap = {
        "format": SNAPSHOT_FORMAT,
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "tables": {
            "sku_costs": [{"sku": "X", "unit_cost": 2}],
        },
    }
    monkeypatch.setattr("src.maintenance.warehouse_snapshot.upsert_rows", lambda *a, **k: 0)

    result = restore_snapshot(snap, table_config, dry_run=True)
    assert result["dry_run"] is True
    assert result["total_upserted"] == 0
    assert result["tables"][0]["status"] == "dry_run"
    assert result["tables"][0]["rows_in_backup"] == 1
