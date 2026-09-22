"""Paid-ads CSV freshness nudge.

The nudge exists so a stale export is noticed without opening the dashboard.
Two things must hold: it fires only when a source that IS in use has gone
quiet, and it never nags about a channel that was never uploaded at all.
"""
from datetime import date

from src.alerts.paid_ads_freshness import (
    GSC_API_FILE,
    META_API_FILE,
    GSC_STALE_BEHIND_PRIOR_DAY,
    STALE_AFTER_DAYS,
    _days_behind,
    _max_date,
    build_message,
    check_paid_ads_freshness,
    gsc_freshness_source,
    gsc_stale_vs_prior,
    meta_freshness_source,
)


def _source(label, max_date, days_behind, stale, missing=False):
    return {
        "label": label,
        "file": f"{label} export",
        "max_date": max_date,
        "days_behind": days_behind,
        "stale": stale,
        "missing": missing,
    }


def test_stale_threshold_matches_the_dashboard():
    # dashboard/src/lib/paid-intel/window.ts STALE_AFTER_DAYS
    assert STALE_AFTER_DAYS == 7


def test_days_behind_counts_calendar_days():
    assert _days_behind("2026-08-24", date(2026, 8, 24)) == 0
    assert _days_behind("2026-08-24", date(2026, 8, 31)) == 7
    assert _days_behind("2026-08-24", date(2026, 9, 2)) == 9
    assert _days_behind("not-a-date", date(2026, 9, 2)) is None


def test_no_message_when_every_source_is_current():
    sources = [
        _source("Google Ads", "2026-08-24", 0, False),
        _source("Meta Ads", "2026-08-24", 0, False),
    ]
    assert build_message({"sources": sources, "stale": []}) is None


def test_message_names_the_file_to_re_export():
    stale = _source("Google Ads", "2026-08-24", 9, True)
    fresh = _source("Meta Ads", "2026-09-01", 1, False)
    msg = build_message({"sources": [stale, fresh], "stale": [stale]})
    assert msg is not None
    assert "Google Ads" in msg
    assert "9d old" in msg
    assert "Google Ads export" in msg, "must say which file to pull"
    # A current source is context, not an action item.
    assert "Current: Meta Ads 2026-09-01" in msg


def test_never_uploaded_source_is_not_nagged_about():
    """A channel that was never uploaded is absent, not stale."""
    absent = _source("GA4", None, None, False, missing=True)
    stale = _source("Google Ads", "2026-08-24", 9, True)
    msg = build_message({"sources": [absent, stale], "stale": [stale]})
    assert msg is not None
    assert "GA4" not in msg


def test_gsc_stale_allows_two_day_lag_plus_buffer():
    """Prior NY day minus 2d lag is current; >4d behind prior day is a fault."""
    assert GSC_STALE_BEHIND_PRIOR_DAY == 4
    prior = date(2026, 9, 21)
    assert gsc_stale_vs_prior("2026-09-19", prior) is False
    assert gsc_stale_vs_prior("2026-09-17", prior) is False
    assert gsc_stale_vs_prior("2026-09-16", prior) is True
    assert gsc_stale_vs_prior(None, prior) is False


def test_gsc_prefers_api_tables_and_does_not_ask_for_csv():
    today = date(2026, 9, 22)
    api = gsc_freshness_source(today, api_max="2026-09-19", csv_max="2026-08-01")
    assert api["origin"] == "api"
    assert api["stale"] is False
    assert api["file"] == GSC_API_FILE
    stale = gsc_freshness_source(today, api_max="2026-09-14", csv_max=None)
    assert stale["stale"] is True
    msg = build_message({"sources": [stale], "stale": [stale]})
    assert msg is not None
    assert "gsc-sync" in msg
    assert "Queries.csv" not in msg
    assert "Not an all-good ping" in msg


class _FakeQuery:
    def __init__(self, rows, calls):
        self._rows = rows
        self._calls = calls

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def neq(self, col, val):
        self._calls.setdefault("neq", []).append((col, val))
        return self

    def order(self, *a, **k):
        return self

    def limit(self, n):
        return self

    def execute(self):
        return type("R", (), {"data": self._rows})()


def test_max_date_returns_api_metric_date_without_empty_string_filter(monkeypatch):
    """PostgREST rejects neq(metric_date, '') on a date column. Must still return max."""
    calls = {}
    rows = [{"metric_date": "2026-09-19"}]

    class Client:
        def table(self, name):
            calls["table"] = name
            return _FakeQuery(rows, calls)

    monkeypatch.setattr("src.alerts.paid_ads_freshness.get_client", lambda: Client())
    assert _max_date("gsc_query_daily", date_col="metric_date") == "2026-09-19"
    assert calls.get("neq") in (None, [])
    assert calls["table"] == "gsc_query_daily"


def test_max_date_csv_text_date_still_skips_blank_rows(monkeypatch):
    calls = {}
    rows = [{"date": "2026-09-12"}]

    class Client:
        def table(self, name):
            return _FakeQuery(rows, calls)

    monkeypatch.setattr("src.alerts.paid_ads_freshness.get_client", lambda: Client())
    assert _max_date("paid_search_query_daily", {"kind": "chart"}) == "2026-09-12"
    assert calls.get("neq") == [("date", "")]


def test_check_uses_api_metric_date_not_csv_fallback(monkeypatch):
    def fake_max(table, filters=None, date_col="date"):
        if date_col == "metric_date" and table == "gsc_query_daily":
            return "2026-09-19"
        if date_col == "metric_date" and table == "gsc_page_daily":
            return "2026-09-18"
        if table == "paid_search_query_daily":
            return "2026-08-01"
        return None

    monkeypatch.setattr("src.alerts.paid_ads_freshness._max_date", fake_max)
    result = check_paid_ads_freshness(date(2026, 9, 22))
    gsc = next(s for s in result["sources"] if s["label"] == "Search Console")
    assert gsc["origin"] == "api"
    assert gsc["max_date"] == "2026-09-19"
    assert gsc["stale"] is False


def test_meta_prefers_api_tables_and_does_not_ask_for_csv():
    today = date(2026, 9, 22)
    api = meta_freshness_source(today, api_max="2026-09-21", csv_max="2026-08-01")
    assert api["origin"] == "api"
    assert api["stale"] is False
    assert api["file"] == META_API_FILE
    stale = meta_freshness_source(today, api_max="2026-09-10", csv_max=None)
    assert stale["stale"] is True
    msg = build_message({"sources": [stale], "stale": [stale]})
    assert msg is not None
    assert "meta-ads-sync" in msg
    assert "Ads Manager campaign export" not in msg
    assert "Not an all-good ping" in msg


def test_gsc_csv_fallback_only_when_api_empty():
    today = date(2026, 9, 22)
    csv = gsc_freshness_source(today, api_max=None, csv_max="2026-09-20")
    assert csv["origin"] == "csv"
    assert csv["stale"] is False
    absent = gsc_freshness_source(today, api_max=None, csv_max=None)
    assert absent["missing"] is True
    assert absent["stale"] is False


def test_worst_offender_is_listed_first():
    a = _source("Google Ads", "2026-08-20", 13, True)
    b = _source("Meta Ads", "2026-08-24", 9, True)
    msg = build_message({"sources": [b, a], "stale": [b, a]})
    assert msg.index("Google Ads") < msg.index("Meta Ads")
