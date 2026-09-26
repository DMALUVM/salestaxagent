"""Failure-only Mini health check. HTTP and Supabase are mocked."""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.maintenance import healthcheck_wake as hw
from src.maintenance import restart_pending as rp
from src.maintenance.job_schedule import (
    EXCLUDED_SCHEDULER_IDS,
    JobSpec,
    build_job_specs,
    required_started_at,
    sqp_schedule_enabled,
)

ROOT = Path(__file__).resolve().parent.parent
ET = ZoneInfo("America/New_York")


@pytest.fixture(autouse=True)
def _isolate_restart_marker(tmp_path, monkeypatch):
    monkeypatch.setattr(rp, "MARKER_PATH", tmp_path / "restart_pending.json")
# Friday 2026-09-25 07:20 ET (EDT, UTC-4).
NOW = datetime(2026, 9, 25, 11, 20, tzinfo=timezone.utc)
WEBHOOK_ENV = {
    "GROKBOT_HEALTH_WEBHOOK_URL": "https://ops.example/hook",
    "GROKBOT_HEALTH_WEBHOOK_KEY": "sekret",
}


def _spec(name, hour, minute, grace=3600, gate=None, dow=None, tz="America/New_York"):
    dows = None
    if dow is not None:
        dows = (dow,)
    return JobSpec(
        name=name,
        minutes=(minute,),
        hours=(hour,),
        dows=dows,
        timezone=tz,
        misfire_grace_seconds=grace,
        gate=gate,
    )


def _row(name, status, started, message="ok"):
    if isinstance(started, datetime):
        started = started.astimezone(timezone.utc).isoformat()
    return {
        "job_name": name,
        "status": status,
        "message": message,
        "started_at": started,
    }


def _fresh_rows(specs, gates, now):
    rows = []
    for spec in specs:
        if spec.gate is not None and not gates.get(spec.gate):
            continue
        started = required_started_at(spec, now) + timedelta(minutes=1)
        rows.append(_row(spec.name, "success", started))
    return rows


