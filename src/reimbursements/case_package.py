"""Reese · Reimbursements notify / export contract.

Dana owns tab + sync. Reese owns case prep. Dave submits.
This payload is structured for SendToAgent / a Dana hook. The desk never
auto-files Seller Central cases.
"""
from __future__ import annotations

from datetime import date
from typing import Iterable

from src.reimbursements.case_queue import (
    HOW_TO_FILE_INTRO,
    HOW_TO_FILE_NO_DEEP_LINK,
    HOW_TO_FILE_STEPS,
    HOW_TO_FILE_TITLE,
    IDR_INSTRUCTION,
    SC_LEDGER_HUB,
    SELLER_CENTRAL_LINK_LIMIT,
    STATUS_NEEDS_CASE,
    fba_shipment_id,
)
from src.reimbursements.reason_legend import (
    CLASSIFICATION_VERSION,
    MINI_RESYNC_HINT,
    reason_label,
)

REESE_AGENT_ID = "74a7ce8a-6754-4bf1-90aa-afa1f4cd774c"
REESE_AGENT_NAME = "Reese · Reimbursements"

PACKAGE_PURPOSE = (
    "Case prep only. Dave submits in Seller Central. "
    "Do not auto-file, scrape Sellerise, or touch SoldScope."
)

GROUP_HEADINGS = {
    "lost_inbound": "Lost inbound",
    "warehouse_damage": "Warehouse damage",
    "lost_warehouse": "Lost warehouse",
}


