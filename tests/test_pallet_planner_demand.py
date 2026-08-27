"""Pallet-planner demand, YoY, remainder, and holiday-gate date math."""
from __future__ import annotations

from datetime import date

from src.inventory.pallet_planner import (
    ACTUAL_2025_SOURCE,
    AMAZON_IN_BY_DEFAULT,
    ASSORTED_SKU,
    DEMAND_METHOD,
    PALLET_MAX_UNITS,
    _holiday_demand_by_sku,
    apply_assorted_correction_display,
    family_yoy_may_jul,
    fba_cover_units,
    holiday_demand_from_sales,
    in_amazon_date,
    inbound_in_transit,
    last_ship_date,
    latest_row_per_sku,
    month_can_make_gate,
    monthly_amazon_units,
    pallet_fill,
    production_months_before_gate,
    ship_by_for_month,
    sku_production_build,
    sku_yoy_may_jul,
    workbook_window_units,
)

# Warehouse amazon_spapi totals used only as test fixtures — not a locked mix.
# Verified against sales_by_sku (sum across states) on 2026-08-26.
LIP = ["DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"]
DEO = "DDPE00019Shop"
TALLOW = "DDPE00020Shop"

# (sku, year, month, units) Amazon pulse monthly totals
AMAZON_MONTHLY = [
    # 2025 May–Jul (YoY prior) + Nov–Dec. Oct from warehouse (2026-08-26).
    ("DDPE0001Shop", 2025, 5, 1558),
    ("DDPE0001Shop", 2025, 6, 1106),
    ("DDPE0001Shop", 2025, 7, 1511),
    ("DDPE0001Shop", 2025, 10, 1670),
    ("DDPE0001Shop", 2025, 11, 2155),
    ("DDPE0001Shop", 2025, 12, 4104),
    ("DDPE0001Shop", 2025, 1, 1386),
    ("DDPE0001Shop", 2026, 1, 2904),
    ("DDPE0001Shop", 2026, 5, 1848),
    ("DDPE0001Shop", 2026, 6, 2002),
    ("DDPE0001Shop", 2026, 7, 1775),
    ("DDPE0002Shop", 2025, 5, 865),
    ("DDPE0002Shop", 2025, 6, 693),
    ("DDPE0002Shop", 2025, 7, 1074),
    ("DDPE0002Shop", 2025, 10, 1056),
    ("DDPE0002Shop", 2025, 11, 1454),
    ("DDPE0002Shop", 2025, 12, 2850),
    ("DDPE0002Shop", 2025, 1, 804),
    ("DDPE0002Shop", 2026, 1, 1685),
    ("DDPE0002Shop", 2026, 5, 1219),
    ("DDPE0002Shop", 2026, 6, 1224),
    ("DDPE0002Shop", 2026, 7, 996),
    ("DDPE0003Shop", 2025, 5, 1677),
    ("DDPE0003Shop", 2025, 6, 1230),
    ("DDPE0003Shop", 2025, 7, 1942),
    ("DDPE0003Shop", 2025, 10, 2439),
    ("DDPE0003Shop", 2025, 11, 2791),
    ("DDPE0003Shop", 2025, 12, 5009),
    ("DDPE0003Shop", 2025, 1, 1585),
    ("DDPE0003Shop", 2026, 1, 3321),
    ("DDPE0003Shop", 2026, 5, 2633),
    ("DDPE0003Shop", 2026, 6, 2712),
    ("DDPE0003Shop", 2026, 7, 2083),
    ("DDPE0004Shop", 2025, 5, 1458),
    ("DDPE0004Shop", 2025, 6, 1075),
    ("DDPE0004Shop", 2025, 7, 967),
    ("DDPE0004Shop", 2025, 10, 1452),
    ("DDPE0004Shop", 2025, 11, 2627),
    ("DDPE0004Shop", 2025, 12, 6861),
    ("DDPE0004Shop", 2025, 1, 1641),
    ("DDPE0004Shop", 2026, 1, 3435),
    ("DDPE0004Shop", 2026, 5, 1955),
    ("DDPE0004Shop", 2026, 6, 1698),
    ("DDPE0004Shop", 2026, 7, 1406),
    # Deodorant: own YoY < 1, Dec is not a lip-balm spike.
    (DEO, 2025, 5, 400),
    (DEO, 2025, 6, 350),
    (DEO, 2025, 7, 400),
    (DEO, 2025, 11, 280),
    (DEO, 2025, 12, 333),
    (DEO, 2026, 5, 380),
    (DEO, 2026, 6, 340),
    (DEO, 2026, 7, 350),
    # Tallow balm: no May–Jul prior window → YoY 1.0, keep own 2025 Dec.
    (TALLOW, 2025, 11, 180),
    (TALLOW, 2025, 12, 200),
]


