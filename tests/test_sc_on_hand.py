"""Planner and inventory table share Seller Central on-hand."""
from src.inventory.pallet_planner import fba_cover_units
from src.inventory.sc_on_hand import parse_reserved_splits, sc_on_hand_units, sc_reserved_units


def test_orange_sc_on_hand_is_4054_not_3501():
    splits = parse_reserved_splits({
        "FC transfer": "553",
        "FC Processing": "1324",
        "Customer Order": "74",
    })
    assert splits["fc_transfer"] == 553
    assert sc_on_hand_units(3501, splits) == 4054
    assert sc_on_hand_units(3501, splits) != 3501
    assert sc_reserved_units(1953, splits) == 1398
    snap = {
        "fulfillable": 3501,
        "reserved": 1953,
        "researching": 9,
        "unfulfillable": 818,
    }
    assert fba_cover_units(snap, {"raw": {"FC transfer": 553}}) == 4054
    assert fba_cover_units(snap) == 3501
    assert fba_cover_units(snap, {"raw": {"FC transfer": 553}}) != snap["unfulfillable"]


def test_json_string_restock_raw():
    import json
    raw = json.dumps({"FC transfer": "553", "FC Processing": "1", "Customer Order": "1"})
    splits = parse_reserved_splits(raw)
    assert splits["fc_transfer"] == 553
    assert sc_on_hand_units(3501, splits) == 4054
    double = json.dumps(raw)
    assert parse_reserved_splits(double)["fc_transfer"] == 553
