"""Sept FBA-target plan: unstacked manufacture, August TBD, AWD overflow."""
from __future__ import annotations

from src.inventory.pallet_planner import (
    LIP_BALM_SKUS,
    PALLET_MAX_UNITS,
    SEPT_FBA_ON_HAND_TARGETS,
    SEPT_FBA_TARGET_CAP,
    allocate_single_sku_awd_pallets,
    build_september_plan,
    fba_manufacture_gap,
    family_tulsa_floor,
    holiday_demand_from_sales,
    holiday_gate_last_3pl_fba,
    remaining_wanted_cover,
    sept_fba_gaps,
    sept_fba_ship_by,
    sku_production_build,
)
from tests.test_pallet_planner_demand import LIP, _monthly

# Context only — 2026-08-26 FBA+inbound snapshot, not live inventory.
CONTEXT_FBA_PLUS_INBOUND = {
    "DDPE0001Shop": 3_248,  # unscented vs 12,800 → gap 9,552
    "DDPE0002Shop": 3_159,  # peppermint vs 8,300 → gap 5,141
    "DDPE0003Shop": 4_603,  # orange vs 16,700 → gap 12,097
    "DDPE0004Shop": 3_873,  # assorted vs 17,800 → gap 13,927
}


def test_sept_targets_and_cap():
    assert SEPT_FBA_ON_HAND_TARGETS["DDPE0004Shop"] == 17_800
    assert SEPT_FBA_ON_HAND_TARGETS["DDPE0003Shop"] == 16_700
    assert SEPT_FBA_ON_HAND_TARGETS["DDPE0001Shop"] == 12_800
    assert SEPT_FBA_ON_HAND_TARGETS["DDPE0002Shop"] == 8_300
    assert SEPT_FBA_TARGET_CAP == 55_600
    assert sum(SEPT_FBA_ON_HAND_TARGETS.values()) == 55_600