class _Resp:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status = status

    def read(self):
        if isinstance(self._payload, bytes):
            return self._payload
        return json.dumps(self._payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _Query:
    def __init__(self, rows, calls):
        self.rows = list(rows)
        self.calls = calls
        self._eq = None
        self._limit = None

    def select(self, cols):
        self.calls.append(("select", cols))
        return self

    def gte(self, col, val):
        self.calls.append(("gte", col, val))
        return self

    def eq(self, col, val):
        self.calls.append(("eq", col, val))
        self._eq = (col, val)
        return self

    def order(self, col, desc=False):
        self.calls.append(("order", col, desc))
        return self

    def range(self, start, end):
        self.calls.append(("range", start, end))
        return self

    def limit(self, n):
        self.calls.append(("limit", n))
        self._limit = n
        return self

    def insert(self, *args, **kwargs):
        raise AssertionError("job_runs insert")

    def update(self, *args, **kwargs):
        raise AssertionError("job_runs update")

    def upsert(self, *args, **kwargs):
        raise AssertionError("upsert")

    def delete(self, *args, **kwargs):
        raise AssertionError("delete")

    def execute(self):
        data = list(self.rows)
        if self._eq:
            col, val = self._eq
            data = [r for r in data if r.get(col) == val]
        if self._limit is not None:
            data = data[: self._limit]
        return SimpleNamespace(data=data)


class _Client:
    def __init__(self, tables):
        self.tables = tables
        self.calls = []

    def table(self, name):
        self.calls.append(name)
        return _Query(self.tables.get(name, []), self.calls)


def _execute(env, *, specs, gates, rows, vercel_payload=None, vercel_error=None,
             git_result=None, kick_ok=True, completeness=None, as_of_day=None,
             post=None, fetch_completeness=None, fetch_runs=None, now=NOW):
    posts = []
    kickstarts = []
    git_calls = []
    vercel_calls = []
    completeness_calls = []

    def fetch_vercel(url, token):
        vercel_calls.append((url, token))
        if vercel_error:
            raise RuntimeError(vercel_error)
        return vercel_payload or {"deployments": []}

    def git_update():
        git_calls.append(True)
        return git_result if git_result is not None else {"status": "up_to_date"}

    def kickstart():
        kickstarts.append(True)
        if kick_ok:
            return True, ""
        return False, "gui/501/com.tallowbourn.salestax: service not found"

    def fetch_job_runs(_now):
        if fetch_runs is not None:
            return fetch_runs(_now)
        return rows

    def fetch_day(day):
        completeness_calls.append(day)
        if fetch_completeness is not None:
            return fetch_completeness(day)
        return completeness

    def post_webhook(url, payload, header, value):
        posts.append((url, payload, header, value))
        if post is not None:
            post(url, payload, header, value)

    code = hw.execute(
        env,
        now=now,
        specs=specs,
        gates=gates,
        fetch_job_runs=fetch_job_runs,
        fetch_completeness=fetch_day,
        fetch_vercel=fetch_vercel,
        git_update=git_update,
        kickstart=kickstart,
        post_webhook=post_webhook,
        as_of=lambda _now: as_of_day or __import__("datetime").date(2026, 9, 24),
    )
    return SimpleNamespace(
        code=code,
        posts=posts,
        kickstarts=kickstarts,
        git_calls=git_calls,
        vercel_calls=vercel_calls,
        completeness_calls=completeness_calls,
    )


def test_launchd_plist_is_0723_and_does_not_keepalive():
    import plistlib
    path = ROOT / "deploy" / "launchd" / "com.tallowbourn.healthcheck.plist"
    plist = plistlib.loads(path.read_bytes())
    assert plist["Label"] == "com.tallowbourn.healthcheck"
    # 07:23 is off every scheduled job minute (ga4_sync is 07:20, gsc is 07:25).
    assert plist["StartCalendarInterval"] == {"Hour": 7, "Minute": 23}
    assert "KeepAlive" not in plist
    assert "RunAtLoad" not in plist
    assert plist["ProgramArguments"][-1].endswith("scripts/healthcheck_wake.py")
    script = (ROOT / "deploy" / "launchd" / "install-healthcheck.sh").read_text()
    assert "GROKBOT_HEALTH_WEBHOOK_URL" in script
    assert "GROKBOT_HEALTH_WEBHOOK_KEY" in script
    assert "com.tallowbourn.salestax" in script
    for spec in build_job_specs():
        if spec.interval_seconds:
            continue
        assert not (7 in spec.hours and 23 in spec.minutes), spec.name


def test_scheduler_ids_match_healthcheck_catalog():
    text = (ROOT / "src" / "main.py").read_text()
    ids = set()
    for match in re.finditer(r"add_job\(", text):
        window = text[match.start(): match.start() + 800]
        found = re.search(r'id="([a-z0-9_]+)"', window)
        if found:
            ids.add(found.group(1))
    specs = build_job_specs()
    assert sqp_schedule_enabled() is True
    assert ids == {s.name for s in specs} | set(EXCLUDED_SCHEDULER_IDS)


def test_freshness_windows_follow_cron_and_grace():
    specs = {s.name: s for s in build_job_specs()}

    campaigns = required_started_at(specs["ads_campaigns_sync"], NOW).astimezone(ET)
    assert (campaigns.hour, campaigns.minute, campaigns.date().isoformat()) == (5, 0, "2026-09-25")

    # 07:35 is still in the future at 07:20, and today's slot is inside grace
    # only after it fires. Yesterday's run is the one that must exist.
    meta = required_started_at(specs["meta_ads_sync"], NOW).astimezone(ET)
    assert (meta.hour, meta.minute, meta.date().isoformat()) == (7, 35, "2026-09-24")

    # 07:15 fired 5 minutes ago but misfire grace is 3600s, so yesterday counts.
    funnel = required_started_at(specs["shopify_funnel_sync"], NOW).astimezone(ET)
    assert (funnel.hour, funnel.minute, funnel.date().isoformat()) == (7, 15, "2026-09-24")

    gno = required_started_at(specs["ads_gno_campaigns_sync"], NOW).astimezone(ET)
    assert (gno.hour, gno.minute, gno.date().isoformat()) == (1, 0, "2026-09-25")

    backfill = required_started_at(specs["ads_campaigns_backfill"], NOW).astimezone(ET)
    assert backfill.date().isoformat() == "2026-09-20"
    assert (backfill.hour, backfill.minute) == (3, 0)

    sqp = required_started_at(specs["sqp_sync"], NOW).astimezone(ZoneInfo("America/Los_Angeles"))
    assert sqp.date().isoformat() == "2026-09-21"
    assert (sqp.hour, sqp.minute) == (10, 0)


def test_healthy_run_is_silent_and_does_not_post():
    specs = build_job_specs()
    gates = {name: True for name in ("shopify", "amazon_sp", "amazon_ads", "sqp",
                                     "ga4", "gsc", "google_ads", "meta_ads", "git")}
    rows = _fresh_rows(specs, gates, NOW)
    out = _execute(
        {**WEBHOOK_ENV, "VERCEL_TOKEN": "vtok"},
        specs=specs,
        gates=gates,
        rows=rows,
        vercel_payload={"deployments": [{
            "uid": "dpl_ok", "target": "production", "readyState": "READY", "created": 3,
        }]},
        completeness={"date": "2026-09-24", "status": "CLEAR", "reason": "prior-day SP+SB+SD present"},
    )
    assert out.code == 0
    assert out.posts == []
    assert out.kickstarts == []
    assert out.git_calls == [True]
    assert out.vercel_calls
    assert "vtok" == out.vercel_calls[0][1]
    assert "projectId=dashboard" in out.vercel_calls[0][0]
    assert "target=production" in out.vercel_calls[0][0]


def test_missing_webhook_logs_once_and_exits_nonzero(caplog):
    caplog.set_level("ERROR")
    out = _execute({}, specs=[], gates={}, rows=[])
    assert out.code == 2
    assert out.posts == []
    assert out.git_calls == []
    assert out.vercel_calls == []
    assert caplog.records
    assert "GROKBOT_HEALTH_WEBHOOK_URL" in caplog.records[0].message
    assert len([r for r in caplog.records if "GROKBOT_HEALTH_WEBHOOK_URL" in r.message]) == 1


def test_missing_webhook_key_exits_nonzero():
    out = _execute(
        {"GROKBOT_HEALTH_WEBHOOK_URL": "https://ops.example/hook"},
        specs=[], gates={}, rows=[],
    )
    assert out.code == 2
    assert out.posts == []


def test_vercel_skip_without_token_is_not_a_failure(caplog):
    caplog.set_level("WARNING")
    spec = _spec("daily_analysis", 8, 0, grace=1)
    required = required_started_at(spec, NOW)
    rows = [_row("daily_analysis", "success", required + timedelta(minutes=1))]
    # Before the ads deadline so completeness is not due.
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)  # 06:00 ET
    out = _execute(
        WEBHOOK_ENV,
        specs=[spec],
        gates={},
        rows=rows,
        now=early,
    )
    assert out.code == 0
    assert out.vercel_calls == []
    assert out.posts == []
    assert any("VERCEL_TOKEN" in r.message for r in caplog.records)


