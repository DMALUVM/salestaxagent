"""Shopper-funnel math — drop-off, recovery, ShopifyQL parse, no invented counts.

No API, no database. Fixtures are small enough to recompute by hand.
"""
from __future__ import annotations

from src import shopify_funnel as F
from src.shopify_funnel_sync import ABANDON_GQL, SHOPIFYQL_GQL, _shopifyql


def daily(d, sessions, pdp=None, atc=None, chk=None, purch=None, kind="all", val=""):
    return {
        "metric_date": d, "split_kind": kind, "split_value": val,
        "sessions": sessions, "pdp_sessions": pdp,
        "add_to_cart": atc, "checkout_started": chk, "purchases": purch,
    }


# ── drop-off ─────────────────────────────────────────────────────────────

def test_drop_off_by_hand():
    d = F.drop_off(100, 40)
    assert d["lost"] == 60 and d["rate"] == 0.6 and d["conversion"] == 0.4
    assert d["nested"] is True and d["present"] is True


def test_drop_off_missing_is_null_not_zero():
    """A missing ShopifyQL column must not become a 100% leak."""
    d = F.drop_off(100, None)
    assert d["lost"] is None and d["rate"] is None and d["present"] is False
    d = F.drop_off(None, 10)
    assert d["present"] is False and d["rate"] is None


def test_drop_off_non_nested_pdp_vs_atc():
    """ATC from collections can exceed PDP landings — do not invent a leak."""
    d = F.drop_off(20, 35)
    assert d["nested"] is False
    assert d["lost"] is None
    assert d["rate"] is None
    assert d["conversion"] == 1.75


def test_drop_off_zero_prev():
    d = F.drop_off(0, 0)
    assert d["rate"] is None and d["nested"] is True


# ── window sum ───────────────────────────────────────────────────────────

def test_sum_daily_does_not_turn_missing_into_zero():
    rows = [
        daily("2026-09-10", 10, pdp=4, atc=3, chk=2, purch=1),
        daily("2026-09-11", 10, pdp=None, atc=None, chk=1, purch=0),
        daily("2026-09-11", 99, kind="device", val="Mobile"),  # ignored
    ]
    c = F.sum_daily(rows, "2026-09-10", "2026-09-11")
    assert c.sessions == 20
    assert c.pdp_sessions == 4          # day 11 contributed nothing, not 0
    assert c.add_to_cart == 3
    assert c.checkout_started == 3
    assert c.purchases == 1


def test_sum_daily_respects_window():
    rows = [
        daily("2026-09-01", 100, atc=50, chk=20, purch=10),
        daily("2026-09-10", 10, atc=5, chk=2, purch=1),
    ]
    c = F.sum_daily(rows, "2026-09-10", "2026-09-10")
    assert c.sessions == 10 and c.purchases == 1


def test_window_bounds_are_inclusive():
    start, end = F.window_bounds("2026-09-20", 7)
    assert end == "2026-09-20"
    assert start == "2026-09-14"
    start28, _ = F.window_bounds("2026-09-20", 28)
    assert start28 == "2026-08-24"


# ── biggest leak ─────────────────────────────────────────────────────────

def test_biggest_leak_is_count_not_rate():
    """90% of 10 is not the leak if 800 sessions died earlier."""
    c = F.FunnelCounts(sessions=1000, add_to_cart=200, checkout_started=180,
                       purchases=18)
    leak = F.biggest_leak(c)
    assert leak["from"] == "sessions" and leak["to"] == "add_to_cart"
    assert leak["lost"] == 800 and leak["rate"] == 0.8


def test_biggest_leak_none_when_counts_missing():
    assert F.biggest_leak(F.FunnelCounts()) is None


def test_closed_funnel_ignores_pdp():
    c = F.FunnelCounts(sessions=100, pdp_sessions=10, add_to_cart=40,
                       checkout_started=20, purchases=10)
    leaks = F.closed_drop_off(c)
    assert [x["from"] for x in leaks] == [
        "sessions", "add_to_cart", "checkout_started"]
    assert leaks[0]["lost"] == 60


def test_steps_omit_pdp_when_missing():
    c = F.FunnelCounts(sessions=10, add_to_cart=4, checkout_started=2,
                       purchases=1)
    keys = [s["key"] for s in F.steps_of(c)]
    assert "pdp_sessions" not in keys
    c2 = F.FunnelCounts(sessions=10, pdp_sessions=6, add_to_cart=4,
                        checkout_started=2, purchases=1)
    keys2 = [s["key"] for s in F.steps_of(c2)]
    assert keys2[1] == "pdp_sessions"


# ── ShopifyQL parse ──────────────────────────────────────────────────────

