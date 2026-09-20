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
    CASE_QUEUE_SOURCE_NOTE,
    HOW_TO_FILE_INBOUND,
    HOW_TO_FILE_INTRO,
    HOW_TO_FILE_NO_DEEP_LINK,
    HOW_TO_FILE_STEPS,
    HOW_TO_FILE_TITLE,
    IDR_INSTRUCTION,
    LINK_KIND_IDR,
    NO_INBOUND_DISCREPANCIES,
    SOURCE_INBOUND,
    SOURCE_SELLERBOARD,
    STATUS_ALREADY_REIMBURSED,
    STATUS_CASE_SUBMITTED,
    STATUS_FOUND_OFFSET,
    STATUS_NEEDS_CASE,
    AMAZON_RECONCILE_BATCH,
    amazon_qty_from_spapi_payloads,
    CLEAR_NOTE_RECEIPTS_COVER,
    apply_inbound_balance,
    apply_paid_dedupe,
    apply_receipt_cover,
    build_case_events,
    collect_live_inbound_qty,
    collect_reconcile_shipment_ids,
    fetch_amazon_inbound_qty,
    inbound_discrepancies,
    inbound_live_short,
    inbound_match_key,
    inbound_ready,
    is_active_inbound_alert,
    is_inbound_balanced,
    merge_inbound_sources,
    preserve_submitted_status,
    reason_group,
    seller_central_link,
    sellerboard_inbound_discrepancies,
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
    assert url is not None and "fba/inbound-shipment/summary/FBA16ABCDE/shipmentEvents" in url
    assert kind == "inbound_shipment"
    url, kind = seller_central_link("FBA16ABCDE", None, "lost_inbound")
    assert "shipmentEvents" in url
    assert kind == "inbound_shipment"
    url, kind = seller_central_link("FBA16ABCDE", None, "warehouse_damage")
    assert url == "https://sellercentral.amazon.com/help/hub/reference/GEV4254LJJ9BAEG#mnd_2jc_jcb"
    assert kind == LINK_KIND_IDR
    url, kind = seller_central_link("FBA16ABCDE", None, "lost_warehouse")
    assert url == "https://sellercentral.amazon.com/help/hub/reference/GEV4254LJJ9BAEG#mnd_2jc_jcb"
    url, kind = seller_central_link(None, "not-an-fba")
    assert url == "https://sellercentral.amazon.com/help/hub/reference/GEV4254LJJ9BAEG#mnd_2jc_jcb"
    assert kind == LINK_KIND_IDR
    url, kind = seller_central_link(None, "20080126439780")
    assert url == "https://sellercentral.amazon.com/help/hub/reference/GEV4254LJJ9BAEG#mnd_2jc_jcb"
    assert kind == LINK_KIND_IDR
    assert "inbound-shipment-workflow" not in url
    assert "help/hub/contact-us" not in url


def test_warehouse_damage_uses_eligible_for_claim_even_with_fba_id():
    events = build_case_events(
        adjustments=[{
            "event_key": "adj|7",
            "event_date": "2026-08-10",
            "sku": "SKU-B",
            "quantity": -1,
            "reason": "7",
            "fulfillment_center": "PHX6",
            "shipment_id": "FBA16DAMAGE",
            "reference_id": "20080126439780",
        }],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
    )
    ev = events[0]
    assert ev["reason_group"] == "warehouse_damage"
    assert ev["shipment_id"] == "FBA16DAMAGE"
    assert ev["seller_central_link_kind"] == LINK_KIND_IDR
    assert ev["seller_central_url"] == (
        "https://sellercentral.amazon.com/help/hub/reference/GEV4254LJJ9BAEG#mnd_2jc_jcb"
    )


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
    assert "GEV4254LJJ9BAEG#mnd_2jc_jcb" in bodies
    assert "shipmentEvents" in HOW_TO_FILE_INBOUND
    assert "inbound-shipment-workflow" not in HOW_TO_FILE_INBOUND
    assert "help/hub/contact-us" not in bodies
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
        "seller_central_url": "https://sellercentral.amazon.com/fba/inbound-shipment/summary/FBA16BBB/shipmentEvents",
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
    queue_src = Path(__file__).resolve().parent.parent.joinpath("src/reimbursements/case_queue.py").read_text()
    assert "sellerboard_inbound_discrepancies" in queue_src
    assert "SOURCE_SELLERBOARD" in queue_src
    assert "fetch_amazon_inbound_qty" in queue_src
    assert "AMAZON_RECONCILE_BATCH" in queue_src


