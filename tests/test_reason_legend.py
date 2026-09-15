"""Amazon ledger reason legend — M is lost_warehouse, 7 is not Found."""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.reimbursements.case_queue import (
    LINK_KIND_SUPPORT_MANUAL,
    SC_SUPPORT_HUB,
    STATUS_NEEDS_CASE,
    build_case_events,
    fail_if_empty_adjustments_pull,
    fba_shipment_id,
    is_fba_shipment_id,
    reason_group,
    reason_label,
    seller_central_link,
)
from src.reimbursements.qa import (
    CaseQueueSyncError,
    evaluate_queue_qa,
    notify_gate_errors,
)
from src.reimbursements.reason_legend import (
    CLASSIFICATION_VERSION,
    LEDGER_REASON_LEGEND,
    NOTIFY_BLOCK_COPY,
    is_eligible_loss,
    is_found_reason,
    is_unknown_reason,
    lookup_reason,
)


def test_legend_table_encodes_amazon_codes():
    by_code = {row.code: row for row in LEDGER_REASON_LEGEND}
    assert by_code["M"].group == "lost_warehouse"
    assert by_code["M"].label == "Inventory misplaced"
    assert by_code["M"].eligible is True
    assert "NOT lost inbound" in by_code["M"].notes
    assert by_code["F"].group == "found"
    assert by_code["Q"].eligible is False
    assert by_code["P"].eligible is False
    assert by_code["E"].group == "warehouse_damage"
    for code in ("6", "7", "H", "K", "U"):
        assert by_code[code].group == "warehouse_damage"
        assert by_code[code].eligible is True
    assert by_code["D"].eligible is False
    assert by_code["D"].group == "disposed"
    assert by_code["O"].eligible is False
    assert by_code["O"].group == "correction"
    assert by_code["G"].eligible is False
    assert by_code["N"].eligible is False
    assert by_code["7"].label == "Damaged at FC"


def test_m_is_lost_warehouse_not_lost_inbound():
    assert reason_group("M") == "lost_warehouse"
    assert reason_group("m") == "lost_warehouse"
    assert reason_group("M") != "lost_inbound"
    assert lookup_reason("M").group == "lost_warehouse"
    assert reason_label("M") == "M — Inventory misplaced"
    assert "Lost inbound" not in reason_label("M")


def test_full_text_reasons_still_map():
    assert reason_group("Lost_Warehouse") == "lost_warehouse"
    assert reason_group("Lost_Inbound") == "lost_inbound"
    assert reason_group("Damaged_Warehouse") == "warehouse_damage"
    assert reason_label("Lost_Inbound") == "Lost inbound"
    assert reason_label("Damaged_Warehouse") == "Warehouse damage"


def test_code_7_is_damage_not_found():
    assert is_found_reason("7") is False
    assert is_found_reason("F") is True
    assert is_found_reason("Found") is True
    assert reason_group("7") == "warehouse_damage"
    assert is_eligible_loss("7", -1) is True
    assert is_eligible_loss("F", 2) is False


def test_qp_and_g_and_n_excluded():
    assert is_eligible_loss("Q", -2) is False
    assert is_eligible_loss("P", 2) is False
    assert is_eligible_loss("G", -1) is False
    assert is_eligible_loss("N", 1) is False
    assert reason_group("Q") == "other"
    assert reason_group("G") == "other"


def test_d_and_o_never_needs_case_even_with_damaged_disposition():
    for code in ("D", "O", "d", "o"):
        assert is_eligible_loss(code, -1, "WAREHOUSE_DAMAGED") is False
        assert reason_group(code, "WAREHOUSE_DAMAGED") == "other"
        assert reason_group(code) != "warehouse_damage"
    assert reason_label("D") == "D — Inventory disposed of"
    assert reason_label("O") == "O — Inventory correction"
    # Eligible damage codes still work; M is still lost_warehouse.
    assert is_eligible_loss("E", -1, "WAREHOUSE_DAMAGED") is True
    assert is_eligible_loss("7", -1, "WAREHOUSE_DAMAGED") is True
    assert reason_group("E") == "warehouse_damage"
    assert reason_group("7") == "warehouse_damage"
    assert reason_group("M", "WAREHOUSE_DAMAGED") == "lost_warehouse"
    assert reason_group("M") != "lost_inbound"


def test_disposition_does_not_promote_unknown_or_blank_letters():
    assert reason_group(None, "WAREHOUSE_DAMAGED") == "other"
    assert is_eligible_loss("", -1, "WAREHOUSE_DAMAGED") is False
    assert is_eligible_loss("Z", -1, "WAREHOUSE_DAMAGED") is False
    assert reason_group("Z", "WAREHOUSE_DAMAGED") == "other"
    assert reason_group("M", "SELLABLE") == "lost_warehouse"


def test_m_unreconciled_zero_is_not_eligible():
    assert is_eligible_loss("M", -1, unreconciled_qty=0) is False
    assert is_eligible_loss("M", -1, unreconciled_qty=1) is True
    assert is_eligible_loss("M", -1, unreconciled_qty=None) is True


def test_reference_id_digit_string_is_not_shipment():
    ref = "20080126439780"
    assert is_fba_shipment_id(ref) is False
    assert fba_shipment_id(None, ref) is None
    assert fba_shipment_id("FBA16ABCDE", ref) == "FBA16ABCDE"
    url, kind = seller_central_link(None, ref)
    assert url == SC_SUPPORT_HUB
    assert kind == LINK_KIND_SUPPORT_MANUAL


