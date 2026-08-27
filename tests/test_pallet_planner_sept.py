"""Two-pile Sept plan: 3PL→FBA fee-free send, August TBD, single-SKU AWD."""
from __future__ import annotations

from datetime import date

from src.inventory.pallet_planner import (
    AMAZON_IN_BY_DEFAULT,
    LIP_BALM_SKUS,
    PALLET_MAX_UNITS,
    PEAK_END_DEFAULT,
    SEPT_FBA_ON_HAND_TARGETS,
    SEPT_FBA_TARGET_CAP,
    OPTIMISTIC_AWD_ON_HAND_TARGETS,
    OPTIMISTIC_AWD_TARGET_CAP,
    FBA_INBOUND_PREFERRED,
    FBA_INBOUND_MIN_FEE_FREE,
    CARTON_13X11X9_UNITS,
    CARTON_20X16X14_UNITS,
    allocate_single_sku_awd_pallets,
    allocate_3pl_fba_send,
    awd_covers_off_fba_reserve,
    build_month_view_entries,
    build_september_plan,
    family_fba_cap_for_month,
    family_tulsa_floor,
    fee_free_inbound_qty,
    inbound_carton_min,
    is_legal_inbound_qty,
    production_horizon_months,
    scale_fba_caps,
    sept_fba_gaps,
    sept_fba_ship_by,
    holiday_gate_last_3pl_fba,
)
from tests.test_pallet_planner_demand import LIP

# 2026-08-26 19:35 ET context — FBA+inbound already includes inbound.
CONTEXT_FBA_PLUS_INBOUND = {
    "DDPE0001Shop": 3_248,
    "DDPE0002Shop": 3_159,
    "DDPE0003Shop": 4_603,
    "DDPE0004Shop": 3_873,
}
CONTEXT_INBOUND = {
    "DDPE0001Shop": 0,
    "DDPE0002Shop": 1_080,
    "DDPE0003Shop": 637,
    "DDPE0004Shop": 270,
}
CONTEXT_FBA = {
    sku: CONTEXT_FBA_PLUS_INBOUND[sku] - CONTEXT_INBOUND[sku] for sku in LIP
}
CONTEXT_3PL = {
    "DDPE0001Shop": 1_594,  # unscented — under a 2,700 send
    "DDPE0002Shop": 6_291,  # peppermint
    "DDPE0003Shop": 6_426,  # orange
    "DDPE0004Shop": 9_177,  # assorted
}
CONTEXT_AWD = {"DDPE0002Shop": 540}
TONIGHT_SEND = {
    "DDPE0004Shop": 8_100,  # 3×2,700 = fifteen 540-boxes
    "DDPE0003Shop": 5_400,  # 2×2,700
    "DDPE0002Shop": 2_700,  # five 540-boxes
    "DDPE0001Shop": 0,      # waits August
}


def test_sept_targets_and_optimistic_awd():
    assert SEPT_FBA_ON_HAND_TARGETS["DDPE0004Shop"] == 17_800
    assert sum(SEPT_FBA_ON_HAND_TARGETS.values()) == SEPT_FBA_TARGET_CAP == 55_600
    assert sum(OPTIMISTIC_AWD_ON_HAND_TARGETS.values()) == OPTIMISTIC_AWD_TARGET_CAP == 76_211
    assert OPTIMISTIC_AWD_ON_HAND_TARGETS["DDPE0003Shop"] == 22_827
    assert OPTIMISTIC_AWD_ON_HAND_TARGETS["DDPE0001Shop"] == 17_803
    assert OPTIMISTIC_AWD_ON_HAND_TARGETS["DDPE0004Shop"] == 24_991
    assert OPTIMISTIC_AWD_ON_HAND_TARGETS["DDPE0002Shop"] == 10_590


def test_inbound_carton_fee_paths():
    assert CARTON_13X11X9_UNITS == 270
    assert CARTON_20X16X14_UNITS == 540
    assert inbound_carton_min(270) == 1_350
    assert inbound_carton_min(540) == 2_700
    assert FBA_INBOUND_MIN_FEE_FREE == 1_350
    assert FBA_INBOUND_PREFERRED == 2_700
    assert is_legal_inbound_qty(0, 540)
    assert is_legal_inbound_qty(2_700, 540)
    assert is_legal_inbound_qty(3_240, 540)
    assert is_legal_inbound_qty(8_100, 540)
    assert not is_legal_inbound_qty(1_349, 540)
    assert not is_legal_inbound_qty(1_350, 540)  # 270-path min, not 540-path
    assert is_legal_inbound_qty(1_350, 270)
    assert not is_legal_inbound_qty(1_080, 270)
    assert not is_legal_inbound_qty(3_000, 540)


