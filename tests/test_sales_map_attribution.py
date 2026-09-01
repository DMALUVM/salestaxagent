"""Sales-map feed QA: ship-to / destination, quarantine, additive Shopify.

Locks the ingest path the dashboard /sales-map reads (sales_by_state).
No map rebuild — attribution only.
"""
from pathlib import Path

from src.amazon_sp.reports import parse_orders_report
from src.channels import SHOPIFY, SHOPIFY_SHOP, SHOPIFY_SUB, is_quarantined_source


def test_orders_parser_uses_ship_state_not_ship_from():
    src = Path("src/amazon_sp/reports.py").read_text()
    assert 'raw_state = _get(row, H, "ship-state")' in src
    assert "ship-from" not in src.split("def parse_orders_report")[1].split("def parse_orders_by_sku")[0]


def test_shopify_api_uses_shipping_address_province():
    src = Path("src/parsers/shopify_orders.py").read_text()
    assert 'order.get("shipping_address")' in src
    assert 'addr.get("province_code"' in src


def test_quarantined_sources_are_the_tax_dumps():
    assert is_quarantined_source("amazon_custom_combined_tax")
    assert is_quarantined_source("amazon_tax_report")
    assert not is_quarantined_source("amazon_spapi")
    assert not is_quarantined_source("shopify_api")


def test_shopify_channels_are_distinct_and_additive():
    assert SHOPIFY == "shopify"
    assert SHOPIFY_SHOP == "shopify_shop"
    assert SHOPIFY_SUB == "shopify_sub"


def test_sample_orders_report_buckets_destination():
    content = (
        "amazon-order-id\torder-status\tship-country\tship-state\t"
        "purchase-date\titem-price\titem-tax\tquantity\n"
        "111\tShipped\tUS\tCalifornia\t2026-03-01T12:00:00-08:00\t10.00\t0.80\t1\n"
        "222\tShipped\tUS\tIowa\t2026-03-02T12:00:00-08:00\t5.00\t0.00\t1\n"
    )
    parsed = parse_orders_report(content)
    states = {r.state_code: r.gross_sales for r in parsed["sales_records"]}
    assert states["CA"] == 10.0
    assert states["IA"] == 5.0
    assert parsed["ship_to_states"] == {"CA", "IA"}
