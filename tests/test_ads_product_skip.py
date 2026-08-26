"""Skip already-loaded SP/SB/SD chunks; always re-pull the restated days."""
from datetime import date

from src.amazon_ads.reports import chunk_needs_fetch, fetch_campaigns_daily


def test_chunk_needs_fetch_skips_complete_old_days():
    loaded = {date(2026, 8, 20), date(2026, 8, 21)}
    as_of = date(2026, 8, 25)
    assert chunk_needs_fetch(date(2026, 8, 20), date(2026, 8, 21), loaded, as_of) is False


def test_chunk_needs_fetch_always_repulls_restated_days():
    loaded = {date(2026, 8, 24), date(2026, 8, 25)}
    as_of = date(2026, 8, 25)
    assert chunk_needs_fetch(date(2026, 8, 24), date(2026, 8, 24), loaded, as_of) is True
    assert chunk_needs_fetch(date(2026, 8, 25), date(2026, 8, 25), loaded, as_of) is True


def test_chunk_needs_fetch_missing_day():
    loaded = {date(2026, 8, 20)}
    as_of = date(2026, 8, 25)
    assert chunk_needs_fetch(date(2026, 8, 20), date(2026, 8, 21), loaded, as_of) is True


def test_fetch_skips_loaded_sb_days(monkeypatch):
    import src.amazon_ads.reports as reports

    calls: list[tuple[str, date, date]] = []

    def fake_chunk(cs, ce, product="SP"):
        calls.append((product, cs, ce))
        return [{"date": ce.isoformat(), "campaignId": f"{product}-1",
                 "campaignName": product, "impressions": 1, "clicks": 1,
                 "spend": 1.0}]

    # SB already has Aug 24–28; as_of is Aug 30 so restated = 29–30.
    loaded = {
        "SP": set(),
        "SB": {date(2026, 8, d) for d in range(24, 29)},
        "SD": set(),
    }

    monkeypatch.setattr(reports, "_fetch_campaigns_chunk", fake_chunk)
    monkeypatch.setattr(reports, "upsert_rows", lambda *a, **k: 1)
    monkeypatch.setattr(
        reports, "loaded_product_dates",
        lambda product, start, end: loaded.get(product, set()),
    )

    fetch_campaigns_daily(
        date(2026, 8, 1), date(2026, 8, 30), sb_sd_days=7)
    sb = [(cs, ce) for product, cs, ce in calls if product == "SB"]
    assert [(cs, ce) for cs, ce in sb] == [
        (date(2026, 8, 30), date(2026, 8, 30)),
        (date(2026, 8, 29), date(2026, 8, 29)),
    ]
    sd = [(cs, ce) for product, cs, ce in calls if product == "SD"]
    assert len(sd) == 7


def test_reporting_headers_use_report_media_types(monkeypatch):
    import src.amazon_ads.auth as auth
    monkeypatch.setattr(auth, "get_access_token", lambda force_refresh=False: "tok")
    h = auth.ads_headers(reporting=True)
    assert "createasyncreportrequest" in h["Content-Type"]
    assert "createasyncreportresponse" in h["Accept"]
    assert "spCampaign" not in h["Accept"]
