"""Read-only Klaviyo abandon-flow stub.

Kit Email already pulled flow reports (WcDdsx / SQa2Yy, metric UG4R5c).
This module turns that fixture into warehouse rows. It never calls the
Klaviyo API and never writes a profile, event, or campaign.
"""
from __future__ import annotations

import json
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent.parent / (
    "fixtures/klaviyo_abandon_flow_kit_2026-09-19.json")


def load_kit_fixture(path: Path | None = None) -> dict:
    p = path or FIXTURE
    return json.loads(p.read_text())


def rows_from_fixture(payload: dict | None = None) -> list[dict]:
    data = payload if payload is not None else load_kit_fixture()
    as_of = data["as_of"]
    source = data.get("source") or "kit_seed"
    metric_id = data.get("conversion_metric_id")
    metric_name = data.get("conversion_metric_name")
    out = []
    for window in data.get("windows") or []:
        days = int(window["window_days"])
        for flow in window.get("flows") or []:
            out.append({
                "as_of": as_of,
                "window_days": days,
                "flow_id": flow["flow_id"],
                "flow_name": flow.get("flow_name"),
                "trigger_metric": flow.get("trigger_metric"),
                "conversion_metric_id": metric_id,
                "conversion_metric_name": metric_name,
                "recipients": flow.get("recipients"),
                "unique_conversions": flow.get("unique_conversions"),
                "conversion_rate": flow.get("conversion_rate"),
                "revenue": flow.get("revenue"),
                "rpr": flow.get("rpr"),
                "unique_clicks": flow.get("unique_clicks"),
                "source": source,
                "notes": flow.get("notes"),
            })
    return out


def upsert_kit_seed(progress=None) -> dict:
    """Idempotent seed. No Klaviyo HTTP."""
    from src.db import upsert_rows

    rows = rows_from_fixture()
    upsert_rows(
        "klaviyo_abandon_flow_daily", rows,
        on_conflict="as_of,window_days,flow_id")
    if progress:
        progress(f"  klaviyo stub: {len(rows)} kit-seed row(s)")
    return {"ok": True, "rows": len(rows), "wrote_klaviyo": False}
