"""Paid-ads CSV freshness nudge.

The nudge exists so a stale export is noticed without opening the dashboard.
Two things must hold: it fires only when a source that IS in use has gone
quiet, and it never nags about a channel that was never uploaded at all.
"""
from datetime import date

from src.alerts.paid_ads_freshness import (
    STALE_AFTER_DAYS,
    _days_behind,
    build_message,
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


def test_worst_offender_is_listed_first():
    a = _source("Google Ads", "2026-08-20", 13, True)
    b = _source("Meta Ads", "2026-08-24", 9, True)
    msg = build_message({"sources": [b, a], "stale": [b, a]})
    assert msg.index("Google Ads") < msg.index("Meta Ads")