def test_vercel_error_state_is_reported():
    spec = _spec("daily_analysis", 8, 0, grace=1)
    rows = [_row("daily_analysis", "success", required_started_at(spec, NOW))]
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
    out = _execute(
        {**WEBHOOK_ENV, "VERCEL_TOKEN": "vtok", "VERCEL_ORG_ID": "team_abc"},
        specs=[spec],
        gates={},
        rows=rows,
        now=early,
        vercel_payload={"deployments": [{
            "uid": "dpl_bad", "target": "production", "readyState": "ERROR", "created": 9,
        }]},
    )
    assert out.code == 1
    assert "teamId=team_abc" in out.vercel_calls[0][0]
    body = out.posts[0][1]
    assert body["failures"] == [{
        "check": "vercel",
        "detail": "latest production deployment dpl_bad is ERROR",
    }]
    assert out.posts[0][2] == "Authorization"
    assert out.posts[0][3] == "Bearer sekret"


def test_vercel_request_error_is_a_failure():
    spec = _spec("daily_analysis", 8, 0, grace=1)
    rows = [_row("daily_analysis", "success", required_started_at(spec, NOW))]
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
    out = _execute(
        {**WEBHOOK_ENV, "VERCEL_ACCESS_TOKEN": "other"},
        specs=[spec],
        gates={},
        rows=rows,
        now=early,
        vercel_error="Vercel HTTP 403: forbidden",
    )
    assert out.code == 1
    assert out.vercel_calls[0][1] == "other"
    assert "403" in out.posts[0][1]["failures"][0]["detail"]


def test_meta_token_failure_includes_message_and_skips_busy_row():
    meta = _spec("meta_ads_sync", 7, 35, grace=3600, gate="meta_ads")
    terms = _spec("ads_search_terms_sync", 5, 30, grace=3600, gate="amazon_ads")
    meta_at = required_started_at(meta, NOW) + timedelta(minutes=2)
    terms_ok = required_started_at(terms, NOW) + timedelta(minutes=5)
    rows = [
        _row("meta_ads_sync", "fail", meta_at, "Meta access token expired"),
        _row("ads_search_terms_sync", "success", terms_ok, "7d search terms"),
        _row(
            "ads_search_terms_sync",
            "skipped",
            terms_ok + timedelta(minutes=30),
            "skipped / another ads pull is running",
        ),
    ]
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
    out = _execute(
        {**WEBHOOK_ENV, "VERCEL_TOKEN": "vtok"},
        specs=[meta, terms],
        gates={"meta_ads": True, "amazon_ads": True},
        rows=rows,
        now=early,
        vercel_payload={"deployments": [{
            "uid": "dpl_ok", "target": "production", "state": "READY", "created": 1,
        }]},
    )
    assert out.code == 1
    checks = out.posts[0][1]["failures"]
    assert len(checks) == 1
    assert checks[0]["check"] == "job:meta_ads_sync"
    assert "Meta access token expired" in checks[0]["detail"]
    assert "ads_search_terms_sync" not in checks[0]["detail"]


