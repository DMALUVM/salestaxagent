"""Tests for warehouse → Amazon inbound wave planner."""
from __future__ import annotations

from datetime import date, timedelta

from src.inventory.inbound_waves import (
    _weekly_demand,
    build_inbound_wave_plan,
    DEFAULT_RECEIVING_DAYS,
)


def test_weekly_demand_uses_seasonality_not_peak_in_august():
    season = {40: 1.0, 49: 3.0}
    cursor = date(2026, 8, 25)
    week_end = cursor + timedelta(days=6)
    demand = _weekly_demand(40.0, cursor, week_end, season, [])
  # ~40 u/d × 7, not peak ×3
    assert 250 < demand < 350


def test_build_inbound_plan_structure_without_db():
    """Smoke test when DB unavailable — should not raise on empty data paths."""
    try:
        plan = build_inbound_wave_plan(skus=["DDPE0001Shop"])
        assert "sku_plans" in plan
        assert "receiving_days" in plan
        assert plan["receiving_days"] >= 14
    except RuntimeError as e:
        if "SUPABASE" not in str(e):
            raise
    except Exception as e:
        if "fetch" not in str(e).lower() and "connection" not in str(e).lower():
            raise


def test_default_receiving_days_in_2_3_week_range():
    assert 14 <= DEFAULT_RECEIVING_DAYS <= 21


def test_inbound_pipeline_reduces_urgent_ship():
    from src.inventory.inbound_waves import (
        _forward_phased_avg_daily,
        _pipeline_receipts_ahead,
        _week_list,
    )
    from collections import defaultdict

    today = date.today()
    end = date(2027, 1, 15)
    weeks = _week_list(today, end)
    season = {35: 1.0}
    scheduled: dict[int, int] = defaultdict(int)
    scheduled[1] = 270
    pipeline = _pipeline_receipts_ahead(scheduled, 0, weeks, 18)
    assert pipeline == 270

    avg = _forward_phased_avg_daily(
        weeks[0], end, 18.2, 60, season, [],
    )
    effective = 730 + pipeline
    cover = effective / avg
    assert cover > 50  # inbound + FBA gives ~55d+ cover at trough rate
