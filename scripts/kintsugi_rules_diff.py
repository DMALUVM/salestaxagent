#!/usr/bin/env python3
"""Compare our state_rules against Kintsugi/public-source economic nexus data.

Outputs a CSV diff report to exports/cpa/.
Does NOT modify production rules. Flags discrepancies for CPA review.

Sources: nexusbystate.com, numeral.com, taxcloud.com, eightx.co (2026).
Kintsugi pages returned 403; cross-referenced from above public sources.
"""
import csv
import io
import json
from datetime import date, datetime, timezone
from pathlib import Path

# ── Public-source reference data (2026, cross-verified) ───

REFERENCE = {
    # state: (dollar_threshold, txn_threshold_or_None, test_type, period_hint, mp_counts, notes)
    "AL": (250000, None,  "or",  "prior_calendar_year",                True,  ""),
    "AR": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  ""),
    "AZ": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  "Txn threshold repealed"),
    "CA": (500000, None,  "or",  "current_or_prior_calendar_year",     True,  "Trailing nexus into following year"),
    "CO": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  ""),
    "CT": (100000, 200,   "and", "12mo_ending_sep30",                  True,  "Both must be met; collection starts Oct 1"),
    "DC": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  ""),
    "FL": (100000, None,  "or",  "prior_calendar_year",               True,  ""),
    "GA": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  ""),
    "HI": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  "GET not traditional sales tax"),
    "IA": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  ""),
    "ID": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  ""),
    "IL": (100000, None,  "or",  "prior_12_months",                    True,  "200-txn threshold REPEALED Jan 1 2026"),
    "IN": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  ""),
    "KS": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  ""),
    "KY": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  ""),
    "LA": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  ""),
    "MA": (100000, None,  "or",  "prior_calendar_year",               True,  ""),
    "MD": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  ""),
    "ME": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  "Txn threshold repealed"),
    "MI": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  ""),
    "MN": (100000, 200,   "or",  "prior_12_months",                    True,  "Rolling 12 months"),
    "MO": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  "Effective Jan 1 2023"),
    "MS": (250000, None,  "or",  "prior_12_months",                    True,  ""),
    "NC": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  "Txn threshold repealed 2024"),
    "ND": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  "Txn threshold repealed"),
    "NE": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  ""),
    "NJ": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  ""),
    "NM": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  "Gross Receipts Tax"),
    "NV": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  ""),
    "NY": (500000, 100,   "and", "prior_4_quarters",                   True,  "Both must be met"),
    "OH": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  ""),
    "OK": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  ""),
    "PA": (100000, None,  "or",  "prior_calendar_year",               True,  "Collection delayed to April 1 following year"),
    "RI": (100000, 200,   "or",  "prior_calendar_year",               True,  ""),
    "SC": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  ""),
    "SD": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  "Wayfair origin; txn repealed"),
    "TN": (100000, None,  "or",  "prior_12_months",                    True,  ""),
    "TX": (500000, None,  "or",  "prior_12_months",                    True,  ""),
    "UT": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  "Txn threshold removed Jul 1 2025"),
    "VA": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  ""),
    "VT": (100000, 200,   "or",  "prior_12_months",                    True,  ""),
    "WA": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  "Txn repealed 2019; B&O separate"),
    "WI": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  "Txn threshold repealed"),
    "WV": (100000, 200,   "or",  "current_or_prior_calendar_year",     True,  ""),
    "WY": (100000, None,  "or",  "current_or_prior_calendar_year",     True,  "Txn threshold repealed"),
}


