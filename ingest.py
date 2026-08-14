#!/usr/bin/env python3
"""
Convenience script for one-time data ingestion.

Usage:
    python ingest.py --amazon path/to/inventory-report.csv
    python ingest.py --shopify
    python ingest.py --shopify-csv path/to/orders.csv
    python ingest.py --registrations path/to/registrations.csv
    python ingest.py --amazon path/to/report.csv --dry-run
"""
from __future__ import annotations

import csv
import sys
from datetime import date
from pathlib import Path

import click


@click.command()
@click.option("--amazon", "amazon_path", type=click.Path(exists=True),
              help="Path to Amazon Inventory Event Detail CSV/TXT file")
@click.option("--shopify", "shopify_api", is_flag=True,
              help="Pull orders from Shopify Admin API")
@click.option("--shopify-csv", "shopify_csv_path", type=click.Path(exists=True),
              help="Path to Shopify order export CSV")
@click.option("--registrations", "reg_path", type=click.Path(exists=True),
              help="Path to state registrations CSV")
@click.option("--dry-run", is_flag=True, help="Parse and validate without writing to database")
def ingest(amazon_path, shopify_api, shopify_csv_path, reg_path, dry_run):
    """Ingest sales tax data from various sources."""

    if not any([amazon_path, shopify_api, shopify_csv_path, reg_path]):
        click.echo("No data source specified. Use --help for options.")
        click.echo("\nExample commands:")
        click.echo("  python ingest.py --amazon ~/Downloads/inventory-event-detail.csv")
        click.echo("  python ingest.py --shopify")
        click.echo("  python ingest.py --shopify-csv ~/Downloads/shopify-orders.csv")
        click.echo("  python ingest.py --registrations ~/registrations.csv")
        sys.exit(1)

    if dry_run:
        click.echo("DRY RUN — no data will be written to the database.\n")

    if amazon_path:
        click.echo(f"Ingesting Amazon inventory report: {amazon_path}")
        from src.parsers.amazon_inventory import ingest_amazon_inventory
        result = ingest_amazon_inventory(amazon_path, dry_run=dry_run)
        _print_result("Amazon Inventory", result)

    if shopify_api:
        click.echo("Fetching orders from Shopify API...")
        from src.parsers.shopify_orders import fetch_shopify_orders_api
        result = fetch_shopify_orders_api()
        if result.get("error"):
            click.echo(f"Error: {result['error']}")
        else:
            click.echo(f"Orders fetched: {result.get('orders_fetched', 0)}")
            click.echo(f"States: {result.get('states_found', [])}")
            click.echo(f"Total sales: ${result.get('total_sales', 0):,.2f}")
            click.echo(f"Rows inserted: {result.get('rows_inserted', 0)}")

    if shopify_csv_path:
        click.echo(f"Ingesting Shopify order CSV: {shopify_csv_path}")
        from src.parsers.shopify_orders import ingest_shopify_csv
        result = ingest_shopify_csv(shopify_csv_path, dry_run=dry_run)
        _print_result("Shopify Orders", result)

    if reg_path:
        click.echo(f"Importing registrations: {reg_path}")
        _import_registrations(reg_path, dry_run)

    click.echo("\nDone. Run 'python -m src.main analyze' for full nexus analysis.")


def _print_result(source: str, result: dict):
    click.echo(f"\n  {source} Results:")
    click.echo(f"  Rows total:    {result.get('rows_total', 0)}")
    click.echo(f"  Rows parsed:   {result.get('rows_parsed', result.get('total_orders', 0))}")
    click.echo(f"  Rows inserted: {result.get('rows_inserted', 0)}")
    click.echo(f"  States found:  {result.get('states_found', [])}")

    if result.get("unknown_fcs"):
        click.echo(f"  Unknown FCs:   {result['unknown_fcs']}")
        click.echo(f"    → Add these to config/fc_codes.json")

    if result.get("total_sales"):
        click.echo(f"  Total sales:   ${result['total_sales']:,.2f}")

    for w in result.get("warnings", []):
        click.echo(f"  ⚠️  {w}")


def _import_registrations(path: str, dry_run: bool):
    rows = []
    with open(path, "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            state = (row.get("state") or "").strip().upper()
            if not state or len(state) != 2:
                continue

            registered = (row.get("registered") or "").strip().lower() in ("true", "yes", "1", "y")
            frequency = (row.get("filing_frequency") or "").strip().lower() or None
            due_day = None
            try:
                due_day = int(row.get("typical_due_day", "").strip())
            except (ValueError, AttributeError):
                pass

            rows.append({
                "state_code": state,
                "is_registered": registered,
                "assigned_frequency": frequency,
                "registration_date": date.today().isoformat() if registered else None,
                "has_physical_nexus": False,
                "has_economic_nexus": False,
                "economic_progress_amount": 0,
                "economic_progress_transactions": 0,
                "economic_progress_percent": 0,
            })

    click.echo(f"  Found {len(rows)} registration entries")

    if not dry_run and rows:
        from src.db import upsert_rows, log_audit
        inserted = upsert_rows("nexus_status", rows, on_conflict="state_code")
        click.echo(f"  Imported {inserted} registration records")
        log_audit(
            action="import_registrations",
            category="ingestion",
            details={"states": [r["state_code"] for r in rows]},
            source_file=path,
            rows_affected=inserted,
        )
    elif dry_run:
        for r in rows:
            click.echo(f"    {r['state_code']}: registered={r['is_registered']}, "
                       f"frequency={r.get('assigned_frequency', 'N/A')}")


if __name__ == "__main__":
    ingest()
