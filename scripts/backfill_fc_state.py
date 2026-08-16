#!/usr/bin/env python3
"""Backfill inventory_events.state_code from fc_codes.json.

Usage:
    python scripts/backfill_fc_state.py --dry-run
    python scripts/backfill_fc_state.py --live
"""
from __future__ import annotations

import argparse
import csv
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.config import load_fc_codes
from src.mappers.fc_to_state import fc_to_state
from src.db import get_client


def main():
    parser = argparse.ArgumentParser(description="Backfill inventory_events.state_code")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true")
    group.add_argument("--live", action="store_true")
    args = parser.parse_args()

    client = get_client()

    # Count nulls before
    result = client.table("inventory_events") \
        .select("id", count="exact") \
        .is_("state_code", "null") \
        .execute()
    null_count = result.count or 0
    print(f"Rows with state_code=null: {null_count:,}")

    if null_count == 0:
        print("Nothing to backfill.")
        return

    # Get distinct fc_codes that have null state_code
    # Supabase doesn't support DISTINCT easily, so fetch fc_code values in pages
    print("Gathering distinct fc_codes with null state_code...")
    fc_counts: dict[str, int] = defaultdict(int)
    offset = 0
    PAGE = 1000
    while True:
        batch = client.table("inventory_events") \
            .select("fc_code") \
            .is_("state_code", "null") \
            .range(offset, offset + PAGE - 1) \
            .execute()
        rows = batch.data or []
        if not rows:
            break
        for r in rows:
            fc = r.get("fc_code", "")
            if fc:
                fc_counts[fc] += 1
        offset += PAGE
        if len(rows) < PAGE:
            break

    print(f"Distinct fc_codes with null state: {len(fc_counts)}")

    # Resolve each fc_code
    resolvable: dict[str, tuple[str, int]] = {}  # fc -> (state, count)
    unresolvable: dict[str, int] = {}  # fc -> count
    total_fixable = 0

    for fc in sorted(fc_counts):
        count = fc_counts[fc]
        state = fc_to_state(fc)
        if state:
            resolvable[fc] = (state, count)
            total_fixable += count
        else:
            unresolvable[fc] = count

    print(f"\nResolvable: {len(resolvable)} FCs → {total_fixable:,} rows")
    print(f"Unresolvable: {len(unresolvable)} FCs → {sum(unresolvable.values()):,} rows")

    # Print resolution table
    print(f"\n{'FC Code':<15} {'State':>5} {'Rows':>8}")
    print("-" * 30)
    for fc in sorted(resolvable, key=lambda x: resolvable[x][1], reverse=True):
        state, count = resolvable[fc]
        print(f"{fc:<15} {state:>5} {count:>8,}")

    if unresolvable:
        print(f"\nUnmapped FCs:")
        for fc in sorted(unresolvable, key=lambda x: unresolvable[x], reverse=True):
            print(f"  {fc}: {unresolvable[fc]:,} rows")

    if args.dry_run:
        print(f"\nDRY RUN — no changes made. {total_fixable:,} rows would be updated.")
        return

    # Live update
    print(f"\nUpdating {total_fixable:,} rows...")
    updated_total = 0
    for fc, (state, count) in sorted(resolvable.items()):
        result = client.table("inventory_events") \
            .update({"state_code": state}) \
            .eq("fc_code", fc) \
            .is_("state_code", "null") \
            .execute()
        updated = len(result.data) if result.data else 0
        updated_total += updated
        print(f"  {fc} → {state}: {updated:,} updated")

    print(f"\nTotal updated: {updated_total:,}")

    # Verify remaining nulls
    result = client.table("inventory_events") \
        .select("id", count="exact") \
        .is_("state_code", "null") \
        .execute()
    remaining = result.count or 0
    print(f"Remaining null state_code: {remaining:,}")

    # Write unmapped FCs if any
    if unresolvable:
        out = ROOT / "exports" / "unmapped_fcs.csv"
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["fc_code", "row_count"])
            for fc in sorted(unresolvable, key=lambda x: unresolvable[x], reverse=True):
                w.writerow([fc, unresolvable[fc]])
        print(f"Unmapped FCs written to {out}")


if __name__ == "__main__":
    main()
