#!/usr/bin/env python3
"""
Seed the Supabase database with state rules and intelligence layer data.
Run after creating the Supabase tables via schema.sql and schema_intelligence.sql.

Usage: python scripts/setup_supabase.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.config import load_state_rules, PROJECT_ROOT
from src.db import upsert_rows, insert_rows, fetch_all, log_audit


def seed_state_rules():
    print("Loading state rules from config/state_rules.json...")
    data = load_state_rules()
    states = data.get("states", {})

    rows = []
    for code, rule in states.items():
        rows.append({
            "state_code": code,
            "state_name": rule.get("state_name", code),
            "has_sales_tax": rule.get("has_sales_tax", True),
            "economic_threshold_amount": rule.get("economic_threshold_amount"),
            "economic_threshold_transactions": rule.get("economic_threshold_transactions"),
            "economic_threshold_period": rule.get("economic_threshold_period"),
            "fba_inventory_creates_nexus": rule.get("fba_inventory_creates_nexus", True),
            "marketplace_sales_count_toward_threshold": rule.get("marketplace_sales_count_toward_threshold", False),
            "filing_frequency_default": rule.get("filing_frequency_default"),
            "typical_due_day": rule.get("typical_due_day"),
            "franchise_tax_notes": rule.get("franchise_tax_notes"),
            "notes": rule.get("notes"),
            "last_reviewed": rule.get("last_reviewed"),
        })

    print(f"Seeding {len(rows)} state rules...")
    inserted = upsert_rows("state_rules", rows, on_conflict="state_code")
    print(f"Done. {inserted} state rules upserted.")

    log_audit(
        action="seed_state_rules",
        category="setup",
        details={"states_seeded": len(rows)},
        rows_affected=inserted,
    )


def _load_json(filename: str) -> list | dict:
    path = PROJECT_ROOT / "config" / filename
    if not path.exists():
        print(f"  ⚠ {filename} not found, skipping.")
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _serialize_json_fields(row: dict) -> dict:
    """JSON-serialize list/dict fields so they're stored as JSONB in Postgres."""
    out = dict(row)
    for key in ("primary_sources", "secondary_sources", "states_affected",
                "key_quotes", "tags"):
        if key in out and isinstance(out[key], (list, dict)):
            out[key] = json.dumps(out[key])
    return out


def seed_nexus_rules():
    print("\nSeeding nexus rules from config/seed_nexus_rules.json...")
    data = _load_json("seed_nexus_rules.json")
    rules = data.get("rules", []) if isinstance(data, dict) else data
    if not rules:
        return 0

    existing = fetch_all("nexus_rules")
    existing_keys = {(r["state_code"], r["rule_type"]) for r in existing}

    to_insert = []
    for r in rules:
        key = (r.get("state_code"), r.get("rule_type"))
        if key not in existing_keys:
            to_insert.append(_serialize_json_fields(r))

    if to_insert:
        inserted = insert_rows("nexus_rules", to_insert)
        print(f"  Inserted {inserted} nexus rules ({len(rules) - len(to_insert)} already existed).")
    else:
        print(f"  All {len(rules)} nexus rules already exist.")
        inserted = 0
    return inserted


def seed_franchise_rules():
    print("Seeding franchise rules from config/seed_franchise_rules.json...")
    data = _load_json("seed_franchise_rules.json")
    rules = data.get("rules", []) if isinstance(data, dict) else data
    if not rules:
        return 0

    existing = fetch_all("franchise_entity_rules")
    existing_keys = {(r["state_code"], r["rule_type"]) for r in existing}

    to_insert = []
    for r in rules:
        key = (r.get("state_code"), r.get("rule_type"))
        if key not in existing_keys:
            to_insert.append(_serialize_json_fields(r))

    if to_insert:
        inserted = insert_rows("franchise_entity_rules", to_insert)
        print(f"  Inserted {inserted} franchise rules ({len(rules) - len(to_insert)} already existed).")
    else:
        print(f"  All {len(rules)} franchise rules already exist.")
        inserted = 0
    return inserted


def seed_filing_rules():
    print("Seeding filing rules from config/seed_filing_rules.json...")
    data = _load_json("seed_filing_rules.json")
    rules = data.get("rules", []) if isinstance(data, dict) else data
    if not rules:
        return 0

    existing = fetch_all("filing_rules")
    existing_keys = {r["state_code"] for r in existing}

    to_insert = []
    for r in rules:
        if r.get("state_code") not in existing_keys:
            to_insert.append(_serialize_json_fields(r))

    if to_insert:
        inserted = insert_rows("filing_rules", to_insert)
        print(f"  Inserted {inserted} filing rules ({len(rules) - len(to_insert)} already existed).")
    else:
        print(f"  All {len(rules)} filing rules already exist.")
        inserted = 0
    return inserted


