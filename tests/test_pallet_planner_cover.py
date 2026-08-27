"""Pallet-planner peak-60d cover, Tulsa floor, lead times, Nov/Dec refill."""
from __future__ import annotations

from datetime import date

from src.inventory.pallet_planner import (
    AMAZON_IN_BY_DEFAULT,
    PEAK_END_DEFAULT,
    TULSA_LIP_FLOOR_UNITS,
    cover_units_from_daily,
    family_tulsa_floor,
    holiday_demand_from_sales,
    in_amazon_date,
    last_ship_date,
    load_planner_policy,
    month_can_make_gate,
    production_horizon_months,
    production_months_before_gate,
    ship_by_for_month,
    sku_production_build,
    sku_yoy_may_jul,
    transferable_3pl_by_sku,
)
from tests.test_pallet_planner_demand import LIP, _monthly

SETTINGS = {
    "target_cover_days": 60,
    "receiving_days_peak": 35,
    "receiving_days_normal": 28,
    "awd_to_fba_days": 14,
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
    assert policy["peak_end_date"] == PEAK_END_DEFAULT
    # Measured FBA median wins for ship-by (existing effective model)
    assert policy["gate_receive_days"] == 20
    gate = AMAZON_IN_BY_DEFAULT
    last = last_ship_date(gate, policy["gate_receive_days"])
    assert last == date(2026, 10, 11)
    oct_ship = date.fromisoformat(ship_by_for_month(
        "2026-10", gate, policy["gate_receive_days"], role="gate",
    ))
    assert oct_ship <= last


def test_horizon_includes_nov_and_dec_refill_not_late_inbound():
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
    assert "2026-09" in months or "2026-08" in months
    assert "2026-10" in months
    assert "2026-11" in months
    assert "2026-12" in months
    assert roles["2026-10"] == "gate"
    assert roles["2026-11"] == "refill"
    assert roles["2026-12"] == "refill"
    assert all(h.get("label") != "late_inbound" for h in horizon)

    # Nov still cannot make the 10-31 gate — but it is a refill month
    assert month_can_make_gate("2026-11", AMAZON_IN_BY_DEFAULT, 20) is False
    gate_only = production_months_before_gate(
        date(2026, 8, 26), AMAZON_IN_BY_DEFAULT, 20, n=4,
    )
    assert "2026-11" not in gate_only

    nov_ship = ship_by_for_month(
        "2026-11", AMAZON_IN_BY_DEFAULT, 20, role="refill",
    )
    assert nov_ship.startswith("2026-11")
    arrive = in_amazon_date(
        date.fromisoformat(nov_ship), 20, AMAZON_IN_BY_DEFAULT, clamp=False,
    )
    assert arrive > AMAZON_IN_BY_DEFAULT
    assert arrive.month in (11, 12)
    clamped = in_amazon_date(
        date.fromisoformat(nov_ship), 20, AMAZON_IN_BY_DEFAULT, clamp=True,
    )
    assert clamped == AMAZON_IN_BY_DEFAULT