def run_diff():
    root = Path(__file__).resolve().parent.parent
    with open(root / "config" / "state_rules.json") as f:
        our_rules = json.load(f)["states"]

    rows = []
    priority_states = {"CT", "NC", "NY", "PA", "OH", "TX", "CA"}

    for sc in sorted(REFERENCE.keys()):
        ref_amt, ref_txn, ref_test, ref_period, ref_mp, ref_notes = REFERENCE[sc]
        our = our_rules.get(sc, {})
        if not our.get("has_sales_tax"):
            continue

        our_amt = our.get("economic_threshold_amount")
        our_txn = our.get("economic_threshold_transactions")
        our_test = our.get("threshold_test_type", "or")
        our_period = our.get("economic_threshold_period", "current_or_prior_calendar_year")
        our_mp = our.get("marketplace_sales_count_toward_threshold")

        # Compare each field
        fields = [
            ("economic_threshold_amount", our_amt, ref_amt),
            ("economic_threshold_transactions", our_txn, ref_txn),
            ("threshold_test_type", our_test, ref_test),
            ("economic_threshold_period", our_period, ref_period),
            ("marketplace_sales_count_toward_threshold", our_mp, ref_mp),
        ]

        for field, our_val, ref_val in fields:
            # Normalize for comparison
            our_norm = our_val
            ref_norm = ref_val
            if our_norm is None and ref_norm is None:
                match = True
            elif our_norm is None or ref_norm is None:
                match = False
            else:
                match = str(our_norm).lower() == str(ref_norm).lower()

            needs_review = ""
            if not match:
                needs_review = "YES — verify against state DOR"

            is_priority = sc in priority_states

            rows.append({
                "state_code": sc,
                "priority": "HIGH" if is_priority else "",
                "field": field,
                "our_value": str(our_val) if our_val is not None else "(null)",
                "reference_value": str(ref_val) if ref_val is not None else "(null)",
                "match": "YES" if match else "NO",
                "notes": ref_notes if not match else "",
                "primary_source_needed": needs_review,
            })

    # Sort: mismatches first, then priority, then state
    rows.sort(key=lambda r: (
        r["match"] == "YES",       # NO first
        r["priority"] != "HIGH",   # HIGH first
        r["state_code"],
    ))

    return rows


def write_report(rows: list[dict]):
    root = Path(__file__).resolve().parent.parent
    out_dir = root / "exports" / "cpa"
    out_dir.mkdir(parents=True, exist_ok=True)

    ts = date.today().isoformat()
    path = out_dir / f"kintsugi_rules_diff_{ts}.csv"

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=[
        "state_code", "priority", "field", "our_value",
        "reference_value", "match", "notes", "primary_source_needed",
    ])
    writer.writeheader()
    writer.writerows(rows)

    content = output.getvalue()
    path.write_text(content, encoding="utf-8")

    return path, rows


def print_summary(rows: list[dict]):
    mismatches = [r for r in rows if r["match"] == "NO"]
    priority_mismatches = [r for r in mismatches if r["priority"] == "HIGH"]
    states_with_diffs = sorted(set(r["state_code"] for r in mismatches))

    print("=" * 72)
    print("KINTSUGI / PUBLIC-SOURCE RULES DIFF vs OUR state_rules.json")
    print("=" * 72)
    print(f"DISCLAIMER: Secondary commercial summary. Verify against")
    print(f"each state's official DOR before changing registration posture.")
    print(f"Sources: nexusbystate.com, numeral.com, taxcloud.com, eightx.co")
    print()
    print(f"Total fields compared: {len(rows)}")
    print(f"Mismatches: {len(mismatches)} across {len(states_with_diffs)} states")
    print(f"Priority mismatches: {len(priority_mismatches)}")
    print()

    if mismatches:
        print(f"{'State':<6} {'Pri':<5} {'Field':<42} {'Ours':<12} {'Reference':<12} {'Notes'}")
        print("-" * 110)
        for r in mismatches:
            print(f"{r['state_code']:<6} {r['priority']:<5} {r['field']:<42} {r['our_value']:<12} {r['reference_value']:<12} {r['notes']}")

    print()
    print("States with differences:", ", ".join(states_with_diffs))


if __name__ == "__main__":
    rows = run_diff()
    path, _ = write_report(rows)
    print_summary(rows)
    print(f"\nCSV: {path}")
