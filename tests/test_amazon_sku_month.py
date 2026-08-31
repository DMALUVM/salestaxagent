"""Current-month Amazon SKU backfill — window, scheduler, no Shopify."""
from __future__ import annotations

import inspect
from datetime import date

from src.amazon_sp.reports import _date_chunks
from src.rules import current_month_sku_range


def test_current_month_window_is_month_start_through_as_of():
    start, end = current_month_sku_range(date(2026, 8, 30))
    assert start == date(2026, 8, 1)
    assert end == date(2026, 8, 30)
    assert start != date(2025, 1, 1)
    assert len(_date_chunks(start, end)) == 1


def test_window_never_uses_cli_default_start():
    for as_of in (date(2026, 8, 1), date(2026, 8, 31), date(2026, 9, 1)):
        start, end = current_month_sku_range(as_of)
        assert start == as_of.replace(day=1)
        assert end == as_of
        assert (end - start).days <= 31
        if as_of.month != 1 or as_of.year != 2025:
            assert start != date(2025, 1, 1)


def test_scheduler_registers_amazon_sku_month_at_0620():
    from pathlib import Path
    src = Path(__file__).resolve().parent.parent.joinpath("src", "main.py").read_text()
    assert 'id="amazon_sku_month"' in src
    assert "minute=20" in src
    assert "_run_amazon_sku_month" in src
    sched = src[src.index("def run("):src.index("def _run_spapi_refresh")]
    assert 'id="amazon_sku_month"' in sched
    assert "minute=20" in sched
    job = sched[sched.index("_run_amazon_sku_month"):sched.index('id="amazon_sku_month"') + 30]
    assert "hour=6" in job
    assert "minute=20" in job
    assert "backfill-shopify-skus" not in sched
    assert "fetch_shopify_skus" not in sched


def test_runner_uses_current_month_range_and_records_job_runs():
    from src.main import _run_amazon_sku_month
    src = inspect.getsource(_run_amazon_sku_month)
    assert "current_month_sku_range" in src
    assert "fetch_amazon_skus(start, end)" in src
    assert 'job_start("amazon_sku_month")' in src
    assert "job_finish" in src
    assert "_all_orders_busy" in src
    assert "2025-01-01" not in src or "refusing" in src
    assert "shopify" not in src.lower() or "not scheduled" in src.lower()


def test_runner_skips_when_all_orders_already_running(monkeypatch):
    from src import main as mainmod

    calls = {"finish": []}

    monkeypatch.setattr(mainmod, "_all_orders_busy", lambda exclude_run_id=None: "spapi_refresh")
    monkeypatch.setattr("src.db.job_start", lambda name: "run-1")

    def fake_finish(run_id, status="success", message=None, stats=None):
        calls["finish"].append((run_id, status, message, stats))

    monkeypatch.setattr("src.db.job_finish", fake_finish)

    def boom(*_a, **_k):
        raise AssertionError("must not request All Orders while one is running")

    monkeypatch.setattr("src.amazon_sp.reports.fetch_amazon_skus", boom)
    monkeypatch.setattr("src.rules.current_month_sku_range",
                        lambda as_of=None: (date(2026, 8, 1), date(2026, 8, 30)))

    mainmod._run_amazon_sku_month()
    assert calls["finish"]
    assert calls["finish"][0][1] == "skipped"
    assert "spapi_refresh" in (calls["finish"][0][2] or "")


def test_runner_passes_current_month_to_fetch(monkeypatch):
    from src import main as mainmod

    captured = {}
    monkeypatch.setattr(mainmod, "_all_orders_busy", lambda exclude_run_id=None: None)
    monkeypatch.setattr("src.db.job_start", lambda name: "run-2")
    monkeypatch.setattr("src.db.job_finish", lambda *a, **k: None)
    monkeypatch.setattr("src.rules.current_month_sku_range",
                        lambda as_of=None: (date(2026, 8, 1), date(2026, 8, 30)))

    def fake_fetch(start, end, dry_run=False, on_poll=None):
        captured["start"] = start
        captured["end"] = end
        return {"chunks": 1, "rows_inserted": 12, "unique_skus": 8, "sku_rows": 12}

    monkeypatch.setattr("src.amazon_sp.reports.fetch_amazon_skus", fake_fetch)
    mainmod._run_amazon_sku_month()
    assert captured["start"] == date(2026, 8, 1)
    assert captured["end"] == date(2026, 8, 30)
    assert captured["start"] != date(2025, 1, 1)