def _money(value: object) -> float:
    try:
        return round(float(value or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def _day(value: object) -> str:
    if isinstance(value, date):
        return value.isoformat()
    raw = str(value or "")
    return raw[:10] if len(raw) >= 10 else raw


def needs_case_only(events: Iterable[dict]) -> list[dict]:
    return [e for e in events if e.get("status") == STATUS_NEEDS_CASE and int(e.get("quantity") or 0) > 0]


def build_case_package(
    events: Iterable[dict],
    *,
    as_of: str,
    start: str,
    end: str,
    source: str = "dashboard",
) -> dict:
    """JSON + markdown package Reese can use to prep documentation."""
    rows = needs_case_only(events)
    rows = sorted(rows, key=lambda r: (_day(r.get("event_date")), r.get("sku") or ""))
    units = sum(int(r.get("quantity") or 0) for r in rows)
    est = round(sum(_money(r.get("estimated_amount")) for r in rows), 2)
    est_known = any(r.get("estimated_amount") not in (None, "") for r in rows)

    payload_events = []
    for r in rows:
        payload_events.append({
            "event_key": r.get("event_key"),
            "source": r.get("source"),
            "event_date": _day(r.get("event_date")),
            "sku": r.get("sku"),
            "asin": r.get("asin"),
            "fnsku": r.get("fnsku"),
            "product_name": r.get("product_name"),
            "quantity": int(r.get("quantity") or 0),
            "reason": r.get("reason"),
            "reason_group": r.get("reason_group"),
            "fulfillment_center": r.get("fulfillment_center"),
            "shipment_id": fba_shipment_id(r.get("shipment_id")),
            "reference_id": r.get("reference_id"),
            "estimated_amount": r.get("estimated_amount"),
            "amount_basis": r.get("amount_basis"),
            "seller_central_url": (
                r.get("seller_central_url")
                if fba_shipment_id(r.get("shipment_id"))
                else None
            ),
            "seller_central_link_kind": (
                r.get("seller_central_link_kind")
                if fba_shipment_id(r.get("shipment_id"))
                else "idr_instructions"
            ),
            "classification_version": r.get("classification_version") or CLASSIFICATION_VERSION,
            "reason_label": reason_label(r.get("reason"), r.get("disposition")),
            "status": "needs_case",
        })

    body = {
        "contract": "fba_case_package/v1",
        "purpose": PACKAGE_PURPOSE,
        "auto_submit": False,
        "target": {
            "agent_id": REESE_AGENT_ID,
            "agent_name": REESE_AGENT_NAME,
        },
        "as_of": as_of,
        "start": start,
        "end": end,
        "source": source,
        "spapi_sources": [
            "GET_LEDGER_DETAIL_VIEW_DATA (eventType=Adjustments)",
            "FBA inbound v0 QuantityShipped − QuantityReceived",
            "GET_FBA_REIMBURSEMENTS_DATA (dedupe only — paid desk)",
        ],
        "not_sources": [
            "GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA (deprecated 2023-01-31)",
            "Sellerise",
            "SoldScope",
            "Eligible-claims API (does not exist)",
        ],
        "seller_central_link_limit": SELLER_CENTRAL_LINK_LIMIT,
        "idr_instruction": IDR_INSTRUCTION,
        "how_to_file_title": HOW_TO_FILE_TITLE,
        "ledger_report_hub": SC_LEDGER_HUB,
        "classification_version": CLASSIFICATION_VERSION,
        "mini_resync": MINI_RESYNC_HINT,
        "summary": {
            "events": len(payload_events),
            "units": units,
            "estimated_amount": est if est_known else None,
            "estimated_known": est_known,
        },
        "events": payload_events,
    }
    body["markdown"] = render_package_markdown(body)
    return body


def render_package_markdown(package: dict) -> str:
    s = package.get("summary") or {}
    est = s.get("estimated_amount")
    est_s = f"${est:,.2f}" if est is not None else "unknown (no recent paid unit rate)"
    lines = [
        f"# FBA Needs-case package — {package.get('target', {}).get('agent_name', REESE_AGENT_NAME)}",
        "",
        f"**{PACKAGE_PURPOSE}**",
        "",
        f"- As of: `{package.get('as_of')}` (America/Los_Angeles)",
        f"- Window: `{package.get('start')}` → `{package.get('end')}`",
        f"- Events: **{s.get('events', 0)}** · Units: **{s.get('units', 0)}** · Est. $: **{est_s}**",
        f"- Target agent: `{package.get('target', {}).get('agent_id', REESE_AGENT_ID)}`",
        f"- Classification: `{package.get('classification_version', CLASSIFICATION_VERSION)}`",
        "",
        f"## {HOW_TO_FILE_TITLE}",
        "",
        HOW_TO_FILE_INTRO,
        "",
        *[f"{i}. **{title}** — {body}" for i, (title, body) in enumerate(HOW_TO_FILE_STEPS, 1)],
        "",
        HOW_TO_FILE_NO_DEEP_LINK,
        "",
        f"- {IDR_INSTRUCTION}",
        f"- Inventory ledger report: {SC_LEDGER_HUB}",
        "",
        SELLER_CENTRAL_LINK_LIMIT,
        "",
    ]
    by_group: dict[str, list[dict]] = {}
    for ev in package.get("events") or []:
        by_group.setdefault(ev.get("reason_group") or "other", []).append(ev)

    if not by_group:
        lines.append("_No open Needs-case rows in this window._")
        lines.append("")
        return "\n".join(lines)

    for group in ("lost_inbound", "warehouse_damage", "lost_warehouse"):
        rows = by_group.get(group) or []
        if not rows:
            continue
        lines.append(f"## {GROUP_HEADINGS.get(group, group)} ({len(rows)})")
        lines.append("")
        lines.append("| Date | SKU | ASIN | Qty | FC | Shipment | Reference ID | Est $ | Seller Central |")
        lines.append("| --- | --- | --- | ---: | --- | --- | --- | ---: | --- |")
        for r in rows:
            est_cell = (
                f"{_money(r.get('estimated_amount')):.2f}"
                if r.get("estimated_amount") not in (None, "")
                else "—"
            )
            shipment = fba_shipment_id(r.get("shipment_id")) or "—"
            ref = r.get("reference_id") or "—"
            if shipment != "—" and ref == shipment:
                ref = "—"
            url = r.get("seller_central_url") or IDR_INSTRUCTION
            lines.append(
                f"| {r.get('event_date')} | `{r.get('sku') or '—'}` | "
                f"{r.get('asin') or '—'} | {r.get('quantity')} | "
                f"{r.get('fulfillment_center') or '—'} | {shipment} | {ref} | "
                f"{est_cell} | {url} |"
            )
        lines.append("")

    lines.extend([
        "## Sources",
        "",
        "- " + "\n- ".join(package.get("spapi_sources") or []),
        "",
        "## Out of scope",
        "",
        "- " + "\n- ".join(package.get("not_sources") or []),
        "",
    ])
    return "\n".join(lines)
