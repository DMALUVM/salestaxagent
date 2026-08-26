"""Pallet-planner demand, YoY, remainder, and holiday-gate date math."""
from __future__ import annotations

from datetime import date

from src.inventory.pallet_planner import (
    ACTUAL_2025_SOURCE,
    AMAZON_IN_BY_DEFAULT,
    PALLET_MAX_UNITS,
    _holiday_demand_by_sku,
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
)

# Warehouse amazon_spapi totals used only as test fixtures — not a locked mix.
# Verified against sales_by_sku (sum across states) on 2026-08-26.
LIP = ["DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"]

# (sku, year, month, units) Amazon pulse monthly totals
AMAZON_MONTHLY = [
    # 2025 May–Jul (YoY prior) + Nov–Dec
    ("DDPE0001Shop", 2025, 5, 1558),
    ("DDPE0001Shop", 2025, 6, 1106),
    ("DDPE0001Shop", 2025, 7, 1511),
    ("DDPE0001Shop", 2025, 11, 2155),
    ("DDPE0001Shop", 2025, 12, 4104),
    ("DDPE0001Shop", 2026, 1, 2904),
    ("DDPE0001Shop", 2026, 5, 1848),
    ("DDPE0001Shop", 2026, 6, 2002),
    ("DDPE0001Shop", 2026, 7, 1775),
    ("DDPE0002Shop", 2025, 5, 865),
    ("DDPE0002Shop", 2025, 6, 693),
    ("DDPE0002Shop", 2025, 7, 1074),
    ("DDPE0002Shop", 2025, 11, 1454),
    ("DDPE0002Shop", 2025, 12, 2850),
    ("DDPE0002Shop", 2026, 1, 1685),
    ("DDPE0002Shop", 2026, 5, 1219),
    ("DDPE0002Shop", 2026, 6, 1224),
    ("DDPE0002Shop", 2026, 7, 996),
    ("DDPE0003Shop", 2025, 5, 1677),
    ("DDPE0003Shop", 2025, 6, 1230),
    ("DDPE0003Shop", 2025, 7, 1942),
    ("DDPE0003Shop", 2025, 11, 2791),
    ("DDPE0003Shop", 2025, 12, 5009),
    ("DDPE0003Shop", 2026, 1, 3321),
    ("DDPE0003Shop", 2026, 5, 2633),
    ("DDPE0003Shop", 2026, 6, 2712),
    ("DDPE0003Shop", 2026, 7, 2083),
    ("DDPE0004Shop", 2025, 5, 1458),
    ("DDPE0004Shop", 2025, 6, 1075),
    ("DDPE0004Shop", 2025, 7, 967),
    ("DDPE0004Shop", 2025, 11, 2627),
    ("DDPE0004Shop", 2025, 12, 6861),
    ("DDPE0004Shop", 2026, 1, 3435),
    ("DDPE0004Shop", 2026, 5, 1955),
    ("DDPE0004Shop", 2026, 6, 1698),
    ("DDPE0004Shop", 2026, 7, 1406),
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


def test_family_yoy_may_jul_matches_warehouse_1_42():
    monthly = monthly_amazon_units(_rows(), LIP)
    info = family_yoy_may_jul(monthly, LIP)
    assert info["prior_units"] == 15156
    assert info["current_units"] == 21551
    assert 1.41 < info["yoy"] < 1.43
    assert info["method"] == "family_may_jul_amazon_sales_by_sku"


def test_unscented_peppermint_nov_dec_from_sales_yoy_not_wave_light():
    monthly = monthly_amazon_units(_rows(), LIP)
    yoy = family_yoy_may_jul(monthly, LIP)["yoy"]
    demand = holiday_demand_from_sales(monthly, LIP, yoy, include_jan=False)
    unscented = demand["DDPE0001Shop"]
    peppermint = demand["DDPE0002Shop"]
    assert unscented["nov_dec_prior"] == 6259
    assert peppermint["nov_dec_prior"] == 4304
    assert 8800 <= unscented["nov_dec_demand"] <= 9000
    assert 6000 <= peppermint["nov_dec_demand"] <= 6200
    # Current production cards were ~2,593 / 2,205 per wave — systematically light
    assert unscented["nov_dec_demand"] > 2593 * 2
    assert peppermint["nov_dec_demand"] > 2205 * 2


def test_demand_is_derived_not_a_hardcoded_mix():
    monthly = monthly_amazon_units(_rows(), LIP)
    doubled = {k: v * 2 for k, v in monthly.items()}
    yoy = family_yoy_may_jul(monthly, LIP)["yoy"]
    a = holiday_demand_from_sales(monthly, LIP, yoy, include_jan=False)
    b = holiday_demand_from_sales(doubled, LIP, yoy, include_jan=False)
    assert b["DDPE0001Shop"]["nov_dec_demand"] == a["DDPE0001Shop"]["nov_dec_demand"] * 2


def test_leftover_4276_is_not_a_one_pallet_card():
    fill = pallet_fill(4276, PALLET_MAX_UNITS)
    assert fill["full_pallets"] == 0
    assert fill["leftover_units"] == 4276
    assert fill["is_pallet_card"] is False
    assert 0.22 < fill["fill_pct"] < 0.24


def test_full_pallet_plus_remainder_uses_floor():
    fill = pallet_fill(19_000 + 4276, PALLET_MAX_UNITS)
    assert fill["full_pallets"] == 1
    assert fill["leftover_units"] == 4276
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


def test_latest_3pl_row_per_sku_not_latest_batch():
    rows = [
        {"sku": "DDPE0001Shop", "available": 10, "pulled_at": "2026-08-26T10:00:00Z"},
        {"sku": "DDPE0002Shop", "available": 99, "pulled_at": "2026-08-17T10:00:00Z"},
        {"sku": "DDPE0001Shop", "available": 1594, "pulled_at": "2026-08-26T23:35:59Z"},
    ]
    latest = latest_row_per_sku(rows)
    assert latest["ddpe0001shop"]["available"] == 1594
    assert latest["ddpe0002shop"]["available"] == 99