def test_sellerboard_closed_short_becomes_lost_inbound():
    rows = sellerboard_inbound_discrepancies(
        [{
            "shipment_id": "FBA19K98F8VN",
            "sku": "sku-c",
            "asin": "B003",
            "fulfillment_center": "SMF3",
            "quantity_shipped": 540,
            "quantity_received": 463,
            "shipment_status": "CLOSED",
            "closed_at": "2026-08-20",
        }],
        date(2026, 9, 14),
        date(2026, 6, 17),
        date(2026, 9, 14),
    )
    assert len(rows) == 1
    assert rows[0]["source"] == SOURCE_SELLERBOARD
    assert rows[0]["quantity"] == 77
    assert rows[0]["quantity_shipped"] == 540
    assert rows[0]["quantity_received"] == 463
    assert rows[0]["shipment_id"] == "FBA19K98F8VN"
    assert rows[0]["reason"] == "Lost_Inbound"
    assert rows[0]["event_key"] == "inbound|FBA19K98F8VN|SKU-C"


def test_sellerboard_working_in_transit_never_eligible():
    for status in ("WORKING", "IN_TRANSIT"):
        rows = sellerboard_inbound_discrepancies(
            [{
                "shipment_id": "FBA19WORKING",
                "sku": "SKU-Z",
                "quantity_shipped": 10,
                "quantity_received": 0,
                "shipment_status": status,
                "closed_at": "2026-08-01",
            }],
            date(2026, 9, 14),
            date(2026, 6, 17),
            date(2026, 9, 14),
        )
        assert rows == [], status


def test_sellerboard_and_spapi_same_shipment_sku_dedupe():
    events = build_case_events(
        adjustments=[],
        shipments=[{
            "shipment_id": "FBA19K98F8VN",
            "shipment_status": "CLOSED",
            "destination_fc": "SMF3",
            "closed_at": "2026-08-20",
        }],
        shipment_items=[{
            "shipment_id": "FBA19K98F8VN",
            "sku": "SKU-C",
            "quantity_shipped": 540,
            "quantity_received": 463,
        }],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        sellerboard_rows=[{
            "shipment_id": "FBA19K98F8VN",
            "sku": "SKU-C",
            "asin": "B003",
            "fulfillment_center": "SMF3",
            "quantity_shipped": 540,
            "quantity_received": 463,
            "shipment_status": "CLOSED",
            "closed_at": "2026-08-20",
        }],
    )
    needs = [e for e in events if e["status"] == STATUS_NEEDS_CASE]
    assert len(needs) == 1
    assert needs[0]["source"] == SOURCE_INBOUND
    assert needs[0]["quantity"] == 77


def test_sellerboard_row_survives_when_spapi_has_no_closed():
    events = build_case_events(
        adjustments=[],
        shipments=[{
            "shipment_id": "FBA19LIVEONLY",
            "shipment_status": "IN_TRANSIT",
            "destination_fc": "ONT8",
            "last_updated_at": "2026-09-10",
        }],
        shipment_items=[{
            "shipment_id": "FBA19LIVEONLY",
            "sku": "SKU-LIVE",
            "quantity_shipped": 12,
            "quantity_received": 0,
        }],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        sellerboard_rows=[{
            "shipment_id": "FBA19K98F8VN",
            "sku": "SKU-C",
            "asin": "B003",
            "fulfillment_center": "SMF3",
            "quantity_shipped": 540,
            "quantity_received": 463,
            "shipment_status": "CLOSED",
            "closed_at": "2026-08-20",
        }],
    )
    needs = [e for e in events if e["status"] == STATUS_NEEDS_CASE]
    assert len(needs) == 1
    assert needs[0]["source"] == SOURCE_SELLERBOARD
    assert needs[0]["shipment_id"] == "FBA19K98F8VN"
    assert is_active_inbound_alert(needs[0]) is True


