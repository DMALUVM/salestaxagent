"""Ship Sidekick 3PL snapshot rows always refresh pulled_at on upsert."""
from __future__ import annotations

from datetime import datetime, timezone

from src.shipsidekick.client import _snapshot_rows


def _item(sku="SKU-1"):
    return {
        "sku": sku,
        "product_name": "Tallow balm",
        "available": 12,
        "committed": 1,
        "reserved": 0,
        "incoming": 4,
        "damaged": 0,
        "warehouse": "3PL-A",
        "raw": "{}",
    }


def test_snapshot_rows_stamp_pulled_at_on_every_row():
    stamp = "2026-08-22T18:00:00+00:00"
    rows = _snapshot_rows([_item("A"), _item("B")], pulled_at=stamp)
    assert [r["sku"] for r in rows] == ["A", "B"]
    assert all(r["pulled_at"] == stamp for r in rows)


def test_snapshot_rows_default_pulled_at_is_utc_now():
    before = datetime.now(timezone.utc)
    rows = _snapshot_rows([_item()])
    after = datetime.now(timezone.utc)
    assert len(rows) == 1
    pulled = datetime.fromisoformat(rows[0]["pulled_at"])
    assert pulled.tzinfo is not None
    assert before <= pulled <= after