def test_restart_interrupt_does_not_hide_or_become_a_failure():
    spec = _spec("ads_campaigns_sync", 5, 0, grace=3600)
    started = required_started_at(spec, NOW) + timedelta(minutes=1)
    rows = [
        _row(spec.name, "success", started, "campaigns ok"),
        _row(
            spec.name,
            "fail",
            started + timedelta(minutes=20),
            "interrupted before job_finish",
        ),
    ]
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
    out = _execute(WEBHOOK_ENV, specs=[spec], gates={}, rows=rows, now=early)
    assert out.code == 0
    assert out.posts == []


def test_partial_and_in_flight_running_are_not_failures():
    spec = _spec("ads_search_terms_sync", 5, 30, grace=3600)
    started = required_started_at(spec, NOW) + timedelta(minutes=1)
    rows = [_row(spec.name, "partial", started, "search_terms partial")]
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
    out = _execute(WEBHOOK_ENV, specs=[spec], gates={}, rows=rows, now=early)
    assert out.code == 0

    rows = [_row(spec.name, "running", started, "")]
    out = _execute(WEBHOOK_ENV, specs=[spec], gates={}, rows=rows, now=early)
    assert out.code == 0


def test_stale_success_is_a_failure():
    spec = _spec("ads_campaigns_sync", 5, 0, grace=3600)
    yesterday = required_started_at(spec, NOW) - timedelta(days=1)
    rows = [_row(spec.name, "success", yesterday, "ok")]
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
    out = _execute(WEBHOOK_ENV, specs=[spec], gates={}, rows=rows, now=early)
    assert out.code == 1
    detail = out.posts[0][1]["failures"][0]["detail"]
    assert "stale" in detail
    assert spec.name == "ads_campaigns_sync"


def test_unscheduled_connector_is_not_required():
    meta = _spec("meta_ads_sync", 7, 35, grace=3600, gate="meta_ads")
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
    out = _execute(
        WEBHOOK_ENV,
        specs=[meta],
        gates={"meta_ads": False},
        rows=[],
        now=early,
    )
    assert out.code == 0
    assert out.posts == []


def test_completeness_hold_after_deadline_includes_reason():
    spec = _spec("daily_analysis", 8, 0, grace=1)
    rows = [_row(spec.name, "success", required_started_at(spec, NOW))]
    out = _execute(
        {**WEBHOOK_ENV, "GROKBOT_ADS_CLEAR_DEADLINE": "07:15"},
        specs=[spec],
        gates={},
        rows=rows,
        now=NOW,
        completeness={
            "date": "2026-09-24",
            "status": "HOLD",
            "reason": "missing SD",
        },
    )
    assert out.code == 1
    found = out.posts[0][1]["failures"]
    assert found == [{
        "check": "ads_day_completeness",
        "detail": "2026-09-24 status=HOLD reason=missing SD",
    }]
    assert out.completeness_calls


def test_completeness_before_deadline_does_not_fail_or_query():
    spec = _spec("daily_analysis", 8, 0, grace=1)
    # 07:00 ET is before 07:15. daily_analysis 08:00 has not fired today;
    # yesterday's success is inside the 1s grace only if we're before today's
    # slot. 07:00 is before 08:00, so yesterday 08:00 is required.
    now = datetime(2026, 9, 25, 11, 0, tzinfo=timezone.utc)
    rows = [_row(spec.name, "success", required_started_at(spec, now))]
    out = _execute(
        WEBHOOK_ENV,
        specs=[spec],
        gates={},
        rows=rows,
        now=now,
        completeness={"date": "2026-09-24", "status": "HOLD", "reason": "missing SD"},
    )
    assert out.code == 0
    assert out.completeness_calls == []
    assert out.posts == []


