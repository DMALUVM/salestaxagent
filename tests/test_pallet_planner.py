"""Pallet planner must agree with the inventory-page reorder."""
from __future__ import annotations

from src.inventory.reorder import (
    allocate_monthly_units,
    amazon_inventory_reorder,
    manufacture_need,
    reorder_qty,
)


# Screenshot: DDPE0001Shop CRITICAL, V30 106.6, Recv 19d, FBA 5234,
# 3PL 1594, inbound 540, holiday cover 90d → inventory reorder ~4,249.
UNSCENTED = {
    "fba": 5234,
    "inbound": 540,
    "awd": 0,
    "tpl": 1594,
    "v30": 106.6,
    "lead": 19,
    "holiday_mode": True,
}

SETTINGS = {
    "target_cover_days": 60,
    "holiday_mode": True,
    "include_inbound": True,
    "include_3pl": True,
    "include_awd": True,
    "receiving_days_normal": 19,
    "awd_to_fba_days": 13,
}


def test_unscented_reorder_matches_inventory_page_formula():
    rec = amazon_inventory_reorder(
        fba=UNSCENTED["fba"],
        inbound=UNSCENTED["inbound"],
        awd=UNSCENTED["awd"],
        tpl=UNSCENTED["tpl"],
        daily_velocity=UNSCENTED["v30"],
        settings=SETTINGS,
        fba_receive_median=19,
        awd_replenish_median=13,
    )
    assert rec["target_days"] == 90
    assert rec["lead_days"] == 19
    assert rec["on_hand"] == 5234 + 540 + 1594
    # 109 × 106.6 = 11,619.4 → ceil 11,620 − 7,368 = 4,252
    assert rec["reorder_qty"] == 4252
    assert rec["reorder_qty"] >= 4000


def test_displayed_4249_is_same_formula_at_stored_v30():
    """UI showed 4,249 because V30 is stored slightly under the 106.6 display."""
    qty = reorder_qty(90, 19, 106.57, 5234 + 540 + 1594)
    assert qty == 4249


def test_month1_front_loads_inventory_reorder_not_25_percent():
    holiday_mfg = {"DDPE0001Shop": 6696}  # 1,674 was 25% of this
    reorder = {"DDPE0001Shop": 4252}
    mixes = allocate_monthly_units(
        ["DDPE0001Shop"], reorder, holiday_mfg, 3, (0.25, 0.35, 0.40),
    )
    month1 = mixes[0].get("DDPE0001Shop", 0)
    old_25pct = round(6696 * 0.25)
    assert old_25pct == 1674
    assert month1 >= 4252
    assert month1 > old_25pct
    assert sum(m.get("DDPE0001Shop", 0) for m in mixes) == 6696


def test_ok_sku_with_no_reorder_keeps_holiday_weight_split():
    mixes = allocate_monthly_units(
        ["DDPE0002Shop"],
        {"DDPE0002Shop": 0},
        {"DDPE0002Shop": 3832},
        3,
        (0.25, 0.35, 0.40),
    )
    assert mixes[0].get("DDPE0002Shop") == round(3832 * 0.25)
    assert sum(m.get("DDPE0002Shop", 0) for m in mixes) == 3832


def test_manufacture_is_max_of_reorder_and_holiday():
    assert manufacture_need(4252, 6696) == 6696
    assert manufacture_need(8000, 6696) == 8000
    assert manufacture_need(0, 0) == 0


def test_mixed_pallet_front_loads_only_the_critical_sku():
    skus = ["DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"]
    reorder = {
        "DDPE0001Shop": 4252,
        "DDPE0002Shop": 0,
        "DDPE0003Shop": 0,
        "DDPE0004Shop": 0,
    }
    holiday = {
        "DDPE0001Shop": 6696,
        "DDPE0002Shop": 3832,
        "DDPE0003Shop": 6736,
        "DDPE0004Shop": 18636,
    }
    mixes = allocate_monthly_units(skus, reorder, holiday, 3, (0.25, 0.35, 0.40))
    assert mixes[0]["DDPE0001Shop"] >= 4252
    # Other flavors still get their August holiday slice
    assert mixes[0]["DDPE0002Shop"] == round(3832 * 0.25)
    assert mixes[0]["DDPE0004Shop"] == round(18636 * 0.25)
