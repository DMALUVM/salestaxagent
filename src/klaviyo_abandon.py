"""Read-only Klaviyo abandon-flow stub.

Kit Email already pulled flow reports (WcDdsx / SQa2Yy, metric UG4R5c).
This module turns that fixture into warehouse rows. It never calls the
Klaviyo API and never writes a profile, event, or campaign.

Kit refresh (not this process): get_flow_report with
contains-any(flow_id,[WcDdsx,SQa2Yy]), conversion_metric_id UG4R5c,
flow_aggregation rows — then upsert klaviyo_abandon_flow_daily.
"""
from __future__ import annotations

import json
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent.parent / (
    "fixtures/klaviyo_abandon_flow_kit_2026-09-19.json")

KIT_MD_CANDIDATES = (
    Path("/workspace/kit-email/abandon-flow-health-2026-09-19.md"),
    Path(__file__).resolve().parent.parent / "kit-email/abandon-flow-health-2026-09-19.md",
)

# Documented for Kit. This module does not HTTP those IDs.
KIT_REFRESH = {
    "method": "get_flow_report",
    "flow_ids": ["WcDdsx", "SQa2Yy"],
    "conversion_metric_id": "UG4R5c",
    "aggregation": "flow_aggregation",
    "wrote_klaviyo": False,
}


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


def summarize(rows: list[dict]) -> dict:
    """Window totals from stored rows. Missing revenue stays missing."""
    by_window: dict[int, dict] = {}
    for r in rows:
        w = int(r["window_days"])
        b = by_window.setdefault(w, {
            "window_days": w, "revenue": None, "unique_clicks_zero": False,
        })
        amt = r.get("revenue")
        if amt is not None and amt != "":
            b["revenue"] = round((b["revenue"] or 0) + float(amt), 2)
        if r.get("unique_clicks") == 0:
            b["unique_clicks_zero"] = True
    return {
        "as_of": rows[0].get("as_of") if rows else None,
        "conversion_metric_id": (rows[0].get("conversion_metric_id") if rows else None)
        or "UG4R5c",
        "windows": sorted(by_window.values(), key=lambda x: -x["window_days"]),
        "refresh": KIT_REFRESH,
    }


def kit_markdown_present() -> Path | None:
    for p in KIT_MD_CANDIDATES:
        if p.exists():
            return p
    return None


def upsert_kit_seed(progress=None) -> dict:
    """Idempotent seed. No Klaviyo HTTP."""
    from src.db import upsert_rows

    rows = rows_from_fixture()
    upsert_rows(
        "klaviyo_abandon_flow_daily", rows,
        on_conflict="as_of,window_days,flow_id")
    md = kit_markdown_present()
    if progress:
        extra = f" (kit md at {md})" if md else " (kit md not on box — JSON fixture)"
        progress(f"  klaviyo stub: {len(rows)} kit-seed row(s){extra}")
    return {
        "ok": True, "rows": len(rows), "wrote_klaviyo": False,
        "kit_markdown": str(md) if md else None,
        "summary": summarize(rows),
    }
