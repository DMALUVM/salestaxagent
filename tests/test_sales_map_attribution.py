"""Sales-map feed QA: ship-to / destination, quarantine, additive Shopify.

Locks the ingest path the dashboard /sales-map reads (sales_by_state).
No map rebuild — attribution only.
"""
from datetime import date
from pathlib import Path

from src.amazon_sp.reports import (
    DEST_DAILY_CONFLICT,
    _dedupe_dest_daily_on_conflict,
    merge_dest_daily,
    parse_orders_report,
    rollup_dest_daily_to_month,
    upsert_amazon_destination_sales,
)
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
    daily = {(r["state_code"], r["sale_date"]): r["gross_sales"]
             for r in parsed["daily_records"]}
    assert daily[("CA", "2026-03-01")] == 10.0
    assert daily[("IA", "2026-03-02")] == 5.0
    assert all(r["source"] == "amazon_spapi" for r in parsed["daily_records"])
    assert all(r["channel"] == "amazon" for r in parsed["daily_records"])


def _day(state: str, sale_date: str, gross: float, orders: int = 1, **extra) -> dict:
    row = {
        "state_code": state,
        "channel": extra.get("channel", "amazon"),
        "sale_date": sale_date,
        "order_count": orders,
        "gross_sales": gross,
        "net_sales": extra.get("net_sales", gross),
        "tax_collected": extra.get("tax_collected", 0.0),
        "source": extra.get("source", "amazon_spapi"),
    }
    return row


def test_short_lookback_keeps_earlier_days_in_the_same_month():
    """A 7-day August pull must not drop Aug 1–20 already stored."""
    existing = [
        _day("CA", "2026-08-01", 1000.00, 10),
        _day("CA", "2026-08-15", 500.00, 5),
        _day("TX", "2026-08-10", 200.00, 2),
        _day("CA", "2026-07-31", 999.00, 9),
    ]
    incoming = [
        _day("CA", "2026-08-25", 80.00, 1),
        _day("TX", "2026-08-28", 40.00, 1),
    ]
    merged = merge_dest_daily(existing, incoming)
    by_day = {(r["state_code"], r["sale_date"]): r["gross_sales"] for r in merged}
    assert by_day[("CA", "2026-08-01")] == 1000.00
    assert by_day[("CA", "2026-08-15")] == 500.00
    assert by_day[("TX", "2026-08-10")] == 200.00
    assert by_day[("CA", "2026-08-25")] == 80.00
    assert by_day[("TX", "2026-08-28")] == 40.00

    monthly = rollup_dest_daily_to_month(merged)
    aug = {r["state_code"]: r for r in monthly if r["period_start"] == "2026-08-01"}
    assert aug["CA"]["gross_sales"] == 1580.00
    assert aug["TX"]["gross_sales"] == 240.00
    assert aug["CA"]["period_end"] == "2026-08-31"
    assert aug["CA"]["source"] == "amazon_spapi"
    assert aug["CA"]["channel"] == "amazon"


def test_current_month_total_grows_as_more_days_arrive():
    """Second lookback adds new days; month total grows, earlier days stay."""
    after_first = merge_dest_daily(
        [_day("CA", "2026-08-01", 1000.00, 10)],
        [_day("CA", "2026-08-20", 200.00, 2)],
    )
    first_month = rollup_dest_daily_to_month(after_first)
    assert first_month[0]["gross_sales"] == 1200.00

    after_second = merge_dest_daily(
        after_first,
        [_day("CA", "2026-08-28", 50.00, 1)],
    )
    second_month = rollup_dest_daily_to_month(after_second)
    assert second_month[0]["gross_sales"] == 1250.00
    days = {r["sale_date"] for r in after_second if r["state_code"] == "CA"}
    assert days == {"2026-08-01", "2026-08-20", "2026-08-28"}


def test_merge_ignores_shopify_and_quarantined_tax_dumps():
    existing = [
        _day("CA", "2026-08-01", 100.00, channel="shopify", source="shopify_api"),
        _day("CA", "2026-08-01", 50.00, source="amazon_custom_combined_tax"),
        _day("CA", "2026-08-01", 25.00, source="amazon_tax_report"),
        _day("CA", "2026-08-01", 10.00),
    ]
    incoming = [_day("CA", "2026-08-25", 5.00)]
    merged = merge_dest_daily(existing, incoming)
    assert all(r["channel"] == "amazon" for r in merged)
    assert all(r["source"] == "amazon_spapi" for r in merged)
    assert {r["sale_date"] for r in merged} == {"2026-08-01", "2026-08-25"}
    assert sum(r["gross_sales"] for r in merged) == 15.00