def test_sellerboard_paid_dedupe_and_dana_existing_row():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[{
            "approval_date": "2026-08-25",
            "reimbursement_id": "R-LI",
            "reason": "Lost_Inbound",
            "sku": "SKU-C",
            "qty_total": 77,
            "amount_per_unit": 4.0,
            "amount_total": 308.0,
            # Shipment-tied paid only (SKU-pool must not clear this FBA id).
            "case_id": "FBA19K98F8VN",
        }],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        existing_events=[{
            "event_key": "inbound|FBA19K98F8VN|SKU-C",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "SKU-C",
            "asin": "B003",
            "quantity": 77,
            "quantity_shipped": 540,
            "quantity_received": 463,
            "reason": "Lost_Inbound",
            "reason_group": "lost_inbound",
            "fulfillment_center": "SMF3",
            "shipment_id": "FBA19K98F8VN",
            "shipment_status": "CLOSED",
            "status": STATUS_NEEDS_CASE,
        }],
    )
    assert events[0]["status"] == STATUS_ALREADY_REIMBURSED
    assert is_active_inbound_alert(events[0]) is False


def test_dismiss_persists_across_rebuild_new_shipment_still_alerts():
    submitted = {
        "event_key": "inbound|FBA19OLD|SKU-C",
        "source": SOURCE_SELLERBOARD,
        "status": STATUS_CASE_SUBMITTED,
        "dismissed_at": "2026-09-10T12:00:00Z",
        "dismissed_note": "filed",
    }
    rebuilt = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        sellerboard_rows=[
            {
                "shipment_id": "FBA19OLD",
                "sku": "SKU-C",
                "fulfillment_center": "SMF3",
                "quantity_shipped": 10,
                "quantity_received": 7,
                "shipment_status": "CLOSED",
                "closed_at": "2026-08-01",
            },
            {
                "shipment_id": "FBA19NEW",
                "sku": "SKU-C",
                "fulfillment_center": "SMF3",
                "quantity_shipped": 20,
                "quantity_received": 18,
                "shipment_status": "CLOSED",
                "closed_at": "2026-09-01",
            },
        ],
        existing_events=[submitted],
    )
    by_sid = {e["shipment_id"]: e for e in rebuilt}
    assert by_sid["FBA19OLD"]["status"] == STATUS_CASE_SUBMITTED
    assert by_sid["FBA19OLD"]["dismissed_at"] == "2026-09-10T12:00:00Z"
    assert by_sid["FBA19NEW"]["status"] == STATUS_NEEDS_CASE
    assert is_active_inbound_alert(by_sid["FBA19OLD"]) is False
    assert is_active_inbound_alert(by_sid["FBA19NEW"]) is True


def test_merge_inbound_prefers_spapi_keeps_sellerboard_qty():
    merged = merge_inbound_sources(
        [{
            "event_key": "inbound|FBA1|SKU-A",
            "source": SOURCE_INBOUND,
            "sku": "SKU-A",
            "shipment_id": "FBA1",
            "quantity": 3,
        }],
        [{
            "event_key": "inbound|FBA1|SKU-A",
            "source": SOURCE_SELLERBOARD,
            "sku": "SKU-A",
            "shipment_id": "FBA1",
            "quantity": 3,
            "quantity_shipped": 10,
            "quantity_received": 7,
            "fulfillment_center": "ONT8",
        }],
    )
    assert len(merged) == 1
    assert merged[0]["source"] == SOURCE_INBOUND
    assert merged[0]["quantity_shipped"] == 10
    assert merged[0]["fulfillment_center"] == "ONT8"


def test_preserve_submitted_does_not_revive_paid():
    out = preserve_submitted_status(
        [{
            "event_key": "inbound|FBA1|SKU-A",
            "status": STATUS_ALREADY_REIMBURSED,
            "quantity": 0,
        }],
        [{
            "event_key": "inbound|FBA1|SKU-A",
            "status": STATUS_CASE_SUBMITTED,
        }],
    )
    assert out[0]["status"] == STATUS_ALREADY_REIMBURSED


def test_inbound_howto_mentions_sellerboard_closed():
    assert "Sellerboard CLOSED" in HOW_TO_FILE_INBOUND
    assert "shipmentEvents" in HOW_TO_FILE_INBOUND
    assert "Reference ID" in HOW_TO_FILE_INBOUND