def test_custom_webhook_header_and_compact_body(monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout=30):
        seen["data"] = req.data
        seen["headers"] = dict(req.header_items())
        return _Resp(b"")

    monkeypatch.setattr(hw.urllib.request, "urlopen", fake_urlopen)
    payload = {"checked_at": "2026-09-25T11:20:00+00:00", "failures": [{"check": "vercel", "detail": "ERROR"}]}
    hw.post_json("https://ops.example/hook", payload, "X-Grok-Key", "sekret")
    assert seen["data"] == json.dumps(payload, separators=(",", ":")).encode()
    headers = {k.lower(): v for k, v in seen["headers"].items()}
    assert headers["x-grok-key"] == "sekret"


def test_header_template_replaces_key():
    name, value = hw.parse_webhook_header("Authorization: Bearer <key>", "sekret")
    assert (name, value) == ("Authorization", "Bearer sekret")
    name, value = hw.parse_webhook_header("X-Grok-Key", "sekret")
    assert (name, value) == ("X-Grok-Key", "sekret")


def test_running_row_fails_after_per_job_max_runtime(monkeypatch):
    """Short jobs are 1h. Ads pulls and long SP-API jobs use the 4h lock TTL."""
    monkeypatch.setattr(
        "src.amazon_ads.sync_lock.read_lease", lambda path=None: None,
    )
    ga4 = _spec("ga4_sync", 7, 20, grace=3600, gate="ga4")
    ads = _spec("ads_search_terms_sync", 5, 30, grace=3600)
    spapi = _spec("spapi_refresh", 6, 0, grace=1, gate="amazon_sp")
    ledger = _spec("inventory_ledger_backfill", 4, 0, grace=7200, gate="amazon_sp", dow=6)
    now = datetime(2026, 9, 25, 11, 23, tzinfo=timezone.utc)  # 07:23 ET

    assert hw.evaluate_job(
        ga4, [_row("ga4_sync", "running", now - timedelta(minutes=59))], now,
    ) is None
    hung_ga4 = hw.evaluate_job(
        ga4, [_row("ga4_sync", "running", now - timedelta(hours=1, minutes=1))], now,
    )
    assert hung_ga4 is not None
    assert hung_ga4.check == "job:ga4_sync"
    assert "older than 1h" in hung_ga4.detail

    assert hw.evaluate_job(
        ads, [_row("ads_search_terms_sync", "running", now - timedelta(hours=3, minutes=59))], now,
    ) is None
    hung_ads = hw.evaluate_job(
        ads, [_row("ads_search_terms_sync", "running", now - timedelta(hours=4, minutes=1))], now,
    )
    assert hung_ads is not None
    assert "older than 4h" in hung_ads.detail

    # 06:00 spapi_refresh still running at 07:23 is inside the 4h TTL.
    assert hw.evaluate_job(
        spapi, [_row("spapi_refresh", "running", now - timedelta(hours=2))], now,
    ) is None
    hung_spapi = hw.evaluate_job(
        spapi, [_row("spapi_refresh", "running", now - timedelta(hours=4, minutes=1))], now,
    )
    assert hung_spapi is not None
    assert "older than 4h" in hung_spapi.detail

    # Sunday 04:00 ledger backfill is still in flight at 07:23 (3h23m).
    assert hw.evaluate_job(
        ledger,
        [_row("inventory_ledger_backfill", "running", now - timedelta(hours=3, minutes=23))],
        now,
    ) is None

    # Yesterday's success still covers a slot inside misfire grace.
    yesterday = now - timedelta(days=1)
    assert hw.evaluate_job(
        ga4, [_row("ga4_sync", "success", yesterday, "ok")], now,
    ) is None


def test_fresh_job_runs_heartbeat_keeps_a_long_run_healthy(monkeypatch):
    monkeypatch.setattr(
        "src.amazon_ads.sync_lock.read_lease", lambda path=None: None,
    )
    ads = _spec("ads_campaigns_sync", 5, 0, grace=3600)
    now = datetime(2026, 9, 25, 11, 23, tzinfo=timezone.utc)
    started = now - timedelta(hours=5)
    row = _row("ads_campaigns_sync", "running", started, "")
    row["heartbeat_at"] = (now - timedelta(minutes=1)).isoformat()
    assert hw.evaluate_job(ads, [row], now) is None

    stale = _row("ads_campaigns_sync", "running", started, "")
    stale["heartbeat_at"] = (now - timedelta(minutes=20)).isoformat()
    found = hw.evaluate_job(ads, [stale], now)
    assert found is not None
    assert "older than 4h" in found.detail

    via_stats = _row("ads_campaigns_sync", "running", started, "")
    via_stats["stats"] = json.dumps({
        "heartbeat_at": (now - timedelta(minutes=2)).isoformat(),
    })
    assert hw.evaluate_job(ads, [via_stats], now) is None


