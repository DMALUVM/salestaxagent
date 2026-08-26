"""Tests for measured vs configured effective lead times."""
from __future__ import annotations

from src.inventory.leadtime_effective import (
    effective_awd_to_fba_days,
    effective_fba_receive_days,
    effective_reorder_lead_days,
)


def test_effective_fba_prefers_measured_sku():
    settings = {"lead_time_days": 35, "receiving_days_normal": 14}
    signals = {"SKU1": {"measured_receive_days": 19}}
    assert effective_fba_receive_days("SKU1", settings, signals, planning=False) == 19


def test_effective_fba_falls_back_to_settings():
    settings = {"lead_time_days": 35, "receiving_days_normal": 14}
    assert effective_fba_receive_days("SKU1", settings, {}, planning=False) == 14


def test_effective_awd_prefers_measured():
    settings = {"awd_to_fba_days": 14}
    signals = {"SKU1": {"measured_replenish_days": 18}}
    assert effective_awd_to_fba_days("SKU1", settings, signals, planning=False) == 18


def test_reorder_lead_uses_awd_when_awd_dominates():
    settings = {"lead_time_days": 35, "receiving_days_normal": 14, "awd_to_fba_days": 14}
    signals = {
        "SKU1": {
            "measured_receive_days": 19,
            "measured_replenish_days": 22,
            "planning_receive_days": 19,
            "planning_replenish_days": 22,
        },
    }
    # FBA thin, AWD heavy → max(19, 22) = 22
    assert effective_reorder_lead_days(
        "SKU1", settings, signals, awd_on_hand=500, fba_on_hand=100, inbound=50,
    ) == 22


def test_reorder_lead_fba_only_when_fba_dominates():
    settings = {"lead_time_days": 35, "receiving_days_normal": 14, "awd_to_fba_days": 14}
    signals = {
        "SKU1": {
            "measured_receive_days": 19,
            "measured_replenish_days": 22,
            "planning_receive_days": 19,
            "planning_replenish_days": 22,
        },
    }
    assert effective_reorder_lead_days(
        "SKU1", settings, signals, awd_on_hand=50, fba_on_hand=500, inbound=100,
    ) == 19


def test_effective_fba_prefers_planning_field():
    settings = {"lead_time_days": 35, "receiving_days_normal": 14}
    signals = {"SKU1": {"measured_receive_days": 20, "planning_receive_days": 25}}
    assert effective_fba_receive_days("SKU1", settings, signals) == 25