def test_tonight_16200_send_not_18488_or_22338():
    gaps = sept_fba_gaps(CONTEXT_FBA, CONTEXT_INBOUND)
    send = allocate_3pl_fba_send(
        CONTEXT_3PL,
        {s: gaps[s]["gap"] for s in LIP},
        awd_loaded=False,
        skus=LIP,
    )
    assert send["tpl_to_fba"] == TONIGHT_SEND
    assert send["send_total"] == 16_200
    assert send["tpl_to_awd"]["DDPE0002Shop"] == 0
    assert send["hold_total"] == 7_288
    assert 7_200 <= send["hold_total"] <= 7_400
    assert send["waits_on_august"]["DDPE0001Shop"] is True
    for sku, qty in send["tpl_to_fba"].items():
        assert qty == 0 or qty >= 2_700
        assert is_legal_inbound_qty(qty, 540)


def test_live_awd_540_keeps_tulsa_floor_no_empty_out():
    assert awd_covers_off_fba_reserve(CONTEXT_AWD) is False
    plan = build_september_plan(
        CONTEXT_FBA, CONTEXT_INBOUND, CONTEXT_3PL,
        sku_awd=CONTEXT_AWD,
    )
    assert plan["awd_loaded"] is False
    assert plan["tulsa_floor_units"] == 5_000
    assert plan["first_action"]["tpl_to_fba_total"] == 16_200
    assert plan["tpl_to_fba"] == TONIGHT_SEND
    assert plan["tpl_to_awd"]["DDPE0002Shop"] == 0
    assert plan["first_action"]["tulsa_hold_total"] >= 5_000
    assert sum(plan["tpl_to_fba"].values()) != 18_488
    assert sum(plan["tpl_to_fba"].values()) != 22_338


def test_manufacture_is_awd_surge_not_fba_hole():
    plan = build_september_plan(
        CONTEXT_FBA, CONTEXT_INBOUND, CONTEXT_3PL,
        sku_awd=CONTEXT_AWD,
    )
    fba_hole = sum(plan["gaps"][s]["gap"] for s in LIP)
    assert 40_700 <= fba_hole <= 40_750
    assert sum(plan["sku_manufacture"].values()) != fba_hole
    assert plan["manufacture_into_fba"]["DDPE0004Shop"] == 0
    assert plan["mixed_need"]["DDPE0001Shop"] == 0
    for sku in LIP:
        assert plan["sku_manufacture"][sku] == max(
            0,
            OPTIMISTIC_AWD_ON_HAND_TARGETS[sku] - CONTEXT_AWD.get(sku, 0),
        )
    assert plan["two_tracks"] is True
    assert plan["august_tbd"] is True


def test_single_sku_awd_cards_from_manufacture():
    plan = build_september_plan(
        CONTEXT_FBA, CONTEXT_INBOUND, CONTEXT_3PL,
        sku_awd=CONTEXT_AWD,
    )
    cards = plan["awd_pallets"]
    assert cards
    assert all(c["single_sku"] and c["destination"] == "awd" for c in cards)
    assert all(c["locked"] is False for c in cards)
    assert all(is_legal_inbound_qty(0) for _ in cards)
    family = sum(c["total_units"] for c in cards)
    assert family > 0
    leftovers = allocate_single_sku_awd_pallets({"DDPE0004Shop": 40_000}, LIP_BALM_SKUS)
    assert len(leftovers) == 2
    assert all(c["single_sku"] for c in leftovers)


def test_august_tbd_does_not_invent_mix():
    plan = build_september_plan(CONTEXT_FBA, CONTEXT_INBOUND, CONTEXT_3PL, sku_awd=CONTEXT_AWD)
    assert plan["august_tbd"] is True
    assert all(qty == 0 for qty in plan["sku_august"].values())
    assert plan["first_action"]["august_is_mixed"] is True
    assert plan["first_action"]["after_august_single_sku_awd"] is True


def test_august_entered_offsets_fba_then_awd():
    fba = {s: SEPT_FBA_ON_HAND_TARGETS[s] for s in LIP}
    before = build_september_plan(fba, {s: 0 for s in LIP}, {s: 0 for s in LIP})
    after = build_september_plan(
        fba, {s: 0 for s in LIP}, {s: 0 for s in LIP},
        sku_august={"DDPE0004Shop": 5_000},
    )
    assert after["august_tbd"] is False
    assert after["august_to_awd"]["DDPE0004Shop"] == 5_000
    assert after["sku_manufacture"]["DDPE0004Shop"] == before["sku_manufacture"]["DDPE0004Shop"] - 5_000


