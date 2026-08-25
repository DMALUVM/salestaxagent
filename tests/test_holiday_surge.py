"""Tests for per-SKU holiday surge planning math."""
from __future__ import annotations

from src.inventory.holiday_surge import (
    holiday_demand_units,
    normalize_sku,
    planning_daily,
)


def test_normalize_sku_casefold():
    assert normalize_sku("DDPE0004SHOP") == normalize_sku("DDPE0004Shop")
    assert normalize_sku("  x  ") == "x"


def test_planning_daily_flat_when_not_holiday_mode():
    # Even with huge surge, off-season uses V30
    assert planning_daily(40, 150, 35, 4.5, holiday_mode=False) == 40.0


def test_planning_daily_non_surge_keeps_v30():
    # Deodorant-like: holiday slower than summer — do not deflate
    assert planning_daily(18, 11, 12, 0.9, holiday_mode=True) == 18.0


def test_planning_daily_assorted_surge():
    # Assorted: summer ~34/d, Nov–Dec ~155/d, current V30 ~42.5
    # YoY = clamp(42.5/34, 0.75, 1.40) ≈ 1.25
    # anchored = 155 * 1.25 ≈ 193.75 → max(42.5, 193.75)
    plan = planning_daily(42.5, 155.5, 34.3, 4.53, holiday_mode=True)
    assert plan > 180
    assert plan < 220
    assert plan > 42.5


def test_planning_daily_yoy_cap():
    # Very strong current V30 vs thin summer → YoY capped at 1.40
    plan = planning_daily(80, 100, 20, 5.0, holiday_mode=True)
    # 100 * 1.40 = 140
    assert plan == 140.0


def test_holiday_demand_units():
    # 155.5/d * 1.24 yoy * 61d ≈ 11,762
    units = holiday_demand_units(155.5, 1.24, days=61)
    assert 11000 < units < 12500


def test_holiday_demand_zero_when_no_history():
    assert holiday_demand_units(0, 1.2, days=61) == 0