def _rows():
    rows = []
    for sku, year, month, units in AMAZON_MONTHLY:
        rows.append({
            "sku": sku,
            "period_start": date(year, month, 1).isoformat(),
            "units": units,
            "channel": "amazon",
            "source": "amazon_spapi",
        })
    return rows


def _monthly(skus=None):
    return monthly_amazon_units(_rows(), skus or [*LIP, DEO, TALLOW])


def test_monthly_amazon_sums_states_and_ignores_quarantine():
    rows = _rows()
    rows.append({
        "sku": "DDPE0001Shop",
        "period_start": "2025-11-01",
        "units": 99999,
        "channel": "amazon",
        "source": "amazon_custom_combined_tax",
    })
    rows.append({
        "sku": "DDPE0001SHOP",
        "period_start": "2025-11-01",
        "units": 10,
        "channel": "amazon",
        "source": "amazon_spapi",
    })
    monthly = monthly_amazon_units(rows, LIP)
    assert monthly[("ddpe0001shop", 2025, 11)] == 2165


def test_family_yoy_is_context_only_not_a_sku_multiplier():
    monthly = monthly_amazon_units(_rows(), LIP)
    info = family_yoy_may_jul(monthly, LIP)
    assert info["prior_units"] == 15156
    assert info["current_units"] == 21551
    assert 1.41 < info["yoy"] < 1.43
    assert info["method"] == "family_may_jul_context_only"
    assert info["applied_to_skus"] is False
    assert DEMAND_METHOD == "sku_2025_same_month_x_sku_may_jul_yoy"


def test_each_lip_sku_uses_its_own_may_jul_yoy():
    monthly = _monthly(LIP)
    yoy = {sku: sku_yoy_may_jul(monthly, sku)["yoy"] for sku in LIP}
    assert 1.34 < yoy["DDPE0001Shop"] < 1.35   # 5625/4175
    assert 1.30 < yoy["DDPE0002Shop"] < 1.31   # 3439/2632
    assert 1.53 < yoy["DDPE0003Shop"] < 1.54   # 7428/4849
    assert 1.44 < yoy["DDPE0004Shop"] < 1.45   # 5059/3500
    family = family_yoy_may_jul(monthly, LIP)["yoy"]
    for sku in LIP:
        assert abs(yoy[sku] - family) > 0.02


def test_unscented_peppermint_use_own_yoy_not_family_1_42():
    monthly = _monthly(LIP)
    demand = holiday_demand_from_sales(monthly, LIP, include_jan=False)
    unscented = demand["DDPE0001Shop"]
    peppermint = demand["DDPE0002Shop"]
    assert unscented["nov_dec_prior"] == 6259
    assert peppermint["nov_dec_prior"] == 4304
    # Per-SKU: 6259 × 1.347 ≈ 8,432 — not family-blend ~8,900
    assert 8400 <= unscented["nov_dec_demand"] <= 8460
    assert unscented["nov_dec_demand"] == (
        unscented["months_2026"][11] + unscented["months_2026"][12]
    )
    # Per-SKU: 4304 × 1.307 ≈ 5,624 — not family-blend ~6,120
    assert 5590 <= peppermint["nov_dec_demand"] <= 5660
    family = family_yoy_may_jul(monthly, LIP)["yoy"]
    family_unscented = round(6259 * family)
    family_peppermint = round(4304 * family)
    assert unscented["nov_dec_demand"] != family_unscented
    assert peppermint["nov_dec_demand"] != family_peppermint
    assert unscented["nov_dec_demand"] < family_unscented
    assert peppermint["nov_dec_demand"] < family_peppermint
    # Still well above the old wave-light cards (~2,593 / 2,205)
    assert unscented["nov_dec_demand"] > 2593 * 2
    assert peppermint["nov_dec_demand"] > 2205 * 2