def test_inbound_match_key_is_case_insensitive():
    assert inbound_match_key("FBA19K98F8VN", "DDPE0001Shop") == (
        "FBA19K98F8VN",
        "DDPE0001SHOP",
    )
    assert inbound_match_key("fba19k98f8vn", "ddpe0001shop") == inbound_match_key(
        "FBA19K98F8VN", "DDPE0001SHOP",
    )
    assert inbound_live_short(540, 540, 2) == 0
    assert inbound_live_short(None, None, 0) == 0
    assert inbound_live_short(None, None, None) is None
    assert is_inbound_balanced(540, 540) is True
    assert is_inbound_balanced(540, 538) is False
    assert is_inbound_balanced(None, None, None) is False


def test_balanced_sellerboard_reconciles_needs_case_casefold_sku():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        sellerboard_rows=[{
            "shipment_id": "FBA19BALANCED",
            "sku": "DDPE0001Shop",
            "asin": "B0CLFSGG49",
            "fulfillment_center": "HGR6",
            "quantity_shipped": 540,
            "quantity_received": 540,
            "quantity_short": 0,
            "shipment_status": "CLOSED",
            "closed_at": "2026-08-20",
        }],
        existing_events=[{
            "event_key": "inbound|FBA19BALANCED|DDPE0001SHOP",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "DDPE0001SHOP",
            "asin": "B0CLFSGG49",
            "quantity": 2,
            "quantity_shipped": 540,
            "quantity_received": 538,
            "reason": "Lost_Inbound",
            "reason_group": "lost_inbound",
            "fulfillment_center": "HGR6",
            "shipment_id": "FBA19BALANCED",
            "status": STATUS_NEEDS_CASE,
        }],
    )
    row = next(e for e in events if e["event_key"] == "inbound|FBA19BALANCED|DDPE0001SHOP")
    assert row["status"] == STATUS_FOUND_OFFSET
    assert row["quantity"] == 0
    assert row["quantity_shipped"] == 540
    assert row["quantity_received"] == 540
    assert row["dismissed_note"] == "reconciled"
    assert row.get("dismissed_at") in (None, "")
    assert is_active_inbound_alert(row) is False


def test_still_short_stays_needs_case_and_refreshes_qty():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        sellerboard_rows=[{
            "shipment_id": "FBA19SHORT",
            "sku": "DDPE0001Shop",
            "fulfillment_center": "LBE1",
            "quantity_shipped": 540,
            "quantity_received": 538,
            "quantity_short": 2,
            "shipment_status": "CLOSED",
            "closed_at": "2026-08-20",
        }],
        existing_events=[{
            "event_key": "inbound|FBA19SHORT|DDPE0001SHOP",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "DDPE0001SHOP",
            "quantity": 77,
            "quantity_shipped": 540,
            "quantity_received": 463,
            "reason": "Lost_Inbound",
            "shipment_id": "FBA19SHORT",
            "status": STATUS_NEEDS_CASE,
            "fulfillment_center": "LBE1",
        }],
    )
    row = next(e for e in events if e["shipment_id"] == "FBA19SHORT")
    assert row["status"] == STATUS_NEEDS_CASE
    assert row["quantity"] == 2
    assert row["quantity_received"] == 538


def test_does_not_invent_balance_without_ship_recv_or_live_short():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        existing_events=[{
            "event_key": "inbound|FBA19OPEN|SKU-C",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "SKU-C",
            "quantity": 3,
            "reason": "Lost_Inbound",
            "shipment_id": "FBA19OPEN",
            "shipment_status": "CLOSED",
            "closed_at": "2026-08-20",
            "status": STATUS_NEEDS_CASE,
            "fulfillment_center": "SMF3",
        }],
    )
    needs = [e for e in events if e["status"] == STATUS_NEEDS_CASE]
    assert len(needs) == 1
    assert needs[0]["quantity"] == 3


def test_stored_540_540_reconciles_without_sellerboard_row():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        existing_events=[{
            "event_key": "inbound|FBA19EVEN|SKU-C",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "SKU-C",
            "quantity": 2,
            "quantity_shipped": 540,
            "quantity_received": 540,
            "reason": "Lost_Inbound",
            "shipment_id": "FBA19EVEN",
            "shipment_status": "CLOSED",
            "closed_at": "2026-08-20",
            "status": STATUS_NEEDS_CASE,
            "fulfillment_center": "SMF3",
        }],
    )
    row = next(e for e in events if e["event_key"] == "inbound|FBA19EVEN|SKU-C")
    assert row["status"] == STATUS_FOUND_OFFSET
    assert row["quantity"] == 0
    assert is_active_inbound_alert(row) is False


