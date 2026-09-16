"""Prior-day ads fast path + Iris CLEAR/HOLD completeness gate."""
from datetime import date

from src.amazon_ads.completeness import (
    STATUS_CLEAR,
    STATUS_HOLD,
    completeness_from_types,
    run_prior_day_gate,
)


AS_OF = date(2026, 9, 15)


def test_completeness_clear_when_sp_sb_sd_present():
    snap = completeness_from_types(AS_OF, {"SP", "SB", "SD"})
    assert snap.status == STATUS_CLEAR
    assert snap.has_sp and snap.has_sb and snap.has_sd
    assert "SP+SB+SD" in snap.reason


def test_completeness_hold_when_sd_missing():
    snap = completeness_from_types(AS_OF, {"SP", "SB"})
    assert snap.status == STATUS_HOLD
    assert snap.has_sp and snap.has_sb
    assert snap.has_sd is False
    assert "SD" in snap.reason


def test_completeness_hold_when_sb_missing():
    snap = completeness_from_types(AS_OF, {"SP", "SD"})
    assert snap.status == STATUS_HOLD
    assert "SB" in snap.reason


def test_completeness_hold_when_day_empty():
    snap = completeness_from_types(AS_OF, set())
    assert snap.status == STATUS_HOLD
    assert not (snap.has_sp or snap.has_sb or snap.has_sd)
    assert "no campaign rows" in snap.reason


def test_gate_skips_heal_when_lease_busy(monkeypatch):
    persisted = []
    monkeypatch.setattr(
        "src.amazon_ads.completeness.persist_day_completeness",
        lambda snap: persisted.append(snap) or True,
    )
    heal_calls = []
    prior_calls = []

    out = run_prior_day_gate(
        as_of=AS_OF,
        load_types=lambda _d: {"SP", "SB"},
        lease_free=lambda: False,
        heal=lambda **k: heal_calls.append(k) or {"healed": True},
        sync_prior_day=lambda: prior_calls.append(1) or {"healed": True},
    )

    assert out["action"] == "hold_lease_busy"
    assert out["healed"] is False
    assert heal_calls == []
    assert prior_calls == []
    assert persisted and persisted[0].status == STATUS_HOLD
    assert "lease held" in persisted[0].reason
    assert "missing SD" in persisted[0].reason


def test_gate_clears_without_heal_when_complete(monkeypatch):
    persisted = []
    monkeypatch.setattr(
        "src.amazon_ads.completeness.persist_day_completeness",
        lambda snap: persisted.append(snap) or True,
    )
    heal_calls = []

    out = run_prior_day_gate(
        as_of=AS_OF,
        load_types=lambda _d: {"SP", "SB", "SD"},
        lease_free=lambda: True,
        heal=lambda **k: heal_calls.append(k) or {"healed": True},
    )

    assert out["action"] == "clear"
    assert out["completeness"]["status"] == STATUS_CLEAR
    assert heal_calls == []
    assert persisted[0].status == STATUS_CLEAR


def test_gate_heals_once_when_lease_free(monkeypatch):
    persisted = []
    monkeypatch.setattr(
        "src.amazon_ads.completeness.persist_day_completeness",
        lambda snap: persisted.append(snap) or True,
    )
    types = {"SP", "SB"}

    def load(_d):
        return set(types)

    def heal(**k):
        assert k.get("lookback_days") == 1
        types.add("SD")
        return {"healed": True, "products": ["SD"]}

    out = run_prior_day_gate(
        as_of=AS_OF,
        load_types=load,
        lease_free=lambda: True,
        heal=heal,
    )

    assert out["action"] == "healed"
    assert out["completeness"]["status"] == STATUS_CLEAR
    assert persisted[-1].status == STATUS_CLEAR


def test_gate_empty_day_uses_prior_day_pull(monkeypatch):
    persisted = []
    monkeypatch.setattr(
        "src.amazon_ads.completeness.persist_day_completeness",
        lambda snap: persisted.append(snap) or True,
    )
    types: set[str] = set()

    def load(_d):
        return set(types)

    heal_calls = []

    def prior():
        types.update({"SP", "SB", "SD"})
        return {"healed": True, "reason": "empty prior day"}

    out = run_prior_day_gate(
        as_of=AS_OF,
        load_types=load,
        lease_free=lambda: True,
        heal=lambda **k: heal_calls.append(k),
        sync_prior_day=prior,
    )

    assert heal_calls == []
    assert out["completeness"]["status"] == STATUS_CLEAR
    assert persisted[-1].status == STATUS_CLEAR