def test_each_sku_keeps_its_own_2025_mom_shape():
    monthly = _monthly(LIP)
    demand = holiday_demand_from_sales(monthly, LIP, include_jan=False)
    for sku in LIP:
        key = sku.lower()
        oct_2025 = monthly[(key, 2025, 10)]
        nov_2025 = monthly[(key, 2025, 11)]
        dec_2025 = monthly[(key, 2025, 12)]
        m = demand[sku]["months_2026"]
        # Same ranking as that SKU's 2025 months
        assert oct_2025 < nov_2025 < dec_2025
        assert m[10] < m[11] < m[12]
        # Dec/Nov ratio preserved (same YoY on each month)
        prior_ratio = dec_2025 / nov_2025
        forecast_ratio = m[12] / m[11]
        assert abs(forecast_ratio - prior_ratio) < 0.01


def test_deodorant_and_tallow_do_not_inherit_lip_yoy_or_dec_spike():
    monthly = _monthly()
    demand = holiday_demand_from_sales(monthly, [*LIP, DEO, TALLOW], include_jan=False)
    lip_yoy = sku_yoy_may_jul(monthly, "DDPE0001Shop")["yoy"]
    family = family_yoy_may_jul(monthly, LIP)["yoy"]
    deo = demand[DEO]
    tallow = demand[TALLOW]

    deo_yoy = sku_yoy_may_jul(monthly, DEO)
    assert deo_yoy["prior_units"] == 1150
    assert deo_yoy["current_units"] == 1070
    assert 0.92 < deo["yoy"] < 0.94
    assert deo["yoy"] != lip_yoy
    assert deo["yoy"] != family
    assert deo["nov_dec_prior"] == 613
    # Own YoY: 280×0.930 + 333×0.930 ≈ 570 — not 1.42× (~872) or lip Dec shape
    assert 560 <= deo["nov_dec_demand"] <= 580
    assert deo["months_2026"][12] < 340
    assert deo["months_2026"][12] != round(333 * family)
    assert deo["months_2026"][12] != round(333 * lip_yoy)
    # Dec/Nov stays deodorant-flat (~1.19), not unscented spike (~1.90)
    deo_ratio = deo["months_2026"][12] / deo["months_2026"][11]
    lip_ratio = (
        demand["DDPE0001Shop"]["months_2026"][12]
        / demand["DDPE0001Shop"]["months_2026"][11]
    )
    assert deo_ratio < 1.25
    assert lip_ratio > 1.85

    tallow_yoy = sku_yoy_may_jul(monthly, TALLOW)
    assert tallow_yoy["prior_units"] == 0
    assert tallow["yoy"] == 1.0
    assert tallow["nov_dec_demand"] == 380
    assert tallow["months_2026"][12] == 200
    assert tallow["months_2026"][12] != round(200 * family)


def test_demand_is_derived_not_a_hardcoded_mix():
    monthly = _monthly(LIP)
    tweaked = dict(monthly)
    tweaked[("ddpe0001shop", 2025, 11)] += 100
    a = holiday_demand_from_sales(monthly, LIP, include_jan=False)
    b = holiday_demand_from_sales(tweaked, LIP, include_jan=False)
    assert b["DDPE0001Shop"]["nov_dec_demand"] > a["DDPE0001Shop"]["nov_dec_demand"]
    assert b["DDPE0002Shop"]["nov_dec_demand"] == a["DDPE0002Shop"]["nov_dec_demand"]
    assert b["DDPE0003Shop"]["nov_dec_demand"] == a["DDPE0003Shop"]["nov_dec_demand"]


def test_leftover_4276_is_not_a_one_pallet_card():
    fill = pallet_fill(4276, PALLET_MAX_UNITS)
    assert fill["full_pallets"] == 0
    assert fill["leftover_units"] == 4276
    assert fill["held_units"] == 4276
    assert fill["has_partial"] is False
    assert fill["merge_or_hold"] is True
    assert fill["is_pallet_card"] is False
    assert 0.22 < fill["fill_pct"] < 0.24


