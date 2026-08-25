"""Monthly SKU economics and the daily $0-sales guard.

Pure logic — no database, no API.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.pnl import is_unwritable_day
from src.pnl_monthly import compute_monthly_from_rows, money
from src.parsers.amazon_orders_skus import is_amazon_orders_report
from src.amazon_sp.reports import parse_orders_by_sku


def test_unwritable_day_is_units_without_sales():
    assert is_unwritable_day(0, 62) is True
    assert is_unwritable_day(0.0, 1) is True
    assert is_unwritable_day(907.38, 58) is False
    assert is_unwritable_day(0, 0) is False
    assert is_unwritable_day(100, 0) is False


def test_monthly_formula_matches_daily_constants():
    cfg = json.loads(
        (Path(__file__).resolve().parent.parent / "config" / "business_rules.json").read_text()
    )
    sku_rows = [
        {"channel": "amazon", "sku": "AA", "period_start": "2025-12-01",
         "units": 10, "gross_sales": 100.0, "product_title": "A"},
        {"channel": "amazon", "sku": "BB", "period_start": "2025-12-01",
         "units": 4, "gross_sales": 40.0},
        {"channel": "shopify", "sku": "AA", "period_start": "2025-12-01",
         "units": 99, "gross_sales": 999.0},
    ]
    costs = {"AA": 3.0, "BB": 5.0}
    result = compute_monthly_from_rows(
        sku_rows, costs, ads_by_month={}, ads_days_by_month={},
        referral_pct=cfg["pnl"]["default_referral_pct"],
        fba_per_unit=cfg["pnl"]["default_fba_fee_per_unit"],
    )
    assert result["month_count"] == 1
    month = result["months"][0]
    # AA: 100 - 15 - 35 - 30 = 20; BB: 40 - 6 - 14 - 20 = 0
    assert month["gross_sales"] == 140.0
    assert month["units"] == 14
    assert month["est_referral_fees"] == 21.0
    assert month["est_fba_fees"] == 49.0
    assert month["est_cogs"] == 50.0
    assert month["ad_spend"] == 0.0
    assert month["net_after_ads"] == 20.0
    assert month["meta"]["ads_basis"] == "unknown"
    assert month["meta"]["source"] == "sku_monthly"
    assert result["sku_row_count"] == 2


def test_ads_known_month_subtracts_spend():
    sku_rows = [
        {"channel": "amazon", "sku": "AA", "period_start": "2026-07-01",
         "units": 10, "gross_sales": 200.0},
    ]
    result = compute_monthly_from_rows(
        sku_rows, {"AA": 2.0},
        ads_by_month={"2026-07": 25.0},
        ads_days_by_month={"2026-07": 12},
        referral_pct=0.15,
        fba_per_unit=3.5,
    )
    month = result["months"][0]
    # 200 - 30 - 35 - 25 - 20 = 90
    assert month["ad_spend"] == 25.0
    assert month["net_after_ads"] == 90.0
    assert month["meta"]["ads_basis"] == "known"


def test_zero_ads_days_does_not_pretend_spend_is_known():
    sku_rows = [
        {"channel": "amazon", "sku": "AA", "period_start": "2025-01-01",
         "units": 1, "gross_sales": 20.0},
    ]
    result = compute_monthly_from_rows(
        sku_rows, {"AA": 1.0},
        ads_by_month={"2025-01": 999.0},
        ads_days_by_month={"2025-01": 0},
        referral_pct=0.15,
        fba_per_unit=3.5,
    )
    assert result["months"][0]["ad_spend"] == 0.0
    assert result["months"][0]["meta"]["ads_basis"] == "unknown"


def test_missing_cost_uses_average():
    sku_rows = [
        {"channel": "amazon", "sku": "priced", "period_start": "2024-08-01",
         "units": 1, "gross_sales": 10.0},
        {"channel": "amazon", "sku": "new", "period_start": "2024-08-01",
         "units": 2, "gross_sales": 20.0},
    ]
    result = compute_monthly_from_rows(
        sku_rows, {"priced": 4.0},
        ads_by_month={}, ads_days_by_month={},
        referral_pct=0.15, fba_per_unit=3.5,
    )
    new = next(r for r in result["skus"] if r["sku"] == "NEW")
    assert new["est_cogs"] == 8.0  # 2 × avg 4.00
    assert result["missing_cost_skus"] == ["NEW"]
    priced = next(r for r in result["skus"] if r["sku"] == "PRICED")
    assert priced["est_cogs"] == 4.0


def test_state_rows_collapse_to_one_sku_month():
    sku_rows = [
        {"channel": "amazon", "sku": "AA", "period_start": "2025-06-01",
         "units": 3, "gross_sales": 30.0, "state_code": "TX"},
        {"channel": "amazon", "sku": "aa", "period_start": "2025-06-01",
         "units": 2, "gross_sales": 20.0, "state_code": "CA"},
    ]
    result = compute_monthly_from_rows(
        sku_rows, {"AA": 1.0}, {}, {},
        referral_pct=0.15, fba_per_unit=3.5,
    )
    assert result["sku_row_count"] == 1
    assert result["skus"][0]["units"] == 5
    assert result["skus"][0]["gross_sales"] == 50.0


def test_money_rounds_to_cents():
    assert money(1.005) == 1.0 or money(1.005) == 1.01  # banker's or half-up
    assert money(10.126) == 10.13


def test_all_orders_headers_are_detected():
    assert is_amazon_orders_report(
        ["amazon-order-id", "order-status", "sku", "item-price", "purchase-date"]
    )
    assert is_amazon_orders_report(
        ["Amazon_Order_ID", "SKU", "Item Price", "Purchase Date"]
    )
    assert not is_amazon_orders_report(
        ["date-time", "fulfillment-center-id", "sku", "quantity"]
    )


def test_orders_csv_feeds_sales_by_sku_parser():
    report = (
        "amazon-order-id\torder-status\tship-country\tship-state"
        "\tsku\titem-price\tpurchase-date\tquantity\n"
        "111-1\tShipped\tUS\tIA\tDDPE0001SHOP\t12.00\t2024-03-15T18:00:00+00:00\t2\n"
        "111-2\tCancelled\tUS\tIA\tDDPE0001SHOP\t12.00\t2024-03-15T18:00:00+00:00\t2\n"
    )
    parsed = parse_orders_by_sku(report)
    assert parsed["rows_parsed"] == 1
    assert parsed["sku_rows"][0]["period_start"] == "2024-03-01"
    assert parsed["sku_rows"][0]["units"] == 2
    assert parsed["sku_rows"][0]["source"] == "amazon_spapi"