def test_parse_shopifyql_dict_rows():
    table = {"columns": [{"name": "day"}],
             "rows": [{"day": "2026-09-18T00:00:00",
                       "sessions": "12",
                       "sessions_with_cart_additions": 4,
                       "sessions_that_reached_checkout": 2,
                       "sessions_that_completed_checkout": 1}]}
    rows = F.parse_shopifyql_table(table)
    row = F.funnel_row_from_shopifyql(rows[0])
    assert row["metric_date"] == "2026-09-18"
    assert row["sessions"] == 12
    assert row["add_to_cart"] == 4
    assert row["checkout_started"] == 2
    assert row["purchases"] == 1
    assert row["pdp_sessions"] is None


def test_parse_shopifyql_list_rows_uses_columns():
    table = {
        "columns": [{"name": "day"}, {"name": "sessions"}],
        "rows": [["2026-09-01", 8]],
    }
    rows = F.parse_shopifyql_table(table)
    assert rows[0]["sessions"] == 8


def test_merge_pdp_does_not_overwrite_closed_funnel():
    daily = [F.funnel_row_from_shopifyql({
        "day": "2026-09-01", "sessions": 20,
        "sessions_with_cart_additions": 5,
        "sessions_that_reached_checkout": 2,
        "sessions_that_completed_checkout": 1,
    })]
    pdp = [F.funnel_row_from_shopifyql({"day": "2026-09-01", "sessions": 9})]
    merged = F.merge_pdp_into_daily(daily, pdp)
    assert merged[0]["sessions"] == 20
    assert merged[0]["pdp_sessions"] == 9
    assert merged[0]["add_to_cart"] == 5


def test_as_int_none_stays_none():
    assert F.as_int(None) is None
    assert F.as_int("") is None
    assert F.as_int("0") == 0


# ── abandoned checkouts ──────────────────────────────────────────────────

def _gql_checkout(oid="gid://shopify/AbandonedCheckout/1", total="32.00",
                  completed=None, items=None):
    return {
        "id": oid,
        "name": "#AC1",
        "createdAt": "2026-09-18T16:00:00Z",
        "updatedAt": "2026-09-18T16:10:00Z",
        "completedAt": completed,
        "totalPriceSet": {"shopMoney": {"amount": total, "currencyCode": "USD"}},
        "subtotalPriceSet": {"shopMoney": {"amount": total}},
        "lineItems": {"nodes": items or [{
            "title": "Tallow Balm",
            "quantity": 2,
            "sku": "TB-01",
            "variantTitle": "2oz",
            "originalTotalPriceSet": {"shopMoney": {"amount": "28.00"}},
            "product": {"id": "gid://shopify/Product/9",
                        "title": "Tallow Balm", "handle": "tallow-balm"},
        }]},
    }


def test_abandoned_row_marks_recovered_from_completed_at():
    open_row = F.abandoned_row_from_gql(_gql_checkout(), "2026-09-18")
    rec_row = F.abandoned_row_from_gql(
        _gql_checkout(completed="2026-09-19T12:00:00Z"), "2026-09-18")
    assert open_row["recovered"] is False and rec_row["recovered"] is True
    assert open_row["total_price"] == 32.0
    assert open_row["line_items"][0]["handle"] == "tallow-balm"
    assert "abandonedCheckoutUrl" not in open_row


def test_recovery_rate_and_open_value_ignore_recovered():
    rows = [
        F.abandoned_row_from_gql(_gql_checkout("gid://x/1", "40.00"), "2026-09-18"),
        F.abandoned_row_from_gql(
            _gql_checkout("gid://x/2", "99.00", completed="2026-09-19T00:00:00Z"),
            "2026-09-18"),
        F.abandoned_row_from_gql(_gql_checkout("gid://x/3", None), "2026-09-18"),
    ]
    # Force missing total on the third (constructor may still parse None).
    rows[2]["total_price"] = None
    r = F.recovery_rate(rows)
    assert r["count"] == 3 and r["recovered"] == 1 and r["open"] == 2
    assert r["recoveryRate"] == round(1 / 3, 4)
    assert r["openValue"] == 40.0
    assert r["openValueMissing"] == 1


def test_top_abandoned_products_skip_recovered_and_blank_titles():
    rec = F.abandoned_row_from_gql(
        _gql_checkout("gid://x/r", "50.00", completed="2026-09-19T00:00:00Z"),
        "2026-09-18")
    open_a = F.abandoned_row_from_gql(_gql_checkout("gid://x/a", "32.00"), "2026-09-18")
    open_b = F.abandoned_row_from_gql(_gql_checkout(
        "gid://x/b", "10.00",
        items=[{"title": "  ", "quantity": 9, "sku": None, "variantTitle": None,
                "originalTotalPriceSet": {"shopMoney": {"amount": "10.00"}},
                "product": {}}]), "2026-09-18")
    top = F.top_abandoned_products([rec, open_a, open_b])
    assert [t["title"] for t in top] == ["Tallow Balm"]
    assert top[0]["quantity"] == 2
    assert top[0]["amount"] == 28.0