def test_full_pallet_plus_remainder_uses_floor():
    fill = pallet_fill(19_000 + 4276, PALLET_MAX_UNITS)
    assert fill["full_pallets"] == 1
    assert fill["leftover_units"] == 4276
    assert fill["held_units"] == 4276
    assert fill["has_partial"] is False
    assert fill["pallet_cards"] == 1
    assert fill["is_pallet_card"] is True


def test_november_wave_cannot_make_oct_31_gate():
    gate = AMAZON_IN_BY_DEFAULT
    assert month_can_make_gate("2026-11", gate, 18) is False
    assert month_can_make_gate("2026-10", gate, 18) is True
    months = production_months_before_gate(date(2026, 8, 26), gate, 18, n=4)
    assert "2026-11" not in months
    assert "2026-10" in months


def test_in_amazon_date_never_past_gate():
    late = in_amazon_date(date(2026, 11, 7), 18, AMAZON_IN_BY_DEFAULT)
    assert late == AMAZON_IN_BY_DEFAULT
    assert late <= AMAZON_IN_BY_DEFAULT
    oct_ship = date.fromisoformat(ship_by_for_month("2026-10", AMAZON_IN_BY_DEFAULT, 18))
    assert oct_ship <= last_ship_date(AMAZON_IN_BY_DEFAULT, 18)
    arrive = in_amazon_date(oct_ship, 18, AMAZON_IN_BY_DEFAULT)
    assert arrive <= AMAZON_IN_BY_DEFAULT


def test_actual_2025_label_is_workbook_not_monthly_sales():
    assert "forecast_weekly" in ACTUAL_2025_SOURCE
    assert "not Amazon monthly" in ACTUAL_2025_SOURCE
    workbook = _holiday_demand_by_sku(
        [
            {"sku": "DDPE0001Shop", "scenario": "actual_2025",
             "week_start": "2026-11-01", "units": 1649},
            {"sku": "DDPE0001Shop", "scenario": "actual_2025",
             "week_start": "2026-12-01", "units": 3866},
            {"sku": "DDPE0001Shop", "scenario": "actual_2025",
             "week_start": "2026-01-01", "units": 2463},
        ],
        ["DDPE0001Shop"],
        "actual_2025",
        include_jan=True,
        velocities={"ignored": True},
    )
    # Workbook weekly Nov+Dec+Jan (3 Nov weeks missing) ≠ 6,259 Nov–Dec sales
    assert workbook["DDPE0001Shop"] == 1649 + 3866 + 2463
    assert workbook["DDPE0001Shop"] != 6259


def test_cover_is_fulfillable_only_inbound_is_transit():
    snap = {
        "fulfillable": 2978,
        "reserved": 2466,
        "researching": 28,
        "unfulfillable": 5,
        "inbound_working": 0,
        "inbound_shipped": 270,
        "inbound_receiving": 0,
    }
    assert fba_cover_units(snap) == 2978
    assert inbound_in_transit(snap) == 270
    assert fba_cover_units(snap) + inbound_in_transit(snap) == 3248


# Workbook window fixtures — derived totals, not a hardcoded recipe.
# Assorted CF ≈ Dave's 22,633; optimistic is stock-to-cover, not display.
FC_WINDOW = [
    {"sku": "DDPE0004Shop", "scenario": "correction_factor",
     "week_start": "2026-11-16", "units": 7000},
    {"sku": "DDPE0004Shop", "scenario": "correction_factor",
     "week_start": "2026-12-07", "units": 10000},
    {"sku": "DDPE0004Shop", "scenario": "correction_factor",
     "week_start": "2027-01-11", "units": 5633},
    # Other-SKU CF must not rewrite Orange / Unscented / Peppermint display
    {"sku": "DDPE0001Shop", "scenario": "correction_factor",
     "week_start": "2026-11-16", "units": 99999},
    {"sku": "DDPE0001Shop", "scenario": "optimistic",
     "week_start": "2026-11-16", "units": 17803},
    {"sku": "DDPE0002Shop", "scenario": "optimistic",
     "week_start": "2026-11-16", "units": 10590},
    {"sku": "DDPE0003Shop", "scenario": "optimistic",
     "week_start": "2026-11-16", "units": 22827},
    {"sku": "DDPE0004Shop", "scenario": "optimistic",
     "week_start": "2026-11-16", "units": 24991},
]


