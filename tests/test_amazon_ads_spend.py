"""SKU Economics / Ads Console spend import — parse only."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.parsers.amazon_ads_spend import (
    SOURCE_SKU_ECON,
    detect_ads_spend_report,
    is_ads_console_campaign_report,
    is_sku_economics_report,
    parse_ads_console_daily,
    parse_sku_economics_monthly,
)


SKU_ECON = [
    "Start Date", "End Date", "MSKU", "Child ASIN",
    "Ordered Product Sales", "Sponsored Products Ad Fee",
    "Sponsored Brands Ad Fee",
]
CONSOLE = ["Date", "Campaign Name", "Campaign ID", "Spend", "Clicks"]


def test_detects_sku_economics_and_console():
    assert is_sku_economics_report(SKU_ECON)
    assert detect_ads_spend_report(SKU_ECON) == "sku_economics"
    assert is_ads_console_campaign_report(CONSOLE)
    assert detect_ads_spend_report(CONSOLE) == "ads_console"
    assert detect_ads_spend_report(["amazon-order-id", "sku", "item-price"]) is None


def test_sku_economics_sums_ad_fees_by_month():
    rows = [
        ["2025-04-01", "2025-04-30", "AA", "B1", "100", "10.00", "2.50"],
        ["2025-04-01", "2025-04-30", "BB", "B2", "80", "5", "0"],
        ["2025-03-01", "2025-03-31", "AA", "B1", "90", "$1,200.10", ""],
    ]
    parsed = parse_sku_economics_monthly(SKU_ECON, rows)
    by_start = {m["period_start"]: m for m in parsed["months"]}
    assert by_start["2025-04-01"]["spend"] == 17.50
    assert by_start["2025-03-01"]["spend"] == 1200.10
    assert parsed["warnings"] == []


def test_sku_economics_refuses_multi_month_lump():
    rows = [["2024-08-01", "2025-07-31", "AA", "B1", "999", "5000", "0"]]
    parsed = parse_sku_economics_monthly(SKU_ECON, rows)
    assert parsed["months"] == []
    assert parsed["warnings"]
    assert "Monthly" in parsed["warnings"][0]


def test_real_sku_economics_april_2026_headers():
    """Seller Central uses 'Sponsored Products charge total', not Ad Fee."""
    headers = (
        "Amazon store,Start date,End date,Parent ASIN,ASIN,FNSKU,MSKU,"
        "Currency code,Average sales price,Units sold,Sales,Net sales,"
        "Sponsored Products charge per unit,"
        "Sponsored Products charge quantity,"
        "Sponsored Products charge total,Net proceeds total"
    ).split(",")
    assert is_sku_economics_report(headers)
    rows = [
        ["US", "04/01/2026", "04/30/2026", "B0", "B0", "", "AA",
         "USD", "10", "2", "20", "20", "1.5", "10", "818.26", "100"],
        ["US", "04/01/2026", "04/30/2026", "B0", "B0", "", "BB",
         "USD", "10", "1", "10", "10", "1.4", "5", "3443.43", "50"],
    ]
    parsed = parse_sku_economics_monthly(headers, rows)
    assert parsed["months"][0]["period_start"] == "2026-04-01"
    assert parsed["months"][0]["spend"] == 4261.69


def test_seed_roundtrip_fields(tmp_path, monkeypatch):
    import src.parsers.amazon_ads_spend as mod
    seed = tmp_path / "seed.csv"
    seed.write_text(
        "period_start,period_end,spend,source,filename\n"
        "2026-03-01,2026-03-31,22413.30,sku_economics,March.csv\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(mod, "SEED_PATH", seed)
    mod.merge_ads_monthly_seed([{
        "period_start": "2026-05-01",
        "period_end": "2026-05-31",
        "spend": 100.0,
        "source": SOURCE_SKU_ECON,
        "filename": "test.csv",
    }])
    rows = mod._read_seed_rows()
    assert len(rows) == 2
    dry = mod.restore_ads_monthly_from_seed(dry_run=True)
    assert dry["rows"] == 2


def test_ads_console_daily_groups_to_month():
    rows = [
        ["2025-01-02", "SP - Lip", "111", "12.00", "4"],
        ["2025-01-03", "SP - Lip", "111", "8.50", "2"],
        ["2024-12-31", "SB - Brand", "222", "40", "1"],
    ]
    parsed = parse_ads_console_daily(CONSOLE, rows)
    assert parsed["rows_parsed"] == 3
    by_start = {m["period_start"]: m["spend"] for m in parsed["months"]}
    assert by_start["2025-01-01"] == 20.50
    assert by_start["2024-12-01"] == 40.0
    assert all(r["campaign_type"] == "IMPORT" for r in parsed["daily"])