def test_live_ads_lock_heartbeat_keeps_a_sunday_backfill_healthy(monkeypatch):
    """job_runs has no mid-run beat. The lock file does."""
    spec = _spec("ads_campaigns_backfill", 3, 0, grace=7200, gate="amazon_ads", dow=6)
    now = datetime(2026, 9, 27, 11, 23, tzinfo=timezone.utc)  # Sunday 07:23 ET
    started = now - timedelta(hours=5)
    row = _row("ads_campaigns_backfill", "running", started, "")
    lease = {
        "pid": 4242,
        "job": "ads_campaigns_backfill",
        "started_at": (started + timedelta(seconds=2)).isoformat(),
        "heartbeat_at": (now - timedelta(minutes=1)).isoformat(),
    }
    monkeypatch.setattr("src.amazon_ads.sync_lock.read_lease", lambda path=None: lease)
    monkeypatch.setattr("src.amazon_ads.sync_lock.pid_is_alive", lambda pid: pid == 4242)
    assert hw.evaluate_job(spec, [row], now) is None

    stale = dict(lease)
    stale["heartbeat_at"] = (now - timedelta(minutes=20)).isoformat()
    monkeypatch.setattr("src.amazon_ads.sync_lock.read_lease", lambda path=None: stale)
    hung = hw.evaluate_job(spec, [row], now)
    assert hung is not None
    assert "older than 4h" in hung.detail

    other = dict(lease)
    other["job"] = "ads_search_terms_sync"
    monkeypatch.setattr("src.amazon_ads.sync_lock.read_lease", lambda path=None: other)
    assert hw.evaluate_job(spec, [row], now) is not None


def test_any_running_row_skips_kickstart_without_a_report():
    """A live job, including one this check does not score, blocks kickstart."""
    spec = _spec("daily_analysis", 8, 0, grace=1)
    now = datetime(2026, 9, 25, 11, 23, tzinfo=timezone.utc)  # 07:23 ET
    rows = [
        _row(spec.name, "success", required_started_at(spec, now)),
        _row("ga4_sync", "running", now - timedelta(minutes=2), ""),
    ]
    out = _execute(
        WEBHOOK_ENV,
        specs=[spec],
        gates={},
        rows=rows,
        now=now,
        git_result={"status": "updated", "message": "fast-forwarded"},
        completeness={"date": "2026-09-24", "status": "CLEAR", "reason": "ok"},
    )
    assert out.code == 0
    assert out.git_calls == []
    assert out.kickstarts == []
    assert out.posts == []
    assert hw.any_job_running(rows) is True
    assert hw.any_job_running(rows[:1]) is False
    assert hw.any_job_running([
        _row("git_auto_update", "running", now, ""),
        _row("healthcheck", "running", now, ""),
    ]) is False


def test_job_that_starts_during_the_pull_is_not_killed():
    spec = _spec("daily_analysis", 8, 0, grace=1)
    now = datetime(2026, 9, 25, 11, 23, tzinfo=timezone.utc)
    quiet = [_row(spec.name, "success", required_started_at(spec, now))]
    state = {"n": 0}

    def fetch(_now):
        state["n"] += 1
        # 1 = score the jobs, 2 = decide whether to pull, 3 = after the pull.
        if state["n"] < 3:
            return quiet
        return quiet + [_row("gsc_sync", "running", now, "")]

    out = _execute(
        WEBHOOK_ENV,
        specs=[spec],
        gates={},
        rows=[],
        now=now,
        git_result={"status": "updated"},
        fetch_runs=fetch,
        completeness={"date": "2026-09-24", "status": "CLEAR", "reason": "ok"},
    )
    assert state["n"] == 3
    assert out.git_calls == [True]
    assert out.kickstarts == []
    assert out.code == 0
    assert out.posts == []
    assert rp.restart_is_pending()


def test_deferred_restart_kickstarts_once_quiet():
    spec = _spec("daily_analysis", 8, 0, grace=1)
    now = datetime(2026, 9, 25, 11, 23, tzinfo=timezone.utc)
    quiet = [_row(spec.name, "success", required_started_at(spec, now))]
    rp.mark_restart_pending("bbb")
    out = _execute(
        WEBHOOK_ENV,
        specs=[spec],
        gates={},
        rows=quiet,
        now=now,
        git_result={"status": "up_to_date"},
        completeness={"date": "2026-09-24", "status": "CLEAR", "reason": "ok"},
    )
    assert out.code == 0
    assert out.kickstarts == [True]
    assert out.posts == []
    assert not rp.restart_is_pending()


