"""Pallet-planner peak-60d cover, Tulsa floor, lead times, Nov/Dec refill."""
from __future__ import annotations

from datetime import date

from src.inventory.pallet_planner import (
    AMAZON_IN_BY_DEFAULT,
    PEAK_END_DEFAULT,
    TULSA_LIP_FLOOR_UNITS,
    cover_units_from_daily,
    early_jan_fba_ship_by,
    family_tulsa_floor,
    holiday_demand_from_sales,
    in_amazon_date,
    last_ship_date,
    load_planner_policy,
    month_can_make_gate,
    production_horizon_months,
    production_months_before_gate,
    sellable_date,
    ship_by_for_month,
    ship_too_late_for_early_jan,
    sku_production_build,
    sku_yoy_may_jul,
    transferable_3pl_by_sku,
    tulsa_after_christmas_outbound,
)
from tests.test_pallet_planner_demand import LIP, _monthly

SETTINGS = {
    "target_cover_days": 60,
    "receiving_days_peak": 35,
    "receiving_days_normal": 28,
    "awd_to_fba_days": 14,
    "peak_start_date": "2026-10-01",
    "peak_end_date": "2027-01-15",
}
LEADTIME = {
    "fba_receive_median": 20,
    "fba_receive_n": 14,
    "awd_replenish_median": 12,
    "awd_replenish_n": 51,
}

# Dave’s peak-60d check (not a hardcoded recipe): Dec 2026 / 31 × 60
PEAK_60_CHECK = {
    "DDPE0001Shop": (10700, 200),   # ~10,700
    "DDPE0002Shop": (7200, 200),    # ~7,200
    "DDPE0003Shop": (14850, 200),   # ~14,850
    "DDPE0004Shop": (19200, 200),   # ~19,200
}


def _demand():
    return holiday_demand_from_sales(_monthly(LIP), LIP, include_jan=True)


def test_peak_60d_fba_uses_december_daily_not_nov_dec_average():
    demand = _demand()
    policy = load_planner_policy(SETTINGS, LEADTIME)
    assert policy["target_cover_days"] == 60
    family_peak = 0
    for sku in LIP:
        build = sku_production_build(
            demand[sku],
            cover_days=policy["target_cover_days"],
            receive_days=policy["gate_receive_days"],
        )
        mid, tol = PEAK_60_CHECK[sku]
        assert abs(build["peak_cover"] - mid) <= tol
        dec = demand[sku]["months_2026"][12]
        nov_dec = demand[sku]["nov_dec_demand"]
        avg_daily = nov_dec / 61
        assert build["dec_daily"] == dec / 31
        assert build["dec_daily"] > avg_daily
        assert build["peak_cover"] == cover_units_from_daily(dec / 31, 60)
        family_peak += build["peak_cover"]
    assert 51_000 <= family_peak <= 53_000


def test_january_is_jan_2026_times_may_jul_yoy_not_a_second_2x():
    monthly = _monthly(LIP)
    demand = holiday_demand_from_sales(monthly, LIP, include_jan=True)
    assert sum(monthly[(s.lower(), 2026, 1)] for s in LIP) == 11345
    assert sum(monthly[(s.lower(), 2025, 1)] for s in LIP) == 5416
    leftover_yoy = 11345 / 5416
    assert 2.09 < leftover_yoy < 2.11
    for sku in LIP:
        yoy = sku_yoy_may_jul(monthly, sku)["yoy"]
        jan_2026 = monthly[(sku.lower(), 2026, 1)]
        expected = round(jan_2026 * yoy)
        assert demand[sku]["jan_demand"] == expected
        assert demand[sku]["jan_prior"] == jan_2026
        # Do not apply leftover-holiday 2.1× on top of Jan 2026
        assert demand[sku]["jan_demand"] != round(jan_2026 * leftover_yoy)
        assert 1.30 < yoy < 1.54


def test_production_target_is_demand_plus_cover_plus_pipeline_not_sellthrough():
    demand = _demand()
    policy = load_planner_policy(SETTINGS, LEADTIME)
    for sku in LIP:
        build = sku_production_build(
            demand[sku],
            cover_days=60,
            receive_days=policy["gate_receive_days"],
        )
        sellthrough = demand[sku]["holiday_demand"]
        assert build["sku_build"] == (
            sellthrough + build["ending_cover"] + build["pipeline"]
        )
        assert build["sku_build"] > sellthrough
        assert build["gate_units"] == (
            build["nov_dec_demand"] + build["peak_cover"] + build["pipeline"]
        )
        assert build["refill_units"] == (
            build["jan_demand"] + max(0, build["jan_cover"] - build["peak_cover"])
        )


def test_tulsa_floor_is_family_5000_not_per_sku():
    assert TULSA_LIP_FLOOR_UNITS == 5000
    empty = family_tulsa_floor({s: 0 for s in LIP})
    assert empty["floor"] == 5000
    assert empty["top_up"] == 5000
    assert empty["transferable"] == 0
    assert empty["split_per_sku"] is False

    over = family_tulsa_floor({
        "DDPE0001Shop": 2000,
        "DDPE0002Shop": 2000,
        "DDPE0003Shop": 3000,
        "DDPE0004Shop": 1000,
    })
    assert over["on_hand"] == 8000
    assert over["transferable"] == 3000
    assert over["top_up"] == 0
    xfer = transferable_3pl_by_sku({
        "DDPE0001Shop": 2000,
        "DDPE0002Shop": 2000,
        "DDPE0003Shop": 3000,
        "DDPE0004Shop": 1000,
    })
    assert sum(xfer.values()) == 3000
    assert all(v >= 0 for v in xfer.values())


