#!/usr/bin/env python3
"""
End-to-end demo using sample data files.
Parses sample Amazon inventory and Shopify order files (dry run — no DB required).

Usage: python scripts/demo.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

SAMPLE_DIR = Path(__file__).resolve().parent.parent / "tests" / "sample_data"


def main():
    print("=" * 60)
    print("Sales Tax Compliance Agent — Demo (Dry Run)")
    print("=" * 60)

    print("\n--- 1. Parse Amazon Inventory Report ---\n")
    from src.parsers.amazon_inventory import parse_amazon_inventory_file

    amazon_file = SAMPLE_DIR / "amazon_inventory_sample.csv"
    result = parse_amazon_inventory_file(amazon_file)

    print(f"File: {result['filename']}")
    print(f"Rows total: {result['rows_total']}")
    print(f"Rows parsed: {result['rows_parsed']}")
    print(f"Rows skipped: {result['rows_skipped']}")
    print(f"States found: {sorted(result['states_found'])}")
    print(f"Unknown FC codes: {sorted(result['unknown_fcs'])}")

    if result["warnings"]:
        print("\nWarnings:")
        for w in result["warnings"]:
            print(f"  ⚠️  {w}")

    print("\nInventory presence by state:")
    state_details: dict[str, dict] = {}
    for event in result["events"]:
        sc = event.state_code
        if not sc:
            continue
        if sc not in state_details:
            state_details[sc] = {"events": 0, "fcs": set(), "first": event.event_date}
        state_details[sc]["events"] += 1
        state_details[sc]["fcs"].add(event.fc_code)
        if event.event_date < state_details[sc]["first"]:
            state_details[sc]["first"] = event.event_date

    for sc in sorted(state_details):
        d = state_details[sc]
        print(f"  {sc}: {d['events']} events, FCs: {sorted(d['fcs'])}, first seen: {d['first']}")

    print("\n--- 2. Parse Shopify Orders ---\n")
    from src.parsers.shopify_orders import parse_shopify_csv

    shopify_file = SAMPLE_DIR / "shopify_orders_sample.csv"
    result = parse_shopify_csv(shopify_file)

    print(f"File: {result['filename']}")
    print(f"Rows total: {result['rows_total']}")
    print(f"Rows skipped: {result['rows_skipped']}")
    print(f"States: {sorted(set(s.state_code for s in result['sales']))}")

    print("\nSales by state:")
    for sale in sorted(result["sales"], key=lambda s: s.gross_sales, reverse=True):
        print(f"  {sale.state_code}: {sale.order_count} orders, ${sale.gross_sales:,.2f} sales, "
              f"${sale.tax_collected:,.2f} tax collected")

    print("\n--- 3. FC Code Mapping ---\n")
    from src.mappers.fc_to_state import fc_to_state

    test_codes = ["DFW7", "ONT8", "PHL7", "BNA5", "EWR9", "SDF8", "SMF6",
                  "IND5", "MKE5", "TPA2", "UNKNOWN1", "XYZ99"]
    for code in test_codes:
        state = fc_to_state(code)
        status = state if state else "⚠️  UNMAPPED"
        print(f"  {code} → {status}")

    print("\n--- 4. State Rules Check ---\n")
    from src.config import load_state_rules
    rules = load_state_rules()
    states = rules.get("states", {})

    high_priority = ["CA", "TX", "PA", "NY", "NJ", "FL"]
    for sc in high_priority:
        rule = states.get(sc, {})
        print(f"  {sc} ({rule.get('state_name', '')}):")
        print(f"    Economic threshold: ${rule.get('economic_threshold_amount', 0):,.0f}")
        print(f"    FBA creates nexus: {rule.get('fba_inventory_creates_nexus', '?')}")
        if rule.get("franchise_tax_notes"):
            print(f"    ⚠️  Franchise tax: {rule['franchise_tax_notes'][:100]}...")
        print()

    print("=" * 60)
    print("Demo complete. To run with real data:")
    print("  1. Set up Supabase and .env (see README)")
    print("  2. python scripts/setup_supabase.py")
    print("  3. python ingest.py --amazon path/to/real-report.csv")
    print("  4. python -m src.main analyze")
    print("=" * 60)


if __name__ == "__main__":
    main()
