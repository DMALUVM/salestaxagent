"""Shopify customer metrics — definitions pinned against fixtures.

No API, no database. Every function under test takes rows and returns numbers,
which is the point: the definitions can be checked by hand and cannot drift with
whatever the store happens to contain today.

The tests are written around the ways these metrics go quietly wrong:
guest checkouts collapsing into one phantom customer, refunds ignored, young
cohorts reading as churn, and Amazon sneaking into a Shopify-only figure.
"""
from __future__ import annotations

import pytest

from src import shopify_metrics as M
from src.shopify_backfill import customer_key, email_hash, to_row


def order(oid, key, d, subtotal, refund=0.0, test=False, cancelled=None):
    return {"order_id": oid, "customer_key": key, "order_date": d,
            "subtotal_price": subtotal, "refunded_amount": refund,
            "is_test": test, "cancelled_at": cancelled}


# ── identity ─────────────────────────────────────────────────────────────

def test_customer_key_prefers_a_real_customer_id():
    assert customer_key(123, "abc", 999) == "c:123"


def test_guest_checkouts_stitch_on_email_hash():
    assert customer_key(None, "abc", 999) == "h:abc"
    assert customer_key(None, "abc", 111) == customer_key(None, "abc", 222)


def test_an_unidentifiable_order_is_its_own_customer():
    """The failure this prevents: one phantom customer with thousands of orders.

    Bucketing every anonymous order under a shared "unknown" key would make the
    repeat rate meaningless — that one pseudo-customer would look like the most
    loyal buyer in the store.
    """
    a, b = customer_key(None, None, 1), customer_key(None, None, 2)
    assert a != b
    rows = [order(1, a, "2026-01-01", 50), order(2, b, "2026-02-01", 50)]
    s = M.summarise(rows)
    assert s.customers == 2 and s.repeat_customers == 0
    assert s.repeat_rate == 0.0


def test_email_hash_is_normalised_and_is_not_the_address():
    assert email_hash("  A@B.com ") == email_hash("a@b.com")
    assert email_hash("a@b.com") and "a@b.com" not in email_hash("a@b.com")
    assert email_hash(None) is None and email_hash("  ") is None


# ── revenue definition ───────────────────────────────────────────────────

def test_revenue_is_net_of_refunds_and_never_negative():
    assert M.revenue_of({"subtotal_price": 100, "refunded_amount": 30}) == 70
    assert M.revenue_of({"subtotal_price": 20, "refunded_amount": 50}) == 0


def test_test_and_cancelled_orders_are_excluded_but_still_stored():
    rows = [order(1, "c:1", "2026-01-01", 100),
            order(2, "c:2", "2026-01-02", 999, test=True),
            order(3, "c:3", "2026-01-03", 999, cancelled="2026-01-04T00:00:00Z")]
    s = M.summarise(rows)
    assert s.orders == 1 and s.revenue == 100
    assert len(rows) == 3, "exclusion happens at read time, not at fetch time"


# ── headline metrics ─────────────────────────────────────────────────────

def test_aov_and_ltv_and_repeat_rate_by_hand():
    rows = [
        order(1, "c:1", "2026-01-01", 100),
        order(2, "c:1", "2026-02-01", 200),   # repeat
        order(3, "c:2", "2026-01-15", 60),
        order(4, "c:3", "2026-03-01", 40, refund=10),   # net 30
    ]
    s = M.summarise(rows)
    assert s.orders == 4
    assert s.revenue == pytest.approx(390.0)          # 100+200+60+30
    assert s.customers == 3
    assert s.aov == pytest.approx(97.5)               # 390/4
    assert s.repeat_customers == 1
    assert s.repeat_rate == pytest.approx(1 / 3)
    assert s.ltv_mean == pytest.approx(130.0)         # (300+60+30)/3
    assert s.ltv_median == pytest.approx(60.0)        # sorted 30,60,300
    assert s.orders_per_customer == pytest.approx(4 / 3)


def test_median_ltv_is_reported_because_the_mean_hides_skew():
    """One wholesale-sized order must not become 'typical customer value'."""
    rows = [order(i, f"c:{i}", "2026-01-01", 50) for i in range(1, 10)]
    rows.append(order(99, "c:99", "2026-01-01", 10_000))
    s = M.summarise(rows)
    assert s.ltv_mean > 1000
    assert s.ltv_median == pytest.approx(50.0)


def test_identified_pct_caps_how_much_repeat_rate_can_mean():
    rows = [order(1, "c:1", "2026-01-01", 10), order(2, "o:2", "2026-01-02", 10),
            order(3, "h:x", "2026-01-03", 10), order(4, "o:4", "2026-01-04", 10)]
    s = M.summarise(rows)
    assert s.identified_pct == pytest.approx(25.0)


def test_empty_input_returns_zeros_and_nulls_not_a_crash():
    s = M.summarise([])
    assert s.orders == 0 and s.customers == 0
    assert s.aov is None and s.ltv_median is None and s.repeat_rate is None


