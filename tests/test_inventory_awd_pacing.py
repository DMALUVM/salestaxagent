"""AWD usage-plan pacing, 429 isolation, and one deferred morning retry."""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from src.amazon_sp.client import SPAPIError
from src.inventory.awd_client import (
    AWD_MAX_RETRIES,
    AWD_MAX_WAIT_SEC,
    AWD_USAGE_PLANS,
    awd_get,
    is_awd_quota_error,
    operation_for_path,
    reset_awd_limiters,
)
from src.inventory.sync import (
    AWD_SYNC_NAMES,
    INVENTORY_SYNC_STEPS,
    classify_sync_errors,
    sync_all,
)

ET = ZoneInfo("America/New_York")


class _Resp:
    def __init__(self, status_code=200, text="", headers=None, body=None):
        self.status_code = status_code
        self.text = text
        self.headers = headers or {}
        self._body = body if body is not None else {}

    def json(self):
        return self._body


def _clock(monkeypatch, module, start=1_000.0):
    now = [start]
    sleeps: list[float] = []

    def monotonic():
        return now[0]

    def sleep(s):
        sleeps.append(float(s))
        now[0] += float(s)

    monkeypatch.setattr(module.time, "monotonic", monotonic)
    monkeypatch.setattr(module.time, "sleep", sleep)
    return now, sleeps


def test_usage_plans_match_published_awd_defaults():
    assert AWD_USAGE_PLANS["listInventory"] == (2.0, 2.0)
    assert AWD_USAGE_PLANS["listInboundShipments"] == (1.0, 1.0)
    assert AWD_USAGE_PLANS["getInboundShipment"] == (2.0, 2.0)
    inbound_rate = AWD_USAGE_PLANS["listInboundShipments"][0]
    inventory_rate = AWD_USAGE_PLANS["listInventory"][0]
    assert inbound_rate < inventory_rate
    # Shared 0.35s (~2.8 rps) is faster than inbound's published 1 rps.
    assert 1.0 / inbound_rate > 0.35


def test_operation_for_path_splits_list_and_detail():
    assert operation_for_path("/inventory") == "listInventory"
    assert operation_for_path("/inboundShipments") == "listInboundShipments"
    assert operation_for_path("/inboundShipments/SH-1") == "getInboundShipment"
    assert operation_for_path("/replenishmentOrders") == "listReplenishmentOrders"
    assert operation_for_path("/replenishmentOrders/RO-1") == "getReplenishmentOrder"


def test_inbound_paced_slower_than_inventory(monkeypatch):
    from src.inventory import awd_client as ac

    reset_awd_limiters()
    _now, sleeps = _clock(monkeypatch, ac)
    monkeypatch.setattr(ac.httpx, "get", lambda *a, **k: _Resp())
    monkeypatch.setattr(ac, "_headers", lambda: {})

    awd_get("/inboundShipments")
    awd_get("/inboundShipments")
    inbound_waits = list(sleeps)
    assert inbound_waits
    assert inbound_waits[0] == pytest.approx(1.0, abs=0.01)

    sleeps.clear()
    awd_get("/inventory")
    awd_get("/inventory")
    # Burst 2: the second inventory GET does not wait.
    assert sleeps == []
    awd_get("/inventory")
    assert sleeps
    assert sleeps[0] == pytest.approx(0.5, abs=0.01)
    assert inbound_waits[0] > sleeps[0]


def test_detail_get_uses_shipment_detail_plan(monkeypatch):
    from src.inventory import awd_client as ac

    reset_awd_limiters()
    _now, sleeps = _clock(monkeypatch, ac)
    monkeypatch.setattr(ac.httpx, "get", lambda *a, **k: _Resp())
    monkeypatch.setattr(ac, "_headers", lambda: {})

    awd_get("/inboundShipments/SH-1")
    awd_get("/inboundShipments/SH-1")
    assert sleeps == []  # burst 2
    awd_get("/inboundShipments/SH-1")
    assert sleeps[0] == pytest.approx(0.5, abs=0.01)


def test_rate_limit_remaining_zero_forces_wait(monkeypatch):
    from src.inventory import awd_client as ac

    reset_awd_limiters()
    _now, sleeps = _clock(monkeypatch, ac)
    monkeypatch.setattr(ac, "_headers", lambda: {})

    def fake_get(*a, **k):
        return _Resp(headers={
            "x-amzn-RateLimit-Limit": "1.0",
            "x-amzn-RateLimit-Remaining": "0",
        })

    monkeypatch.setattr(ac.httpx, "get", fake_get)
    awd_get("/inboundShipments")
    awd_get("/inboundShipments")
    assert sleeps
    assert sleeps[0] == pytest.approx(1.0, abs=0.01)