def test_job_runs_reread_after_pull_is_a_failure():
    spec = _spec("daily_analysis", 8, 0, grace=1)
    now = datetime(2026, 9, 25, 11, 23, tzinfo=timezone.utc)
    quiet = [_row(spec.name, "success", required_started_at(spec, now))]
    state = {"n": 0}

    def fetch(_now):
        state["n"] += 1
        if state["n"] < 3:
            return quiet
        raise RuntimeError("supabase down")

    out = _execute(
        WEBHOOK_ENV,
        specs=[spec],
        gates={},
        rows=[],
        now=now,
        git_result={"status": "updated", "commit": "abc123"},
        fetch_runs=fetch,
        completeness={"date": "2026-09-24", "status": "CLEAR", "reason": "ok"},
    )
    assert out.kickstarts == []
    assert out.code == 1
    failures = out.posts[0][1]["failures"]
    assert [f["check"] for f in failures] == ["mini_checkout"]
    assert "re-read job_runs" in failures[0]["detail"]
    assert rp.restart_is_pending()


def test_stuck_running_is_reported_and_kickstart_stays_silent():
    ga4 = _spec("ga4_sync", 7, 20, grace=3600, gate="ga4")
    now = datetime(2026, 9, 25, 11, 23, tzinfo=timezone.utc)
    out = _execute(
        WEBHOOK_ENV,
        specs=[ga4],
        gates={"ga4": True},
        rows=[_row("ga4_sync", "running", now - timedelta(hours=2), "")],
        now=now,
        git_result={"status": "updated"},
        completeness={"date": "2026-09-24", "status": "CLEAR", "reason": "ok"},
    )
    assert out.kickstarts == []
    failures = out.posts[0][1]["failures"]
    assert [f["check"] for f in failures] == ["job:ga4_sync"]
    assert "older than 1h" in failures[0]["detail"]


def test_checkout_pull_and_kickstart_success_is_silent():
    spec = _spec("daily_analysis", 8, 0, grace=1)
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
    rows = [_row(spec.name, "success", required_started_at(spec, early))]
    out = _execute(
        WEBHOOK_ENV,
        specs=[spec],
        gates={},
        rows=rows,
        now=early,
        git_result={"status": "updated", "message": "fast-forwarded aaa → bbb"},
        kick_ok=True,
    )
    assert out.code == 0
    assert out.kickstarts == [True]
    assert out.posts == []


def test_checkout_kickstart_failure_is_reported_without_telegram():
    spec = _spec("daily_analysis", 8, 0, grace=1)
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
    rows = [_row(spec.name, "success", required_started_at(spec, early))]
    out = _execute(
        WEBHOOK_ENV,
        specs=[spec],
        gates={},
        rows=rows,
        now=early,
        git_result={"status": "updated"},
        kick_ok=False,
    )
    assert out.code == 1
    detail = out.posts[0][1]["failures"][0]
    assert detail["check"] == "mini_checkout"
    assert "kickstart failed" in detail["detail"]


def test_dirty_tree_does_not_kickstart():
    spec = _spec("daily_analysis", 8, 0, grace=1)
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
    rows = [_row(spec.name, "success", required_started_at(spec, early))]
    out = _execute(
        WEBHOOK_ENV,
        specs=[spec],
        gates={},
        rows=rows,
        now=early,
        git_result={"status": "dirty", "error": "tracked working tree has uncommitted changes — aborting; will not reset or stash"},
    )
    assert out.code == 1
    assert out.kickstarts == []
    assert "will not reset" in out.posts[0][1]["failures"][0]["detail"]


def test_checkout_helper_uses_ff_only_pull_without_restart_or_alert(monkeypatch):
    seen = {}

    def fake_update(**kwargs):
        seen.update(kwargs)
        return {"status": "up_to_date", "message": "already"}

    def boom(*args, **kwargs):
        raise AssertionError("alert_if_needed must not run from the health check")

    monkeypatch.setattr(
        "src.maintenance.git_auto_update.run_auto_update", fake_update,
    )
    monkeypatch.setattr(
        "src.maintenance.git_auto_update.alert_if_needed", boom,
    )
    assert hw.checkout_git_update()["status"] == "up_to_date"
    assert seen["restart"] is False
    assert seen["force"] is True


