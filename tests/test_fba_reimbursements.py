"""FBA reimbursements parser — LA approval day, signed cash, CSV detect."""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.amazon_sp.reports import (
    _dedupe_reimbursements,
    _parse_signed_money,
    parse_reimbursements,
)
from src.parsers.amazon_reimbursements import is_fba_reimbursements_report
from src.rules import AMAZON_TZ, SPAPI_REIMBURSEMENTS_DAYS


TSV = """approval-date\treimbursement-id\tcase-id\tamazon-order-id\treason\tsku\tfnsku\tasin\tproduct-name\tcondition\tcurrency-unit\tamount-per-unit\tamount-total\tquantity-reimbursed-cash\tquantity-reimbursed-inventory\tquantity-reimbursed-total
2026-07-02T15:04:00-07:00\tX1\tC1\t111-1\tLost\tSKU-A\tF1\tB001\tTallow\tNew\tUSD\t100.00\t100.00\t1\t0\t1
2026-07-18T08:00:00-07:00\tX2\tC2\t111-2\tDamaged\tSKU-B\tF2\tB002\tBalm\tNew\tUSD\t50.25\t50.25\t1\t0\t1
2026-07-28T23:30:00-07:00\tX3\tC3\t111-3\tReversal\tSKU-A\tF1\tB001\tTallow\tNew\tUSD\t-3423.78\t-3423.78\t0\t0\t0
"""

CSV_PAREN = """approval-date,reimbursement-id,sku,amount-total,amount-per-unit,quantity-reimbursed-cash,quantity-reimbursed-inventory,quantity-reimbursed-total
07/15/2026,R-REV,SKU-C,"($12.50)",($12.50),0,0,0
2026-07-15,R-CR,SKU-C,$12.50,12.50,1,0,1
"""


def test_signed_money_credits_and_reversals():
    assert _parse_signed_money("100.00") == 100.0
    assert _parse_signed_money("-3423.78") == -3423.78
    assert _parse_signed_money("($12.50)") == -12.5
    assert _parse_signed_money("$12.50") == 12.5
    assert _parse_signed_money("") == 0.0


def test_parse_reimbursements_la_day_and_july_net():
    parsed = parse_reimbursements(TSV)
    assert parsed["rows_parsed"] == 3
    assert parsed["rows_skipped"] == 0
    assert round(parsed["total_amount"], 2) == -3273.53

    days = []
    for rec in parsed["records"]:
        dt = __import__("datetime").datetime.fromisoformat(rec["approval_date"])
        assert dt.tzinfo is not None
        days.append(dt.astimezone(AMAZON_TZ).date())
    assert days == [date(2026, 7, 2), date(2026, 7, 18), date(2026, 7, 28)]
    # Noon LA so a UTC slice cannot fall onto the previous Amazon day.
    assert all(dt.astimezone(AMAZON_TZ).hour == 12 for rec in parsed["records"]
               for dt in [__import__("datetime").datetime.fromisoformat(rec["approval_date"])])


def test_parse_csv_reversal_parentheses_and_us_date():
    parsed = parse_reimbursements(CSV_PAREN)
    assert parsed["rows_parsed"] == 2
    assert parsed["records"][0]["amount_total"] == -12.5
    assert parsed["records"][1]["amount_total"] == 12.5
    assert parsed["total_amount"] == 0.0
    for rec in parsed["records"]:
        dt = __import__("datetime").datetime.fromisoformat(rec["approval_date"])
        assert dt.astimezone(AMAZON_TZ).date() == date(2026, 7, 15)


def test_detect_reimbursements_not_sku_economics():
    assert is_fba_reimbursements_report(
        ["approval-date", "reimbursement-id", "sku", "amount-total"]
    )
    assert is_fba_reimbursements_report(
        ["Approval Date", "Reimbursement ID", "SKU", "Amount Total"]
    )
    # SKU Economics has a value column, not reimbursement-id.
    assert not is_fba_reimbursements_report(
        ["MSKU", "FBA Inventory Reimbursement", "Sponsored Products charge total"]
    )
    assert not is_fba_reimbursements_report(
        ["amazon-order-id", "sku", "item-price"]
    )


def test_dedupe_last_row_wins():
    rows = [
        {"reimbursement_id": "X1", "sku": "A", "amount_total": 1},
        {"reimbursement_id": "X1", "sku": "A", "amount_total": 2},
        {"reimbursement_id": "X2", "sku": "", "amount_total": 3},
    ]
    out = _dedupe_reimbursements(rows)
    assert len(out) == 2
    assert out[0]["amount_total"] == 2


def test_contribution_formula_excludes_reimbursements():
    from src.pnl import compute_pnl
    from src.rules import PNL_CONTRIBUTION_FORMULA
    src = Path(__file__).resolve().parent.parent.joinpath("src/pnl.py").read_text()
    assert "reimburse" not in PNL_CONTRIBUTION_FORMULA
    assert "contribution = round(sales - referral - fba - ads - cogs, 2)" in src
    # compute_pnl must not read the reimbursements table.
    import inspect
    assert "fba_reimbursements" not in inspect.getsource(compute_pnl)


def test_nightly_window_covers_july_at_end_of_august():
    # 2026-08-30 as-of minus 90d still includes 2026-07-02.
    assert SPAPI_REIMBURSEMENTS_DAYS >= 90
    from datetime import timedelta
    as_of = date(2026, 8, 30)
    start = as_of - timedelta(days=SPAPI_REIMBURSEMENTS_DAYS)
    assert start <= date(2026, 7, 2)