def test_build_events_maps_m_and_keeps_reference_out_of_shipment():
    events = build_case_events(
        adjustments=[{
            "event_key": "adj|m",
            "event_date": "2026-08-01",
            "sku": "SKU-A",
            "asin": "B001",
            "quantity": -2,
            "reason": "M",
            "fulfillment_center": "ONT8",
            "reference_id": "20080126439780",
            "disposition": "SELLABLE",
        }],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
    )
    assert len(events) == 1
    ev = events[0]
    assert ev["status"] == STATUS_NEEDS_CASE
    assert ev["reason_group"] == "lost_warehouse"
    assert ev["reason_label"] == "M — Inventory misplaced"
    assert ev["shipment_id"] is None
    assert ev["reference_id"] == "20080126439780"
    assert ev["seller_central_link_kind"] == LINK_KIND_SUPPORT_MANUAL
    assert ev["classification_version"] == CLASSIFICATION_VERSION


def test_qp_rows_never_enter_needs_case():
    events = build_case_events(
        adjustments=[
            {
                "event_key": "adj|q",
                "event_date": "2026-08-01",
                "sku": "SKU-Q",
                "quantity": -3,
                "reason": "Q",
                "fulfillment_center": "PHX6",
                "reference_id": "111",
            },
            {
                "event_key": "adj|p",
                "event_date": "2026-08-01",
                "sku": "SKU-Q",
                "quantity": 3,
                "reason": "P",
                "fulfillment_center": "PHX6",
                "reference_id": "222",
            },
        ],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
    )
    assert events == []


def test_notify_gate_blocks_unknown_missing_fc_outdated():
    rows = [{
        "event_key": "adj|bad",
        "status": STATUS_NEEDS_CASE,
        "quantity": 1,
        "reason": "ZZZ",
        "fulfillment_center": None,
        "classification_version": "old",
    }]
    qa = evaluate_queue_qa(rows)
    assert qa["ok"] is False
    errors = notify_gate_errors(rows, qa)
    assert errors
    assert any("unknown reason" in e for e in errors)
    assert any("missing FC" in e for e in errors)
    assert any("classification_version" in e for e in errors)
    assert "Do not prep" in NOTIFY_BLOCK_COPY


def test_notify_gate_allows_verified_row():
    rows = [{
        "event_key": "adj|ok",
        "status": STATUS_NEEDS_CASE,
        "quantity": 1,
        "reason": "M",
        "disposition": "SELLABLE",
        "fulfillment_center": "ONT8",
        "classification_version": CLASSIFICATION_VERSION,
    }]
    qa = evaluate_queue_qa(rows)
    assert qa["ok"] is True
    assert notify_gate_errors(rows, qa) == []


def test_empty_adjustments_pull_fails_loudly():
    try:
        fail_if_empty_adjustments_pull(99, 0, None)
        raise AssertionError("expected CaseQueueSyncError")
    except CaseQueueSyncError as e:
        assert "empty" in str(e).lower()
        assert "do not rebuild" in str(e).lower()
    fail_if_empty_adjustments_pull(0, 0, None)  # first sync: ok
    fail_if_empty_adjustments_pull(10, 4, None)  # pull had rows: ok


def test_unknown_reason_helper():
    assert is_unknown_reason("M") is False
    assert is_unknown_reason("D") is False
    assert is_unknown_reason("O") is False
    assert is_unknown_reason("ZZZ") is True
    assert is_unknown_reason("", "WAREHOUSE_DAMAGED") is True


def test_d_o_with_disposition_never_enter_needs_case_queue():
    from src.reimbursements.case_queue import orphan_needs_case_keys

    events = build_case_events(
        adjustments=[
            {
                "event_key": "adj|d",
                "event_date": "2026-08-01",
                "sku": "SKU-D",
                "quantity": -2,
                "reason": "D",
                "fulfillment_center": "ONT8",
                "disposition": "WAREHOUSE_DAMAGED",
                "reference_id": "111",
            },
            {
                "event_key": "adj|o",
                "event_date": "2026-08-01",
                "sku": "SKU-O",
                "quantity": -1,
                "reason": "O",
                "fulfillment_center": "SMF3",
                "disposition": "WAREHOUSE_DAMAGED",
                "reference_id": "222",
            },
            {
                "event_key": "adj|e",
                "event_date": "2026-08-01",
                "sku": "SKU-E",
                "quantity": -1,
                "reason": "E",
                "fulfillment_center": "PHX6",
                "disposition": "WAREHOUSE_DAMAGED",
            },
            {
                "event_key": "adj|7",
                "event_date": "2026-08-01",
                "sku": "SKU-7",
                "quantity": -1,
                "reason": "7",
                "fulfillment_center": "PHX6",
            },
            {
                "event_key": "adj|m",
                "event_date": "2026-08-01",
                "sku": "SKU-M",
                "quantity": -1,
                "reason": "M",
                "fulfillment_center": "ONT8",
            },
        ],
        shipments=[],
        shipment_items=[],
        reimbursements=[],
        start=date(2026, 6, 17),
        end=date(2026, 9, 14),
    )
    reasons = {e["reason"] for e in events if e["status"] == STATUS_NEEDS_CASE}
    assert reasons == {"E", "7", "M"}
    assert all(e["reason_group"] != "warehouse_damage" or e["reason"] in {"E", "7"} for e in events)
    stale = [
        {"event_key": "adj|stale-d", "status": STATUS_NEEDS_CASE, "reason": "D", "quantity": 2},
        {"event_key": "adj|stale-o", "status": STATUS_NEEDS_CASE, "reason": "O", "quantity": 1},
        {"event_key": "adj|keep-e", "status": STATUS_NEEDS_CASE, "reason": "E", "quantity": 1},
    ]
    assert orphan_needs_case_keys(stale) == ["adj|stale-d", "adj|stale-o"]
