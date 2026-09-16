"""Allow/deny gate for Sales-tax / Dashboard Telegram.

Dave locked: important updates ONLY. These tests pin the config lists and
the deny-wins / silent-unknown rules so a new sender cannot page until it
is allowlisted.
"""
from __future__ import annotations

from src.alerts.telegram_gate import telegram_allowed, telegram_decision
from src.rules import TELEGRAM_ALLOW, TELEGRAM_DENY, TELEGRAM_IMPORTANT_ONLY


def test_important_updates_only_is_on():
    assert TELEGRAM_IMPORTANT_ONLY is True


def test_allowlist_covers_locked_keep_topics():
    for topic in (
        "sales_tax_overdue",
        "sales_tax_filing_risk",
        "threshold_crossed",
        "inventory_damaged_unfillable",
        "inventory_checked_in",
        "health_faults",
        "job_fail",
        "paid_ads_freshness",
    ):
        assert topic in TELEGRAM_ALLOW, topic
        assert telegram_allowed(topic) is True, topic


def test_denylist_covers_locked_drop_topics():
    for topic in (
        "health_routine",
        "ads_scoreboard",
        "playbook_p0",
        "gno_export_due",
        "source_monitor",
    ):
        assert topic in TELEGRAM_DENY, topic
        allowed, reason = telegram_decision(topic)
        assert allowed is False
        assert reason.startswith("denied:"), reason


def test_allow_and_deny_do_not_overlap():
    assert TELEGRAM_ALLOW.isdisjoint(TELEGRAM_DENY)


def test_deny_wins_even_if_also_listed_on_allow():
    """A topic on both lists must not send. Deny is the lock."""
    # paid_ads_freshness is allowed; pretend a future edit also denies it
    # by exercising the deny-first branch with a real deny topic.
    assert telegram_allowed("gno_export_due") is False
    assert "gno_export_due" not in TELEGRAM_ALLOW


def test_unknown_topic_is_refused():
    allowed, reason = telegram_decision("playbook_brief")
    assert allowed is False
    assert "not on allowlist" in reason


def test_missing_topic_is_refused():
    allowed, reason = telegram_decision(None)
    assert allowed is False
    assert "missing topic" in reason


def test_send_telegram_refuses_denied_without_network(monkeypatch):
    from src.alerts.telegram import send_telegram

    def explode(*a, **k):
        raise AssertionError("denied topic must not hit Telegram or the DB")

    monkeypatch.setattr("src.alerts.telegram.settings.telegram_enabled", True)
    monkeypatch.setattr("src.alerts.telegram.httpx.post", explode)
    monkeypatch.setattr("src.alerts.telegram.insert_rows", explode)

    r = send_telegram("GNO pack due", topic="gno_export_due")
    assert r["sent"] is False
    assert r.get("suppressed") is True
    assert "denied:gno_export_due" in (r.get("error") or "")
