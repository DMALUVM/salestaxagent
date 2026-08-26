"""Pallet planner must agree with the inventory-page reorder."""
from __future__ import annotations

from src.inventory.reorder import (
    PALLET_MAX_UNITS,
    allocate_monthly_units,
    amazon_inventory_reorder,
    holiday_inbound_months,
    manufacture_need,
    month_pallet_fill_pct,
    pack_pallets,
    reorder_qty,
    ship_by_for_amazon_deadline,
    sku_pack_priority,
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


MONTHS = ["2026-08", "2026-09", "2026-10"]


def test_august_is_inventory_reorder_holiday_goes_to_sep_oct():
    holiday_mfg = {"DDPE0001Shop": 6696}
    reorder = {"DDPE0001Shop": 4252}
    mixes = allocate_monthly_units(
        ["DDPE0001Shop"], reorder, holiday_mfg, MONTHS,
    )
    assert mixes[0].get("DDPE0001Shop") == 4252
    assert mixes[0].get("DDPE0001Shop") != round(6696 * 0.25)
    later = mixes[1].get("DDPE0001Shop", 0) + mixes[2].get("DDPE0001Shop", 0)
    assert later == 2444
    assert sum(m.get("DDPE0001Shop", 0) for m in mixes) == 6696


def test_ok_sku_has_no_august_and_all_holiday_in_sep_oct():
    mixes = allocate_monthly_units(
        ["DDPE0002Shop"],
        {"DDPE0002Shop": 0},
        {"DDPE0002Shop": 3832},
        MONTHS,
    )
    assert mixes[0].get("DDPE0002Shop", 0) == 0
    assert mixes[1].get("DDPE0002Shop", 0) + mixes[2].get("DDPE0002Shop", 0) == 3832


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
    mixes = allocate_monthly_units(skus, reorder, holiday, MONTHS)
    assert mixes[0]["DDPE0001Shop"] == 4252
    assert mixes[0].get("DDPE0002Shop", 0) == 0
    assert mixes[0].get("DDPE0004Shop", 0) == 0
    assert mixes[1].get("DDPE0004Shop", 0) + mixes[2].get("DDPE0004Shop", 0) == 18636


def test_pack_pallets_splits_over_19k_and_keeps_critical_first():
    mix = {
        "DDPE0001Shop": 8_000,  # CRITICAL
        "DDPE0002Shop": 8_000,
        "DDPE0004Shop": 9_000,
    }
    priority = sku_pack_priority(
        list(mix),
        {"DDPE0001Shop": "CRITICAL", "DDPE0002Shop": "OK", "DDPE0004Shop": "OK"},
        {"DDPE0001Shop": 8000, "DDPE0002Shop": 0, "DDPE0004Shop": 0},
    )
    packed = pack_pallets(mix, priority, PALLET_MAX_UNITS)
    assert len(packed) == 2
    assert packed[0]["total_units"] == PALLET_MAX_UNITS
    assert packed[0]["mix"]["DDPE0001Shop"] == 8_000
    assert sum(p["total_units"] for p in packed) == 25_000
    assert packed[1]["total_units"] == 6_000


def test_october_ship_by_clears_oct_31_with_19d_recv():
    assert ship_by_for_amazon_deadline("2026-10", "2026-10-31", 19) == "2026-10-12"
    assert ship_by_for_amazon_deadline("2026-09", "2026-10-31", 19) == "2026-09-20"


def test_long_lead_keeps_holiday_out_of_october():
    assert holiday_inbound_months(MONTHS, "2026-10-31", 35) == ["2026-09"]
    mixes = allocate_monthly_units(
        ["DDPE0001Shop"],
        {"DDPE0001Shop": 0},
        {"DDPE0001Shop": 4000},
        MONTHS,
        lead_days=35,
    )
    assert mixes[2].get("DDPE0001Shop", 0) == 0
    assert mixes[1].get("DDPE0001Shop") == 4000


def test_month_under_19k_is_one_pallet():
    packed = pack_pallets({"DDPE0001Shop": 12_164}, ["DDPE0001Shop"], PALLET_MAX_UNITS)
    assert len(packed) == 1
    assert packed[0]["total_units"] == 12_164
    assert month_pallet_fill_pct(12_164, 1) == round(100 * 12_164 / 19_000)