def test_apply_inbound_balance_does_not_touch_warehouse_damage():
    live = collect_live_inbound_qty([], [])
    out = apply_inbound_balance(
        [{
            "event_key": "adj|e",
            "source": "ledger_adjustment",
            "sku": "SKU-B",
            "reason": "E",
            "quantity": 1,
            "status": STATUS_NEEDS_CASE,
        }],
        live,
        [],
    )
    assert out[0]["status"] == STATUS_NEEDS_CASE
    assert out[0]["quantity"] == 1


def test_manual_reconcile_persists_auto_balance_does_not_block_reopen():
    out = preserve_submitted_status(
        [{
            "event_key": "inbound|FBA1|SKU-A",
            "status": STATUS_NEEDS_CASE,
            "quantity": 2,
        }],
        [{
            "event_key": "inbound|FBA1|SKU-A",
            "status": STATUS_FOUND_OFFSET,
            "dismissed_at": "2026-09-15T12:00:00Z",
            "dismissed_note": "reconciled",
        }],
    )
    assert out[0]["status"] == STATUS_FOUND_OFFSET
    auto = preserve_submitted_status(
        [{
            "event_key": "inbound|FBA1|SKU-A",
            "status": STATUS_NEEDS_CASE,
            "quantity": 2,
        }],
        [{
            "event_key": "inbound|FBA1|SKU-A",
            "status": STATUS_FOUND_OFFSET,
            "dismissed_note": "reconciled",
        }],
    )
    assert auto[0]["status"] == STATUS_NEEDS_CASE


def test_amazon_live_wins_over_sellerboard_short():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        sellerboard_rows=[{
            "shipment_id": "FBA19CT9WXRX",
            "sku": "DDPE0001Shop",
            "quantity_shipped": 540,
            "quantity_received": 538,
            "quantity_short": 2,
            "shipment_status": "CLOSED",
            "closed_at": "2026-08-20",
            "fulfillment_center": "HGR6",
        }],
        existing_events=[{
            "event_key": "inbound|FBA19CT9WXRX|DDPE0001SHOP",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "DDPE0001SHOP",
            "quantity": 2,
            "reason": "Lost_Inbound",
            "shipment_id": "FBA19CT9WXRX",
            "status": STATUS_NEEDS_CASE,
            "fulfillment_center": "HGR6",
        }],
        amazon_inbound_rows=[{
            "shipment_id": "FBA19CT9WXRX",
            "sku": "DDPE0001Shop",
            "quantity_shipped": 540,
            "quantity_received": 540,
        }],
    )
    row = next(e for e in events if e["shipment_id"] == "FBA19CT9WXRX")
    assert row["status"] == STATUS_FOUND_OFFSET
    assert row["quantity"] == 0
    assert row["quantity_received"] == 540


def test_amazon_over_receive_is_balanced():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        existing_events=[{
            "event_key": "inbound|FBA19CT7HCZQ|DDPE0001SHOP",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "DDPE0001SHOP",
            "quantity": 2,
            "reason": "Lost_Inbound",
            "shipment_id": "FBA19CT7HCZQ",
            "status": STATUS_NEEDS_CASE,
            "fulfillment_center": "SMF3",
        }],
        amazon_inbound_rows=[{
            "shipment_id": "FBA19CT7HCZQ",
            "sku": "DDPE0001SHOP",
            "quantity_shipped": 540,
            "quantity_received": 541,
        }],
    )
    row = next(e for e in events if e["shipment_id"] == "FBA19CT7HCZQ")
    assert row["status"] == STATUS_FOUND_OFFSET
    assert row["quantity"] == 0


