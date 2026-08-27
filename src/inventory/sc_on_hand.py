"""Seller Central on-hand + reserved splits.

Mirrors dashboard/src/lib/inventory-sc-on-hand.ts so the inventory table
and pallet planner share one FBA definition.

    FBA (cover/cap) = fulfillable + FC transfer
    SC reserved     = FC Processing + Customer Order
                    = API reserved − FC transfer
    Unfulfillable is never in cap or cover.
"""
from __future__ import annotations

import json
import re
from typing import Any


def _as_record(raw: Any) -> dict:
    if raw is None:
        return {}
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return {}
        if isinstance(parsed, str):
            try:
                parsed = json.loads(parsed)
            except (ValueError, TypeError):
                return {}
        if isinstance(parsed, dict):
            return parsed
        return {}
    if isinstance(raw, dict):
        return raw
    return {}


def _norm_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


def _int_field(record: dict, aliases: list[str]) -> int | None:
    wanted = {_norm_key(a) for a in aliases}
    for key, value in record.items():
        if _norm_key(str(key)) not in wanted:
            continue
        try:
            n = float(str(value or "").replace(",", "").strip())
        except (ValueError, TypeError):
            continue
        if n == n:  # not NaN
            return int(n)
    return None


def parse_one(raw: Any) -> dict:
    record = _as_record(raw)
    return {
        "fc_transfer": _int_field(record, ["FC transfer", "fc-transfer", "fc_transfer"]) or 0,
        "fc_processing": _int_field(
            record, ["FC Processing", "Reserved FC Processing", "fc-processing"]
        ) or 0,
        "customer_order": _int_field(
            record, ["Customer Order", "Reserved Customer Order", "customer-order"]
        ) or 0,
        "total_reserved_sc": _int_field(
            record,
            ["Total Reserved Quantity", "total-reserved-quantity", "totalReservedQuantity"],
        ),
    }


def parse_reserved_splits(restock_raw: Any = None, planning_raw: Any = None) -> dict:
    restock = parse_one(restock_raw)
    planning = parse_one(planning_raw)
    return {
        "fc_transfer": restock["fc_transfer"] or planning["fc_transfer"],
        "fc_processing": restock["fc_processing"] or planning["fc_processing"],
        "customer_order": restock["customer_order"] or planning["customer_order"],
        "total_reserved_sc": (
            restock["total_reserved_sc"]
            if restock["total_reserved_sc"] is not None
            else planning["total_reserved_sc"]
        ),
    }


def sc_on_hand_units(fulfillable: int, splits: dict) -> int:
    """Seller Central on-hand (sellable/cover). Not API fulfillable."""
    return int(fulfillable or 0) + int(splits.get("fc_transfer") or 0)


def sc_reserved_units(api_reserved: int, splits: dict) -> int:
    from_restock = int(splits.get("fc_processing") or 0) + int(splits.get("customer_order") or 0)
    if from_restock > 0:
        return from_restock
    if splits.get("total_reserved_sc") is not None:
        return int(splits["total_reserved_sc"])
    return max(0, int(api_reserved or 0) - int(splits.get("fc_transfer") or 0))


def raw_from_row(row: dict | None) -> Any:
    if not row:
        return None
    return row.get("raw")