def seed_rulings():
    print("Seeding rulings from config/seed_rulings.json...")
    data = _load_json("seed_rulings.json")
    if not data:
        return 0

    court_rulings = data.get("court_rulings", [])
    admin_rulings = data.get("admin_rulings", [])

    court_inserted = 0
    if court_rulings:
        existing = fetch_all("court_rulings")
        existing_names = {r.get("case_name") for r in existing}
        to_insert = [r for r in court_rulings if r.get("case_name") not in existing_names]
        if to_insert:
            for r in to_insert:
                if isinstance(r.get("states_affected"), list):
                    r["states_affected"] = json.dumps(r["states_affected"])
                if isinstance(r.get("primary_sources"), list):
                    r["primary_sources"] = json.dumps(r["primary_sources"])
            court_inserted = insert_rows("court_rulings", to_insert)
        print(f"  Court rulings: {court_inserted} inserted ({len(court_rulings) - len(to_insert)} already existed).")

    admin_inserted = 0
    if admin_rulings:
        existing = fetch_all("admin_rulings")
        existing_titles = {r.get("title") for r in existing}
        to_insert = [r for r in admin_rulings if r.get("title") not in existing_titles]
        if to_insert:
            for r in to_insert:
                if isinstance(r.get("states_affected"), list):
                    r["states_affected"] = json.dumps(r["states_affected"])
                if isinstance(r.get("primary_sources"), list):
                    r["primary_sources"] = json.dumps(r["primary_sources"])
            admin_inserted = insert_rows("admin_rulings", to_insert)
        print(f"  Admin rulings: {admin_inserted} inserted ({len(admin_rulings) - len(to_insert)} already existed).")

    return court_inserted + admin_inserted


def seed_source_registry():
    print("Seeding source registry from config/source_registry.json...")
    data = _load_json("source_registry.json")
    if not data:
        return 0

    sources = data.get("sources", data) if isinstance(data, dict) else data

    existing = fetch_all("source_registry")
    existing_urls = {r.get("url") for r in existing}

    to_insert = []
    for s in sources:
        if s.get("url") not in existing_urls:
            to_insert.append(s)

    if to_insert:
        inserted = insert_rows("source_registry", to_insert)
        print(f"  Inserted {inserted} monitored sources ({len(sources) - len(to_insert)} already existed).")
    else:
        print(f"  All {len(sources)} sources already exist.")
        inserted = 0
    return inserted


def verify_tables():
    from src.db import get_client
    client = get_client()

    core_tables = [
        "state_rules", "inventory_events", "sales_by_state",
        "nexus_status", "filing_calendar", "franchise_tax_flags",
        "alerts", "audit_log", "ingestion_log",
    ]

    intel_tables = [
        "nexus_rules", "franchise_entity_rules", "filing_rules",
        "court_rulings", "admin_rulings", "source_documents",
        "source_registry", "monitoring_checks", "rule_changelog",
        "research_tasks",
    ]

    print("\nVerifying core tables...")
    for table in core_tables:
        try:
            result = client.table(table).select("*", count="exact").limit(0).execute()
            count = result.count if hasattr(result, "count") else "?"
            print(f"  ✓ {table} (rows: {count})")
        except Exception as e:
            print(f"  ✗ {table} — ERROR: {e}")

    print("\nVerifying intelligence layer tables...")
    intel_ok = True
    for table in intel_tables:
        try:
            result = client.table(table).select("*", count="exact").limit(0).execute()
            count = result.count if hasattr(result, "count") else "?"
            print(f"  ✓ {table} (rows: {count})")
        except Exception as e:
            print(f"  ✗ {table} — ERROR: {e}")
            intel_ok = False

    return intel_ok


if __name__ == "__main__":
    print("Sales Tax Agent — Database Setup\n")

    try:
        intel_ok = verify_tables()
    except Exception as e:
        print(f"\nError connecting to Supabase: {e}")
        print("Make sure SUPABASE_URL and SUPABASE_SERVICE_KEY are set in .env")
        print("And that you've run supabase/schema.sql in the SQL Editor first.")
        sys.exit(1)

    seed_state_rules()

    if intel_ok:
        print("\n--- Seeding Intelligence Layer ---")
        seed_nexus_rules()
        seed_franchise_rules()
        seed_filing_rules()
        seed_rulings()
        seed_source_registry()

        log_audit(
            action="seed_intelligence_layer",
            category="setup",
            details={"step": "initial_seed"},
        )
    else:
        print("\n⚠ Intelligence layer tables not found.")
        print("  Run supabase/schema_intelligence.sql first, then re-run this script.")

    print("\nSetup complete! Next steps:")
    print("  1. Ingest Amazon data:  python ingest.py --amazon path/to/report.csv")
    print("  2. Connect Shopify:     python ingest.py --shopify")
    print("  3. Run analysis:        python -m src.main analyze")
    print("  4. Check intel health:  python -m src.main health-report")
