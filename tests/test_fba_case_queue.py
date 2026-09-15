"""Needs-case queue — ledger Adjustments + inbound shorts, not paid-only."""
from __future__ import annotations

import inspect
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.amazon_sp.adjustments import adjustment_event_key, parse_ledger_adjustments
from src.reimbursements.case_package import (
    REESE_AGENT_ID,
    build_case_package,
)
from src.reimbursements.case_queue import (
    HOW_TO_FILE_INTRO,
    HOW_TO_FILE_NO_DEEP_LINK,
    HOW_TO_FILE_STEPS,
    HOW_TO_FILE_TITLE,
    IDR_INSTRUCTION,
    LINK_KIND_IDR,
    NO_INBOUND_DISCREPANCIES,
    CASE_QUEUE_SOURCE_NOTE,
    STATUS_ALREADY_REIMBURSED,
    STATUS_FOUND_OFFSET,
    STATUS_NEEDS_CASE,
    apply_paid_dedupe,
    build_case_events,
    inbound_discrepancies,
    inbound_ready,
    reason_group,
    seller_central_link,
)
from src.rules import SPAPI_CASE_QUEUE_DAYS, SPAPI_MAX_CHUNK_DAYS


LEDGER_TSV = """Date\tFNSKU\tASIN\tMSKU\tTitle\tEvent Type\tReference ID\tQuantity\tFulfillment Center\tDisposition\tReason\tCountry
2026-08-01\tX1\tB001\tSKU-A\tTallow\tAdjustments\tFBA16AAA\t-2\tONT8\tSELLABLE\tLost_Warehouse\tUS
2026-08-05\tX1\tB001\tSKU-A\tTallow\tAdjustments\tFBA16AAA\t2\tONT8\tSELLABLE\tFound\tUS
2026-08-10\tX2\tB002\tSKU-B\tBalm\tAdjustments\tref-dw\t-1\tPHX6\tSELLABLE\tDamaged_Warehouse\tUS
2026-08-12\tX3\tB003\tSKU-C\tDeo\tAdjustments\tFBA16BBB\t-3\tSMF3\tSELLABLE\tLost_Inbound\tUS
2026-08-20\tX4\tB004\tSKU-D\tLip\tShipments\t111-2\t-1\tONT8\tSELLABLE\t\tUS
"""

LEDGER_QUOTED = (
    '"Date" "FNSKU" "ASIN" "MSKU" "Title" "Event Type" "Reference ID" '
    '"Quantity" "Fulfillment Center" "Disposition" "Reason" "Country"\n'
    '"Aug 10, 2026 3:00:00 AM PDT" "X2" "B002" "SKU-B" "Balm" '
    '"Adjustments" "ref-dw" "-1" "PHX6" "SELLABLE" "Damaged_Warehouse" "US"\n'
)


def test_parse_ledger_keeps_reason_and_skips_shipments():
    parsed = parse_ledger_adjustments(LEDGER_TSV)
    assert parsed["rows_total"] == 5
    assert parsed["rows_parsed"] == 4  # shipments skipped
    reasons = {r["reason"] for r in parsed["records"]}
    assert reasons == {"Lost_Warehouse", "Found", "Damaged_Warehouse", "Lost_Inbound"}
    lost = next(r for r in parsed["records"] if r["reason"] == "Lost_Warehouse")
    assert lost["quantity"] == -2
    assert lost["sku"] == "SKU-A"
    assert lost["reference_id"] == "FBA16AAA"
    assert lost["event_key"].startswith("adj|2026-08-01|ONT8|SKU-A")


def test_parse_quoted_space_delimited_ledger():
    parsed = parse_ledger_adjustments(LEDGER_QUOTED)
    assert parsed["rows_parsed"] == 1
    rec = parsed["records"][0]
    assert rec["reason"] == "Damaged_Warehouse"
    assert rec["event_date"] == "2026-08-10"
    assert rec["quantity"] == -1