# ── monthly ──────────────────────────────────────────────────────────────

def test_a_customer_counts_as_new_only_in_their_first_month():
    rows = [order(1, "c:1", "2026-01-05", 100),
            order(2, "c:1", "2026-02-05", 100),
            order(3, "c:2", "2026-02-06", 50)]
    m = {x["month"]: x for x in M.monthly(rows)}
    assert m["2026-01"]["newCustomers"] == 1
    assert m["2026-02"]["newCustomers"] == 1          # c:2 only
    assert m["2026-02"]["returningOrders"] == 1       # c:1's second order


# ── cohorts ──────────────────────────────────────────────────────────────

def test_cohort_revenue_is_cumulative_per_customer():
    rows = [order(1, "c:1", "2026-01-10", 100),
            order(2, "c:1", "2026-02-10", 50),
            order(3, "c:2", "2026-01-20", 200)]
    c = next(x for x in M.cohorts(rows, today="2026-04-01") if x["cohort"] == "2026-01")
    assert c["customers"] == 2
    off = {o["offset"]: o for o in c["offsets"]}
    assert off[0]["cumRevenuePerCustomer"] == pytest.approx(150.0)   # 300/2
    assert off[1]["cumRevenuePerCustomer"] == pytest.approx(175.0)   # 350/2


def test_unobserved_cohort_months_are_null_not_zero():
    """Zero would read as churn. The month simply has not happened yet."""
    rows = [order(1, "c:1", "2026-03-10", 100)]
    c = M.cohorts(rows, max_offset=6, today="2026-04-15")[0]
    off = {o["offset"]: o for o in c["offsets"]}
    assert off[0]["observed"] is True
    assert off[1]["observed"] is True and off[1]["cumRevenuePerCustomer"] == 100.0
    for n in (2, 3, 4, 5, 6):
        assert off[n]["observed"] is False
        assert off[n]["cumRevenuePerCustomer"] is None, (
            "a cohort too young to have this month must not report 0")


def test_cohorts_on_empty_input():
    assert M.cohorts([]) == []


# ── row mapping ──────────────────────────────────────────────────────────

def test_to_row_maps_an_api_order_without_a_store():
    api = {
        "id": 123, "name": "#1", "created_at": "2026-08-21T12:37:35-04:00",
        "customer": {"id": 456, "email": "A@B.com"}, "email": "A@B.com",
        "subtotal_price": "20.39", "total_price": "28.15", "total_tax": "1.81",
        "total_discounts": "3.59", "financial_status": "paid", "test": False,
        "source_name": "web", "shipping_address": {"province_code": "nc",
                                                   "country_code": "us"},
        "refunds": [{"transactions": [
            {"kind": "refund", "status": "success", "amount": "5.00"},
            {"kind": "refund", "status": "failure", "amount": "99.00"},
        ]}],
    }
    r = to_row(api)
    assert r["order_id"] == 123 and r["customer_id"] == 456
    assert r["customer_key"] == "c:456"
    assert r["subtotal_price"] == pytest.approx(20.39)
    assert r["refunded_amount"] == pytest.approx(5.00), "failed refunds don't count"
    assert r["state_code"] == "NC" and r["country_code"] == "US"
    assert r["order_date"] == "2026-08-21"


def test_to_row_does_not_store_raw_email_by_default():
    """Every metric here needs a stable identity, not a contactable one."""
    api = {"id": 1, "created_at": "2026-08-21T12:00:00-04:00",
           "email": "a@b.com", "customer": {"id": 9, "email": "a@b.com"},
           "subtotal_price": "10"}
    assert "email" not in to_row(api)
    assert to_row(api)["email_hash"] == email_hash("a@b.com")
    assert to_row(api, with_email=True)["email"] == "a@b.com"


# ── Amazon ───────────────────────────────────────────────────────────────

def test_amazon_person_level_is_documented_as_unavailable():
    note = M.amazon_identity_note()
    assert note["personLevelAvailable"] is False
    assert len(note["why"]) >= 3
    assert "do not approximate" in note["doNotDo"].lower()


def test_amazon_aov_is_order_level_and_says_so():
    rows = [{"sale_date": "2026-08-20", "gross_sales": 3000, "order_count": 100},
            {"sale_date": "2026-08-19", "gross_sales": 1000, "order_count": 50}]
    a = M.amazon_aov(rows)
    assert a["aov"] == pytest.approx(4000 / 150, abs=0.01)  # stored to 2dp
    assert a["personLevel"] is False
    assert "sales_daily" in a["basis"]


def test_no_amazon_channel_leaks_into_shopify_summaries():
    """A Shopify-only metric must never silently absorb Amazon rows."""
    rows = [order(1, "c:1", "2026-01-01", 100)]
    s = M.summarise(rows)
    assert s.revenue == 100
    # summarise() has no channel awareness by design — the loader is what scopes
    # it to shopify_orders, a table Amazon never writes to.
    import inspect
    assert "amazon" not in inspect.getsource(M.summarise).lower()