def test_amazon_still_short_keeps_needs_case():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        sellerboard_rows=[{
            "shipment_id": "FBA19L1VXQVZ",
            "sku": "DDPE0001SHOP",
            "quantity_shipped": 540,
            "quantity_received": 540,
            "quantity_short": 0,
            "shipment_status": "CLOSED",
            "closed_at": "2026-08-20",
        }],
        existing_events=[{
            "event_key": "inbound|FBA19L1VXQVZ|DDPE0001SHOP",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "DDPE0001SHOP",
            "quantity": 2,
            "reason": "Lost_Inbound",
            "shipment_id": "FBA19L1VXQVZ",
            "status": STATUS_NEEDS_CASE,
            "fulfillment_center": "LBE1",
        }],
        amazon_inbound_rows=[{
            "shipment_id": "FBA19L1VXQVZ",
            "sku": "ddpe0001shop",
            "quantity_shipped": 540,
            "quantity_received": 538,
        }],
    )
    row = next(e for e in events if e["shipment_id"] == "FBA19L1VXQVZ")
    assert row["status"] == STATUS_NEEDS_CASE
    assert row["quantity"] == 2
    assert row["quantity_received"] == 538


def test_shipment_level_single_sku_header_clears():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        existing_events=[{
            "event_key": "inbound|FBA19CP0DTJV|SKU-A",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "SKU-A",
            "quantity": 3,
            "reason": "Lost_Inbound",
            "shipment_id": "FBA19CP0DTJV",
            "status": STATUS_NEEDS_CASE,
            "fulfillment_center": "ONT8",
        }],
        amazon_shipment_totals={
            "FBA19CP0DTJV": {
                "quantity_shipped": 45,
                "quantity_received": 45,
                "quantity_short": 0,
                "sku_count": 0,
            },
        },
    )
    row = next(e for e in events if e["shipment_id"] == "FBA19CP0DTJV")
    assert row["status"] == STATUS_FOUND_OFFSET
    assert row["quantity_shipped"] == 45


def test_shipment_level_does_not_invent_on_multi_sku():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        existing_events=[{
            "event_key": "inbound|FBA19MULTI|SKU-A",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "SKU-A",
            "quantity": 2,
            "reason": "Lost_Inbound",
            "shipment_id": "FBA19MULTI",
            "shipment_status": "CLOSED",
            "closed_at": "2026-08-20",
            "status": STATUS_NEEDS_CASE,
            "fulfillment_center": "ONT8",
        }, {
            "event_key": "inbound|FBA19MULTI|SKU-B",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "SKU-B",
            "quantity": 2,
            "reason": "Lost_Inbound",
            "shipment_id": "FBA19MULTI",
            "shipment_status": "CLOSED",
            "closed_at": "2026-08-20",
            "status": STATUS_NEEDS_CASE,
            "fulfillment_center": "ONT8",
        }],
        amazon_shipment_totals={
            "FBA19MULTI": {
                "quantity_shipped": 10,
                "quantity_received": 10,
                "quantity_short": 0,
                "sku_count": 0,
            },
        },
    )
    needs = [e for e in events if e["status"] == STATUS_NEEDS_CASE]
    assert len(needs) == 2


def test_amazon_payload_parse_and_fetch_batches():
    assert 1 <= AMAZON_RECONCILE_BATCH <= 5
    rows, totals = amazon_qty_from_spapi_payloads(
        [{"ShipmentId": "FBA19DGCW81X", "QuantityShipped": 540, "QuantityReceived": 540}],
        {"FBA19DGCW81X": [{
            "SellerSKU": "DDPE0001Shop",
            "QuantityShipped": 540,
            "QuantityReceived": 540,
        }]},
    )
    assert rows[0]["sku"] == "DDPE0001SHOP"
    assert rows[0]["quantity_short"] == 0
    assert totals["FBA19DGCW81X"]["sku_count"] == 1
    batches: list[list[str]] = []

    def get_ships(batch):
        batches.append(list(batch))
        return [{"ShipmentId": batch[0], "QuantityShipped": 45, "QuantityReceived": 45}]

    def get_items(sid):
        return [{"SellerSKU": "SKU-A", "QuantityShipped": 45, "QuantityReceived": 45}]

    ids = [f"FBA19BAT{i:02d}XXXX" for i in range(12)]
    fetch_amazon_inbound_qty(ids, get_shipments=get_ships, get_items=get_items)
    assert batches
    assert all(1 <= len(b) <= 5 for b in batches)
    assert collect_reconcile_shipment_ids([{
        "shipment_id": "FBA19CP0DTJV",
        "sku": "SKU-A",
        "source": SOURCE_SELLERBOARD,
        "reason": "Lost_Inbound",
        "status": STATUS_NEEDS_CASE,
    }]) == ["FBA19CP0DTJV"]


