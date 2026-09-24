"""Shopify contribution — pure logic, no database, no API.

Amazon P&L is a separate channel. These tests pin the shipping + estimate
formula so a free-ship threshold decision uses real charged shipping and a
labelled outbound estimate, not an inferred residual.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.pnl_shopify import (
    CHANNEL,
    FORMULA,
    aggregate_shopify_days,
    estimate_outbound_ship,
    monthly_shopify_cogs,
)
from src.shopify_backfill import is_subscription_order, shipping_price_of


def _order(oid, d, subtotal, shipping=0.0, *, refund=0.0, sub=False,
           source="shipping_lines", test=False, cancelled=None, tax=0.0, total=None):
    tot = total if total is not None else subtotal + shipping + tax
    return {
        "order_id": oid, "order_date": d,
        "subtotal_price": subtotal, "shipping_price": shipping,
        "total_price": tot, "total_tax": tax,
        "refunded_amount": refund, "is_subscription": sub,
        "shipping_source": source, "is_test": test, "cancelled_at": cancelled,
    }


def test_shipping_lines_sum_is_preferred_over_residual():
    amt, src = shipping_price_of({
        "total_price": "50", "subtotal_price": "40", "total_tax": "3",
        "shipping_lines": [{"price": "5.00"}, {"price": "0.50"}],
    })
    assert amt == 5.50 and src == "shipping_lines"


def test_empty_shipping_lines_is_zero_charged_not_residual():
    amt, src = shipping_price_of({
        "total_price": "50", "subtotal_price": "40", "total_tax": "3",
        "shipping_lines": [],
    })
    assert amt == 0.0 and src == "shipping_lines"


def test_residual_only_when_shipping_lines_absent():
    amt, src = shipping_price_of({
        "total_price": "50", "subtotal_price": "40", "total_tax": "3",
    })
    assert amt == 7.0 and src == "provisional_residual"


def test_subscription_rule_covers_source_tags_and_selling_plan():
    assert is_subscription_order({"source_name": "subscription_contract"})
    assert is_subscription_order({"source_name": "web", "tags": "foo, Subscription"})
    assert is_subscription_order({
        "source_name": "web",
        "line_items": [{"selling_plan_allocation": {"selling_plan_id": 1}}],
    })
    assert not is_subscription_order({"source_name": "web", "tags": "gift"})


def test_contribution_is_merchandise_plus_ship_minus_outbound_minus_cogs_minus_ads():
    orders = [
        _order(1, "2026-09-01", 40.0, 5.0),
        _order(2, "2026-09-01", 20.0, 0.0, sub=True),
    ]
    monthly = {"2026-09": {"cogs": 30.0, "units": 6, "sales": 60.0}}
    rows = aggregate_shopify_days(
        orders, monthly, ad_spend_by_day={"2026-09-01": 4.25})
    assert len(rows) == 1
    r = rows[0]
    assert r["channel"] == CHANNEL
    assert r["grain"] == "account"
    # merchandise 60 + ship 5 = 65; units 6 known;
    # outbound 2×8.30 + 0.50×6 = 19.60; cogs 30; ads 4.25
    assert r["gross_sales"] == 65.0
    assert r["units"] == 6
    assert r["est_fba_fees"] == 19.60
    assert r["est_cogs"] == 30.0
    assert r["ad_spend"] == 4.25
    assert r["est_contribution"] == 11.15
    assert r["net_after_ads"] == 11.15
    meta = json.loads(r["meta"])
    assert meta["formula"] == FORMULA
    assert meta["shipping_charged"] == 5.0
    assert meta["subscription_orders"] == 1
    assert meta["one_time_orders"] == 1
    assert meta["outbound_basis"] == "tpl_apr_jun_2026"
    assert meta["outbound_units_known"] is True
    assert "Apr–Jun 2026" in meta["outbound_note"]
    assert "google_ads_daily" in meta["ad_spend_note"]
    assert "ads_campaigns_daily" in meta["ad_spend_note"]


def test_test_and_cancelled_orders_do_not_enter_contribution():
    orders = [
        _order(1, "2026-09-01", 40.0, 5.0),
        _order(2, "2026-09-01", 999.0, 9.0, test=True),
        _order(3, "2026-09-01", 999.0, 9.0, cancelled="2026-09-02T00:00:00Z"),
    ]
    rows = aggregate_shopify_days(orders, {})
    assert rows[0]["gross_sales"] == 45.0
    assert json.loads(rows[0]["meta"])["order_count"] == 1
    meta = json.loads(rows[0]["meta"])
    assert meta["outbound_basis"] == "tpl_flat_fallback"
    assert rows[0]["est_fba_fees"] == 9.90


def test_refunds_reduce_merchandise_and_never_go_negative():
    orders = [_order(1, "2026-09-01", 20.0, 5.0, refund=50.0)]
    rows = aggregate_shopify_days(orders, {})
    meta = json.loads(rows[0]["meta"])
    assert meta["merchandise"] == 0.0
    assert meta["shipping_charged"] == 5.0
    # units unknown → 9.90; 0 + 5 − 9.90 − 0 − 0 ads = −4.90
    assert rows[0]["est_contribution"] == -4.90


def test_cogs_allocates_by_day_share_of_month_merchandise():
    orders = [
        _order(1, "2026-09-01", 30.0, 0.0),
        _order(2, "2026-09-02", 10.0, 0.0),
    ]
    monthly = {"2026-09": {"cogs": 20.0, "units": 8, "sales": 40.0}}
    rows = {r["date"]: r for r in aggregate_shopify_days(orders, monthly)}
    assert rows["2026-09-01"]["est_cogs"] == 15.0   # 20 * 30/40
    assert rows["2026-09-02"]["est_cogs"] == 5.0    # 20 * 10/40


def test_missing_sku_costs_are_zero_not_inferred():
    sku_rows = [
        {"channel": "shopify", "sku": "KNOWN", "period_start": "2026-09-01",
         "units": 2, "gross_sales": 40},
        {"channel": "shopify", "sku": "NEW", "period_start": "2026-09-01",
         "units": 10, "gross_sales": 200},
        {"channel": "amazon", "sku": "KNOWN", "period_start": "2026-09-01",
         "units": 99, "gross_sales": 999},
    ]
    monthly, missing = monthly_shopify_cogs(sku_rows, {"KNOWN": 3.0})
    assert missing == {"NEW"}
    assert monthly["2026-09"]["cogs"] == 6.0
    assert "amazon" not in str(monthly).lower() or monthly["2026-09"]["cogs"] == 6.0


def test_pnl_api_keeps_amazon_and_shopify_on_separate_channels():
    api = Path("dashboard/src/app/api/pnl/route.ts").read_text()
    assert '.eq("channel", "amazon")' in api
    assert '.eq("channel", "shopify")' in api
    assert "Shopify is never folded" in api
    day = Path("dashboard/src/app/api/pnl/day/route.ts").read_text()
    assert '.eq("channel", "amazon")' in day


def test_compute_pnl_isolates_shopify_failures():
    src = Path("src/pnl.py").read_text()
    assert "_safe_shopify_pnl" in src
    assert "Amazon rows unchanged" in src


def test_amazon_channel_never_written_by_shopify_aggregator():
    rows = aggregate_shopify_days(
        [_order(1, "2026-09-01", 10.0, 0.0)], {})
    assert all(r["channel"] == "shopify" for r in rows)
    import inspect
    from src import pnl_shopify as m
    src = inspect.getsource(m.aggregate_shopify_days)
    assert 'channel": "amazon"' not in src
    assert "channel': 'amazon'" not in src
    assert "ads_campaigns_daily" not in src


def test_outbound_formula_matches_apr_jun_invoice_fit():
    # 337 orders × 8.30 + 0.50 × 1,040 units = 3,317.10
    amount, basis = estimate_outbound_ship(337, 1040, units_known=True)
    assert basis == "tpl_apr_jun_2026"
    assert amount == 3317.10
    one, _ = estimate_outbound_ship(1, 1, units_known=True)
    assert one == 8.80
    flat, flat_basis = estimate_outbound_ship(10, None, units_known=False)
    assert flat_basis == "tpl_flat_fallback"
    assert flat == 99.00
    assert estimate_outbound_ship(0, 5, units_known=True) == (0.0, "none")


def test_missing_ad_days_are_zero_and_not_filled_from_neighbors():
    orders = [
        _order(1, "2026-08-01", 20.0, 0.0),
        _order(2, "2026-09-14", 20.0, 0.0),
    ]
    rows = {r["date"]: r for r in aggregate_shopify_days(
        orders, {},
        ad_spend_by_day={"2026-09-14": 12.5, "2026-09-15": 9.0},
    )}
    assert rows["2026-08-01"]["ad_spend"] == 0.0
    assert rows["2026-09-14"]["ad_spend"] == 12.5
    assert "2026-09-15" not in rows


def test_pnl_route_loads_google_and_meta_without_amazon_campaigns():
    api = Path("dashboard/src/app/api/pnl/route.ts").read_text()
    assert "google_ads_daily" in api
    assert "meta_ads_daily" in api
    assert "applyShopifyProfitAdjustments" in api
    assert 'from("ads_campaigns_daily")' in api
    # Amazon monthly ads stay on the campaign table. The Shopify loader
    # is a separate function and does not append into adsByDay.
    assert "loadChannelAdSpend" in api
