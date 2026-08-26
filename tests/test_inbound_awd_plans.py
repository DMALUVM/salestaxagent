"""Tests for skipping AWD inbound plans in v2024 sync."""
from __future__ import annotations

from src.amazon_sp.client import SPAPIError
from src.inventory.inbound_plans import (
    _is_awd_inbound_plan,
    _is_awd_plan_error,
    sync_inbound_plans_v2024,
)


def test_is_awd_inbound_plan_detects_workflow_ids():
    assert _is_awd_inbound_plan({"inboundPlanId": "wf929c0d09-3ebd-40f6-afaf-54cfc0bbdf57"})
    assert not _is_awd_inbound_plan({"inboundPlanId": "ip1234567890"})


def test_is_awd_plan_error_matches_api_message():
    err = SPAPIError(
        "Inbound v2024 failed (400): Operation GetInboundPlan is not supported "
        "for Amazon Warehousing and Distribution inbound plans."
    )
    assert _is_awd_plan_error(err)


def test_sync_skips_awd_plans_without_warning_spam(monkeypatch):
    summaries = [
        {"inboundPlanId": "wf11111111-1111-1111-1111-111111111111", "lastUpdatedAt": "2026-08-01T00:00:00Z"},
        {"inboundPlanId": "ip222222222222", "lastUpdatedAt": "2026-08-02T00:00:00Z"},
    ]

    def fake_list(_token=None):
        return {"inboundPlans": summaries, "pagination": {}}

    get_plan_calls: list[str] = []

    def fake_get(plan_id: str):
        get_plan_calls.append(plan_id)
        return {
            "createdAt": "2026-01-02T00:00:00Z",
            "lastUpdatedAt": "2026-01-03T00:00:00Z",
            "shipments": [],
        }

    monkeypatch.setattr("src.inventory.inbound_plans._list_plans_page", fake_list)
    monkeypatch.setattr("src.inventory.inbound_plans._get_plan", fake_get)
    monkeypatch.setattr("src.inventory.inbound_shipments._existing_by_id", lambda: {})

    result = sync_inbound_plans_v2024(days_back=180, dry_run=True)
    assert result["awd_plans_skipped"] == 1
    assert result["plans_scanned"] == 2
    assert get_plan_calls == ["ip222222222222"]