def test_filter_abandoned_window():
    rows = [
        {"checkout_date": "2026-09-01", "recovered": False},
        {"checkout_date": "2026-09-18", "recovered": False},
    ]
    assert len(F.filter_abandoned(rows, "2026-09-14", "2026-09-20")) == 1


# ── triage stub (fail closed, no LLM) ────────────────────────────────────

def test_stub_triage_fail_closed_and_recovered_is_noise():
    assert F.stub_triage_severity(None, False)[0] == "hold_for_review"
    assert F.stub_triage_severity(5.0, False)[0] == "noise"
    assert F.stub_triage_severity(40.0, False)[0] == "needs_eyes"
    assert F.stub_triage_severity(15.0, False)[0] == "hold_for_review"
    assert F.stub_triage_severity(999.0, True)[0] == "noise"


# ── silent when nothing material changed ─────────────────────────────────

def test_material_change_silent_when_same_leak_and_abandons():
    prev = F.PreviousSnapshot(
        leak_from="sessions", leak_to="add_to_cart",
        leak_lost=80, leak_rate=0.8,
        abandon_open=10, abandon_value=120.0)
    leak = {"from": "sessions", "to": "add_to_cart", "lost": 81, "rate": 0.81}
    abandon = {"open": 11, "openValue": 130.0}
    assert F.is_material_change(prev, leak, abandon) is False


def test_material_change_when_leak_step_moves():
    prev = F.PreviousSnapshot(leak_from="sessions", leak_to="add_to_cart",
                              leak_lost=80, leak_rate=0.8,
                              abandon_open=10, abandon_value=120.0)
    leak = {"from": "checkout_started", "to": "purchases", "lost": 80, "rate": 0.8}
    assert F.is_material_change(prev, leak, {"open": 10, "openValue": 120.0})


def test_first_sync_is_material():
    assert F.is_material_change(None, {"from": "sessions", "to": "add_to_cart",
                                       "lost": 1, "rate": 0.1},
                                {"open": 0, "openValue": 0}) is True


# ── scope classification ─────────────────────────────────────────────────

def test_classify_gql_errors_names_the_grant():
    scopes = F.classify_gql_errors([
        {"message": "Access denied for shopifyqlQuery field. "
                    "Required access: `read_reports` access scope."},
        {"message": "Access denied for abandonedCheckouts field."},
    ])
    assert "read_reports" in scopes
    assert "read_orders" in scopes
    assert "manage_abandoned_checkouts" in scopes


# ── device window ────────────────────────────────────────────────────────

def test_device_window_sums_only_device_rows():
    rows = [
        daily("2026-09-18", 10, atc=4, chk=2, purch=1, kind="device", val="Mobile"),
        daily("2026-09-19", 5, atc=1, chk=1, purch=0, kind="device", val="Mobile"),
        daily("2026-09-18", 8, atc=3, chk=1, purch=1, kind="device", val="Desktop"),
        daily("2026-09-18", 99, atc=9, chk=9, purch=9),
    ]
    out = F.device_window(rows, "2026-09-18", "2026-09-19")
    by = {r["device"]: r for r in out}
    assert by["Mobile"]["sessions"] == 15
    assert by["Desktop"]["sessions"] == 8
    assert by["Mobile"]["leak"]["from"] == "sessions"


# ── sync documents are queries, never Place Order ────────────────────────

def test_graphql_documents_are_queries_only():
    for doc in (SHOPIFYQL_GQL, ABANDON_GQL):
        assert "mutation" not in doc.lower()
        assert "orderCreate" not in doc
        assert "draftOrderComplete" not in doc
        assert "abandonedCheckoutUrl" not in doc
    assert "shopifyqlQuery" in SHOPIFYQL_GQL
    assert "abandonedCheckouts" in ABANDON_GQL


def test_shopifyql_strings_use_official_closed_funnel_metrics():
    q = _shopifyql("closed", 28)
    assert "FROM sessions" in q
    assert "sessions_with_cart_additions" in q
    assert "sessions_that_reached_checkout" in q
    assert "sessions_that_completed_checkout" in q
    assert "human_or_bot_session = 'human'" in q
    pdp = _shopifyql("pdp", 28, extra_where="landing_page_type = 'product'")
    assert "landing_page_type = 'product'" in pdp
    land = _shopifyql("landing", 7, group="landing_page_path", limit=25)
    assert "GROUP BY landing_page_path" in land
    assert "LIMIT 25" in land


def test_cli_command_is_registered_and_mentions_scopes():
    from pathlib import Path
    src = Path("src/main.py").read_text()
    assert '@cli.command("shopify-funnel-sync")' in src
    assert "_run_shopify_funnel_sync" in src
    assert "shopify_funnel_sync" in src