def test_assorted_display_uses_correction_factor_not_yoy_or_optimistic():
    monthly = _monthly(LIP)
    yoy = holiday_demand_from_sales(monthly, LIP, include_jan=True)
    yoy_holiday = yoy[ASSORTED_SKU]["holiday_demand"]
    assert 18_600 <= yoy_holiday <= 18_750
    displayed = apply_assorted_correction_display(yoy, FC_WINDOW)
    assorted = displayed[ASSORTED_SKU]
    cf = workbook_window_units(FC_WINDOW, ASSORTED_SKU, "correction_factor")
    assert cf == 22633
    assert assorted["holiday_demand"] == cf
    assert assorted["holiday_demand"] != yoy_holiday
    assert assorted["holiday_demand"] != 24991
    assert assorted["display_method"] == "assorted_correction_factor_scaled"
    # Own 2025 MoM shape preserved
    prior_ratio = (
        monthly[("ddpe0004shop", 2025, 12)]
        / monthly[("ddpe0004shop", 2025, 11)]
    )
    assert abs(
        assorted["months_2026"][12] / assorted["months_2026"][11] - prior_ratio
    ) < 0.02
    # Other SKUs stay on own YoY — CF 99,999 does not apply
    for sku in ("DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop"):
        assert displayed[sku]["holiday_demand"] == yoy[sku]["holiday_demand"]
        assert displayed[sku]["display_method"] == DEMAND_METHOD


def test_optimistic_is_stock_to_cover_not_displayed_forecast():
    monthly = _monthly(LIP)
    displayed = apply_assorted_correction_display(
        holiday_demand_from_sales(monthly, LIP, include_jan=True), FC_WINDOW,
    )
    family_opt = 0
    family_display = 0
    for sku in LIP:
        opt = workbook_window_units(FC_WINDOW, sku, "optimistic")
        build = sku_production_build(
            displayed[sku], cover_days=60, receive_days=35, optimistic_units=opt,
        )
        family_opt += opt
        family_display += build["display_demand"]
        assert build["display_demand"] == displayed[sku]["holiday_demand"]
        assert build["optimistic_units"] == opt
        assert build["cover_fulfill"] == max(build["display_demand"], opt)
        assert build["sku_build"] == build["display_demand"]
        assert build["stacked_build"] == (
            build["cover_fulfill"] + build["ending_cover"] + build["pipeline"]
        )
        assert build["unstacked"] is True
        # Peak-60d still from display December, not optimistic
        dec = displayed[sku]["months_2026"][12]
        assert build["peak_cover"] == round(dec / 31 * 60)
    assert family_opt == 76211
    assert 76_000 <= family_opt <= 76_400
    assert displayed[ASSORTED_SKU]["holiday_demand"] != 24991
    assert displayed[ASSORTED_SKU]["holiday_demand"] == 22633
    # Optimistic sits above display — gap is stock-to-cover
    assert family_opt > family_display
    assorted_build = sku_production_build(
        displayed[ASSORTED_SKU],
        cover_days=60, receive_days=35, optimistic_units=24991,
    )
    assert assorted_build["stock_to_cover"] == 24991 - 22633
    assert assorted_build["cover_fulfill"] == 24991


def test_assorted_cf_missing_falls_back_to_yoy():
    monthly = _monthly(LIP)
    yoy = holiday_demand_from_sales(monthly, LIP, include_jan=True)
    displayed = apply_assorted_correction_display(yoy, [])
    assert displayed[ASSORTED_SKU]["holiday_demand"] == yoy[ASSORTED_SKU]["holiday_demand"]


def test_latest_3pl_row_per_sku_not_latest_batch():
    rows = [
        {"sku": "DDPE0001Shop", "available": 10, "pulled_at": "2026-08-26T10:00:00Z"},
        {"sku": "DDPE0002Shop", "available": 99, "pulled_at": "2026-08-17T10:00:00Z"},
        {"sku": "DDPE0001Shop", "available": 1594, "pulled_at": "2026-08-26T23:35:59Z"},
    ]
    latest = latest_row_per_sku(rows)
    assert latest["ddpe0001shop"]["available"] == 1594
    assert latest["ddpe0002shop"]["available"] == 99