def test_retry_after_capped_and_not_multi_minute(monkeypatch):
    from src.inventory import awd_client as ac

    reset_awd_limiters()
    _now, sleeps = _clock(monkeypatch, ac)
    monkeypatch.setattr(ac, "_headers", lambda: {})
    monkeypatch.setattr(ac, "_throttle", lambda *a, **k: None)
    calls = {"n": 0}

    def fake_get(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            return _Resp(429, "quota", headers={"Retry-After": "120"})
        return _Resp()

    monkeypatch.setattr(ac.httpx, "get", fake_get)
    assert awd_get("/inboundShipments") == {}
    assert sleeps == [AWD_MAX_WAIT_SEC]


def test_awd_get_429_gives_up_after_max_retries(monkeypatch):
    from src.inventory import awd_client as ac

    reset_awd_limiters()
    monkeypatch.setattr(ac.time, "sleep", lambda _s: None)
    monkeypatch.setattr(ac, "_throttle", lambda *a, **k: None)
    monkeypatch.setattr(ac, "_headers", lambda: {})
    calls = {"n": 0}

    def fake_get(*a, **k):
        calls["n"] += 1
        return _Resp(429, "quota")

    monkeypatch.setattr(ac.httpx, "get", fake_get)
    with pytest.raises(SPAPIError, match="429"):
        awd_get("/inboundShipments")
    assert calls["n"] == AWD_MAX_RETRIES
    assert AWD_MAX_RETRIES == 5


def test_reports_finish_before_awd_paging():
    restock_i = INVENTORY_SYNC_STEPS.index("restock")
    planning_i = INVENTORY_SYNC_STEPS.index("planning")
    awd_i = INVENTORY_SYNC_STEPS.index("awd")
    inbound_i = INVENTORY_SYNC_STEPS.index("awd_inbound")
    assert restock_i < awd_i
    assert planning_i < awd_i
    assert planning_i < inbound_i
    assert INVENTORY_SYNC_STEPS.index("fba_summaries") < restock_i


def test_awd_inbound_429_keeps_sibling_results(monkeypatch):
    from src.inventory import sync as syn

    monkeypatch.setattr(syn, "fetch_fba_summaries", lambda **k: {"rows_total": 4})
    monkeypatch.setattr(syn, "fetch_restock", lambda **k: {"rows_total": 3})
    monkeypatch.setattr(syn, "fetch_planning", lambda **k: {"rows_total": 2})
    monkeypatch.setattr(
        "src.inventory.awd.fetch_awd_inventory",
        lambda **k: {"rows_total": 5},
    )
    monkeypatch.setattr(
        syn, "_sync_awd_replenishments",
        lambda dry: {"orders_found": 1, "order_rows": [{"order_id": "R1"}]},
    )
    monkeypatch.setattr(
        syn, "_sync_inbound",
        lambda dry, orders=None: {"shipments_found": 7},
    )

    def boom(dry=False):
        raise SPAPIError("AWD API quota exceeded (429) on /inboundShipments")

    monkeypatch.setattr(syn, "_sync_awd_inbound", boom)

    results = sync_all()
    assert results["fba_summaries"]["rows_total"] == 4
    assert results["restock"]["rows_total"] == 3
    assert results["planning"]["rows_total"] == 2
    assert results["awd"]["rows_total"] == 5
    assert results["inbound_shipments"]["shipments_found"] == 7
    assert "429" in results["awd_inbound"]["error"]
    fatal, quota = classify_sync_errors(results)
    assert fatal == []
    assert any("awd_inbound" in q for q in quota)


def test_sync_all_only_awd_skips_report_polls(monkeypatch):
    from src.inventory import sync as syn

    called: list[str] = []

    def rec(name):
        def fn(*a, **k):
            called.append(name)
            return {"rows_total": 1, "order_rows": []}
        return fn

    monkeypatch.setattr(syn, "fetch_fba_summaries", rec("fba_summaries"))
    monkeypatch.setattr(syn, "fetch_restock", rec("restock"))
    monkeypatch.setattr(syn, "fetch_planning", rec("planning"))
    monkeypatch.setattr("src.inventory.awd.fetch_awd_inventory", rec("awd"))
    monkeypatch.setattr(syn, "_sync_awd_replenishments", rec("awd_replenishments"))
    monkeypatch.setattr(syn, "_sync_awd_inbound", rec("awd_inbound"))
    monkeypatch.setattr(syn, "_sync_inbound", rec("inbound_shipments"))

    results = sync_all(only=AWD_SYNC_NAMES)
    assert "restock" not in called
    assert "planning" not in called
    assert "fba_summaries" not in called
    assert set(called) == set(AWD_SYNC_NAMES)
    assert "restock" not in results


def test_classify_non_quota_awd_error_is_fatal():
    fatal, quota = classify_sync_errors({
        "awd": {"error": "AWD API forbidden (403)"},
        "restock": {"rows_total": 1},
    })
    assert fatal
    assert quota == []
    assert is_awd_quota_error("quota exceeded (429)") is True
    assert is_awd_quota_error("timeout") is False


def test_awd_retry_run_at_is_before_morning_check():
    from src.main import awd_retry_run_at

    morning = datetime(2026, 9, 18, 6, 50, tzinfo=ET)
    when = awd_retry_run_at(morning)
    assert when.hour == 7 and when.minute == 0
    late = datetime(2026, 9, 18, 7, 2, tzinfo=ET)
    when2 = awd_retry_run_at(late)
    assert when2 >= late
    assert when2.hour == 7 and when2.minute <= 5
    assert (when2 - late).total_seconds() <= 30


def test_schedule_awd_retry_one_replaceable_date_trigger(monkeypatch):
    import inspect
    from src import main as main_mod

    added = []

    class Sched:
        def add_job(self, fn, kind, run_date=None, id=None, **k):
            added.append({
                "fn": fn, "kind": kind, "run_date": run_date,
                "id": id, "replace": k.get("replace_existing"),
            })

    monkeypatch.setattr(main_mod, "_SCHEDULER", Sched())
    assert main_mod._schedule_awd_retry() is True
    assert main_mod._schedule_awd_retry() is True
    assert [a["id"] for a in added] == [
        "inventory_awd_retry", "inventory_awd_retry",
    ]
    assert all(a["kind"] == "date" for a in added)
    assert all(a["replace"] is True for a in added)
    assert all(a["fn"] is main_mod._run_inventory_awd_retry for a in added)

    src = inspect.getsource(main_mod._schedule_awd_retry)
    assert "while " not in src
    assert "sleep" not in src
    retry_src = inspect.getsource(main_mod._run_inventory_awd_retry)
    assert "_schedule_awd_retry" not in retry_src


def test_inventory_sync_awd_429_does_not_fail_job(monkeypatch):
    from src import main as main_mod

    finishes = []
    scheduled = []

    monkeypatch.setattr("src.db.job_start", lambda n: "rid")
    monkeypatch.setattr(
        "src.db.job_finish",
        lambda rid, status, msg=None, stats=None: finishes.append((status, msg)),
    )
    monkeypatch.setattr(main_mod, "_schedule_awd_retry", lambda: scheduled.append(True) or True)
    monkeypatch.setattr(
        "src.inventory.sync.sync_all",
        lambda: {
            "fba_summaries": {"rows_total": 1},
            "restock": {"rows_total": 1},
            "planning": {"rows_total": 1},
            "awd": {"rows_total": 1},
            "awd_replenishments": {"orders_found": 1},
            "inbound_shipments": {"shipments_found": 1},
            "awd_inbound": {"error": "AWD API quota exceeded (429) on /inboundShipments"},
            "errors": ["awd_inbound: AWD API quota exceeded (429)"],
        },
    )
    monkeypatch.setattr(
        "src.inventory.holiday_surge.approaching_peak", lambda: False,
    )
    monkeypatch.setattr(
        "src.inventory.velocity.compute_velocity",
        lambda **k: {"skus": 1, "avg_forward_mult": 1.0},
    )
    monkeypatch.setattr(
        "src.inventory.rate_signals.sync_sku_signals",
        lambda: {"skus": 1, "account_receive_days": 10, "account_receive_n": 2},
    )
    monkeypatch.setattr(
        "src.inventory.freshness.collect_skip_reasons", lambda results: [],
    )

    main_mod._run_inventory_sync()
    assert scheduled == [True]
    assert finishes
    assert finishes[0][0] == "success"
    assert "fail" not in [s for s, _ in finishes]


def test_inventory_sync_still_fails_non_quota_errors(monkeypatch):
    from src import main as main_mod

    finishes = []
    monkeypatch.setattr("src.db.job_start", lambda n: "rid")
    monkeypatch.setattr(
        "src.db.job_finish",
        lambda rid, status, msg=None, stats=None: finishes.append(status),
    )
    monkeypatch.setattr(main_mod, "_schedule_awd_retry", lambda: False)
    monkeypatch.setattr(
        "src.inventory.sync.sync_all",
        lambda: {
            "fba_summaries": {"error": "FBA Inventory summaries failed (500)"},
            "restock": {"rows_total": 1},
            "planning": {"rows_total": 1},
            "awd": {"rows_total": 1},
            "awd_replenishments": {"orders_found": 1},
            "inbound_shipments": {"shipments_found": 1},
            "awd_inbound": {"rows_total": 1},
            "errors": ["fba_summaries: 500"],
        },
    )
    monkeypatch.setattr("src.inventory.holiday_surge.approaching_peak", lambda: False)
    monkeypatch.setattr(
        "src.inventory.velocity.compute_velocity",
        lambda **k: {"skus": 1, "avg_forward_mult": 1.0},
    )
    monkeypatch.setattr(
        "src.inventory.rate_signals.sync_sku_signals",
        lambda: {"skus": 1},
    )
    monkeypatch.setattr("src.inventory.freshness.collect_skip_reasons", lambda results: [])

    main_mod._run_inventory_sync()
    assert finishes[0] == "fail"