def test_manufacture_is_fba_target_minus_fulfillable_minus_inbound():
    fba = {s: CONTEXT_FBA_PLUS_INBOUND[s] // 2 for s in LIP}
    inbound = {s: CONTEXT_FBA_PLUS_INBOUND[s] - fba[s] for s in LIP}
    gaps = sept_fba_gaps(fba, inbound)
    assert gaps["DDPE0001Shop"]["gap"] == 9_552
    assert gaps["DDPE0002Shop"]["gap"] == 5_141
    assert gaps["DDPE0003Shop"]["gap"] == 12_097
    assert gaps["DDPE0004Shop"]["gap"] == 13_927
    family = sum(g["gap"] for g in gaps.values())
    assert 40_700 <= family <= 40_750
    for sku in LIP:
        assert fba_manufacture_gap(
            SEPT_FBA_ON_HAND_TARGETS[sku], fba[sku], inbound[sku],
        ) == gaps[sku]["gap"]


def test_august_tbd_does_not_invent_qty():
    fba = {s: 1000 for s in LIP}
    inbound = {s: 200 for s in LIP}
    plan = build_september_plan(fba, inbound, {s: 0 for s in LIP})
    assert plan["august_tbd"] is True
    assert all(qty == 0 for qty in plan["sku_august"].values())
    for sku in LIP:
        assert plan["sku_manufacture"][sku] == fba_manufacture_gap(
            SEPT_FBA_ON_HAND_TARGETS[sku], 1000, 200, 0,
        )


def test_august_entered_offsets_remaining_buy_and_3pl():
    fba = {s: 1000 for s in LIP}
    inbound = {s: 0 for s in LIP}
    august = {"DDPE0004Shop": 5_000}
    tpl = {s: 0 for s in LIP}
    before = build_september_plan(fba, inbound, tpl)
    after = build_september_plan(fba, inbound, tpl, sku_august=august)
    assert after["august_tbd"] is False
    assert after["sku_august"]["DDPE0004Shop"] == 5_000
    assert after["sku_manufacture"]["DDPE0004Shop"] == before["sku_manufacture"]["DDPE0004Shop"] - 5_000
    assert after["sku_manufacture"]["DDPE0001Shop"] == before["sku_manufacture"]["DDPE0001Shop"]


def test_inbound_not_resent():
    gaps = sept_fba_gaps(
        {"DDPE0001Shop": 2000},
        {"DDPE0001Shop": 1500},
        skus=["DDPE0001Shop"],
    )
    assert gaps["DDPE0001Shop"]["fba_plus_inbound"] == 3500
    assert gaps["DDPE0001Shop"]["gap"] == 12_800 - 3500


def test_awd_overflow_is_wanted_cover_not_stacked_60d():
    demand = holiday_demand_from_sales(_monthly(LIP), LIP, include_jan=True)
    wanted = {}
    stacked = {}
    for sku in LIP:
        build = sku_production_build(
            demand[sku], cover_days=60, receive_days=35,
            fba_target=SEPT_FBA_ON_HAND_TARGETS[sku],
        )
        wanted[sku] = build["wanted_cover"]
        stacked[sku] = build["stacked_build"]
        assert build["sku_build"] == build["sellthrough"]
        assert remaining_wanted_cover(
            build["wanted_cover"], SEPT_FBA_ON_HAND_TARGETS[sku],
        ) == build["awd_ammo"]
    plan = build_september_plan(
        {s: 0 for s in LIP}, {s: 0 for s in LIP}, {s: 0 for s in LIP},
        sku_wanted_cover=wanted,
    )
    family_awd = sum(plan["awd_need"].values())
    family_stacked_remainder = sum(
        max(0, stacked[s] - SEPT_FBA_ON_HAND_TARGETS[s]) for s in LIP
    )
    assert family_awd < family_stacked_remainder
    assert plan["unstacked"] is True
    assert plan["mix_locked"] is False


def test_live_awd_540_does_not_drop_tulsa_floor():
    fba = {s: CONTEXT_FBA_PLUS_INBOUND[s] for s in LIP}
    inbound = {s: 0 for s in LIP}
    tpl = {s: 2000 for s in LIP}
    awd = {"DDPE0002Shop": 540}
    # No planned overflow — wanted cover at the FBA target.
    plan = build_september_plan(
        fba, inbound, tpl,
        sku_wanted_cover=dict(SEPT_FBA_ON_HAND_TARGETS),
        sku_awd=awd,
    )
    assert plan["awd_loaded"] is False
    assert plan["tulsa_floor_units"] == 5000
    assert plan["tulsa"]["floor"] == 5000
    assert sum(plan["tpl_to_fba"].values()) == 3_000


def test_awd_loaded_drops_tulsa_floor_no_5k_addon():
    fba = {s: CONTEXT_FBA_PLUS_INBOUND[s] for s in LIP}
    inbound = {s: 0 for s in LIP}
    tpl = {s: 2000 for s in LIP}
    awd = {"DDPE0001Shop": 6_000, "DDPE0002Shop": 0, "DDPE0003Shop": 0, "DDPE0004Shop": 0}
    plan = build_september_plan(
        fba, inbound, tpl, sku_wanted_cover={s: 20_000 for s in LIP}, sku_awd=awd,
    )
    assert plan["awd_loaded"] is True
    assert plan["tulsa_floor_units"] == 0
    assert plan["tulsa"]["top_up"] == 0
    assert sum(plan["tpl_to_fba"].values()) == 8_000
    assert plan["tulsa"]["floor"] == 0
    for sku in LIP:
        assert plan["sku_manufacture"][sku] == plan["gaps"][sku]["gap"]


def test_empty_awd_keeps_tulsa_so_not_zero_both():
    plan = build_september_plan(
        {s: SEPT_FBA_ON_HAND_TARGETS[s] for s in LIP},
        {s: 0 for s in LIP},
        {s: 0 for s in LIP},
        sku_wanted_cover={s: SEPT_FBA_ON_HAND_TARGETS[s] for s in LIP},
        sku_awd={s: 0 for s in LIP},
    )
    assert plan["awd_loaded"] is False
    assert sum(plan["awd_need"].values()) == 0
    tulsa = family_tulsa_floor({s: 0 for s in LIP}, sku_awd={s: 0 for s in LIP})
    assert tulsa["floor"] == 5000
    assert tulsa["top_up"] == 5000
    assert not (plan["awd_loaded"] is False and tulsa["on_hand"] == 0 and tulsa["floor"] == 0)


def test_mixed_tulsa_then_single_sku_awd_unlimited():
    remainder = {"DDPE0004Shop": 40_000, "DDPE0001Shop": 0, "DDPE0002Shop": 0, "DDPE0003Shop": 0}
    cards = allocate_single_sku_awd_pallets(remainder, LIP_BALM_SKUS)
    assert len(cards) == 2  # two full; 2,000 leftover is under half — held
    assert all(c["single_sku"] and c["destination"] == "awd" for c in cards)
    assert all(c["locked"] is False for c in cards)
    assert sum(c["total_units"] for c in cards) == 38_000
    half = allocate_single_sku_awd_pallets({"DDPE0003Shop": 9_500}, ["DDPE0003Shop"])
    assert len(half) == 1
    assert half[0]["partial"] is True


def test_sept_ship_dates():
    assert sept_fba_ship_by(35).isoformat() == "2026-09-02"
    assert holiday_gate_last_3pl_fba(35).isoformat() == "2026-09-26"


def test_partial_threshold_still_9500():
    from src.inventory.pallet_planner import pallet_partial_min_units
    assert pallet_partial_min_units(PALLET_MAX_UNITS) == 9_500