def test_lead_times_come_from_settings_and_summary():
    policy = load_planner_policy(SETTINGS, LEADTIME)
    assert policy["receiving_days_peak"] == 35
    assert policy["receiving_days_normal"] == 28
    assert policy["awd_to_fba_days"] == 14
    assert policy["fba_receive_median"] == 20
    assert policy["fba_receive_n"] == 14
    assert policy["awd_replenish_median"] == 12
    assert policy["awd_replenish_n"] == 51
    assert policy["peak_start_date"] == date(2026, 10, 1)
    assert policy["peak_end_date"] == PEAK_END_DEFAULT
    # Q4 / early January uses configured peak 35 — measured 20 is context only
    assert policy["gate_receive_days"] == 35
    assert policy["refill_receive_days"] == 35
    assert policy["peak_receive_overrides_measured"] is True
    assert policy["measured_fba_receive_days"] == 20
    gate = AMAZON_IN_BY_DEFAULT
    last = last_ship_date(gate, policy["gate_receive_days"])
    assert last == date(2026, 9, 26)
    assert month_can_make_gate("2026-10", gate, 35) is False
    assert month_can_make_gate("2026-09", gate, 35) is True
    sep_ship = date.fromisoformat(ship_by_for_month(
        "2026-09", gate, policy["gate_receive_days"], role="gate",
    ))
    assert sep_ship <= last


def test_horizon_includes_oct_nov_dec_ammo_not_late_inbound():
    policy = load_planner_policy(SETTINGS, LEADTIME)
    horizon = production_horizon_months(
        date(2026, 8, 26),
        AMAZON_IN_BY_DEFAULT,
        policy["gate_receive_days"],
        peak_end=policy["peak_end_date"],
        refill_receive_days=policy["refill_receive_days"],
    )
    months = [h["month"] for h in horizon]
    roles = {h["month"]: h["role"] for h in horizon}
    labels = {h["month"]: h["label"] for h in horizon}
    assert "2026-08" in months
    assert "2026-09" in months
    assert "2026-10" in months
    assert "2026-11" in months
    assert "2026-12" in months
    assert roles["2026-08"] == "gate"
    assert roles["2026-09"] == "gate"
    assert roles["2026-10"] == "refill"
    assert roles["2026-11"] == "refill"
    assert roles["2026-12"] == "refill"
    assert labels["2026-10"] == "post_christmas_ammo"
    assert labels["2026-11"] == "post_christmas_ammo"
    assert labels["2026-12"] == "post_christmas_ammo"
    assert all(h.get("label") != "late_inbound" for h in horizon)

    # Oct/Nov cannot make the 10-31 gate at 35d
    assert month_can_make_gate("2026-10", AMAZON_IN_BY_DEFAULT, 35) is False
    assert month_can_make_gate("2026-11", AMAZON_IN_BY_DEFAULT, 35) is False
    gate_only = production_months_before_gate(
        date(2026, 8, 26), AMAZON_IN_BY_DEFAULT, 35, n=4,
    )
    assert "2026-10" not in gate_only
    assert "2026-11" not in gate_only
    assert "2026-09" in gate_only

    nov_ship = ship_by_for_month(
        "2026-11", AMAZON_IN_BY_DEFAULT, 35, role="refill",
    )
    assert nov_ship.startswith("2026-11")
    arrive = in_amazon_date(
        date.fromisoformat(nov_ship), 35, AMAZON_IN_BY_DEFAULT, clamp=False,
    )
    assert arrive > AMAZON_IN_BY_DEFAULT


def test_dec_26_ship_is_too_late_for_early_january():
    policy = load_planner_policy(SETTINGS, LEADTIME)
    assert policy["gate_receive_days"] == 35
    assert sellable_date(date(2026, 12, 26), 35) == date(2027, 1, 30)
    assert ship_too_late_for_early_jan(date(2026, 12, 26), 35, PEAK_END_DEFAULT)
    ship_by = early_jan_fba_ship_by(PEAK_END_DEFAULT, 35)
    assert ship_by == date(2026, 12, 11)
    assert ship_by < date(2026, 12, 25)
    assert policy["early_jan_fba_ship_by"] == ship_by
    dec_ship = date.fromisoformat(ship_by_for_month(
        "2026-12", AMAZON_IN_BY_DEFAULT, 35,
        role="refill", need_in_fba=PEAK_END_DEFAULT,
    ))
    assert dec_ship == date(2026, 12, 11)
    assert dec_ship <= ship_by
    assert sellable_date(dec_ship, 35) <= PEAK_END_DEFAULT


def test_tulsa_keeps_5000_after_christmas_outbound():
    sku_3pl = {
        "DDPE0001Shop": 2000,
        "DDPE0002Shop": 2000,
        "DDPE0003Shop": 3000,
        "DDPE0004Shop": 1000,
    }
    # 2k early-Jan FBA from Tulsa — remaining 6k stays as ammo
    kept = tulsa_after_christmas_outbound(sku_3pl, 2000)
    assert kept["outbound"] == 2000
    assert kept["after_outbound"] == 6000
    assert kept["needed_before_outbound"] == 7000
    assert kept["meets_floor_after_outbound"] is True
    assert kept["cover_through"] == "2027-02-14"
    assert kept["do_not_drain_to_zero"] is True

    # Asking for more than excess caps at transferable — never drain to 0
    capped = tulsa_after_christmas_outbound(sku_3pl, 4000)
    assert capped["outbound"] == 3000
    assert capped["after_outbound"] == 5000
    assert capped["meets_floor_after_outbound"] is True
    assert capped["needed_before_outbound"] == 9000

    empty = tulsa_after_christmas_outbound({s: 0 for s in sku_3pl}, 2000)
    assert empty["outbound"] == 0
    assert empty["after_outbound"] == 0
    assert empty["needed_before_outbound"] == 7000