def test_kickstart_command(monkeypatch):
    seen = {}

    def fake_run(cmd, **kwargs):
        seen["cmd"] = cmd
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(hw.subprocess, "run", fake_run)
    ok, err = hw.kickstart_sync_agent("com.tallowbourn.salestax", uid=501)
    assert ok is True and err == ""
    assert seen["cmd"] == ["launchctl", "kickstart", "-k", "gui/501/com.tallowbourn.salestax"]


def test_supabase_reads_are_select_only():
    client = _Client({
        "job_runs": [
            _row("meta_ads_sync", "fail", "2026-09-25T11:35:00+00:00", "expired"),
            _row("daily_analysis", "success", "2026-09-24T12:00:00+00:00"),
        ],
        "ads_day_completeness": [
            {"date": "2026-09-24", "status": "CLEAR", "reason": "ok", "updated_at": "t"},
            {"date": "2026-09-23", "status": "HOLD", "reason": "old", "updated_at": "t"},
        ],
    })
    runs = hw.select_job_runs(client, NOW - timedelta(days=10))
    assert {r["job_name"] for r in runs} == {"meta_ads_sync", "daily_analysis"}
    row = hw.select_ads_day_completeness(client, __import__("datetime").date(2026, 9, 24))
    assert row["status"] == "CLEAR"
    assert hw.select_ads_day_completeness(client, __import__("datetime").date(2026, 9, 1)) is None
    kinds = [c[0] for c in client.calls if isinstance(c, tuple)]
    assert "select" in kinds
    assert "insert" not in kinds
    assert "update" not in kinds


def test_scheduler_startup_clears_a_pending_restart():
    text = (ROOT / "src" / "main.py").read_text()
    start = text.index("def run():")
    window = text[start:start + 800]
    assert "clear_restart_pending" in window


def test_module_does_not_touch_telegram_or_writes():
    source = (ROOT / "src" / "maintenance" / "healthcheck_wake.py").read_text()
    assert "send_telegram" not in source
    assert "src.alerts.telegram" not in source
    assert ".insert(" not in source
    assert ".update(" not in source
    assert ".upsert(" not in source
    assert ".delete(" not in source
    sys.modules.pop("src.alerts.telegram", None)
    import src.maintenance.healthcheck_wake as loaded
    assert "src.alerts.telegram" not in sys.modules
    assert loaded.main


def test_job_runs_read_error_is_one_failure():
    spec = _spec("meta_ads_sync", 7, 35, grace=3600, gate="meta_ads")
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)

    def boom(_now):
        raise RuntimeError("supabase down")

    out = _execute(
        WEBHOOK_ENV,
        specs=[spec],
        gates={"meta_ads": True},
        rows=[],
        now=early,
        fetch_runs=boom,
    )
    assert out.code == 1
    failures = out.posts[0][1]["failures"]
    assert len(failures) == 1
    assert failures[0]["check"] == "job_runs"
    assert "supabase down" in failures[0]["detail"]


def test_webhook_post_failure_exits_nonzero():
    spec = _spec("daily_analysis", 8, 0, grace=1)
    early = datetime(2026, 9, 25, 10, 0, tzinfo=timezone.utc)
    rows = [_row(spec.name, "fail", required_started_at(spec, early), "boom")]

    def post(*args):
        raise RuntimeError("connection refused")

    out = _execute(
        WEBHOOK_ENV,
        specs=[spec],
        gates={},
        rows=rows,
        now=early,
        post=post,
    )
    assert out.code == 1


def test_interval_window_is_two_periods():
    spec = JobSpec(
        name="shopify_poll",
        minutes=(),
        hours=(),
        dows=None,
        timezone="America/New_York",
        misfire_grace_seconds=2 * 3600,
        gate="shopify",
        interval_seconds=2 * 3600,
    )
    required = required_started_at(spec, NOW)
    assert NOW - required == timedelta(hours=4)
    fresh = _row("shopify_poll", "success", NOW - timedelta(hours=3))
    stale = _row("shopify_poll", "success", NOW - timedelta(hours=5))
    assert hw.evaluate_job(spec, [fresh], NOW) is None
    found = hw.evaluate_job(spec, [stale], NOW)
    assert found is not None and "stale" in found.detail


def test_ready_state_alias_and_newest_production_row():
    failure = hw.vercel_failure_from_payload({
        "deployments": [
            {"uid": "dpl_old", "target": "production", "readyState": "ERROR", "created": 1},
            {"uid": "dpl_new", "target": "production", "state": "READY", "created": 5},
            {"uid": "dpl_preview", "target": "preview", "readyState": "ERROR", "created": 9},
        ],
    })
    assert failure is None