# ── LTV panel: repeaters are the primary customer-LTV figure ─────────────

def _panel_rows():
    """3 one-timers at $10, 2 repeaters worth $100 and $200."""
    return [
        order(1, "c:1", "2026-01-01", 10), order(2, "c:2", "2026-01-02", 10),
        order(3, "c:3", "2026-01-03", 10),
        order(4, "c:4", "2026-01-04", 40), order(5, "c:4", "2026-02-04", 60),
        order(6, "c:5", "2026-01-05", 80), order(7, "c:5", "2026-02-05", 120),
    ]


def test_repeater_ltv_is_computed_only_over_customers_with_two_or_more_orders():
    s = M.summarise(_panel_rows())
    assert s.repeat_customers == 2
    assert s.ltv_mean_repeat == pytest.approx(150.0)     # (100+200)/2
    assert s.ltv_median_repeat == pytest.approx(150.0)
    assert s.orders_per_repeater == pytest.approx(2.0)


def test_all_customer_ltv_and_repeater_ltv_are_different_numbers():
    """The whole point of the panel: one describes acquisition, one retention."""
    s = M.summarise(_panel_rows())
    assert s.ltv_median == pytest.approx(10.0), "median customer is a one-timer"
    assert s.ltv_mean_repeat > s.ltv_mean > s.ltv_median


def test_revenue_share_from_repeaters():
    s = M.summarise(_panel_rows())
    assert s.revenue == pytest.approx(330.0)
    assert s.revenue_from_repeaters == pytest.approx(300.0)
    assert s.revenue_from_repeaters_pct == pytest.approx(300 / 330 * 100)


def test_aov_reports_mean_and_median_on_both_bases():
    rows = [dict(order(1, "c:1", "2026-01-01", 10), total_price=12.0),
            dict(order(2, "c:2", "2026-01-02", 30), total_price=36.0)]
    s = M.summarise(rows)
    assert s.aov == pytest.approx(20.0) and s.aov_median == pytest.approx(20.0)
    assert s.aov_paid == pytest.approx(24.0)
    assert s.aov_paid > s.aov, "paid includes tax and shipping"


def test_paid_of_is_net_of_refunds_and_floored():
    assert M.paid_of({"total_price": 100, "refunded_amount": 40}) == 60
    assert M.paid_of({"total_price": 10, "refunded_amount": 50}) == 0


def test_interpretation_names_the_split_and_never_leads_with_median_alone():
    text = M.summarise(_panel_rows()).interpretation()
    assert "one-time" in text
    assert "%" in text and "come back" in text
    assert "LTV" in text
    # It must state the repeater value, not just the median.
    assert "150" in text


def test_interpretation_when_nobody_has_repeated():
    rows = [order(1, "c:1", "2026-01-01", 10), order(2, "c:2", "2026-01-02", 10)]
    s = M.summarise(rows)
    assert s.ltv_mean_repeat is None and s.orders_per_repeater is None
    assert "no repeat cohort" in s.interpretation().lower()


def test_summary_dict_exposes_every_panel_field_the_ui_reads():
    d = M.summarise(_panel_rows()).as_dict()
    for k in ("aov", "aovMedian", "aovPaid", "aovPaidMedian", "ltvMean",
              "ltvMedian", "ltvMeanRepeat", "ltvMedianRepeat", "repeatRate",
              "ordersPerRepeater", "revenueFromRepeaters",
              "revenueFromRepeatersPct", "interpretation"):
        assert k in d, f"panel field {k} missing from as_dict()"


# ── cohort LTV at fixed day horizons ────────────────────────────────────

def test_cohort_ltv_uses_days_from_each_customers_own_first_order():
    rows = [order(1, "c:1", "2026-01-01", 100),
            order(2, "c:1", "2026-03-01", 50),    # day 59 → inside 90
            order(3, "c:1", "2026-06-01", 25)]    # day 151 → outside 90
    c = M.cohort_ltv_at_days(rows, days=(90,), today="2026-08-01")[0]
    assert c["day90"] == pytest.approx(150.0)


def test_cohort_day_window_that_has_not_elapsed_is_null():
    rows = [order(1, "c:1", "2026-07-01", 100)]
    c = M.cohort_ltv_at_days(rows, days=(90, 365), today="2026-08-01")[0]
    assert c["day90"] is None and c["day90Complete"] is False
    assert c["day365"] is None


def test_by_year_separates_eras_so_an_all_time_aov_is_not_the_only_figure():
    rows = [dict(order(1, "c:1", "2024-05-01", 10), total_price=11.0),
            dict(order(2, "c:2", "2025-05-01", 40), total_price=44.0)]
    ys = {y["year"]: y for y in M.by_year(rows)}
    assert ys["2024"]["aov"] == pytest.approx(10.0)
    assert ys["2025"]["aov"] == pytest.approx(40.0)
    assert ys["2025"]["aovPaid"] == pytest.approx(44.0)
