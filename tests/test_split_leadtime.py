"""First-box vs last-box on multi-FC AWD replenishment splits."""
from datetime import date

from src.inventory.split_leadtime import (
    first_last_from_replenishments,
    open_inbound_split,
    split_leg_days,
)


AUG_SPLIT = {
    "order_status": "SUCCESS",
    "shipped_at": "2026-08-06T18:43:05Z",
    "created_at": "2026-08-06T18:34:40Z",
    "raw": {
        "outboundShipments": [
            {"shipmentStatus": "DELIVERED", "updatedAt": "2026-08-10T20:19:59Z"},
            {"shipmentStatus": "DELIVERED", "updatedAt": "2026-08-13T07:18:51Z"},
            {"shipmentStatus": "DELIVERED", "updatedAt": "2026-08-14T11:19:56Z"},
            {"shipmentStatus": "DELIVERED", "updatedAt": "2026-08-23T17:34:30Z"},
        ],
    },
}


def test_aug_four_box_first_and_last():
    days = split_leg_days(AUG_SPLIT)
    assert min(days) == 4
    assert max(days) == 17
    assert max(days) - min(days) == 13


def test_median_across_splits():
    fast = {
        "order_status": "SUCCESS",
        "shipped_at": "2026-06-18T10:33:58Z",
        "raw": {
            "outboundShipments": [
                {"shipmentStatus": "DELIVERED", "updatedAt": "2026-06-19T13:48:35Z"},
                {"shipmentStatus": "DELIVERED", "updatedAt": "2026-06-20T06:00:21Z"},
            ],
        },
    }
    out = first_last_from_replenishments([AUG_SPLIT, fast])
    assert out["split_n"] == 2
    assert out["first_box_days"] == 3   # 1 and 4
    assert out["last_box_days"] == 10   # 2 and 17
    assert out["box_spread_days"] == 7  # 1 and 13


def test_ignores_single_fc_and_open_orders():
    single = {
        "order_status": "SUCCESS",
        "shipped_at": "2026-08-01T00:00:00Z",
        "raw": {
            "outboundShipments": [
                {"shipmentStatus": "DELIVERED", "updatedAt": "2026-08-08T00:00:00Z"},
            ],
        },
    }
    open_order = {
        "order_status": "EXECUTING",
        "shipped_at": "2026-08-25T17:50:03Z",
        "raw": {
            "outboundShipments": [
                {"shipmentStatus": "IN_TRANSIT", "updatedAt": "2026-08-25T17:50:03Z"},
                {"shipmentStatus": "IN_TRANSIT", "updatedAt": "2026-08-25T17:50:03Z"},
            ],
        },
    }
    assert first_last_from_replenishments([single, open_order])["split_n"] == 0


def test_open_inbound_split_picks_newest_multi_fc():
    ships = [
        {"shipment_status": "IN_TRANSIT", "created_at": "2026-08-25T17:46:58Z",
         "shipped_at": "2026-08-25T17:50:03Z", "destination_fc": "VGT2"},
        {"shipment_status": "IN_TRANSIT", "created_at": "2026-08-25T17:46:58Z",
         "shipped_at": "2026-08-25T17:50:03Z", "destination_fc": "MCI4"},
        {"shipment_status": "IN_TRANSIT", "created_at": "2026-08-25T17:46:58Z",
         "shipped_at": "2026-08-25T17:50:03Z", "destination_fc": "MQY2"},
        {"shipment_status": "CLOSED", "created_at": "2026-07-01T00:00:00Z",
         "destination_fc": "PHX3"},
    ]
    open_split = open_inbound_split(ships, today=date(2026, 8, 26))
    assert open_split is not None
    assert open_split["boxes"] == 3
    assert open_split["fcs"] == ["MCI4", "MQY2", "VGT2"]
    assert open_split["age_days"] == 1