def test_adjustment_event_key_is_stable():
    a = adjustment_event_key(date(2026, 8, 10), "phx6", "sku-b", "Damaged_Warehouse", "ref", -1)
    b = adjustment_event_key("2026-08-10", "PHX6", "SKU-B", "Damaged_Warehouse", "ref", -1)
    assert a == b


def test_inbound_short_only_when_closed():
    ships = [{
        "shipment_id": "FBA16CCC",
        "shipment_status": "CLOSED",
        "destination_fc": "ONT8",
        "closed_at": "2026-08-15T00:00:00Z",
    }]
    items = [{
        "shipment_id": "FBA16CCC",
        "sku": "sku-c",
        "quantity_shipped": 10,
        "quantity_received": 7,
    }]
    rows = inbound_discrepancies(ships, items, date(2026, 9, 14), date(2026, 6, 17), date(2026, 9, 14))
    assert len(rows) == 1
    assert rows[0]["quantity"] == 3
    assert rows[0]["reason"] == "Lost_Inbound"
    assert rows[0]["seller_central_link_kind"] == "inbound_shipment"

    ships[0]["shipment_status"] = "IN_TRANSIT"
    assert inbound_discrepancies(ships, items, date(2026, 9, 14), date(2026, 6, 17), date(2026, 9, 14)) == []


def test_stale_receiving_is_ready():
    ship = {
        "shipment_status": "RECEIVING",
        "last_updated_at": "2026-08-01",
    }
    assert inbound_ready(ship, date(2026, 9, 14)) is True
    ship["last_updated_at"] = "2026-09-10"
    assert inbound_ready(ship, date(2026, 9, 14)) is False


def test_stale_receiving_prefers_received_at_over_stuck_last_updated():
    """FBA19MVLNNJ2-shaped: LastUpdatedDate stuck at ship, received_at later."""
    ship = {
        "shipment_id": "FBA19MVLNNJ2",
        "shipment_status": "RECEIVING",
        "received_at": "2026-08-29",
        "closed_at": None,
        "last_updated_at": "2026-08-25",
    }
    # 21-day clock starts at received_at (Aug 29), not stuck ship time (Aug 25).
    assert inbound_ready(ship, date(2026, 9, 15)) is False
    assert inbound_ready(ship, date(2026, 9, 18)) is False
    assert inbound_ready(ship, date(2026, 9, 19)) is True
    # closed_at wins over last_updated when received_at is missing.
    ship_closed_age = {
        "shipment_status": "DELIVERED",
        "received_at": None,
        "closed_at": "2026-08-20",
        "last_updated_at": "2026-09-10",
    }
    assert inbound_ready(ship_closed_age, date(2026, 9, 14)) is True


def test_found_offsets_same_sku_fc():
    events = build_case_events(
        adjustments=[
            {
                "event_key": "adj|lw",
                "event_date": "2026-08-01",
                "sku": "SKU-A",
                "asin": "B001",
                "quantity": -2,
                "reason": "Lost_Warehouse",
                "fulfillment_center": "ONT8",
                "reference_id": "x",
            },
            {
                "event_key": "adj|found",
                "event_date": "2026-08-05",
                "sku": "SKU-A",
                "quantity": 2,
                "reason": "Found",
                "fulfillment_center": "ONT8",
            },
        ],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
    )
    assert events[0]["status"] == STATUS_FOUND_OFFSET
    assert events[0]["quantity"] == 0


