"""Tests for per-SKU holiday surge planning math."""
from __future__ import annotations

from datetime import date

from src.inventory.holiday_surge import (
    AMAZON_MIN_COVER_DAYS,
    amazon_cover_target,
    holiday_demand_units,
    is_slow_season,
    normalize_sku,
    normalized_baseline,
    planning_daily,
)


def test_normalize_sku_casefold():
    assert normalize_sku("DDPE0004SHOP") == normalize_sku("DDPE0004Shop")
    assert normalize_sku("  x  ") == "x"


def test_slow_season_aug_sep():
    assert is_slow_season(date(2026, 8, 25)) is True
    assert is_slow_season(date(2026, 9, 15)) is True
    assert is_slow_season(date(2026, 11, 1)) is False
    assert is_slow_season(date(2026, 6, 1)) is False


def test_normalized_baseline_ignores_aug_trough_v30():
    # Aug: V30 depressed vs V90 — max picks V90/summer, not trough V30
    base = normalized_baseline(25.0, v90=50.0, summer_prior_daily=38.0, today=date(2026, 8, 20))
    assert base == 50.0


def test_normalized_baseline_keeps_strong_v30():
    # Unscented-like: current V30 above V90 — keep it
    base = normalized_baseline(106.0, v90=77.0, summer_prior_daily=43.0, today=date(2026, 8, 20))
    assert base == 106.0


def test_planning_daily_non_surge_keeps_baseline():
    # Deodorant-like: holiday slower than summer — do not deflate
    plan = planning_daily(18, 11, 12, 0.9, v90=17, today=date(2026, 8, 25))
    assert plan >= 17.0


def test_planning_daily_assorted_not_understated_by_aug_v30():
    # Assorted: if Aug V30 is artificially low (25) but V90=52, summer=38, holiday=160
    # Must not anchor YoY to depressed 25.
    plan = planning_daily(
        25.0, 155.5, 34.3, 4.53, v90=51.59, today=date(2026, 8, 25),
    )
    # baseline ≈ 51.59; yoy ≈ 1.40 cap vs summer 34.3; anchored ≈ 217
    assert plan > 200
    assert plan > 25 * 4.53  # better than trough×surge alone would be if yoy floored


def test_planning_daily_yoy_cap():
    plan = planning_daily(80, 100, 20, 5.0, v90=80, today=date(2026, 4, 1))
    # baseline ≥ 80; yoy capped 1.40 → anchored 140; from_surge 400 → 400
    assert plan == 400.0


def test_amazon_cover_target_floor_60():
    assert amazon_cover_target(45, holiday_mode=False) == AMAZON_MIN_COVER_DAYS
    assert amazon_cover_target(60, holiday_mode=False) == 60
    assert amazon_cover_target(60, holiday_mode=True) == 90
    assert amazon_cover_target(120, holiday_mode=True) == 120


def test_holiday_demand_units():
    units = holiday_demand_units(155.5, 1.24, days=61)
    assert 11000 < units < 12500


def test_holiday_demand_zero_when_no_history():
    assert holiday_demand_units(0, 1.2, days=61) == 0