def test_inbound_not_resent():
    gaps = sept_fba_gaps({"DDPE0001Shop": 2000}, {"DDPE0001Shop": 1500}, skus=["DDPE0001Shop"])
    assert gaps["DDPE0001Shop"]["fba_plus_inbound"] == 3500
    assert gaps["DDPE0001Shop"]["gap"] == 12_800 - 3500


def test_never_send_under_carton_min():
    assert fee_free_inbound_qty(1_349, 10_000) == 0
    assert fee_free_inbound_qty(1_594, 9_552) == 0  # unscented waits
    assert fee_free_inbound_qty(2_700, 5_141) == 2_700
    assert fee_free_inbound_qty(6_291, 5_141) == 2_700


def test_awd_on_hand_5k_drops_floor():
    awd = {"DDPE0001Shop": 6_000}
    assert awd_covers_off_fba_reserve(awd) is True
    tulsa = family_tulsa_floor(CONTEXT_3PL, sku_awd=awd)
    assert tulsa["floor"] == 0
    planned = {s: 20_000 for s in LIP}
    assert awd_covers_off_fba_reserve(CONTEXT_AWD, planned) is False


def test_empty_awd_keeps_tulsa_so_not_zero_both():
    tulsa = family_tulsa_floor({s: 0 for s in LIP}, sku_awd={s: 0 for s in LIP})
    assert tulsa["floor"] == 5_000
    assert tulsa["top_up"] == 5_000
    assert not (tulsa["awd_loaded"] is False and tulsa["on_hand"] == 0 and tulsa["floor"] == 0)


def test_oct_dec_fba_cap_scales():
    assert family_fba_cap_for_month("2026-10") == 49_400
    assert family_fba_cap_for_month("2026-09") == 55_600
    caps = scale_fba_caps(49_400)
    assert sum(caps.values()) == 49_400


def test_sept_ship_dates():
    assert sept_fba_ship_by(35).isoformat() == "2026-09-02"
    assert holiday_gate_last_3pl_fba(35).isoformat() == "2026-09-26"


def test_partial_threshold_still_9500():
    from src.inventory.pallet_planner import pallet_partial_min_units
    assert pallet_partial_min_units(PALLET_MAX_UNITS) == 9_500


def _locked_month_view():
    plan = build_september_plan(
        CONTEXT_FBA, CONTEXT_INBOUND, CONTEXT_3PL,
        sku_awd=CONTEXT_AWD,
    )
    horizon = production_horizon_months(
        date(2026, 8, 26), AMAZON_IN_BY_DEFAULT, 35,
        peak_end=PEAK_END_DEFAULT, refill_receive_days=35,
    )
    months = [h["month"] for h in horizon]
    by_month = {h["month"]: h for h in horizon}
    return plan, build_month_view_entries(months, by_month, plan)


def test_month_view_sept_not_empty_and_not_fba_only():
    _plan, entries = _locked_month_view()
    sept = [e for e in entries if e["month"] == "2026-09"]
    assert sept, "September was skipped"
    assert any(e["units"] > 0 for e in sept)
    dests = {e["destination"] for e in sept if e["units"] > 0}
    assert "3pl_fba" in dests
    assert "awd" in dests
    assert dests != {"3pl_fba"}
    fba = next(e for e in sept if e["destination"] == "3pl_fba")
    assert fba["mix"]["DDPE0004Shop"] == 8_100
    assert fba["mix"]["DDPE0003Shop"] == 5_400
    assert fba["mix"]["DDPE0002Shop"] == 2_700
    assert fba["mix"].get("DDPE0001Shop", 0) == 0
    assert fba["units"] == 16_200
    assert fba["next_hop"] is True
    awd = [e for e in sept if e["destination"] == "awd" and e["units"] > 0]
    assert awd
    assert all(e["single_sku"] for e in awd)


def test_month_view_oct_dec_awd_cards():
    _plan, entries = _locked_month_view()
    for month in ("2026-10", "2026-11", "2026-12"):
        cards = [e for e in entries if e["month"] == month and e["units"] > 0]
        assert cards, f"{month} missing AWD card"
        assert all(e["destination"] == "awd" for e in cards)
        assert all(e["single_sku"] for e in cards)
        assert all(e["is_pallet_card"] for e in cards)


def test_no_sub_half_awd_card():
    _plan, entries = _locked_month_view()
    for e in entries:
        if e["destination"] == "awd" and e["units"] > 0:
            assert e["units"] >= 9_500
            assert e["is_pallet_card"] is True