def test_short_lookback_does_not_write_closed_months(monkeypatch):
    """August incoming days must not rebuild or upsert July sales_by_state."""
    captured: dict = {"upserts": []}

    def fake_upsert(table, rows, on_conflict=None):
        captured["upserts"].append((table, list(rows), on_conflict))
        return len(rows)

    monkeypatch.setattr(
        "src.amazon_sp.reports.upsert_rows", fake_upsert,
    )
    existing = [
        _day("CA", "2026-07-15", 80000.00, 400),
        _day("CA", "2026-08-01", 1000.00, 10),
    ]
    incoming = [_day("CA", "2026-08-25", 80.00, 1)]
    result = upsert_amazon_destination_sales(
        incoming,
        date(2026, 8, 24),
        date(2026, 8, 31),
        existing_daily=existing,
    )
    assert result["months"] == ["2026-08-01"]
    assert len(result["monthly_rows"]) == 1
    assert result["monthly_rows"][0]["period_start"] == "2026-08-01"
    assert result["monthly_rows"][0]["gross_sales"] == 1080.00
    assert result["monthly_rows"][0]["source"] == "amazon_spapi"

    monthly_writes = [u for u in captured["upserts"] if u[0] == "sales_by_state"]
    assert monthly_writes
    written_starts = {r["period_start"] for r in monthly_writes[0][1]}
    assert written_starts == {"2026-08-01"}
    daily_writes = [u for u in captured["upserts"] if u[0] == "sales_by_state_daily"]
    assert daily_writes
    assert all(r["sale_date"].startswith("2026-08-") for r in daily_writes[0][1])
    assert all(r["channel"] == "amazon" for r in daily_writes[0][1])


def test_dest_daily_dedupe_last_write_wins():
    rows = [
        _day("CA", "2026-08-31", 80.00, 1),
        _day("CA", "2026-08-31", 90.00, 2),
        _day("TX", "2026-08-31", 40.00, 1),
    ]
    out = _dedupe_dest_daily_on_conflict(rows)
    assert len(out) == 2
    by_state = {r["state_code"]: r for r in out}
    assert by_state["CA"]["gross_sales"] == 90.00
    assert by_state["CA"]["order_count"] == 2
    assert by_state["TX"]["gross_sales"] == 40.00


def test_duplicate_orders_dest_daily_keys_upsert_once(monkeypatch):
    """Same-batch dest-daily keys must not hit Postgres 21000."""
    captured: dict = {"upserts": []}

    def fake_upsert(table, rows, on_conflict=None):
        captured["upserts"].append((table, list(rows), on_conflict))
        return len(rows)

    monkeypatch.setattr("src.amazon_sp.reports.upsert_rows", fake_upsert)
    incoming = [
        _day("CA", "2026-08-31", 80.00, 1),
        _day("CA", "2026-08-31", 90.00, 2),
        _day("TX", "2026-08-31", 40.00, 1),
    ]
    result = upsert_amazon_destination_sales(
        incoming,
        date(2026, 8, 1),
        date(2026, 8, 31),
        existing_daily=[],
    )
    daily_writes = [u for u in captured["upserts"] if u[0] == "sales_by_state_daily"]
    assert len(daily_writes) == 1
    daily_rows, conflict = daily_writes[0][1], daily_writes[0][2]
    assert conflict == DEST_DAILY_CONFLICT
    assert len(daily_rows) == 2
    ca = [r for r in daily_rows if r["state_code"] == "CA"]
    assert len(ca) == 1
    assert ca[0]["gross_sales"] == 90.00
    assert ca[0]["order_count"] == 2
    assert result["daily_upserted"] == 2
    monthly_writes = [u for u in captured["upserts"] if u[0] == "sales_by_state"]
    assert monthly_writes
    ca_month = [r for r in monthly_writes[0][1] if r["state_code"] == "CA"]
    assert len(ca_month) == 1
    assert ca_month[0]["gross_sales"] == 90.00
