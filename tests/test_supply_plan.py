"""Tests for four-number supply plan."""
from __future__ import annotations

from src.inventory.supply_plan import (
    PRODUCTION_LEAD_DAYS,
    production_lead_days,
    sku_product_line,
    build_four_numbers_plan,
)


def test_sku_product_line_lip():
    assert sku_product_line("DDPE0004Shop", "Lip Balm") == "lip"
    assert production_lead_days("lip") == PRODUCTION_LEAD_DAYS["lip"]


def test_sku_product_line_deodorant():
    assert sku_product_line("SKU1", "Tallow Deodorant") == "deodorant"
    assert production_lead_days("deodorant") == 70


def test_sku_product_line_balm():
    assert sku_product_line("SKU2", "Tallow Balm Face") == "balm"


def test_build_four_numbers_smoke():
    try:
        plan = build_four_numbers_plan(skus=["DDPE0001Shop"])
        assert "sku_rows" in plan
        assert "total_manufacture" in plan
        assert plan["receiving_days"] >= 14
    except RuntimeError as e:
        if "SUPABASE" not in str(e):
            raise
    except Exception as e:
        if "fetch" not in str(e).lower() and "connection" not in str(e).lower():
            raise
