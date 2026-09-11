"""GNO export-due ping — observe-only, P0 / review only, no wait-loops."""
from __future__ import annotations

from datetime import datetime

from src.amazon_ads.gno_watch_alert import (
    campaign_launched_at,
    cheap_p0s_from_campaigns,
    hours_since_campaign_launch,
    hours_since_launch,
    new_exact_zero_impr_p0s,
    ping_reasons,
    resolve_gno_review_at,
    review_due,
    unacked_p0s,
)
from src.rules import (
    GNO_AUTO_LOOSE_BUDGET,
    GNO_KEEP_ALIVE,
    GNO_LAUNCHED_AT,
    GNO_NEW_EXACT,
    GNO_NEXT_REVIEW_AT,
)


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
    assert "KEEPER_MISSING" not in codes
    assert "KEEPER_NOT_ENABLED" in codes
    assert "AUTO_LOOSE_BUDGET" in codes
    assert GNO_AUTO_LOOSE_BUDGET == 303
    missing_only = cheap_p0s_from_campaigns([])
    assert missing_only == []


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
        p0s=[{"code": "KEEPER_NOT_ENABLED", "campaign_name": "X", "search_term": ""}],
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


MIDDAY_ET = "2026-09-07T12:00:00-04:00"
MIDNIGHT_PT = "2026-09-07T00:00:00-07:00"
TALLOW = next(n for n in GNO_NEW_EXACT if "tallow lip balm" in n)


def _zero_rows() -> list[dict]:
    return [{"date": "2026-09-08", "campaign_name": n, "impressions": 0} for n in GNO_NEW_EXACT]


def test_fallback_launched_at_is_midday_et_not_midnight_pt():
    assert GNO_LAUNCHED_AT == MIDDAY_ET
    assert GNO_NEXT_REVIEW_AT == "2026-09-09T18:00:00-07:00"
    tue_7am = datetime.fromisoformat("2026-09-08T07:00:00-04:00")
    assert hours_since_launch(tue_7am) < 24
    assert hours_since_launch(tue_7am, MIDNIGHT_PT) >= 28


def test_new_exact_zero_impr_18h_no_p0_25h_p0():
    created = [{"campaign_name": n, "created_at": MIDDAY_ET} for n in GNO_NEW_EXACT]
    plus_18h = datetime.fromisoformat("2026-09-08T06:00:00-04:00")
    plus_25h = datetime.fromisoformat("2026-09-08T13:00:00-04:00")
    assert new_exact_zero_impr_p0s(_zero_rows(), plus_18h, meta=created) == []
    p0s = new_exact_zero_impr_p0s(_zero_rows(), plus_25h, meta=created)
    assert {p["code"] for p in p0s} == {"NEW_EXACT_ZERO_IMPR"}
    assert all("tallow lip balm" in p["campaign_name"] for p in p0s)


def test_midnight_launched_at_does_not_override_later_created_at():
    tue_7am = datetime.fromisoformat("2026-09-08T07:00:00-04:00")
    meta = {"campaign_name": TALLOW, "created_at": MIDDAY_ET}
    iso = campaign_launched_at(meta, MIDNIGHT_PT)
    assert iso.startswith("2026-09-07T12:00:00") or "2026-09-07T16:00:00" in iso
    hours = hours_since_campaign_launch(tue_7am, meta, MIDNIGHT_PT)
    assert hours < 24
    assert hours_since_launch(tue_7am, MIDNIGHT_PT) >= 28
    all_meta = [{"campaign_name": n, "created_at": MIDDAY_ET} for n in GNO_NEW_EXACT]
    p0s = new_exact_zero_impr_p0s(
        _zero_rows(), tue_7am, meta=all_meta, launched_at=MIDNIGHT_PT)
    assert p0s == []


def test_tue_7am_nudge_quiet_without_meta_uses_midday_fallback():
    tue_7am = datetime.fromisoformat("2026-09-08T07:00:00-04:00")
    assert new_exact_zero_impr_p0s(_zero_rows(), tue_7am, meta=[]) == []
    reasons = ping_reasons(
        now=tue_7am,
        next_review_at=GNO_NEXT_REVIEW_AT,
        last_export_at=None,
        p0s=[],
        acked_p0_keys=[],
    )
    assert reasons == []


def test_live_wednesday_clock_ignores_past_sep9_seed():
    fri = datetime.fromisoformat("2026-09-11T10:00:00-07:00")
    covered = datetime.fromisoformat("2026-09-09T13:00:00-07:00")
    nxt = resolve_gno_review_at(fri, covered)
    assert nxt.startswith("2026-09-16T18:00:00")
    reasons = ping_reasons(
        now=fri,
        next_review_at=nxt,
        last_export_at=covered,
        p0s=[],
        acked_p0_keys=[],
    )
    assert reasons == []
    overdue = resolve_gno_review_at(fri, datetime.fromisoformat("2026-09-07T12:00:00-07:00"))
    assert overdue.startswith("2026-09-09T18:00:00")
    wed_am = datetime.fromisoformat("2026-09-16T10:00:00-07:00")
    assert resolve_gno_review_at(wed_am, None).startswith("2026-09-09T18:00:00")
    assert resolve_gno_review_at(
        wed_am, datetime.fromisoformat("2026-09-09T19:00:00-07:00")
    ).startswith("2026-09-16T18:00:00")
    assert GNO_NEXT_REVIEW_AT == "2026-09-09T18:00:00-07:00"


def test_alert_module_is_observe_only_no_wait():
    from pathlib import Path
    src = (Path(__file__).resolve().parent.parent / "src/amazon_ads/gno_watch_alert.py").read_text()
    assert "observe" in src.lower()
    assert "await" not in src.lower()
    assert "time.sleep" not in src
    assert "amazonads" not in src.lower()