def test_paid_dedupe_drops_reimbursed_units():
    candidates = [{
        "event_key": "adj|dw",
        "source": "ledger_adjustment",
        "event_date": date(2026, 8, 10),
        "sku": "SKU-B",
        "asin": "B002",
        "quantity": 1,
        "reason": "Damaged_Warehouse",
        "reason_group": "warehouse_damage",
        "fulfillment_center": "PHX6",
        "shipment_id": None,
        "reference_id": "ref-dw",
        "seller_central_url": None,
        "seller_central_link_kind": "idr_instructions",
    }]
    paid = [{
        "approval_date": "2026-08-20T12:00:00-07:00",
        "reimbursement_id": "R-DW",
        "reason": "Damaged_Warehouse",
        "sku": "SKU-B",
        "qty_total": 1,
        "qty_cash": 1,
        "amount_per_unit": 6.50,
        "amount_total": 6.50,
    }]
    out = apply_paid_dedupe(candidates, paid)
    assert out[0]["status"] == STATUS_ALREADY_REIMBURSED
    assert out[0]["quantity"] == 0


def test_partial_paid_leaves_remainder_as_needs_case():
    events = build_case_events(
        adjustments=[{
            "event_key": "adj|lw2",
            "event_date": "2026-08-01",
            "sku": "SKU-A",
            "asin": "B001",
            "quantity": -4,
            "reason": "Lost_Warehouse",
            "fulfillment_center": "ONT8",
            "reference_id": "z",
        }],
        shipments=[],
        shipment_items=[],
        reimbursements=[{
            "approval_date": "2026-08-15",
            "reimbursement_id": "R-LW",
            "reason": "Lost_Warehouse",
            "sku": "SKU-A",
            "qty_total": 1,
            "amount_per_unit": 5.00,
            "amount_total": 5.00,
        }],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
    )
    assert events[0]["status"] == STATUS_NEEDS_CASE
    assert events[0]["quantity"] == 3
    assert events[0]["estimated_amount"] == 15.0
    assert events[0]["amount_basis"] == "recent_reimbursement"


def test_paid_only_rows_never_become_needs_case():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[{
            "approval_date": "2026-08-20",
            "reimbursement_id": "R-ONLY",
            "reason": "Lost_Warehouse",
            "sku": "SKU-Z",
            "qty_total": 8,
            "amount_total": 40,
        }],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
    )
    assert events == []


def test_inbound_and_ledger_lost_inbound_dedupe_to_one_row():
    events = build_case_events(
        adjustments=[{
            "event_key": "adj|li",
            "event_date": "2026-08-12",
            "sku": "SKU-C",
            "asin": "B003",
            "quantity": -3,
            "reason": "Lost_Inbound",
            "fulfillment_center": "SMF3",
            "reference_id": "FBA16BBB",
        }],
        shipments=[{
            "shipment_id": "FBA16BBB",
            "shipment_status": "CLOSED",
            "destination_fc": "SMF3",
            "closed_at": "2026-08-12",
        }],
        shipment_items=[{
            "shipment_id": "FBA16BBB",
            "sku": "SKU-C",
            "quantity_shipped": 5,
            "quantity_received": 2,
        }],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
    )
    needs = [e for e in events if e["status"] == STATUS_NEEDS_CASE]
    assert len(needs) == 1
    assert needs[0]["source"] == "inbound_discrepancy"
    assert needs[0]["shipment_id"] == "FBA16BBB"


def test_seller_central_links_are_honest():
    url, kind = seller_central_link("FBA16ABCDE", None)
    assert url is not None and "inbound-shipment-workflow" in url
    assert kind == "inbound_shipment"
    url, kind = seller_central_link(None, "not-an-fba")
    assert url is None
    assert kind == LINK_KIND_IDR
    url, kind = seller_central_link(None, "20080126439780")
    assert url is None
    assert kind == LINK_KIND_IDR