def test_gate_ads_sync_busy_writes_hold_no_wait(monkeypatch):
    from src.amazon_ads.reports import AdsSyncBusy

    persisted = []
    monkeypatch.setattr(
        "src.amazon_ads.completeness.persist_day_completeness",
        lambda snap: persisted.append(snap) or True,
    )

    def boom(**k):
        raise AdsSyncBusy("another ads pull is running")

    out = run_prior_day_gate(
        as_of=AS_OF,
        load_types=lambda _d: {"SP"},
        lease_free=lambda: True,
        heal=boom,
    )

    assert out["action"] == "hold_lease_busy"
    assert persisted[0].status == STATUS_HOLD
    assert "lease held" in persisted[0].reason


def test_prior_day_fast_path_runs_before_lookback(monkeypatch):
    """Nightly campaigns: 1-day SP+SB+SD, then the existing 7d lookback."""
    import src.amazon_ads.reports as reports

    calls: list[tuple] = []

    def fake_fetch(start, end, **kw):
        calls.append((
            start, end,
            kw.get("sb_sd_independent"),
            kw.get("sb_sd_days"),
            kw.get("chunk_days"),
        ))
        return {"rows": 1, "by_type": {}, "errors": []}

    monkeypatch.setattr(reports, "amazon_as_of", lambda: AS_OF)
    monkeypatch.setattr(reports, "fetch_campaigns_daily", fake_fetch)
    monkeypatch.setattr(reports, "_refresh_prior_day_completeness",
                        lambda *a, **k: None)
    monkeypatch.setattr(reports, "claim_ads_lease", lambda job=None: True)
    monkeypatch.setattr(reports, "release_ads_lease", lambda: None)
    monkeypatch.setattr(reports, "fail_stale_ads_job_runs", lambda: [])
    monkeypatch.setattr(reports, "beat_ads_lease", lambda: None)
    acquired = reports._SYNC_LOCK.acquire(blocking=False)
    if acquired:
        reports._SYNC_LOCK.release()

    result = reports.sync_ads(
        days=7, campaigns_only=True, prior_day_first=True)

    assert "prior_day" in result
    assert "campaigns" in result
    assert len(calls) == 2
    prior_start, prior_end, independent, prior_sb_sd, prior_chunk = calls[0]
    look_start, look_end, look_ind, look_sb_sd, look_chunk = calls[1]
    assert prior_start == prior_end == AS_OF
    assert independent is True
    assert prior_sb_sd == 1
    assert prior_chunk == 1
    assert look_start == date(2026, 9, 9)
    assert look_end == AS_OF
    assert look_ind is None  # lookback keeps default sb_sd_stop
    assert look_sb_sd is None


def test_prior_day_helper_is_one_day_independent(monkeypatch):
    import src.amazon_ads.reports as reports

    seen = {}

    def fake_fetch(start, end, **kw):
        seen["start"] = start
        seen["end"] = end
        seen.update(kw)
        return {"rows": 3}

    monkeypatch.setattr(reports, "fetch_campaigns_daily", fake_fetch)
    reports.fetch_prior_day_campaigns(AS_OF)
    assert seen["start"] == seen["end"] == AS_OF
    assert seen["chunk_days"] == 1
    assert seen["sb_sd_days"] == 1
    assert seen["sb_sd_independent"] is True


def test_sb_sd_independent_still_fetches_sd_after_sb_timeout(monkeypatch):
    import src.amazon_ads.reports as reports

    calls: list[str] = []

    def fake_chunk(cs, ce, product="SP"):
        calls.append(product)
        if product == "SB":
            raise TimeoutError("Report timed out after 900s")
        return [{"date": "2026-09-15", "campaignId": f"{product}-1",
                 "campaignName": product, "impressions": 1, "clicks": 1,
                 "spend": 1.0}]

    monkeypatch.setattr(reports, "_fetch_campaigns_chunk", fake_chunk)
    monkeypatch.setattr(reports, "upsert_rows",
                        lambda t, rows, on_conflict=None: len(rows))

    default = reports.fetch_campaigns_daily(AS_OF, AS_OF)
    assert "SD" not in default["products_ok"]
    assert calls.count("SD") == 0

    calls.clear()
    independent = reports.fetch_campaigns_daily(
        AS_OF, AS_OF, sb_sd_independent=True)
    assert "SD" in independent["products_ok"]
    assert "SD" in calls


def test_nightly_wrapper_requests_prior_day_first():
    import inspect
    from src.main import _run_ads_campaigns_sync, _run_ads_sync_job

    src = inspect.getsource(_run_ads_campaigns_sync)
    assert "prior_day_first=True" in src
    job = inspect.getsource(_run_ads_sync_job)
    assert "prior_day_first=prior_day_first" in job
