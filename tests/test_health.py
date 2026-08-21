"""Daily health check-in — formatting, debounce and fail-soft behaviour.

Nothing here touches the database or Telegram. `collect()` is the only
DB-facing function precisely so the parts that decide whether to wake the
operator can be tested exhaustively without an account.

The property that matters most is asymmetric: a suppressed message is a silent
failure of the monitor itself, so every debounce test is written from the angle
of "could this hide something the operator needed to see?"
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from src import health
from src.health import CRITICAL, OK, WARN, Fault, Health

NOW = datetime(2026, 8, 21, 12, 0, tzinfo=timezone.utc)


def healthy_facts(**over) -> dict:
    f = {
        "now": NOW.isoformat(), "db_ok": True, "db_error": None,
        "window_days": 7, "as_of": "2026-08-20",
        "ads": {"spend": 3010.34, "sales": 7520.84, "orders": 508, "rows": 210},
        "prior": {"spend": 2802.38, "sales": 7515.67, "orders": 513, "rows": 210},
        "amazon_sales": 21965.40,
        "ads_last_sync": "2026-08-21T05:00:00+00:00", "ads_sync_age_hours": 7.0,
        "ads_last_date": "2026-08-20", "ads_data_age_days": 0,
        "sqp_last_week_end": "2026-08-15", "sqp_age_days": 5,
        "sqp_span_weeks": 33, "open_p0": 8,
        "heartbeat_at": NOW.isoformat(), "heartbeat_age_minutes": 3.0,
        "auth_failures": [],
    }
    f.update(over)
    return f


# ── healthy path ─────────────────────────────────────────────────────────

def test_healthy_produces_exactly_one_short_message():
    facts = healthy_facts()
    h = health.evaluate(facts)
    assert h.healthy, [f.text for f in h.faults]
    msg = health.format_message(facts, h)

    assert msg.startswith("✅ Sales Tax Agent OK — 2026-08-21")
    # Short enough to read on a lock screen without expanding.
    assert len(msg.splitlines()) <= 12, msg
    assert len(msg) < 700, f"{len(msg)} chars is not a glanceable check-in"


def test_healthy_message_carries_the_full_ads_scoreboard():
    facts = healthy_facts()
    msg = health.format_message(facts, health.evaluate(facts))
    for token in ("$3,010", "$7,521", "ACOS 40.0%", "ROAS 2.50x", "TACoS 13.7%"):
        assert token in msg, f"scoreboard missing {token}"


def test_scoreboard_documents_its_window_and_timezone():
    msg = health.format_message(healthy_facts(), Health())
    assert "7d to 2026-08-20" in msg
    assert "LA closed days" in msg, "the day boundary must be stated, not assumed"


def test_scoreboard_shows_movement_against_the_prior_window():
    msg = health.format_message(healthy_facts(), Health())
    assert "vs prior 7d" in msg
    assert "spend +7%" in msg
    assert "37.3% → 40.0%" in msg, "prior and current ACOS must both be visible"


def test_no_playbook_body_or_brief_in_the_daily_ping():
    msg = health.format_message(healthy_facts(), Health())
    for leak in ("Break-even", "Action plan", "Risk if ignored", "Hard rules",
                 "Campaign Manager"):
        assert leak not in msg, f"daily ping is leaking brief content: {leak}"
    assert "P0 open" in msg, "the P0 COUNT is wanted; the list is not"


# ── never fabricate ──────────────────────────────────────────────────────

def test_missing_sales_says_n_a_rather_than_vanishing():
    """A silently dropped field reads as a healthy zero."""
    facts = healthy_facts(amazon_sales=None)
    msg = health.format_message(facts, health.evaluate(facts))
    assert "TACoS n/a" in msg, "TACoS must be present-and-n/a, never omitted"
    assert "sales" in msg.lower()
    faults = [f.key for f in health.evaluate(facts).faults]
    assert "sales" in faults, "an n/a figure must also be reported as a fault"


def test_no_ads_rows_reports_n_a_not_zero():
    facts = healthy_facts(ads={"spend": 0.0, "sales": 0.0, "orders": 0, "rows": 0})
    msg = health.format_message(facts, Health())
    assert "no rows" in msg and "n/a" in msg
    assert "$0" not in msg, "zero rows is not zero spend"


def test_absent_prior_window_is_stated():
    facts = healthy_facts(prior={"spend": 0, "sales": 0, "orders": 0, "rows": 0})
    msg = health.format_message(facts, Health())
    assert "no prior rows" in msg


# ── fault detection ──────────────────────────────────────────────────────

@pytest.mark.parametrize("over,key", [
    ({"ads_sync_age_hours": 40.0}, "ads_sync"),
    ({"ads_sync_age_hours": None, "ads_last_sync": None}, "ads_sync"),
    ({"sqp_age_days": 19}, "sqp"),
    ({"sqp_age_days": None, "sqp_last_week_end": None}, "sqp"),
    ({"heartbeat_age_minutes": None, "heartbeat_at": None}, "heartbeat"),
    ({"heartbeat_age_minutes": 90.0}, "heartbeat"),
    ({"ads_data_age_days": 5}, "ads_data"),
    ({"amazon_sales": None}, "sales"),
])
def test_each_failure_mode_is_detected(over, key):
    h = health.evaluate(healthy_facts(**over))
    assert key in [f.key for f in h.faults], f"{over} was not detected"


def test_auth_failures_are_named_without_stack_spam():
    h = health.evaluate(healthy_facts(auth_failures=["ads_campaigns_sync"]))
    fault = next(f for f in h.faults if f.key.startswith("auth:"))
    assert "ads_campaigns_sync" in fault.text
    assert "re-authorise" in fault.text
    assert "Traceback" not in fault.text and len(fault.text) < 120


def test_unreachable_db_reports_once_not_as_five_stale_feeds():
    """One cause must not produce five alarms."""
    h = health.evaluate(healthy_facts(db_ok=False, db_error="connection refused"))
    assert len(h.faults) == 1
    assert h.faults[0].key == "db"
    assert h.severity == CRITICAL


def test_degraded_message_lists_plain_faults_and_keeps_the_scoreboard():
    facts = healthy_facts(sqp_age_days=19, heartbeat_age_minutes=None,
                          heartbeat_at=None)
    h = health.evaluate(facts)
    msg = health.format_message(facts, h)
    assert msg.startswith("🚨 Agent attention")
    assert "- " in msg
    assert "ACOS 40.0%" in msg, "a degraded ping still needs the scoreboard"
    assert "Traceback" not in msg


def test_severity_escalates_with_how_stale_the_sync_is():
    mild = health.evaluate(healthy_facts(ads_sync_age_hours=30.0))
    bad = health.evaluate(healthy_facts(ads_sync_age_hours=200.0))
    assert mild.severity == WARN
    assert bad.severity == CRITICAL


# ── debounce ─────────────────────────────────────────────────────────────

def test_one_routine_message_per_calendar_day():
    h = Health()
    send, _ = health.should_send(h, NOW, {})
    assert send
    state = health.record_sent(h, NOW, {})

    again, reason = health.should_send(h, NOW + timedelta(hours=3), state)
    assert not again, reason
    assert "already sent today" in reason

    tomorrow = NOW + timedelta(days=1)
    assert health.should_send(h, tomorrow, state)[0], "next day must send again"


def test_same_warning_does_not_repeat_every_hour():
    h = Health([Fault("sqp", WARN, "SQP stale")])
    state = health.record_sent(h, NOW, {})
    for hours in (1, 6, 23):
        send, reason = health.should_send(h, NOW + timedelta(hours=hours), state)
        assert not send, f"re-alerted after {hours}h: {reason}"


def test_same_warning_repeats_after_the_debounce_window():
    h = Health([Fault("sqp", WARN, "SQP stale")])
    state = health.record_sent(h, NOW, {})
    send, reason = health.should_send(h, NOW + timedelta(hours=25), state)
    assert send and "debounce elapsed" in reason


def test_a_new_fault_is_never_suppressed_by_the_debounce_window():
    """The failure mode that would make this monitor useless."""
    first = Health([Fault("sqp", WARN, "SQP stale")])
    state = health.record_sent(first, NOW, {})
    worse = Health([Fault("sqp", WARN, "SQP stale"),
                    Fault("heartbeat", CRITICAL, "heartbeat missing")])
    send, reason = health.should_send(worse, NOW + timedelta(minutes=5), state)
    assert send, "a NEW fault must break the debounce"
    assert reason == "fault set changed"


def test_rising_severity_breaks_the_debounce():
    warn = Health([Fault("ads_sync", WARN, "stale")])
    state = health.record_sent(warn, NOW, {})
    crit = Health([Fault("ads_sync", CRITICAL, "very stale")])
    send, reason = health.should_send(crit, NOW + timedelta(minutes=5), state)
    assert send and reason in ("fault set changed", "severity increased")


def test_recovery_clears_the_fault_state_so_the_next_fault_alerts():
    faulty = Health([Fault("sqp", WARN, "SQP stale")])
    state = health.record_sent(faulty, NOW, {})
    recovered = health.record_sent(Health(), NOW + timedelta(days=1), state)
    assert recovered["last_fault_signature"] is None

    send, _ = health.should_send(faulty, NOW + timedelta(days=1, hours=1), recovered)
    assert send, "a fault returning after recovery must alert"


# ── fail soft ────────────────────────────────────────────────────────────

def test_dry_run_never_touches_telegram(monkeypatch):
    """Missing TELEGRAM_* must not be an error in --dry-run."""
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)

    def explode(*a, **k):
        raise AssertionError("dry-run must not call send_telegram")

    monkeypatch.setattr("src.alerts.telegram.send_telegram", explode)
    monkeypatch.setattr(health, "collect", lambda **k: healthy_facts())

    r = health.run_health_ping(send=False, now=NOW)
    assert r["sent"] is False
    assert r["message"].startswith("✅")
    assert r["error"] is None


def test_mute_flag_suppresses_delivery_but_still_reports(monkeypatch):
    monkeypatch.setenv("HEALTH_TELEGRAM", "0")
    monkeypatch.setattr(health, "collect", lambda **k: healthy_facts())

    def explode(*a, **k):
        raise AssertionError("muted run must not call send_telegram")

    monkeypatch.setattr("src.alerts.telegram.send_telegram", explode)
    r = health.run_health_ping(send=True, now=NOW)
    assert r["muted"] and r["sent"] is False
    assert r["message"], "muting delivery must not stop the check itself"


def test_collect_never_raises_when_the_database_is_gone(monkeypatch):
    def boom():
        raise RuntimeError("connection refused")

    monkeypatch.setattr("src.db.get_client", boom)
    facts = health.collect(now=NOW)
    assert facts["db_ok"] is False
    assert "connection refused" in (facts["db_error"] or "")
    # And it must still produce a sendable message rather than a traceback.
    msg = health.format_message(facts, health.evaluate(facts))
    assert "UNREACHABLE" in msg


# ── heartbeat ────────────────────────────────────────────────────────────

def test_heartbeat_round_trips(tmp_path, monkeypatch):
    cfg = dict(health.CONFIG)
    cfg["heartbeat"] = dict(cfg["heartbeat"])
    cfg["heartbeat"]["path"] = "hb.json"
    # monkeypatch, not a bare assignment: reassigning health.ROOT directly
    # leaks into every test that runs afterwards in the same session, which
    # would point the real heartbeat writer at a deleted tmp directory.
    monkeypatch.setattr(health, "ROOT", tmp_path)
    health.write_heartbeat(cfg)
    hb = health.read_heartbeat(cfg)
    assert hb and "at" in hb and "pid" in hb
    assert json.loads((tmp_path / "hb.json").read_text())["pid"] == hb["pid"]


def test_config_thresholds_are_all_present():
    t = health.CONFIG["thresholds"]
    for key in ("ads_sync_stale_hours", "ads_data_stale_days", "sqp_stale_days",
                "auth_failure_lookback_hours"):
        assert key in t, f"missing threshold {key}"
    assert health.CONFIG["debounce"]["routine_per_calendar_day"] == 1


# ── audit regressions ────────────────────────────────────────────────────

def test_auth_check_queries_a_column_that_exists():
    """The column is `message`; `error_message` does not exist on job_runs.

    Selecting a missing column makes PostgREST raise, and the except that
    wrapped it swallowed the error — so the auth-failure check silently never
    ran, and reported healthy precisely because it was broken. Pinned by name
    because the failure is invisible at runtime.
    """
    src = (Path(health.__file__)).read_text()
    auth = src[src.index("Auth failures, by NAME only"):]
    auth = auth[: auth.index("except Exception")]
    # Comments are stripped: the block documents the bug by name, so a naive
    # search finds "error_message" in the prose explaining why it is gone.
    code = "\n".join(ln for ln in auth.splitlines()
                     if not ln.strip().startswith("#"))
    assert "error_message" not in code, (
        "job_runs has no error_message column — use `message`")
    assert '"job_name,status,message,started_at"' in code


def test_a_check_that_cannot_run_is_reported_not_swallowed():
    facts = healthy_facts(check_errors=["auth-failure check: boom"])
    h = health.evaluate(facts)
    keys = [f.key for f in h.faults]
    assert "check_broken" in keys, (
        "a check that errored must surface; silence reads as 'passed'")


def test_failed_jobs_are_reported_by_name_only():
    """Inherited from the retired digest — the only place a broken job showed."""
    facts = healthy_facts(failed_jobs=["inventory_sync", "ads_sync"])
    h = health.evaluate(facts)
    fault = next(f for f in h.faults if f.key == "failed_jobs")
    assert "inventory_sync" in fault.text and "ads_sync" in fault.text
    assert "Traceback" not in fault.text and len(fault.text) < 160


def test_mtd_line_survived_the_digest_retirement():
    facts = healthy_facts(mtd={"amazon": 25032.95, "shopify": 5072.34},
                          mtd_start="2026-08-01")
    msg = health.format_message(facts, health.evaluate(facts))
    assert "MTD from 2026-08-01" in msg
    assert "$25,033" in msg and "$5,072" in msg
    assert "total $30,105" in msg


def test_ping_stays_glanceable_with_the_merged_content():
    facts = healthy_facts(mtd={"amazon": 25032.95, "shopify": 5072.34},
                          mtd_start="2026-08-01")
    msg = health.format_message(facts, health.evaluate(facts))
    assert len(msg.splitlines()) <= 14, msg
    assert len(msg) < 900, f"{len(msg)} chars is no longer a glance"


def test_an_import_error_is_not_reported_as_an_auth_failure():
    """The first live run flagged inventory_sync as an auth failure.

    Its ImportError names `auth_headers_with_retry`, and the matcher keyed on
    the bare substring "auth". Credential rejection and a broken import are
    different faults with different fixes; conflating them sends the operator
    to re-authorise an app that is fine.
    """
    src = (Path(health.__file__)).read_text()
    blk = src[src.index("Auth failures, by NAME only"):]
    blk = blk[: blk.index("except Exception")]
    code = "\n".join(ln for ln in blk.splitlines()
                     if not ln.strip().startswith("#"))
    assert '"cannot import name"' in code, "import errors must be excluded"
    for loose in ('"auth"', '"token"'):
        assert loose not in code, (
            f"{loose} matches `auth_headers_with_retry` and any token refresh log")
    for tight in ('"401"', '"unauthorized"', '"invalid_grant"'):
        assert tight in code