def test_sellerboard_short_does_not_reopen_amazon_found_offset():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        sellerboard_rows=[{
            "shipment_id": "FBA19CT9WXRX",
            "sku": "DDPE0001SHOP",
            "quantity_shipped": 540,
            "quantity_received": 538,
            "quantity_short": 2,
            "shipment_status": "CLOSED",
            "closed_at": "2026-08-20",
        }],
        existing_events=[{
            "event_key": "inbound|FBA19CT9WXRX|DDPE0001SHOP",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "DDPE0001SHOP",
            "quantity": 0,
            "reason": "Lost_Inbound",
            "shipment_id": "FBA19CT9WXRX",
            "status": STATUS_FOUND_OFFSET,
            "dismissed_note": "reconciled",
            "fulfillment_center": "HGR6",
        }],
    )
    row = next(e for e in events if e["shipment_id"] == "FBA19CT9WXRX")
    assert row["status"] == STATUS_FOUND_OFFSET
    assert row["quantity"] == 0


def test_amazon_short_reopens_auto_found_offset():
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
        existing_events=[{
            "event_key": "inbound|FBA19L1VXQVZ|DDPE0001SHOP",
            "source": SOURCE_SELLERBOARD,
            "event_date": "2026-08-20",
            "sku": "DDPE0001SHOP",
            "quantity": 0,
            "reason": "Lost_Inbound",
            "shipment_id": "FBA19L1VXQVZ",
            "status": STATUS_FOUND_OFFSET,
            "dismissed_note": "reconciled",
            "fulfillment_center": "LBE1",
        }],
        amazon_inbound_rows=[{
            "shipment_id": "FBA19L1VXQVZ",
            "sku": "DDPE0001SHOP",
            "quantity_shipped": 540,
            "quantity_received": 538,
        }],
    )
    row = next(e for e in events if e["shipment_id"] == "FBA19L1VXQVZ")
    assert row["status"] == STATUS_NEEDS_CASE
    assert row["quantity"] == 2


def test_deprecated_adjustments_report_is_not_the_source():
    adj = Path(__file__).resolve().parent.parent.joinpath("src/amazon_sp/adjustments.py").read_text()
    assert "GET_LEDGER_DETAIL_VIEW_DATA" in adj
    assert "deprecated" in adj.lower()
    assert 'eventType": ADJUSTMENTS_EVENT_TYPE' in adj or "eventType" in adj

def test_zero_recv_closed_receipts_full_dismisses():
    """Sellerboard CLOSED UnitsReceived=0 + Receipts cover shipped → found_offset."""
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 5, 1),
        end=date(2026, 9, 14),
        sellerboard_rows=[{
            "shipment_id": "FBA19D3KTVB8",
            "sku": "DDPE0003Shop",
            "quantity_shipped": 1080,
            "quantity_received": 0,
            "quantity_short": 1080,
            "shipment_status": "CLOSED",
            "closed_at": "2026-07-02",
            "fulfillment_center": "SCK4",
            "raw": {"plan_date": 1746967680, "UnitsReceived": 0, "Units": 1080},
        }],
        receipt_events=[{
            "event_type": "Receipts",
            "event_date": "2026-05-13",
            "sku": "DDPE0003SHOP",
            "quantity": 1080,
            "fc_code": "XSB3",
            "reference_id": "FBA19D3KTVB8",
        }],
    )
    row = next(e for e in events if e["shipment_id"] == "FBA19D3KTVB8")
    assert row["status"] == STATUS_FOUND_OFFSET
    assert row["quantity"] == 0
    assert row["quantity_received"] == 1080
    assert row.get("dismissed_at")
    assert row.get("dismissed_note") == CLEAR_NOTE_RECEIPTS_COVER


