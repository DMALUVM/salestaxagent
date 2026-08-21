"""Daily sales totals must never shrink on a re-pull.

The live failure this pins: 2026-08-13 held $3,073.53 / 198 orders, then a run
that saw only ~7 hours of that day wrote $1,066.29 / 67 orders straight over it.
Neighbouring days were untouched and correct, and `updated_at` had no trigger,
so nothing recorded that it had happened. Fixing the date by hand left the
mechanism intact, so the same day regressed on the next incomplete pull.
"""
from datetime import date

import pytest

from src.sales_guard import (
    TOLERANCE_ABS, TOLERANCE_PCT, guard_rows, is_shrink,
)

TODAY = date(2026, 8, 21)


def row(day="2026-08-13", channel="amazon", gross=3073.53, orders=198):
    return {"sale_date": day, "channel": channel,
            "gross_sales": gross, "order_count": orders, "source": "amazon_spapi"}


class TestPartialRepullCannotShrinkADay:
    def test_the_live_2026_08_13_regression(self):
        """Full day stored, then a ~7-hour partial re-pull arrives."""
        existing = [row()]
        partial = [row(gross=1066.29, orders=67)]
        res = guard_rows(partial, existing, TODAY)
        assert res.to_write == []
        assert res.blocked_days == ["2026-08-13"]
        assert "REFUSED" in res.reasons[0]

    def test_totals_do_not_fall_across_two_syncs(self):
        """Full write, then partial re-pull — the sequence from the report."""
        stored: list[dict] = []
        full = guard_rows([row()], stored, TODAY)
        stored = full.to_write
        assert stored[0]["gross_sales"] == 3073.53

        partial = guard_rows([row(gross=1066.29, orders=67)], stored, TODAY)
        surviving = {r["sale_date"]: r for r in stored}
        for r in partial.to_write:
            surviving[r["sale_date"]] = r
        assert surviving["2026-08-13"]["gross_sales"] == 3073.53

    def test_a_run_missing_the_day_entirely_changes_nothing(self):
        """Absence is not a zero — a day not in the pull is simply untouched."""
        existing = [row()]
        res = guard_rows([], existing, TODAY)
        assert res.to_write == [] and res.blocked == []

    def test_zero_gross_never_overwrites_a_real_day(self):
        res = guard_rows([row(gross=0.0, orders=0)], [row()], TODAY)
        assert res.to_write == []

    def test_each_channel_is_guarded_independently(self):
        existing = [row(channel="amazon"), row(channel="shopify", gross=267.16, orders=9)]
        incoming = [row(channel="amazon"),                       # unchanged
                    row(channel="shopify", gross=80.0, orders=3)]  # partial
        res = guard_rows(incoming, existing, TODAY)
        assert [r["channel"] for r in res.to_write] == ["amazon"]
        assert res.blocked[0]["channel"] == "shopify"


class TestGrowthIsAlwaysAllowed:
    def test_late_arriving_orders_push_a_day_up(self):
        res = guard_rows([row(gross=3200.00, orders=205)], [row()], TODAY)
        assert res.to_write[0]["gross_sales"] == 3200.00
        assert res.blocked == []

    def test_a_brand_new_day_is_written(self):
        res = guard_rows([row(day="2026-08-20")], [], TODAY)
        assert len(res.to_write) == 1
        assert res.to_write[0]["is_complete"] is True

    def test_an_identical_rewrite_is_allowed(self):
        res = guard_rows([row()], [row()], TODAY)
        assert len(res.to_write) == 1


class TestTolerance:
    def test_a_small_drift_is_not_treated_as_a_partial_pull(self):
        """One cancelled order should not block a legitimate refresh."""
        res = guard_rows([row(gross=3070.00, orders=198)], [row()], TODAY)
        assert len(res.to_write) == 1

    def test_a_drop_below_the_absolute_floor_passes(self):
        res = guard_rows([row(gross=3073.53 - (TOLERANCE_ABS - 1), orders=198)],
                         [row()], TODAY)
        assert len(res.to_write) == 1

    def test_losing_whole_orders_is_caught_even_when_money_is_close(self):
        """The partial-pull signature: fewer orders, similar-looking total."""
        assert is_shrink(3000.0, 3073.53, 120, 198)

    def test_from_an_empty_day_anything_is_growth(self):
        assert not is_shrink(500.0, 0.0, 10, 0)


class TestTodayIsPartialByDesign:
    def test_the_current_day_is_always_written(self):
        """Guarding today would freeze the first value seen each morning."""
        res = guard_rows([row(day=TODAY.isoformat(), gross=100.0, orders=5)],
                         [row(day=TODAY.isoformat(), gross=900.0, orders=40)],
                         TODAY)
        assert len(res.to_write) == 1
        assert res.to_write[0]["gross_sales"] == 100.0

    def test_the_current_day_is_flagged_incomplete(self):
        res = guard_rows([row(day=TODAY.isoformat())], [], TODAY)
        assert res.to_write[0]["is_complete"] is False

    def test_closed_days_are_flagged_complete(self):
        res = guard_rows([row(day="2026-08-13")], [], TODAY)
        assert res.to_write[0]["is_complete"] is True


class TestExplicitDecrease:
    def test_a_real_refund_sweep_can_be_applied_deliberately(self):
        res = guard_rows([row(gross=1066.29, orders=67)], [row()], TODAY,
                         allow_decrease=True)
        assert len(res.to_write) == 1
        assert "allow_decrease" in res.reasons[0]

    def test_the_decrease_is_still_recorded(self):
        res = guard_rows([row(gross=1000.0, orders=50)], [row()], TODAY,
                         allow_decrease=True)
        assert res.reasons and "3,073.53" in res.reasons[0]


class TestReasonsAreActionable:
    def test_a_refusal_names_the_day_channel_and_both_totals(self):
        res = guard_rows([row(gross=1066.29, orders=67)], [row()], TODAY)
        r = res.reasons[0]
        for fragment in ("2026-08-13", "amazon", "3,073.53", "1,066.29", "198", "67"):
            assert fragment in r, fragment

    def test_a_refusal_says_how_to_override(self):
        res = guard_rows([row(gross=1.0, orders=1)], [row()], TODAY)
        assert "allow_decrease" in res.reasons[0]
