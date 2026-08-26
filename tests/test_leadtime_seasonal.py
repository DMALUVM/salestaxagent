"""Seasonal inbound lead-time priors and blending."""
from __future__ import annotations

from datetime import date

from src.inventory.leadtime_seasonal import (
    apply_factor,
    calendar_prior,
    lookahead_factor,
    month_factor,
    monthly_stats_from_rows,
    observed_from_rows,
    percentile_inclusive,
    window_label,
    build_seasonal_snapshot,
)


def test_calendar_prior_late_q3_q4():
    assert calendar_prior(date(2026, 6, 15)) == 1.0
    assert calendar_prior(date(2026, 8, 26)) == 1.10
    assert calendar_prior(date(2026, 9, 1)) == 1.25
    assert calendar_prior(date(2026, 11, 15)) == 1.50
    assert calendar_prior(date(2026, 12, 20)) == 1.55
    assert calendar_prior(date(2027, 1, 10)) == 1.15
    assert calendar_prior(date(2027, 1, 16)) == 1.0


def test_lookahead_picks_up_september_from_late_august():
    factor = lookahead_factor(date(2026, 8, 26), [], None)
    assert factor == 1.25  # Sep is inside the 30-day inbound window


def test_november_lookahead_is_peak():
    factor = lookahead_factor(date(2026, 11, 1), [], None)
    assert factor == 1.55
    assert window_label(factor) == "peak"


def test_percentile_drops_stale_and_noise():
    assert percentile_inclusive([1, 2, 3, 230], 0.75) is None
    assert percentile_inclusive([4, 5, 6, 11, 12], 0.75) == 11


def test_apply_factor_caps_at_peak_setting():
    assert apply_factor(20, 1.25, cap=35) == 25
    assert apply_factor(20, 1.55, cap=35) == 31
    assert apply_factor(20, 2.0, cap=35) == 35


def test_month_factor_blends_last_year_when_present():
    monthly = [
        {
            "year_month": "2025-11",
            "inbound_n": 4,
            "replenish_n": 4,
            "recv_p75": 30,
        },
        {
            "year_month": "2026-04",
            "inbound_n": 4,
            "replenish_n": 4,
            "recv_p75": 16,
        },
    ]
    # offpeak 16, last Nov 30 → measured 1.875, blended toward 1.50 prior
    factor = month_factor(date(2026, 11, 1), monthly, 16)
    assert 1.50 < factor < 1.80


def test_snapshot_never_plans_shorter_than_observed():
    inbound = [
        {
            "shipment_status": "CLOSED",
            "created_at": "2026-04-01T00:00:00Z",
            "closed_at": "2026-04-06T00:00:00Z",
        },
        {
            "shipment_status": "CLOSED",
            "created_at": "2026-08-01T00:00:00Z",
            "closed_at": "2026-08-12T00:00:00Z",
        },
    ]
    replen = [
        {
            "order_status": "SUCCESS",
            "created_at": "2026-04-01T00:00:00Z",
            "completed_at": "2026-04-11T00:00:00Z",
        },
        {
            "order_status": "SUCCESS",
            "created_at": "2026-08-01T00:00:00Z",
            "completed_at": "2026-08-13T00:00:00Z",
        },
    ]
    snap = build_seasonal_snapshot(
        settings={"receiving_days_peak": 35},
        today=date(2026, 8, 26),
        inbound_rows=inbound,
        replen_rows=replen,
        monthly=[],
    )
    assert snap["observed_receive_days"] is not None
    assert snap["planning_receive_days"] >= snap["observed_receive_days"]
    assert snap["factor"] == 1.25
    assert snap["yoy_available"] is False


def test_monthly_stats_ignore_230_day_stale():
    inbound = [
        {
            "shipment_status": "CLOSED",
            "created_at": "2025-12-03T00:00:00Z",
            "closed_at": "2026-07-21T00:00:00Z",
        },
        {
            "shipment_status": "CLOSED",
            "created_at": "2026-08-01T00:00:00Z",
            "closed_at": "2026-08-12T00:00:00Z",
        },
    ]
    rows = monthly_stats_from_rows(inbound, [])
    dec = [r for r in rows if r["year_month"] == "2025-12"]
    assert dec == [] or dec[0]["inbound_n"] == 0
    aug = next(r for r in rows if r["year_month"] == "2026-08")
    assert aug["inbound_p75"] == 11


def test_observed_matches_dashboard_p75_sum():
    inbound = [
        {"shipment_status": "CLOSED", "created_at": "2026-07-01T00:00:00Z",
         "closed_at": "2026-07-06T00:00:00Z"},
        {"shipment_status": "CLOSED", "created_at": "2026-07-08T00:00:00Z",
         "closed_at": "2026-07-14T00:00:00Z"},
        {"shipment_status": "CLOSED", "created_at": "2026-07-15T00:00:00Z",
         "closed_at": "2026-07-23T00:00:00Z"},
        {"shipment_status": "CLOSED", "created_at": "2026-08-01T00:00:00Z",
         "closed_at": "2026-08-12T00:00:00Z"},
        {"shipment_status": "CLOSED", "created_at": "2026-08-02T00:00:00Z",
         "closed_at": "2026-08-14T00:00:00Z"},
    ]
    replen = [
        {"order_status": "SUCCESS", "created_at": "2026-07-01T00:00:00Z",
         "completed_at": "2026-07-09T00:00:00Z"},
        {"order_status": "SUCCESS", "created_at": "2026-07-10T00:00:00Z",
         "completed_at": "2026-07-19T00:00:00Z"},
        {"order_status": "SUCCESS", "created_at": "2026-07-20T00:00:00Z",
         "completed_at": "2026-07-30T00:00:00Z"},
        {"order_status": "SUCCESS", "created_at": "2026-08-01T00:00:00Z",
         "completed_at": "2026-08-13T00:00:00Z"},
        {"order_status": "SUCCESS", "created_at": "2026-08-02T00:00:00Z",
         "completed_at": "2026-08-15T00:00:00Z"},
    ]
    obs = observed_from_rows(inbound, replen)
    assert obs["inbound_days"] == 11
    assert obs["awd_to_fba_days"] == 12
    assert obs["receive_days"] == 23
