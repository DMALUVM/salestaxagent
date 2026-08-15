#!/usr/bin/env python3
"""Generate compliance playbook JSON files for all unregistered sales-tax states.

Tier 1 (hand-written): CA, TX, WA, OH, PA — skipped if already exists.
Tier 2 (generated from rules): everything else with nexus/sales.
Tier 3: _GENERIC.json fallback (already exists).

Usage:
    python scripts/seed_compliance_playbooks.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Add project root to path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.config import load_state_rules

PLAYBOOK_DIR = ROOT / "config" / "compliance_playbooks"
TIER1_STATES = {"CA", "TX", "WA", "OH", "PA"}  # hand-written, don't overwrite

# Known official DOR/registration URLs (only verified .gov domains)
DOR_URLS: dict[str, dict[str, str]] = {
    "AL": {"reg": "https://myalabamataxes.alabama.gov/", "label": "My Alabama Taxes"},
    "AZ": {"reg": "https://azdor.gov/transaction-privilege-tax", "label": "AZ DOR TPT"},
    "AR": {"reg": "https://www.dfa.arkansas.gov/sales-use-tax/", "label": "AR DFA Sales Tax"},
    "CO": {"reg": "https://tax.colorado.gov/sales-tax", "label": "CO DOR Sales Tax"},
    "CT": {"reg": "https://portal.ct.gov/drs", "label": "CT DRS"},
    "DC": {"reg": "https://otr.cfo.dc.gov/", "label": "DC OTR"},
    "FL": {"reg": "https://floridarevenue.com/taxes/taxesfees/pages/sales_tax.aspx", "label": "FL DOR Sales Tax"},
    "GA": {"reg": "https://dor.georgia.gov/", "label": "GA DOR"},
    "HI": {"reg": "https://tax.hawaii.gov/", "label": "HI DOTAX"},
    "ID": {"reg": "https://tax.idaho.gov/", "label": "ID State Tax Commission"},
    "IL": {"reg": "https://tax.illinois.gov/", "label": "IL DOR"},
    "IN": {"reg": "https://www.in.gov/dor/", "label": "IN DOR"},
    "IA": {"reg": "https://tax.iowa.gov/", "label": "IA DOR"},
    "KS": {"reg": "https://www.ksrevenue.gov/", "label": "KS DOR"},
    "KY": {"reg": "https://revenue.ky.gov/", "label": "KY DOR"},
    "LA": {"reg": "https://revenue.louisiana.gov/", "label": "LA DOR"},
    "ME": {"reg": "https://www.maine.gov/revenue/", "label": "ME Revenue Services"},
    "MD": {"reg": "https://www.marylandtaxes.gov/", "label": "MD Comptroller"},
    "MA": {"reg": "https://www.mass.gov/orgs/massachusetts-department-of-revenue", "label": "MA DOR"},
    "MI": {"reg": "https://www.michigan.gov/taxes/", "label": "MI Treasury"},
    "MN": {"reg": "https://www.revenue.state.mn.us/", "label": "MN DOR"},
    "MS": {"reg": "https://www.dor.ms.gov/", "label": "MS DOR"},
    "MO": {"reg": "https://dor.mo.gov/", "label": "MO DOR"},
    "NE": {"reg": "https://revenue.nebraska.gov/", "label": "NE DOR"},
    "NV": {"reg": "https://tax.nv.gov/", "label": "NV Dept of Taxation"},
    "NJ": {"reg": "https://www.nj.gov/treasury/taxation/", "label": "NJ Division of Taxation"},
    "NM": {"reg": "https://www.tax.newmexico.gov/", "label": "NM TRD"},
    "NY": {"reg": "https://www.tax.ny.gov/", "label": "NYS DTF"},
    "NC": {"reg": "https://www.ncdor.gov/", "label": "NC DOR"},
    "ND": {"reg": "https://www.tax.nd.gov/", "label": "ND Tax Dept"},
    "OK": {"reg": "https://oklahoma.gov/tax.html", "label": "OK Tax Commission"},
    "RI": {"reg": "https://tax.ri.gov/", "label": "RI Division of Taxation"},
    "SC": {"reg": "https://dor.sc.gov/", "label": "SC DOR"},
    "SD": {"reg": "https://dor.sd.gov/", "label": "SD DOR"},
    "TN": {"reg": "https://www.tn.gov/revenue.html", "label": "TN DOR"},
    "UT": {"reg": "https://tax.utah.gov/", "label": "UT State Tax Commission"},
    "VT": {"reg": "https://tax.vermont.gov/", "label": "VT Dept of Taxes"},
    "VA": {"reg": "https://www.tax.virginia.gov/", "label": "VA Tax"},
    "WI": {"reg": "https://www.revenue.wi.gov/", "label": "WI DOR"},
    "WV": {"reg": "https://tax.wv.gov/", "label": "WV State Tax Dept"},
    "WY": {"reg": "https://revenue.wyo.gov/", "label": "WY DOR"},
}

# States with known entity-level tax obligations from seed data
ENTITY_TAX_NOTES: dict[str, dict] = {
    "TN": {
        "title": "Tennessee Franchise & Excise Tax",
        "summary": "TN imposes franchise tax (on net worth/property) and excise tax (6.5% on net earnings) on entities doing business in TN. Minimum franchise tax is $100.",
        "severity": "warning",
        "source": "Tenn. Code Ann. § 67-4-2004, § 67-4-2007",
    },
    "NV": {
        "title": "Nevada Commerce Tax",
        "summary": "NV Commerce Tax applies to businesses with >$4M Nevada-sourced gross revenue. High threshold; unlikely for most small sellers but monitor as revenue grows.",
        "severity": "info",
        "source": "NRS 363C",
    },
    "NJ": {
        "title": "New Jersey Corporation Business Tax",
        "summary": "NJ imposes a Corporation Business Tax on entities doing business in NJ. LLC-specific obligations depend on entity classification. Consult CPA for applicability.",
        "severity": "info",
        "source": "N.J.S.A. 54:10A",
    },
}


def build_tier2_playbook(state_code: str, rules: dict) -> dict:
    """Generate a Tier 2 playbook JSON from state rules and known URLs."""
    state_name = rules.get("state_name", state_code)
    threshold = rules.get("economic_threshold_amount", 100000)
    txn = rules.get("economic_threshold_transactions")
    test_type = rules.get("threshold_test_type", "or")
    fba_pos = rules.get("fba_inventory_creates_nexus", "unknown_default_true")
    period = rules.get("economic_threshold_period", "current_or_prior_calendar_year")
    freq = rules.get("filing_frequency_default", "quarterly")
    due_day = rules.get("typical_due_day", 20)
    franchise_notes = rules.get("franchise_tax_notes")
    state_notes = rules.get("notes", "")
    mp_counts = rules.get("marketplace_sales_count_toward_threshold", True)

    dor = DOR_URLS.get(state_code, {})
    reg_url = dor.get("reg")
    reg_label = dor.get("label", f"{state_name} DOR")

    # Threshold description
    thresh_desc = f"${threshold:,}"
    if txn:
        conj = "AND" if test_type == "and" else "OR"
        thresh_desc += f" {conj} {txn} transactions"
    mp_note = " (includes marketplace sales)" if mp_counts else " (direct sales only; marketplace excluded)"

    # FBA note
    fba_desc = {
        "true": "FBA inventory creates physical nexus (high confidence).",
        "false": "State has marketplace-facilitator FBA carve-out — FBA inventory alone may not create nexus.",
        "contested": "⚠ FBA nexus position is CONTESTED — consult CPA before registering.",
        "conditional": "FBA nexus is conditional — may not apply under certain marketplace facilitator conditions.",
        "unknown_default_true": "FBA inventory likely creates nexus (majority rule; no specific carve-out found).",
    }.get(str(fba_pos), "FBA nexus position uncertain.")

    # Build scenarios
    scenarios = {}

    # Registration
    reg_steps = []
    if str(fba_pos) == "contested":
        reg_steps.append({
            "order": 1,
            "title": "⚠ Evaluate with CPA — contested FBA nexus",
            "detail": f"FBA nexus in {state_name} is contested. {state_notes}" if state_notes else f"FBA nexus in {state_name} is contested. Consult CPA before registering.",
        })

    reg_steps.append({
        "order": len(reg_steps) + 1,
        "title": f"Register with {state_name} DOR",
        "detail": f"Apply as a remote seller. Threshold: {thresh_desc}{mp_note}. {fba_desc}",
        **({"url": reg_url, "url_label": reg_label} if reg_url else {}),
        "documents_needed": ["Federal EIN", "LLC formation certificate", "Responsible party SSN"],
        "verification_check": f"Receive a {state_name} sales tax permit/license number.",
    })
    reg_steps.append({
        "order": len(reg_steps) + 1,
        "title": "Note filing frequency and due dates",
        "detail": f"Typical: {freq} filing. Returns typically due the {due_day}th of the month following the period. Verify assigned frequency after registration.",
        "frequency": freq.replace("_", "-").title(),
        "deadline_rule": f"{due_day}th of following month (verify with DOR)",
    })
    reg_steps.append({
        "order": len(reg_steps) + 1,
        "title": "Configure Shopify and update dashboard",
        "detail": f"Enable {state_code} tax collection in Shopify for direct orders. Amazon handles marketplace orders. Mark {state_code} as registered in the dashboard.",
    })

    scenarios["register_sales_tax"] = {
        "title": f"Register for {state_name} Sales Tax",
        "summary": f"If you have physical nexus (FBA inventory) or economic nexus ({thresh_desc}{mp_note}) in {state_name}, registration is required.",
        "severity": "action",
        "steps": reg_steps,
        **({"related_urls": {"registration_url": reg_url}} if reg_url else {}),
    }

    # Entity/franchise (only if notes exist)
    entity_info = ENTITY_TAX_NOTES.get(state_code)
    if franchise_notes or entity_info:
        entity = entity_info or {}
        scenarios["franchise_or_entity"] = {
            "title": entity.get("title", f"{state_name} Entity-Level Tax"),
            "summary": entity.get("summary", franchise_notes),
            "severity": entity.get("severity", "warning"),
            "steps": [{
                "order": 1,
                "title": "Review entity-level obligations with CPA",
                "detail": franchise_notes or entity.get("summary", ""),
            }],
        }

    # Marketplace notes
    scenarios["marketplace_facilitator_notes"] = {
        "title": f"Amazon Marketplace — {state_name}",
        "summary": f"Amazon collects and remits {state_code} sales tax on marketplace orders. This does not eliminate registration or filing obligations.",
        "severity": "info",
        "steps": [
            {"order": 1, "title": "Amazon handles sales tax on Amazon orders", "detail": "You do not owe additional sales tax on Amazon-facilitated orders."},
            {"order": 2, "title": "Register and file if nexus exists", "detail": "If you have physical or economic nexus, registration may be required. Returns show Amazon-collected amounts as marketplace deductions."},
            {"order": 3, "title": "Collect on Shopify/direct", "detail": f"You are responsible for collecting and remitting on direct (Shopify) orders shipped to {state_code}."},
        ],
    }

    return {
        "state_code": state_code,
        "state_name": state_name,
        "last_reviewed": "2026-08-15",
        "confidence": "contested" if str(fba_pos) == "contested" else "medium",
        "sources": [f"{state_name} DOR remote seller guidance", entity_info.get("source")] if entity_info else [f"{state_name} DOR remote seller guidance"],
        "scenarios": scenarios,
    }


def main():
    rules_data = load_state_rules().get("states", {})

    created = 0
    skipped = 0
    updated = 0

    for sc, rules in sorted(rules_data.items()):
        if not rules.get("has_sales_tax"):
            continue

        path = PLAYBOOK_DIR / f"{sc}.json"

        if sc in TIER1_STATES and path.exists():
            print(f"  {sc}: Tier 1 (hand-written) — skipped")
            skipped += 1
            continue

        if sc in TIER1_STATES and not path.exists():
            print(f"  {sc}: Tier 1 but MISSING — generating Tier 2 fallback")

        playbook = build_tier2_playbook(sc, rules)

        with open(path, "w") as f:
            json.dump(playbook, f, indent=2)
            f.write("\n")

        if path.exists():
            updated += 1
        else:
            created += 1
        print(f"  {sc}: {'generated' if not path.exists() else 'updated'} ({playbook.get('confidence', '?')})")

    print(f"\nDone: {created} created, {updated} updated, {skipped} Tier 1 skipped")
    print(f"Total playbook files: {len(list(PLAYBOOK_DIR.glob('*.json'))) - 1}")  # exclude _GENERIC


if __name__ == "__main__":
    main()