def test_real_recv_short_kept_as_needs_case():
    """Real partial receive (e.g. 538/540) stays Needs-case — not a ghost."""
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 1),
        end=date(2026, 9, 14),
        sellerboard_rows=[{
            "shipment_id": "FBA19FHXWS31",
            "sku": "DDPE0001Shop",
            "quantity_shipped": 540,
            "quantity_received": 538,
            "quantity_short": 2,
            "shipment_status": "CLOSED",
            "closed_at": "2026-07-02",
            "fulfillment_center": "LBE1",
            "raw": {"plan_date": 1748971800, "UnitsReceived": 538, "Units": 540},
        }],
        receipt_events=[{
            "event_type": "Receipts",
            "event_date": "2026-06-04",
            "sku": "DDPE0001SHOP",
            "quantity": 540,
            "fc_code": "XMD5",
            # Different shipment — must not steal cover from the real short.
            "reference_id": "FBA19FHXPN77",
        }],
    )
    row = next(e for e in events if e["shipment_id"] == "FBA19FHXWS31")
    assert row["status"] == STATUS_NEEDS_CASE
    assert row["quantity"] == 2


def test_sku_pool_reimb_does_not_reduce_shipment_claimable():
    """Lost_Inbound SKU-pool cash must not fake partial paid on a shipment."""
    events = build_case_events(
        adjustments=[],
        shipments=[],
        shipment_items=[],
        reimbursements=[{
            "approval_date": "2026-07-16",
            "reimbursement_id": "R-POOL",
            "reason": "Lost_Inbound",
            "sku": "DDPE0001Shop",
            "qty_total": 85,
            "amount_per_unit": 6.02,
            "amount_total": 511.70,
            "case_id": "21208325051",  # digit case id — not FBA*
            "order_id": None,
        }],
        start=date(2026, 6, 1),
        end=date(2026, 9, 14),
        sellerboard_rows=[{
            "shipment_id": "FBA19FHXWS31",
            "sku": "DDPE0001Shop",
            "quantity_shipped": 540,
            "quantity_received": 538,
            "quantity_short": 2,
            "shipment_status": "CLOSED",
            "closed_at": "2026-07-02",
        }],
    )
    row = next(e for e in events if e["shipment_id"] == "FBA19FHXWS31")
    assert row["status"] == STATUS_NEEDS_CASE
    assert row["quantity"] == 2
    assert row.get("matched_reimbursed_qty", 0) == 0


def test_shipment_tied_reimb_still_reduces_claimable():
    out = apply_paid_dedupe([{
        "event_key": "inbound|FBA19AAA|SKU-A",
        "source": SOURCE_SELLERBOARD,
        "event_date": date(2026, 8, 1),
        "sku": "SKU-A",
        "quantity": 10,
        "reason": "Lost_Inbound",
        "reason_group": "lost_inbound",
        "shipment_id": "FBA19AAA",
        "fulfillment_center": "PHX6",
    }], [{
        "approval_date": "2026-08-10",
        "reimbursement_id": "R-SHIP",
        "reason": "Lost_Inbound",
        "sku": "SKU-A",
        "qty_total": 4,
        "amount_per_unit": 5.0,
        "case_id": "FBA19AAA",
    }])
    assert out[0]["quantity"] == 6
    assert out[0]["matched_reimbursed_qty"] == 4
    assert out[0]["status"] == STATUS_NEEDS_CASE


def test_receipt_cover_sku_pool_exact_qty_without_reference_id():
    """Heuristic: exact-qty Receipts near plan_date clear zero-recv CLOSED."""
    covered = apply_receipt_cover([{
        "event_key": "inbound|FBA19GHOST|SKU-Z",
        "source": SOURCE_SELLERBOARD,
        "event_date": date(2026, 7, 2),
        "sku": "SKU-Z",
        "quantity": 90,
        "quantity_shipped": 90,
        "quantity_received": 0,
        "reason": "Lost_Inbound",
        "reason_group": "lost_inbound",
        "shipment_id": "FBA19GHOST",
        "status": STATUS_NEEDS_CASE,
        "plan_date": "2026-05-10",
        "fulfillment_center": "RDU2",
    }], [{
        "event_type": "Receipts",
        "event_date": "2026-05-16",
        "sku": "SKU-Z",
        "quantity": 90,
        "fc_code": "HIA1",
    }])
    assert covered[0]["status"] == STATUS_FOUND_OFFSET
    assert covered[0]["quantity"] == 0
    assert covered[0].get("dismissed_at")