def test_how_to_file_copy_matches_amazon_warehouse_damage_process():
    assert HOW_TO_FILE_TITLE == "How to file"
    assert "7 / E" in HOW_TO_FILE_INTRO
    assert "Damaged at FC" in HOW_TO_FILE_INTRO
    titles = " | ".join(title for title, _ in HOW_TO_FILE_STEPS)
    bodies = " ".join(body for _, body in HOW_TO_FILE_STEPS)
    assert "Check Paid / Reimbursements report first" in titles
    assert "File within 60 days" in titles
    assert "already paid within ~60 days" in bodies
    assert "Inventory Defect and Reimbursement" in bodies
    assert "Inventory Adjustments / Ledger Adjustments" in bodies
    assert "not a shipment ID" in bodies
    assert "no stable deep link" in HOW_TO_FILE_NO_DEEP_LINK
    assert "Support hub" in HOW_TO_FILE_NO_DEEP_LINK
    assert IDR_INSTRUCTION == "Open IDR (Inventory → Inventory Defect and Reimbursement)"
    assert "ledger adjustments with eligible codes" in CASE_QUEUE_SOURCE_NOTE
    assert NO_INBOUND_DISCREPANCIES == (
        "No CLOSED inbound discrepancies in warehouse right now"
    )


def test_reese_package_contract():
    events = [{
        "event_key": "inbound|FBA1|SKU-C",
        "source": "inbound_discrepancy",
        "event_date": date(2026, 8, 12),
        "sku": "SKU-C",
        "asin": "B003",
        "quantity": 3,
        "reason": "Lost_Inbound",
        "reason_group": "lost_inbound",
        "fulfillment_center": "SMF3",
        "shipment_id": "FBA16BBB",
        "status": STATUS_NEEDS_CASE,
        "estimated_amount": 18.0,
        "seller_central_url": "https://sellercentral.amazon.com/gp/fba/inbound-shipment-workflow/index.html?shipmentId=FBA16BBB",
        "seller_central_link_kind": "inbound_shipment",
    }]
    pkg = build_case_package(
        events, as_of="2026-09-14", start="2026-06-17", end="2026-09-14",
    )
    assert pkg["contract"] == "fba_case_package/v1"
    assert pkg["auto_submit"] is False
    assert pkg["target"]["agent_id"] == REESE_AGENT_ID
    assert pkg["summary"]["events"] == 1
    assert pkg["summary"]["units"] == 3
    assert "Do not auto-file" in pkg["markdown"]
    assert "How to file" in pkg["markdown"]
    assert "Inventory Defect and Reimbursement" in pkg["markdown"]
    assert "help/hub/contact-us" not in pkg["markdown"]
    assert "Sellerise" not in pkg["markdown"] or "scrape Sellerise" in pkg["purpose"]


def test_reason_groups():
    assert reason_group("Damaged_Warehouse") == "warehouse_damage"
    assert reason_group("Lost_Inbound") == "lost_inbound"
    assert reason_group("Lost_Warehouse") == "lost_warehouse"
    assert reason_group("CustomerReturn") == "other"
    assert reason_group("M") == "lost_warehouse"
    assert reason_group("M") != "lost_inbound"
    assert reason_group("7") == "warehouse_damage"


def test_window_and_worker_wiring():
    assert SPAPI_CASE_QUEUE_DAYS >= 90
    assert SPAPI_CASE_QUEUE_DAYS >= SPAPI_MAX_CHUNK_DAYS
    from src.main import _run_job_worker, _run_reimbursements_case_sync
    worker = inspect.getsource(_run_job_worker)
    helper = inspect.getsource(_run_reimbursements_case_sync)
    nightly = Path(__file__).resolve().parent.parent.joinpath("src/main.py").read_text()
    assert 'job_type == "reimbursements_case_sync"' in worker
    assert "sync_case_queue" in helper
    assert "GET_LEDGER_DETAIL_VIEW_DATA" in helper
    assert "open_case" not in helper
    assert "sync_case_queue" in nightly
    assert "GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA" not in helper


def test_deprecated_adjustments_report_is_not_the_source():
    adj = Path(__file__).resolve().parent.parent.joinpath("src/amazon_sp/adjustments.py").read_text()
    assert "GET_LEDGER_DETAIL_VIEW_DATA" in adj
    assert "deprecated" in adj.lower()
    assert 'eventType": ADJUSTMENTS_EVENT_TYPE' in adj or "eventType" in adj
