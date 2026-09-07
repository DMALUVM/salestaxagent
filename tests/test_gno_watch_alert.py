"""GNO export-due ping — observe-only, P0 / review only, no wait-loops."""
from __future__ import annotations

from datetime import datetime

from src.amazon_ads.gno_watch_alert import (
    cheap_p0s_from_campaigns,
    ping_reasons,
    review_due,
    unacked_p0s,
)
from src.rules import GNO_AUTO_LOOSE_BUDGET, GNO_KEEP_ALIVE, GNO_NEXT_REVIEW_AT


def test_review_due_window_and_ack():
    review = "2026-09-09T18:00:00-07:00"
    assert review_due(datetime.fromisoformat("2026-09-09T11:00:00-07:00"), review, None) is False
    assert review_due(datetime.fromisoformat("2026-09-09T13:00:00-07:00"), review, None) is True
    assert review_due(datetime.fromisoformat("2026-09-10T08:00:00-07:00"), review, None) is True
    exported = datetime.fromisoformat("2026-09-09T12:30:00-07:00")
    assert review_due(datetime.fromisoformat("2026-09-09T13:00:00-07:00"), review, exported) is False
    early = datetime.fromisoformat("2026-09-08T10:00:00-07:00")
    assert review_due(datetime.fromisoformat("2026-09-09T13:00:00-07:00"), review, early) is True


def test_cheap_p0s_keeper_and_budget():
    auto = GNO_KEEP_ALIVE[0]
    rows = [
        {"date": "2026-09-06", "campaign_name": auto, "campaign_status": "paused", "budget": 200},
    ]
    p0s = cheap_p0s_from_campaigns(rows)
    codes = {p["code"] for p in p0s}
    assert "KEEPER_MISSING" in codes
    assert "KEEPER_NOT_ENABLED" in codes
    assert "AUTO_LOOSE_BUDGET" in codes
    assert GNO_AUTO_LOOSE_BUDGET == 303


def test_acked_p0_does_not_reping_until_new():
    p0s = [{"code": "KEEPER_MISSING", "campaign_name": "X", "search_term": ""}]
    acked = ["KEEPER_MISSING|x|"]
    assert unacked_p0s(p0s, acked) == []
    p0s.append({"code": "NEW_EXACT_BURN", "campaign_name": "Y", "search_term": ""})
    assert len(unacked_p0s(p0s, acked)) == 1


def test_ping_reasons_p0_and_review_not_digest():
    now = datetime.fromisoformat("2026-09-09T13:00:00-07:00")
    reasons = ping_reasons(
        now=now,
        next_review_at=GNO_NEXT_REVIEW_AT,
        last_export_at=None,
        p0s=[{"code": "KEEPER_MISSING", "campaign_name": "X", "search_term": ""}],
        acked_p0_keys=[],
    )
    assert reasons == ["P0", "REVIEW"]
    quiet = ping_reasons(
        now=datetime.fromisoformat("2026-09-08T07:00:00-04:00"),
        next_review_at=GNO_NEXT_REVIEW_AT,
        last_export_at=None,
        p0s=[],
        acked_p0_keys=[],
    )
    assert quiet == []


def test_alert_module_is_observe_only_no_wait():
    from pathlib import Path
    src = (Path(__file__).resolve().parent.parent / "src/amazon_ads/gno_watch_alert.py").read_text()
    assert "observe" in src.lower()
    assert "await" not in src.lower()
    assert "time.sleep" not in src
    assert "amazonads" not in src.lower()
