"""Ads heal — detect SP-only days and plan SB/SD backfill."""
from datetime import date

from src.amazon_ads.heal import heal_window, missing_product_days


def test_flags_sp_only_days_when_sb_exists_elsewhere():
    rows = [
        {"date": "2026-08-22", "campaign_type": "SP"},
        {"date": "2026-08-22", "campaign_type": "SB"},
        {"date": "2026-08-22", "campaign_type": "SD"},
        {"date": "2026-08-23", "campaign_type": "SP"},
        {"date": "2026-08-24", "campaign_type": "SP"},
    ]
    missing = missing_product_days(
        rows, as_of=date(2026, 8, 24), lookback_days=3)
    assert missing["SB"] == [date(2026, 8, 23), date(2026, 8, 24)]
    assert missing["SD"] == [date(2026, 8, 23), date(2026, 8, 24)]
    assert heal_window(missing) == (date(2026, 8, 23), date(2026, 8, 24))


def test_no_gaps_when_all_products_present():
    rows = [
        {"date": "2026-08-23", "campaign_type": "SP"},
        {"date": "2026-08-23", "campaign_type": "SB"},
        {"date": "2026-08-23", "campaign_type": "SD"},
    ]
    missing = missing_product_days(
        rows, as_of=date(2026, 8, 23), lookback_days=1)
    assert missing == {}
    assert heal_window(missing) is None


def test_skips_empty_calendar_days():
    """A day with no campaign rows at all is not a heal target."""
    rows = [
        {"date": "2026-08-22", "campaign_type": "SP"},
        {"date": "2026-08-22", "campaign_type": "SB"},
        # 23 missing entirely
        {"date": "2026-08-24", "campaign_type": "SP"},
        {"date": "2026-08-24", "campaign_type": "SB"},
    ]
    missing = missing_product_days(
        rows, as_of=date(2026, 8, 24), lookback_days=3, required=("SB",))
    assert missing == {}
