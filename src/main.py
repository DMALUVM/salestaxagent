from __future__ import annotations

import signal
import sys
import time

import click


@click.group()
def cli():
    """Sales Tax Compliance Agent — Monitor nexus, track deadlines, stay compliant."""
    pass


@cli.command()
def analyze():
    """Run full nexus analysis (physical + economic) and print summary."""
    click.echo("Running nexus analysis...")

    click.echo("\n--- Physical Nexus (FBA Inventory) ---")
    from src.engines.physical_nexus import evaluate_physical_nexus
    phys = evaluate_physical_nexus()

    if phys.get("nexus_states"):
        click.echo(f"Physical nexus detected in {len(phys['nexus_states'])} states: {', '.join(phys['nexus_states'])}")
        if phys.get("new_nexus_states"):
            click.echo(f"  NEW nexus states: {', '.join(phys['new_nexus_states'])}")
    else:
        click.echo(phys.get("message", "No physical nexus detected."))

    if phys.get("franchise_flags"):
        click.echo(f"\n  Franchise tax flags: {len(phys['franchise_flags'])}")
        for flag in phys["franchise_flags"]:
            click.echo(f"    {flag['severity'].upper()}: {flag['state_code']} — {flag['description'][:100]}")

    click.echo("\n--- Economic Nexus (Sales Thresholds) ---")
    from src.engines.economic_nexus import evaluate_economic_nexus
    econ = evaluate_economic_nexus()

    if econ.get("exceeded_threshold"):
        click.echo(f"Economic nexus EXCEEDED: {', '.join(econ['exceeded_threshold'])}")
    if econ.get("approaching_threshold"):
        click.echo(f"Approaching threshold: {', '.join(econ['approaching_threshold'])}")
    if not econ.get("exceeded_threshold") and not econ.get("approaching_threshold"):
        click.echo(econ.get("message", "No states approaching economic nexus thresholds."))

    # Show top states by total sales so the user sees their Amazon data
    details = econ.get("details", {})
    if details:
        top = sorted(details.items(), key=lambda kv: kv[1].get("total_amount", 0), reverse=True)[:10]
        click.echo(f"\n  Top 10 states by total sales (Shopify + Amazon):")
        click.echo(f"  {'State':<6} {'Counted$':>12} {'Shopify':>12} {'Amazon':>12} {'Threshold':>12} {'$ Prog':>8} {'MP?':>4}")
        for sc, d in top:
            mp = "Y" if d.get("marketplace_included", True) else "N"
            click.echo(
                f"  {sc:<6} ${d['threshold_amount']:>11,.2f} ${d['shopify_amount']:>11,.2f} "
                f"${d['amazon_amount']:>11,.2f} ${(d.get('threshold_amount_cfg') or 0):>11,.0f} "
                f"{d['progress_percent']:>6.1f}% {mp:>4}"
            )
        click.echo(f"\n  MP? = marketplace sales count toward threshold (Y/N per state rule).")
        click.echo(f"  Remittance liability is always Shopify/direct only.")

    click.echo("\n--- Full Report ---")
    from src.reports.cli_reports import full_report
    click.echo(full_report())


@cli.command()
def status():
    """Show current nexus status summary."""
    from src.reports.cli_reports import nexus_summary
    click.echo(nexus_summary())


@cli.command()
@click.option("--days", default=30, help="Days ahead to check")
def deadlines(days):
    """Show upcoming filing deadlines."""
    from src.reports.cli_reports import deadlines_report
    click.echo(deadlines_report(days))


@cli.command()
def flags():
    """Show franchise / entity tax flags."""
    from src.reports.cli_reports import franchise_flags_report
    click.echo(franchise_flags_report())


@cli.command()
@click.option("--state", required=True, help="State code (e.g., TX)")
@click.option("--period", required=True, help="Period label (e.g., 2026-Q1)")
@click.option("--amount", type=float, default=None, help="Amount filed")
@click.option("--notes", default=None, help="Filing notes")
@click.option("--zero-return", is_flag=True, help="Mark as zero return")
def complete(state, period, amount, notes, zero_return):
    """Mark a filing as complete."""
    from src.calendar.filing_calendar import mark_filing_complete
    result = mark_filing_complete(state.upper(), period, amount, notes, zero_return)
    if result:
        click.echo(f"Filing marked complete: {state.upper()} {period}")
    else:
        click.echo(f"Filing not found: {state.upper()} {period}. Check state code and period label.")


@cli.command()
@click.option("--format", "fmt", type=click.Choice(["csv", "json"]), default="json")
@click.option("--output", default=None, help="Output file path")
def export(fmt, output):
    """Export nexus data for CPA review."""
    from src.reports.cli_reports import export_csv, export_json

    if output is None:
        from datetime import date
        output = f"sales_tax_report_{date.today().isoformat()}.{fmt}"

    if fmt == "csv":
        result = export_csv(output)
    else:
        result = export_json(output)
    click.echo(result)


@cli.command("test-alert")
def test_alert():
    """Send a test Telegram notification."""
    from src.alerts.telegram import send_test_alert
    result = send_test_alert()
    if result.get("sent"):
        click.echo("Test alert sent successfully! Check your Telegram.")
    else:
        click.echo(f"Failed to send alert: {result.get('error')}")


@cli.command("backfill-shopify-skus")
def backfill_shopify_skus():
    """Pull Shopify line items and populate sales_by_sku (monthly grain)."""
    click.echo("Fetching Shopify orders with line items...")
    from src.parsers.shopify_skus import fetch_shopify_skus
    result = fetch_shopify_skus()
    if result.get("error"):
        click.echo(f"Error: {result['error']}")
    else:
        click.echo(f"Orders: {result['orders_fetched']:,}")
        click.echo(f"SKU rows: {result['sku_rows']:,}")
        click.echo(f"Unique SKUs: {result['unique_skus']}")
        click.echo(f"Inserted: {result['rows_inserted']}")


@cli.command("backfill-amazon-skus")
@click.option("--start", "start_str", default=None,
              help="Start date (YYYY-MM-DD, default: 2025-01-01)")
@click.option("--end", "end_str", default=None,
              help="End date (YYYY-MM-DD, default: yesterday)")
@click.option("--dry-run", is_flag=True)
def backfill_amazon_skus(start_str, end_str, dry_run):
    """Pull Amazon SP-API orders and populate sales_by_sku (monthly grain)."""
    from datetime import date as d, timedelta
    start = d.fromisoformat(start_str) if start_str else d(2025, 1, 1)
    end = d.fromisoformat(end_str) if end_str else d.today() - timedelta(days=1)
    yesterday = d.today() - timedelta(days=1)
    if end > yesterday:
        end = yesterday

    if dry_run:
        click.echo("DRY RUN — no data will be written.\n")

    click.echo(f"Fetching Amazon SKU data: {start} to {end}")

    def _on_poll(status, elapsed):
        click.echo(f"  [{elapsed}s] {status}")

    from src.amazon_sp.reports import fetch_amazon_skus
    result = fetch_amazon_skus(start, end, dry_run=dry_run, on_poll=_on_poll)

    click.echo(f"\n  Amazon SKU Results:")
    click.echo(f"  Chunks:      {result.get('chunks', 0)}")
    click.echo(f"  Rows total:  {result.get('rows_total', 0):,}")
    click.echo(f"  Rows parsed: {result.get('rows_parsed', 0):,}")
    click.echo(f"  SKU rows:    {result.get('sku_rows', 0):,}")
    click.echo(f"  Unique SKUs: {result.get('unique_skus', 0)}")
    click.echo(f"  Inserted:    {result.get('rows_inserted', 0):,}")
    for w in result.get("warnings", []):
        click.echo(f"  Warning: {w}")


@cli.command("export-csv")
@click.option("--table", type=click.Choice(["sales_by_state", "sales_by_sku"]),
              default="sales_by_state", help="Table to export")
@click.option("--start", "start_str", default=None, help="Start date (YYYY-MM-DD)")
@click.option("--end", "end_str", default=None, help="End date (YYYY-MM-DD)")
@click.option("--output", default=None, help="Output file path")
def export_csv_cmd(table, start_str, end_str, output):
    """Export sales data as CSV for CPA review."""
    import csv as csvmod
    from datetime import date as d
    from src.db import fetch_all

    rows = fetch_all(table)
    if start_str:
        rows = [r for r in rows if (r.get("period_start") or "") >= start_str]
    if end_str:
        rows = [r for r in rows if (r.get("period_start") or "") <= end_str]

    if not rows:
        click.echo("No rows match the filter.")
        return

    if output is None:
        output = f"{table}_{d.today().isoformat()}.csv"

    keys = sorted(rows[0].keys())
    with open(output, "w", newline="") as f:
        writer = csvmod.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        writer.writerows(rows)

    click.echo(f"Exported {len(rows)} rows to {output}")


@cli.command("populate-calendar")
@click.option("--year", type=int, default=None, help="Calendar year (default: current + next)")
def populate_calendar(year):
    """Generate filing calendar entries for registered states."""
    from src.calendar.filing_calendar import populate_calendar_for_registered_states
    result = populate_calendar_for_registered_states(year)
    click.echo(f"States: {result.get('states_populated', [])}")
    click.echo(f"Entries: {result.get('entries_created', 0)}")
    if result.get("message"):
        click.echo(result["message"])


@cli.command("generate-filings")
def generate_filings_cmd():
    """Generate filing periods for all registered states (current + next year)."""
    from src.calendar.filing_calendar import populate_calendar_for_registered_states
    result = populate_calendar_for_registered_states()
    states = result.get("states_populated", [])
    entries = result.get("entries_created", 0)
    if not states:
        click.echo("No registered states found. Register states on the Registrations page first.")
    else:
        click.echo(f"Generated {entries} filing periods for {len(states)} states: {', '.join(states)}")
        click.echo(f"Years: {result.get('years', [])}")


@cli.command("health-report")
@click.option("--stale-days", default=90, help="Days before a rule is considered stale")
def health_report(stale_days):
    """Generate a Rules Health Report for the intelligence layer."""
    from src.intelligence.health_report import generate_health_report
    click.echo(generate_health_report(stale_threshold_days=stale_days))


@cli.command("query-state")
@click.argument("state_code")
def query_state(state_code):
    """Query the intelligence layer for a state's full nexus profile."""
    from src.intelligence.knowledge_base import query_state_nexus
    result = query_state_nexus(state_code)

    click.echo(f"\n═══ {result['state_name']} ({result['state_code']}) ═══\n")
    click.echo(f"Sales tax: {'Yes' if result['has_sales_tax'] else 'No'}")
    click.echo(f"Contested positions: {'Yes' if result['has_contested_positions'] else 'No'}")
    click.echo(f"Franchise risk: {'Yes' if result['has_franchise_risk'] else 'No'}")

    if result["nexus_rules"]:
        click.echo(f"\nNexus rules ({len(result['nexus_rules'])}):")
        for r in result["nexus_rules"]:
            confidence = r.get("confidence", "?")
            marker = "⚠️" if confidence == "contested" else "✓" if confidence == "high" else "○"
            click.echo(f"  {marker} [{r.get('rule_type', '?')}] {r.get('position_summary', '')[:120]}")
            click.echo(f"    Confidence: {confidence} | Last reviewed: {r.get('last_reviewed', '?')}")
            for src in (r.get("primary_sources") or [])[:3]:
                if isinstance(src, dict):
                    click.echo(f"    Source: {src.get('citation', 'N/A')}")

    if result["franchise_entity_rules"]:
        click.echo(f"\nFranchise/entity rules ({len(result['franchise_entity_rules'])}):")
        for r in result["franchise_entity_rules"]:
            click.echo(f"  🏛️ [{r.get('rule_type', '?')}] {r.get('position_summary', '')[:120]}")
            if r.get("minimum_amount"):
                click.echo(f"    Minimum: ${r['minimum_amount']:,.0f}")
            if r.get("due_date_pattern"):
                click.echo(f"    Due: {r['due_date_pattern'][:80]}")

    if result["court_rulings"]:
        click.echo(f"\nCourt rulings ({len(result['court_rulings'])}):")
        for r in result["court_rulings"]:
            click.echo(f"  📜 {r.get('case_name', '?')} ({r.get('status', '?')})")
            click.echo(f"    {r.get('holding_summary', '')[:120]}")

    if result["admin_rulings"]:
        click.echo(f"\nAdmin rulings ({len(result['admin_rulings'])}):")
        for r in result["admin_rulings"]:
            click.echo(f"  📋 {r.get('title', '?')} ({r.get('status', '?')})")
            click.echo(f"    {r.get('summary', '')[:120]}")

    click.echo(f"\n{result['disclaimer']}")


@cli.command("search-rulings")
@click.argument("query")
@click.option("--type", "ruling_type", type=click.Choice(["all", "court", "admin"]), default="all")
def search_rulings_cmd(query, ruling_type):
    """Search court and administrative rulings by keyword."""
    from src.intelligence.knowledge_base import search_rulings
    results = search_rulings(query, ruling_type)

    if not results:
        click.echo(f"No rulings found matching '{query}'.")
        return

    click.echo(f"\nFound {len(results)} ruling(s) matching '{query}':\n")
    for r in results:
        rtype = r.get("_ruling_type", "?")
        name = r.get("case_name") or r.get("title", "?")
        status = r.get("status", "?")
        click.echo(f"  [{rtype.upper()}] {name} — {status}")
        summary = r.get("holding_summary") or r.get("summary", "")
        click.echo(f"    {summary[:150]}")
        if r.get("relevance_to_fba"):
            click.echo(f"    FBA relevance: {r['relevance_to_fba'][:120]}")
        click.echo()


@cli.command("contested")
def contested_positions():
    """Show all contested positions that need attention."""
    from src.intelligence.knowledge_base import get_all_contested_positions
    positions = get_all_contested_positions()

    if not positions:
        click.echo("No contested positions in the knowledge base.")
        return

    click.echo(f"\n═══ CONTESTED POSITIONS ({len(positions)}) ═══\n")
    for p in positions:
        click.echo(f"  ⚠️  {p['state_code']} — {p['rule_type']}")
        click.echo(f"    {p.get('summary', '')[:120]}")
        if p.get("conservative"):
            click.echo(f"    Conservative: {p['conservative'][:100]}")
        if p.get("aggressive"):
            click.echo(f"    Aggressive: {p['aggressive'][:100]}")
        if p.get("open_questions"):
            click.echo(f"    Open questions: {p['open_questions'][:120]}")
        click.echo()


@cli.command("monitor-sources")
@click.option("--frequency", type=click.Choice(["weekly", "biweekly", "monthly", "quarterly"]),
              default=None, help="Filter by check frequency")
def monitor_sources(frequency):
    """Run change detection on monitored source URLs."""
    from src.intelligence.monitor import run_monitoring_cycle
    click.echo("Running source monitoring cycle...")
    result = run_monitoring_cycle(frequency_filter=frequency)
    click.echo(f"\nSources checked: {result['sources_checked']}")
    click.echo(f"Changes detected: {result['changes_detected']}")
    click.echo(f"Errors: {result['errors']}")

    if result["changes_detected"] > 0:
        click.echo("\nChanges detected in:")
        for d in result["details"]:
            if d.get("change"):
                click.echo(f"  ⚠️  {d.get('state', '?')} — {d.get('title', '?')}")


@cli.command("research-tasks")
@click.option("--status", type=click.Choice(["open", "in_progress", "completed", "all"]), default="open")
def research_tasks_cmd(status):
    """List research tasks from the intelligence layer."""
    from src.db import fetch_all
    tasks = fetch_all("research_tasks")
    if status != "all":
        tasks = [t for t in tasks if t.get("status") == status]

    if not tasks:
        click.echo(f"No {status} research tasks.")
        return

    click.echo(f"\n═══ RESEARCH TASKS ({status.upper()}) ═══\n")
    for t in sorted(tasks, key=lambda x: {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(x.get("priority", "medium"), 2)):
        click.echo(f"  [{t.get('priority', '?').upper()}] {t.get('title', '?')}")
        click.echo(f"    State: {t.get('state_code', '—')} | Type: {t.get('task_type', '?')}")
        click.echo(f"    {t.get('description', '')[:120]}")
        click.echo()


@cli.command("spapi-test")
def spapi_test():
    """Test the SP-API connection (verifies credentials)."""
    from src.config import settings
    if not settings.amazon_sp_enabled:
        click.echo("SP-API not configured.  Set AMAZON_SP_CLIENT_ID, "
                    "AMAZON_SP_CLIENT_SECRET, and AMAZON_SP_REFRESH_TOKEN in .env")
        return
    try:
        from src.amazon_sp.auth import get_access_token
        token = get_access_token()
        click.echo(f"SP-API auth OK.  Access token: {token[:20]}...")
        click.echo(f"Marketplace: {settings.amazon_sp_marketplace_id}")
    except Exception as e:
        click.echo(f"SP-API auth failed: {e}")


@cli.command("spapi-dump-headers")
@click.option("--report", "report_type", required=True,
              help="SP-API report type constant (e.g. GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL)")
@click.option("--start", "start_str", required=True, help="Start date (YYYY-MM-DD)")
@click.option("--end", "end_str", default=None, help="End date (YYYY-MM-DD)")
def spapi_dump_headers(report_type, start_str, end_str):
    """Download an SP-API report and print the raw header + first 3 data rows."""
    from datetime import date as d
    start = d.fromisoformat(start_str)
    end = d.fromisoformat(end_str) if end_str else d.today()

    click.echo(f"Requesting {report_type}: {start} to {end}")

    def _on_poll(status, elapsed):
        click.echo(f"  [{elapsed}s] {status}")

    from src.amazon_sp.client import request_and_download
    content = request_and_download(report_type, start, end, on_poll=_on_poll)

    lines = content.split("\n")
    click.echo(f"\nTotal lines: {len(lines)}")
    click.echo(f"First line length: {len(lines[0])} chars")
    click.echo(f"\n--- repr of header line ---")
    click.echo(repr(lines[0][:500]))
    click.echo(f"\n--- first 3 data rows (repr) ---")
    for i, line in enumerate(lines[1:4], 1):
        click.echo(f"Row {i}: {repr(line[:500])}")

    # Also detect delimiter and show parsed fieldnames
    from src.amazon_sp.reports import _detect_delimiter, _build_header_lookup
    import csv, io
    delim = _detect_delimiter(lines[0])
    click.echo(f"\n--- delimiter detected: {repr(delim)} ---")
    reader = csv.DictReader(io.StringIO(content), delimiter=delim, quotechar='"')
    if reader.fieldnames:
        click.echo(f"Parsed {len(reader.fieldnames)} headers:")
        for j, fn in enumerate(reader.fieldnames):
            click.echo(f"  [{j:2d}] {fn!r}")
    else:
        click.echo("NO HEADERS DETECTED")


@cli.command("spapi-orders")
@click.option("--start", "start_str", required=True,
              help="Start date (YYYY-MM-DD)")
@click.option("--end", "end_str", default=None,
              help="End date (YYYY-MM-DD, default: today)")
@click.option("--dry-run", is_flag=True,
              help="Parse and display without writing to database")
def spapi_orders(start_str, end_str, dry_run):
    """Fetch Amazon orders via SP-API and ingest into sales_by_state."""
    from datetime import date as d, timedelta
    start = d.fromisoformat(start_str)
    end = d.fromisoformat(end_str) if end_str else d.today()
    # Clamp end to yesterday — SP-API returns empty reports for future dates
    yesterday = d.today() - timedelta(days=1)
    if end > yesterday:
        end = yesterday

    if dry_run:
        click.echo("DRY RUN — no data will be written.\n")

    click.echo(f"Requesting SP-API orders report: {start} to {end}")

    def _on_poll(status, elapsed):
        click.echo(f"  [{elapsed}s] Report status: {status}")

    from src.amazon_sp.reports import fetch_orders
    result = fetch_orders(start, end, dry_run=dry_run, on_poll=_on_poll)
    _print_spapi_result("SP-API Orders", result)


@cli.command("spapi-inventory")
@click.option("--start", "start_str", required=True,
              help="Start date (YYYY-MM-DD)")
@click.option("--end", "end_str", default=None,
              help="End date (YYYY-MM-DD, default: today)")
@click.option("--dry-run", is_flag=True,
              help="Parse and display without writing to database")
def spapi_inventory(start_str, end_str, dry_run):
    """Fetch Inventory Ledger via SP-API and ingest into inventory_events."""
    from datetime import date as d, timedelta
    start = d.fromisoformat(start_str)
    end = d.fromisoformat(end_str) if end_str else d.today()
    yesterday = d.today() - timedelta(days=1)
    if end > yesterday:
        end = yesterday

    if dry_run:
        click.echo("DRY RUN — no data will be written.\n")

    click.echo(f"Requesting SP-API inventory ledger: {start} to {end}")

    def _on_poll(status, elapsed):
        click.echo(f"  [{elapsed}s] Report status: {status}")

    from src.amazon_sp.reports import fetch_inventory
    result = fetch_inventory(start, end, dry_run=dry_run, on_poll=_on_poll)
    _print_spapi_result("SP-API Inventory Ledger", result)


@cli.command("sync-daily")
@click.option("--days", default=7, help="Days back to sync")
def sync_daily_cmd(days):
    """Sync sales_daily from SP-API + Shopify (Amazon LA tz, pending included)."""
    from src.sales_daily import sync_amazon_daily, sync_shopify_daily

    click.echo(f"Syncing Amazon daily sales ({days}d, Pacific timezone, incl. pending)...")
    try:
        result = sync_amazon_daily(days=days)
        click.echo(f"  Amazon: {result.get('rows_upserted', 0)} rows, "
                   f"${result.get('total_gross', 0):,.2f}")
    except Exception as e:
        click.echo(f"  Amazon error: {e}")

    click.echo(f"Syncing Shopify daily sales ({days}d, Eastern timezone)...")
    try:
        result = sync_shopify_daily(days=days)
        click.echo(f"  Shopify: {result.get('rows_upserted', 0)} rows")
    except Exception as e:
        click.echo(f"  Shopify error: {e}")


@cli.command("ads-test")
def ads_test_cmd():
    """Test Amazon Ads API connection and list profiles."""
    from src.config import settings
    if not settings.amazon_ads_enabled:
        click.echo("Amazon Ads not configured. Set AMAZON_ADS_* in .env")
        return
    try:
        from src.amazon_ads.client import get_profiles
        profiles = get_profiles()
        click.echo(f"Connected! {len(profiles)} profile(s):")
        for p in profiles:
            click.echo(f"  ID={p.get('profileId')}  Name={p.get('accountInfo',{}).get('name','')}  "
                       f"Type={p.get('accountInfo',{}).get('type','')}  Marketplace={p.get('accountInfo',{}).get('marketplaceStringId','')}")
    except Exception as e:
        click.echo(f"Error: {e}")


@cli.command("ads-sync")
@click.option("--days", default=14, help="Days of history to sync")
def ads_sync_cmd(days):
    """Sync Amazon Ads campaigns + search terms."""
    from src.config import settings
    if not settings.amazon_ads_enabled:
        click.echo("Amazon Ads not configured.")
        return
    from src.amazon_ads.reports import sync_ads
    click.echo(f"Syncing last {days} days of Ads data...")
    result = sync_ads(days=days)
    for key, val in result.items():
        if isinstance(val, dict) and "error" in val:
            click.echo(f"  {key}: ERROR — {val['error'][:80]}")
        elif isinstance(val, dict):
            click.echo(f"  {key}: {val.get('rows', 0)} rows, {val.get('inserted', 0)} inserted")


@cli.command("ads-actions")
@click.option("--target-acos", default=30.0, help="Target ACOS %")
def ads_actions_cmd(target_acos):
    """Generate PPC action recommendations."""
    from src.amazon_ads.actions_engine import generate_recommendations
    recs = generate_recommendations(target_acos=target_acos)
    if not recs:
        click.echo("No recommendations (no ads data or all within target)")
        return
    click.echo(f"{len(recs)} recommendations:")
    for r in recs[:15]:
        evidence = r.get("evidence", {})
        if isinstance(evidence, str):
            import json
            evidence = json.loads(evidence)
        click.echo(f"  [{r['priority']}] {r['type']}: {r.get('entity_name','')[:40]}")
        click.echo(f"       Impact: ${r['impact_estimate']:.2f}  {r['suggested_action'][:60]}")


@cli.command("ads-waste")
@click.option("--days", default=14, help="Lookback days")
def ads_waste_cmd(days):
    """Show top wasted ad spend."""
    from src.db import fetch_all
    try:
        search_terms = fetch_all("ads_search_terms_daily")
    except Exception:
        click.echo("No search term data. Run ads-sync first.")
        return
    # Group zero-order spend by search term
    waste = {}
    for st in search_terms:
        orders = int(st.get("orders_14d", 0) or 0)
        if orders == 0:
            term = st.get("search_term", "?")
            waste[term] = waste.get(term, 0) + float(st.get("spend", 0) or 0)
    sorted_waste = sorted(waste.items(), key=lambda x: -x[1])
    total = sum(v for _, v in sorted_waste)
    click.echo(f"Total wasted spend (0 orders): ${total:,.2f} across {len(sorted_waste)} terms")
    for term, amount in sorted_waste[:20]:
        click.echo(f"  ${amount:>8.2f}  {term[:50]}")


@cli.command("spapi-probe")
def spapi_probe_cmd():
    """Probe which SP-API report types are authorized with current credentials."""
    from datetime import date as d, timedelta
    from src.amazon_sp.client import create_report

    end = d.today() - timedelta(days=1)
    start = end - timedelta(days=7)

    reports = [
        ("GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL", "All Orders"),
        ("GET_LEDGER_DETAIL_VIEW_DATA", "Inventory Ledger"),
        ("GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA", "FBA Customer Returns"),
        ("GET_FBA_STORAGE_FEE_CHARGES_DATA", "FBA Storage Fees"),
        ("GET_FBA_REIMBURSEMENTS_DATA", "FBA Reimbursements"),
        ("GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA", "FBA Fee Preview"),
        ("GET_SALES_AND_TRAFFIC_REPORT", "Sales & Traffic (BA)"),
        ("GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT", "Repeat Purchase (BA)"),
        ("GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_SALES_DATA", "FBA Shipment Sales"),
        ("GET_FBA_SNS_FORECAST_DATA", "Subscribe & Save Forecast"),
        ("GET_FBA_SNS_PERFORMANCE_DATA", "Subscribe & Save Performance"),
    ]

    click.echo(f"Probing {len(reports)} report types ({start} to {end})")
    click.echo(f"{'Report':<40} {'Status'}")
    click.echo("-" * 55)
    for rt, label in reports:
        try:
            create_report(rt, start, end)
            click.echo(f"  {label:<40} OK")
        except Exception as e:
            err = str(e)
            status = "403 (not authorized)" if "403" in err or "Forbidden" in err else f"ERROR: {err[:40]}"
            click.echo(f"  {label:<40} {status}")


@cli.command("spapi-returns")
@click.option("--days", default=30, help="Days back to fetch")
@click.option("--dry-run", is_flag=True)
def spapi_returns_cmd(days, dry_run):
    """Fetch FBA customer returns via SP-API."""
    from datetime import date as d, timedelta
    from src.amazon_sp.reports import fetch_fba_returns

    end = d.today() - timedelta(days=1)
    start = end - timedelta(days=days)
    if dry_run:
        click.echo("DRY RUN\n")

    click.echo(f"Fetching FBA returns: {start} to {end}")

    def _on_poll(status, elapsed):
        click.echo(f"  [{elapsed}s] {status}")

    result = fetch_fba_returns(start, end, dry_run=dry_run, on_poll=_on_poll)
    click.echo(f"Returns: {result['rows_parsed']} parsed, {result['rows_inserted']} inserted")
    click.echo(f"SKUs: {', '.join(result['skus_found'][:10])}")
    if result["reasons"]:
        click.echo("Reasons:")
        for reason, count in sorted(result["reasons"].items(), key=lambda x: -x[1]):
            click.echo(f"  {reason}: {count}")


@cli.command("forecast-sku")
@click.option("--sku", required=True, help="SKU code")
@click.option("--end", "end_date", required=True, help="End date YYYY-MM-DD")
@click.option("--start", "start_date", default=None, help="Start date (default: today)")
@click.option("--safety", default=0.15, help="Safety stock %% (default 0.15)")
def forecast_sku_cmd(sku, end_date, start_date, safety):
    """Forecast demand and coverage for a single SKU."""
    from src.forecast.sku_demand import forecast_sku

    result = forecast_sku(sku, end_date, start_date, safety)
    if result.get("error"):
        click.echo(f"Error: {result['error']}")
        return

    click.echo(f"{'='*60}")
    click.echo(f"  SKU DEMAND FORECAST — {result['product_name']}")
    click.echo(f"  {result['start_date']} → {result['end_date']} ({result['num_weeks']} weeks)")
    click.echo(f"{'='*60}")

    click.echo(f"\n  Expected:  {result['expected_units']:>8,} units")
    click.echo(f"  Coverage:  {result['coverage_units']:>8,} units ({safety*100:.0f}% safety)")
    click.echo(f"  Low/High:  {result['low_band']:>8,} / {result['high_band']:>8,}")

    m = result["methods"]
    click.echo(f"\n  TRIPLE-CHECK:")
    click.echo(f"    A) Naive run-rate:     {m['A_naive_runrate']:>8,}")
    click.echo(f"    B) Seasonal+Holiday:   {m['B_seasonal_yoy']:>8,}")
    click.echo(f"    C) SnS+organic:        {m['C_sns_plus_organic']:>8,}")
    click.echo(f"    Spread: {m['spread_pct']}%{' ⚠️ WIDE' if m['spread_warning'] else ''}")

    b = result["breakdown"]
    click.echo(f"\n  BREAKDOWN:")
    click.echo(f"    Velocity: {b['blended_daily_velocity']} u/day")
    click.echo(f"    SnS: {b['sns_active_subs']} subs, {b['sns_weekly_shipped']} shipped/wk")
    click.echo(f"    Return rate: {b['return_rate_pct']}%")

    for h in result.get("holidays", []):
        click.echo(f"    {h}")

    click.echo(f"\n  Model: {result.get('model_version', 'default')}")
    click.echo(f"  Offpeak weights: {result.get('offpeak_weights', result.get('weights', {}))}")
    if result.get("has_peak_weeks"):
        click.echo(f"  Peak weights:    {result.get('peak_weights', {})}")
        click.echo(f"  Peak protection: {'ACTIVE' if result.get('peak_protection') else 'no'}")
        click.echo(f"  Effective safety: {result.get('effective_safety_pct', 0)*100:.0f}%")
        # Show how expected compares to pure method B
        m = result["methods"]
        click.echo(f"  Expected vs pure B: {result['expected_units']:,} vs {m['B_seasonal_yoy']:,} "
                   f"({result['expected_units']/max(m['B_seasonal_yoy'],1)*100:.0f}%)")
    click.echo(f"\n  {result['disclaimer']}")
    click.echo()


@cli.command("forecast-backfill")
@click.option("--start", "start_date", required=True, help="Start date YYYY-MM-DD")
@click.option("--end", "end_date", required=True, help="End date YYYY-MM-DD")
@click.option("--min-velocity", default=0.5, help="Min V30 to include SKU")
def forecast_backfill_cmd(start_date, end_date, min_velocity):
    """Backfill forecasts for all active physical/inventory SKUs."""
    from src.forecast.sku_demand import forecast_sku
    from src.forecast.inventory_filter import filter_inventory_skus
    from src.db import fetch_all

    vel_rows = fetch_all("sku_velocity")
    all_active = sorted(set(
        v["sku"] for v in vel_rows
        if v.get("sku") and float(v.get("total_u_30", 0) or 0) > min_velocity
    ))

    active_skus, skipped = filter_inventory_skus(all_active)
    active_skus.sort()

    click.echo(f"Backfilling {len(active_skus)} physical SKUs: {start_date} → {end_date}")
    if skipped:
        click.echo(f"Skipped {len(skipped)} non-inventory: {', '.join(skipped)}")
    click.echo(f"{'='*60}")

    ok = 0
    fail = 0
    for sku in active_skus:
        try:
            result = forecast_sku(sku, end_date, start_date)
            if result.get("error"):
                click.echo(f"  {sku:<18} SKIP  {result['error']}")
                fail += 1
            else:
                click.echo(f"  {sku:<18} OK    {result['num_weeks']}wk  expected={result['expected_units']:,}")
                ok += 1
        except Exception as e:
            click.echo(f"  {sku:<18} FAIL  {str(e)[:60]}")
            fail += 1

    click.echo(f"\nDone: {ok} OK, {fail} failed/skipped out of {len(active_skus)}")


@cli.command("forecast-reconcile")
@click.option("--sku", default=None, help="Single SKU or all")
def forecast_reconcile_cmd(sku):
    """Reconcile forecasts: ingest actuals → score → calibrate."""
    from src.forecast.reconcile import run_full_reconcile

    result = run_full_reconcile(sku)
    a = result["actuals"]
    r = result["reconciliation"]
    c = result["calibration"]

    click.echo(f"Actuals: {a.get('rows_upserted', 0)} rows, {a.get('skus', 0)} SKUs "
               f"(orders: {a.get('orders_weeks', 0)} weeks, proxy: {a.get('proxy_weeks', 0)} weeks, "
               f"{a.get('skus_with_orders', 0)} SKUs with real order data)")
    click.echo(f"Reconciliation: {r.get('runs_found', 0)} runs, "
               f"{r.get('weeks_scored', 0)} weeks scored, "
               f"{r.get('skus_scored', 0)} SKUs"
               + (f" ({r.get('skus_non_inventory_skipped', 0)} non-inventory skipped)" if r.get('skus_non_inventory_skipped') else ""))
    if r.get("message"):
        click.echo(f"  {r['message']}")

    # Show per-SKU season detail
    sw = r.get("season_weights", {})
    if sw:
        for s, info in sorted(sw.items()):
            op_n = info.get("offpeak_weeks", 0)
            pk_n = info.get("peak_weeks", 0)
            status = "calibrated" if (op_n >= 8 or pk_n >= 8) else "insufficient"
            click.echo(f"  {s:<18} offpeak={op_n}wk peak={pk_n}wk → {status}")

    click.echo(f"Calibration: {c.get('calibrated', 0)} SKUs calibrated")
    if c.get("message"):
        click.echo(f"  {c['message']}")
    for ch in c.get("changes", []):
        click.echo(f"  {ch}")


@cli.command("spapi-sns")
@click.option("--weeks", default=None, type=int, help="Weeks of history (default 13)")
@click.option("--start", "start_date", default=None, help="Start date YYYY-MM-DD (overrides --weeks)")
@click.option("--dry-run", is_flag=True)
def spapi_sns_cmd(weeks, start_date, dry_run):
    """Fetch Subscribe & Save metrics via Replenishment API."""
    from src.amazon_sp.replenishment import fetch_seller_metrics, fetch_offer_metrics

    if dry_run:
        click.echo("DRY RUN\n")

    label = f"from {start_date}" if start_date else f"{weeks or 13} weeks"
    click.echo(f"Fetching seller-level SnS metrics ({label})...")
    try:
        seller = fetch_seller_metrics(weeks=weeks, start_date=start_date, dry_run=dry_run)
        click.echo(f"  Weeks: {seller['weeks_fetched']} ({seller['complete_weeks']} complete)")
        click.echo(f"  Latest complete: wk {seller['latest_week']} — "
                   f"{seller['latest_subs']:,} subs, {seller['latest_shipped']} shipped, "
                   f"${seller['latest_revenue']:,.2f} rev")
        click.echo(f"  Inserted: {seller['rows_inserted']}")
    except PermissionError as e:
        click.echo(f"  {e}")
        return
    except Exception as e:
        click.echo(f"  Error: {e}")

    click.echo("Fetching offer-level SnS metrics (latest week)...")
    try:
        offers = fetch_offer_metrics(dry_run=dry_run)
        click.echo(f"  Offers: {offers['offers_fetched']}, Week: {offers['week']}, Inserted: {offers['rows_inserted']}")
    except Exception as e:
        click.echo(f"  Error: {e}")


@cli.command("spapi-traffic")
@click.option("--days", default=7, help="Days back to fetch")
@click.option("--dry-run", is_flag=True)
def spapi_traffic_cmd(days, dry_run):
    """Fetch Amazon Sales & Traffic report via SP-API."""
    from datetime import date as d, timedelta
    from src.amazon_sp.reports import fetch_sales_traffic

    end = d.today() - timedelta(days=1)
    start = end - timedelta(days=days)
    if dry_run:
        click.echo("DRY RUN\n")

    click.echo(f"Fetching Sales & Traffic: {start} to {end}")
    result = fetch_sales_traffic(start, end, dry_run=dry_run)
    click.echo(f"Days: {result['days']}, ASINs: {result['asins']}, Inserted: {result['rows_inserted']}")


@cli.command("spapi-reimbursements")
@click.option("--days", default=30, help="Days back to fetch")
@click.option("--dry-run", is_flag=True)
def spapi_reimbursements_cmd(days, dry_run):
    """Fetch FBA reimbursements via SP-API."""
    from datetime import date as d, timedelta
    from src.amazon_sp.reports import fetch_reimbursements

    end = d.today() - timedelta(days=1)
    start = end - timedelta(days=days)
    if dry_run:
        click.echo("DRY RUN\n")

    click.echo(f"Fetching reimbursements: {start} to {end}")
    result = fetch_reimbursements(start, end, dry_run=dry_run)
    click.echo(f"Parsed: {result['rows_parsed']}, Total: ${result['total_amount']:,.2f}, Inserted: {result['rows_inserted']}")


@cli.command("spapi-refresh")
@click.option("--days", default=30, help="Number of days back to fetch (default 30)")
@click.option("--dry-run", is_flag=True)
def spapi_refresh(days, dry_run):
    """Refresh both orders and inventory from SP-API (last N days)."""
    from datetime import date as d, timedelta
    end = d.today() - timedelta(days=1)
    start = end - timedelta(days=days)

    if dry_run:
        click.echo("DRY RUN — no data will be written.\n")

    click.echo(f"SP-API refresh: {start} to {end}\n")

    def _on_poll(status, elapsed):
        click.echo(f"  [{elapsed}s] {status}")

    from src.amazon_sp.reports import fetch_orders, fetch_inventory

    click.echo("--- Orders ---")
    try:
        orders = fetch_orders(start, end, dry_run=dry_run, on_poll=_on_poll)
        _print_spapi_result("Orders", orders)
    except Exception as e:
        click.echo(f"  Orders failed: {e}")

    click.echo("\n--- Inventory Ledger ---")
    try:
        inv = fetch_inventory(start, end, dry_run=dry_run, on_poll=_on_poll)
        _print_spapi_result("Inventory", inv)
    except Exception as e:
        click.echo(f"  Inventory failed: {e}")

    click.echo("\nDone.")


def _print_spapi_result(label: str, result: dict):
    click.echo(f"\n  {label} Results:")
    if result.get("chunks", 0) > 1:
        click.echo(f"  Chunks:        {result['chunks']}")
    click.echo(f"  Rows total:    {result.get('rows_total', 0):,}")
    click.echo(f"  Rows parsed:   {result.get('rows_parsed', 0):,}")
    click.echo(f"  Rows inserted: {result.get('rows_inserted', 0):,}")
    if result.get("unique_orders"):
        click.echo(f"  Unique orders: {result['unique_orders']:,}")
    if result.get("sales_periods"):
        click.echo(f"  Sales periods: {result['sales_periods']}")
    if result.get("total_gross_sales"):
        click.echo(f"  Gross sales:   ${result['total_gross_sales']:,.2f}")
    if result.get("total_tax"):
        click.echo(f"  Tax:           ${result['total_tax']:,.2f}")
    if result.get("ship_to_states"):
        click.echo(f"  States (to):   {result['ship_to_states']}")
    if result.get("states_found"):
        click.echo(f"  States found:  {result['states_found']}")
    if result.get("unknown_fcs"):
        click.echo(f"  Unknown FCs:   {result['unknown_fcs']}")
    for w in result.get("warnings", []):
        click.echo(f"  Warning: {w}")

    # Show sample records during dry-run
    samples = result.get("_samples", [])
    if samples:
        click.echo(f"\n  Sample records ({len(samples)}):")
        for s in samples:
            if hasattr(s, "state_code"):
                click.echo(
                    f"    {s.state_code} {s.period_start}..{s.period_end}: "
                    f"${s.gross_sales:,.2f} sales, ${s.tax_collected:,.2f} tax, "
                    f"{s.order_count} orders"
                )
            elif isinstance(s, dict):
                click.echo(
                    f"    {s.get('state_code', '?')} "
                    f"{s.get('period_start', '?')}..{s.get('period_end', '?')}: "
                    f"${s.get('gross_sales', 0):,.2f} sales"
                )


@cli.command("playbook")
@click.argument("state_code", required=False, default=None)
@click.option("--export", "export_path", default=None,
              help="Write playbook to a file (e.g., ./exports/CA_playbook.md)")
@click.option("--unregistered", is_flag=True,
              help="Generate playbooks for ALL unregistered states")
@click.option("--nexus-only", is_flag=True,
              help="With --unregistered: only states with nexus/franchise flags")
def playbook_cmd(state_code, export_path, unregistered, nexus_only):
    """Generate compliance playbooks. Single state or batch unregistered."""
    from src.compliance.playbook import build_playbook
    from pathlib import Path

    if unregistered:
        from src.db import fetch_all
        nexus_rows = fetch_all("nexus_status")
        flags = {f["state_code"] for f in fetch_all("franchise_tax_flags")
                 if f.get("status") == "open"}

        targets = []
        for n in nexus_rows:
            if n.get("is_registered"):
                continue
            sc = n["state_code"]
            has_nexus = n.get("has_physical_nexus") or n.get("has_economic_nexus")
            has_flag = sc in flags
            if nexus_only and not (has_nexus or has_flag):
                continue
            targets.append(sc)

        out_dir = Path(export_path) if export_path else Path("exports/playbooks")
        out_dir.mkdir(parents=True, exist_ok=True)

        for sc in sorted(targets):
            md = build_playbook(sc)
            p = out_dir / f"{sc}_playbook.md"
            p.write_text(md, encoding="utf-8")
            click.echo(f"  {sc} → {p}")

        click.echo(f"\nExported {len(targets)} playbooks to {out_dir}/")
        return

    if not state_code:
        click.echo("Usage: playbook STATE or playbook --unregistered")
        return

    state_code = state_code.upper()
    md = build_playbook(state_code)

    if export_path:
        p = Path(export_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(md, encoding="utf-8")
        click.echo(f"Playbook exported to {p}")
    else:
        click.echo(md)


@cli.command("inventory-presence-export")
@click.option("--format", "fmt", type=click.Choice(["md", "csv", "pdf", "all"]),
              default="all", help="Output format")
@click.option("--out", "out_dir", default="exports/cpa",
              help="Output directory")
@click.option("--state", default=None, help="Single state filter (e.g., CA)")
@click.option("--validate-only", is_flag=True,
              help="Run validation checks only, no export")
@click.option("--no-upload", is_flag=True,
              help="Skip uploading to Supabase Storage")
def inventory_presence_export(fmt, out_dir, state, validate_only, no_upload):
    """CPA Export: FBA Inventory Presence by State (MD + CSV + PDF)."""
    from pathlib import Path
    from datetime import datetime, timezone
    from src.exports.inventory_presence import (
        build_markdown, build_csv, build_pdf, build_metadata,
        upload_exports, _gather_state_evidence, _run_validation,
    )

    if validate_only:
        evidence = _gather_state_evidence()
        results = _run_validation(evidence)
        for v in results:
            icon = "PASS" if v["status"] == "PASS" else "WARN"
            click.echo(f"  [{icon}] {v['check']}: {v['details']}")
        failed = any(v["status"] != "PASS" for v in results)
        click.echo(f"\n{'WARNINGS present' if failed else 'All checks passed'}")
        return

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    suffix = f"_{state}" if state else ""
    base = f"Tallowbourn_FBA_Inventory_Presence_{ts}"

    md_content = None
    csv_content = None
    pdf_bytes = None

    if fmt in ("md", "all"):
        md_content = build_markdown(state_filter=state)
        # Latest
        (out / f"inventory_presence_latest{suffix}.md").write_text(md_content, encoding="utf-8")
        # Timestamped
        p = out / f"{base}{suffix}.md"
        p.write_text(md_content, encoding="utf-8")
        click.echo(f"Markdown: {p}")

    if fmt in ("csv", "all"):
        csv_content = build_csv(state_filter=state)
        (out / f"inventory_presence_latest{suffix}.csv").write_text(csv_content, encoding="utf-8")
        p = out / f"{base}{suffix}.csv"
        p.write_text(csv_content, encoding="utf-8")
        click.echo(f"CSV: {p}")

    if fmt in ("pdf", "all"):
        pdf_bytes = build_pdf(state_filter=state)
        (out / f"inventory_presence_latest{suffix}.pdf").write_bytes(pdf_bytes)
        p = out / f"{base}{suffix}.pdf"
        p.write_bytes(pdf_bytes)
        click.echo(f"PDF: {p} ({len(pdf_bytes):,} bytes)")

    # Write metadata sidecar
    if fmt == "all":
        meta = build_metadata(state_filter=state)
        import json
        (out / "inventory_presence_meta.json").write_text(
            json.dumps(meta, indent=2), encoding="utf-8")
        click.echo(f"Metadata: {out / 'inventory_presence_meta.json'}")

    # Upload to Supabase Storage
    if not no_upload and fmt == "all" and not state:
        if md_content and csv_content and pdf_bytes:
            click.echo("Uploading to Supabase Storage...")
            try:
                meta = build_metadata()
                results = upload_exports(md_content, csv_content, pdf_bytes, meta)
                ok = sum(1 for v in results.values() if v)
                click.echo(f"  Uploaded {ok}/{len(results)} files to cpa-exports bucket")
            except Exception as e:
                click.echo(f"  Storage upload failed (non-fatal): {e}", err=True)


@cli.command("economic-nexus-audit")
@click.option("--format", "fmt", type=click.Choice(["pdf", "csv", "json", "all"]),
              default="all", help="Output format")
@click.option("--out", "out_dir", default="exports/cpa",
              help="Output directory")
@click.option("--no-upload", is_flag=True, help="Skip Supabase Storage upload")
def economic_nexus_audit(fmt, out_dir, no_upload):
    """CPA Export: Economic Nexus Audit — transparent per-state analysis."""
    from pathlib import Path
    from datetime import datetime, timezone
    from src.exports.economic_nexus_audit import (
        build_audit, build_pdf, build_csv, build_meta, upload_exports,
    )

    audit = build_audit()
    exceeded = [s["state_code"] for s in audit["states"] if s["status"] == "exceeded"]
    approaching = [s["state_code"] for s in audit["states"] if s["status"] == "approaching"]

    # Print validation
    for v in audit["validation"]:
        icon = "PASS" if v["status"] == "PASS" else "WARN"
        click.echo(f"  [{icon}] {v['check']}: {v['details']}")

    click.echo(f"\nExceeded ({len(exceeded)}): {', '.join(exceeded)}")
    click.echo(f"Approaching ({len(approaching)}): {', '.join(approaching)}")

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    if fmt in ("pdf", "all"):
        pdf_bytes = build_pdf(audit)
        p = out / f"Economic_Nexus_Audit_{ts}.pdf"
        p.write_bytes(bytes(pdf_bytes) if isinstance(pdf_bytes, bytearray) else pdf_bytes)
        click.echo(f"PDF: {p} ({len(pdf_bytes):,} bytes)")

    if fmt in ("csv", "all"):
        csv_content = build_csv(audit)
        p = out / f"Economic_Nexus_Audit_{ts}.csv"
        p.write_text(csv_content, encoding="utf-8")
        click.echo(f"CSV: {p}")

    if fmt in ("json", "all"):
        import json
        p = out / f"Economic_Nexus_Audit_{ts}.json"
        p.write_text(json.dumps(audit, indent=2, default=str), encoding="utf-8")
        click.echo(f"JSON: {p}")

    if not no_upload and fmt == "all":
        click.echo("Uploading to Supabase Storage...")
        try:
            results = upload_exports(audit)
            ok = sum(1 for v in results.values() if v)
            click.echo(f"  Uploaded {ok}/{len(results)} files to cpa-exports/economic-nexus/")
        except Exception as e:
            click.echo(f"  Storage upload failed (non-fatal): {e}", err=True)


@cli.command("kintsugi-compare")
@click.option("--file", "filepath", default=None,
              help="Path to Kintsugi XLSX (auto-detects newest in incoming/kintsugi/)")
@click.option("--window", "window", default="2024-01-01:",
              help="Date window as START:END (e.g. 2024-01-01:2026-08-16)")
@click.option("--out", "out_dir", default="exports/cpa",
              help="Output directory for CSV")
@click.option("--dry-run", is_flag=True, help="Parse Kintsugi only, no agent query")
@click.option("--no-upload", is_flag=True, help="Skip Storage upload")
def kintsugi_compare(filepath, window, out_dir, dry_run, no_upload):
    """Reconcile Kintsugi transaction report against agent sales data."""
    from pathlib import Path
    from src.exports.kintsugi_compare import (
        parse_jurisdiction_summary, build_comparison, build_csv, print_report,
    )
    from src.db import upload_to_storage

    # Auto-detect file
    if not filepath:
        kdir = Path("incoming/kintsugi")
        xlsx_files = sorted(kdir.glob("*.xlsx"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not xlsx_files:
            click.echo("No .xlsx files found in incoming/kintsugi/", err=True)
            return
        filepath = str(xlsx_files[0])
        click.echo(f"Auto-detected: {filepath}")

    # Parse window
    parts = window.split(":")
    w_start = parts[0] if parts[0] else "2024-01-01"
    w_end = parts[1] if len(parts) > 1 and parts[1] else None

    if dry_run:
        rows = parse_jurisdiction_summary(filepath)
        click.echo(f"Kintsugi: {len(rows)} US states")
        total = sum(r["txn_amount"] for r in rows)
        click.echo(f"Grand total txn amount: ${total:,.2f}")
        for r in sorted(rows, key=lambda x: x["txn_amount"], reverse=True)[:10]:
            click.echo(f"  {r['state_code']}: ${r['txn_amount']:>12,.0f}  txns: {r['txn_count']:>6,}")
        return

    comparison = build_comparison(filepath, w_start, w_end)
    report = print_report(comparison)
    click.echo(report)

    # Write CSV
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    csv_content = build_csv(comparison)
    csv_path = out / f"Kintsugi_Reconciliation_{ts}.csv"
    csv_path.write_text(csv_content, encoding="utf-8")
    click.echo(f"\nCSV: {csv_path}")

    # JSON
    import json
    json_path = out / f"Kintsugi_Reconciliation_{ts}.json"
    json_path.write_text(json.dumps(comparison, indent=2, default=str), encoding="utf-8")
    click.echo(f"JSON: {json_path}")

    # Upload
    if not no_upload:
        click.echo("Uploading to Supabase Storage...")
        try:
            upload_to_storage("cpa-exports", "kintsugi-compare/latest.csv",
                              csv_content.encode("utf-8"), "text/csv")
            upload_to_storage("cpa-exports", "kintsugi-compare/latest.json",
                              json.dumps(comparison, indent=2, default=str).encode("utf-8"),
                              "application/json")
            meta = {
                "generated_at": comparison["generated_at"],
                "window": comparison["window"],
                "totals": comparison["totals"],
                "flags_count": len(comparison["flags"]),
            }
            upload_to_storage("cpa-exports", "kintsugi-compare/meta.json",
                              json.dumps(meta, indent=2).encode("utf-8"), "application/json")
            click.echo("  Uploaded 3 files to cpa-exports/kintsugi-compare/")
        except Exception as e:
            click.echo(f"  Upload failed (non-fatal): {e}", err=True)


@cli.command("registration-triage")
@click.option("--format", "fmt", type=click.Choice(["md", "csv", "all"]),
              default="all", help="Output format")
@click.option("--out", "out_dir", default="exports/cpa",
              help="Output directory")
def registration_triage(fmt, out_dir):
    """CPA Export: Registration Triage by state (research aid, not advice)."""
    from pathlib import Path
    from src.exports.registration_triage import build_markdown, build_csv, build_triage_rows

    rows = build_triage_rows()

    # Print summary to console
    from collections import Counter
    buckets = Counter(r["triage_bucket"] for r in rows)
    click.echo("Registration Triage Summary:")
    for b in ["A_discuss", "D_entity_tax", "C_economic_watch", "B_monitor"]:
        if buckets.get(b):
            states = [r["state_code"] for r in rows if r["triage_bucket"] == b]
            click.echo(f"  {b}: {buckets[b]} states — {', '.join(states)}")
    click.echo()

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    if fmt in ("md", "all"):
        md = build_markdown()
        p = out / "registration_triage.md"
        p.write_text(md, encoding="utf-8")
        click.echo(f"Markdown: {p}")

    if fmt in ("csv", "all"):
        csv_content = build_csv()
        p = out / "registration_triage.csv"
        p.write_text(csv_content, encoding="utf-8")
        click.echo(f"CSV: {p}")


@cli.command("github-backup")
@click.option("--dry-run", is_flag=True, help="Show what would be committed without pushing")
def github_backup(dry_run):
    """Push project state to a dated backup/* branch on GitHub."""
    from src.maintenance.github_backup import run_backup
    result = run_backup(dry_run=dry_run)
    if result["status"] == "success":
        click.echo(f"Backup: {result['message']}")
    elif result["status"] == "dry_run":
        click.echo(f"Dry run: {result['message']}")
    elif result["status"] == "nothing_to_backup":
        click.echo("Nothing to back up — working tree matches HEAD.")
    else:
        click.echo(f"Backup failed: {result.get('error', result['status'])}")


@cli.command("inventory-sync")
@click.option("--dry-run", is_flag=True)
def inventory_sync_cmd(dry_run):
    """Pull FBA inventory: restock, planning, stock levels, AWD."""
    from src.inventory.sync import sync_all
    if dry_run:
        click.echo("DRY RUN\n")
    results = sync_all(dry_run=dry_run)
    for name in ["fba_summaries", "awd", "restock", "planning"]:
        r = results.get(name, {})
        if "error" in r:
            click.echo(f"{name}: ERROR — {r['error'][:200]}")
        else:
            click.echo(f"{name}: {r.get('rows_total', 0)} rows ({r.get('rows_inserted', 0)} inserted)")


@cli.command("inventory-velocity")
@click.option("--days", default=400)
@click.option("--dry-run", is_flag=True)
def inventory_velocity_cmd(days, dry_run):
    """Recompute SKU velocity + seasonality from order history."""
    from src.inventory.velocity import compute_velocity
    click.echo(f"Computing velocity from {days} days of history...\n")
    r = compute_velocity(amazon_days=days, shopify_days=days, dry_run=dry_run)
    click.echo(f"Amazon SKUs: {r['amazon_skus']}")
    click.echo(f"Shopify SKUs: {r['shopify_skus']}")
    click.echo(f"Total: {r['skus']}, seasonality weeks: {r['seasonality_weeks']}")
    click.echo(f"Forward multiplier: {r['avg_forward_mult']:.3f}")
    click.echo(f"Rows inserted: {r['rows_inserted']}")


@cli.command("inventory-report")
@click.option("--top", default=20)
def inventory_report_cmd(top):
    """Terminal summary: at-risk SKUs, reorder list."""
    from src.inventory.report import build_report
    report = build_report()
    s = report["summary"]
    click.echo(f"Active SKUs:     {s['active_skus']}")
    click.echo(f"FBA <60d cover:  {s['at_risk_skus']}")
    click.echo(f"Reorder total:   {s['total_our_reorder']:,} units")
    click.echo(f"Portfolio cover: {s['portfolio_weeks_cover']} weeks\n")
    for r in report["rows"][:top]:
        dos_str = f"{r['dos']:.0f}" if r['dos'] < 9999 else "—"
        click.echo(f"  {r['sku'][:22]:<22} {r['flag']:<9} FBA={r['fba_on_hand']:>5} V30={r['total_u_30']:>5.1f} DOS={dos_str:>4}")


@cli.command("inventory-3pl-sync")
@click.option("--dry-run", is_flag=True)
def inventory_3pl_sync_cmd(dry_run):
    """Pull 3PL inventory from Ship Sidekick."""
    from src.shipsidekick.client import sync_3pl
    r = sync_3pl(dry_run=dry_run)
    click.echo(f"SKUs: {r['rows_total']}, inserted: {r['rows_inserted']}")


@cli.command("plan-sku")
@click.option("--sku", required=True)
@click.option("--until", "until_date", default="2027-03-31")
@click.option("--scenario", default="correction_factor",
              type=click.Choice(["correction_factor", "actual_2025", "optimistic"]))
def plan_sku_cmd(sku, until_date, scenario):
    """Forward sell-through plan for a single SKU.

    Uses imported weekly forecast (forecast_weekly) when available.
    Falls back to velocity × seasonality for weeks without forecast data.
    """
    from datetime import date as d, timedelta
    from src.db import fetch_all

    end = d.fromisoformat(until_date) + timedelta(days=14)
    today = d.today()

    vels = {r["sku"]: r for r in fetch_all("sku_velocity")}
    snaps = {r["sku"]: r for r in fetch_all("inventory_snapshots")}
    awds = {r["sku"]: r for r in fetch_all("inventory_awd")}
    tpls = {}
    try:
        tpls = {r["sku"]: r for r in fetch_all("inventory_3pl_snapshots")}
    except Exception:
        pass

    vel = vels.get(sku)
    snap = snaps.get(sku)
    if not vel:
        click.echo(f"SKU {sku} not found in sku_velocity")
        return

    base = float(vel.get("total_u_30", 0) or 0)
    fba = sum(int(snap.get(k, 0) or 0) for k in
              ["fulfillable", "reserved", "researching", "unfulfillable"]) if snap else 0
    inbound = sum(int(snap.get(k, 0) or 0) for k in
                  ["inbound_working", "inbound_shipped", "inbound_receiving"]) if snap else 0
    awd_oh = int(awds.get(sku, {}).get("awd_on_hand", 0) or 0)
    tpl_oh = int(tpls.get(sku, {}).get("available", 0) or 0)
    owned = fba + inbound + awd_oh + tpl_oh

    # Load forecast weekly series (range-based lookup: cursor within
    # [week_start, week_start+6] matches that forecast week)
    forecast_weeks: list[tuple[d, float]] = []
    try:
        fc_rows = fetch_all("forecast_weekly")
        for r in fc_rows:
            if r.get("sku") == sku and r.get("scenario") == scenario:
                ws = d.fromisoformat(str(r["week_start"]))
                forecast_weeks.append((ws, float(r.get("units", 0) or 0)))
        forecast_weeks.sort()
    except Exception:
        pass

    has_forecast = len(forecast_weeks) > 0

    def _get_forecast(cursor_date: d, cursor_end: d) -> float | None:
        """Find forecast that overlaps the plan week [cursor_date, cursor_end].
        Uses the forecast whose week_start is closest to cursor_date."""
        best = None
        best_dist = 999
        for ws, units in forecast_weeks:
            we = ws + timedelta(days=6)
            # Overlap: forecast [ws, we] intersects plan [cursor_date, cursor_end]
            if ws <= cursor_end and we >= cursor_date:
                dist = abs((ws - cursor_date).days)
                if dist < best_dist:
                    best = units
                    best_dist = dist
        return best

    # For summary display
    forecast_map = {ws.isoformat(): u for ws, u in forecast_weeks}

    # Seasonality fallback
    season: dict[int, float] = {}
    for r in fetch_all("seasonality_weekly"):
        if r.get("sku") == "_account_" and r.get("year") == 0:
            season[int(r["week"])] = float(r.get("multiplier", 1.0) or 1.0)

    # Header
    click.echo(f"{'='*65}")
    click.echo(f"  PLAN: {sku}")
    click.echo(f"  {today} → {end}")
    click.echo(f"  Demand source: {'forecast_weekly (' + scenario + ')' if has_forecast else 'velocity × seasonality'}")
    click.echo(f"{'='*65}")
    click.echo(f"  V30={base:.1f} u/day  FBA={fba:,}  inbound={inbound:,}  AWD={awd_oh:,}  3PL={tpl_oh:,}  owned={owned:,}")
    if has_forecast:
        fc_total = sum(forecast_map.values())
        click.echo(f"  Forecast weeks: {len(forecast_map)}  total={fc_total:,.0f} units ({scenario})")
    click.echo()

    # Weekly walk
    remaining = fba
    total_demand = 0
    forecast_demand = 0
    velocity_demand = 0
    stockout_week = None

    click.echo(f"  {'Wk':<4} {'Dates':<24} {'Source':<6} {'Demand':>7} {'FBA':>7}")
    click.echo(f"  {'-'*52}")

    cursor = today
    while cursor <= end:
        wk_end = min(cursor + timedelta(days=6), end)
        days = (wk_end - cursor).days + 1
        fc_units = _get_forecast(cursor, wk_end)

        if fc_units is not None:
            demand = round(fc_units)
            source = "FC"
            forecast_demand += demand
        else:
            mult = season.get(cursor.isocalendar()[1], 1.0)
            demand = round(base * days * mult)
            source = "V×S"
            velocity_demand += demand

        total_demand += demand
        remaining -= demand

        note = ""
        if remaining <= 0 and stockout_week is None:
            stockout_week = cursor
            note = " ← STOCKOUT"

        iso_wk = cursor.isocalendar()[1]
        click.echo(
            f"  W{iso_wk:<3} {cursor} → {wk_end}  {source:<6} {demand:>7,} {max(remaining, 0):>7,}{note}"
        )

        cursor = wk_end + timedelta(days=1)

    click.echo(f"  {'-'*52}")
    click.echo(f"\n  Total demand:    {total_demand:>8,}")
    if has_forecast:
        click.echo(f"    from forecast:  {forecast_demand:>8,} ({len(forecast_map)} weeks)")
        click.echo(f"    from velocity:  {velocity_demand:>8,} (remainder)")
    click.echo(f"  FBA on-hand:     {fba:>8,}")
    click.echo(f"  Owned total:     {owned:>8,}")
    click.echo(f"  Gap (FBA):       {max(total_demand - fba, 0):>8,}")
    click.echo(f"  Gap (owned):     {max(total_demand - owned, 0):>8,}")
    if stockout_week:
        click.echo(f"  FBA stockout:    {stockout_week}")
    click.echo()


@cli.command("pallet-plan")
@click.option("--scenario", default="correction_factor",
              type=click.Choice(["correction_factor", "actual_2025", "optimistic"]))
@click.option("--pallet-max", default=19000, help="Units per pallet")
@click.option("--target", default="2026-10-31", help="In-Amazon-by date")
@click.option("--no-3pl", is_flag=True, help="Exclude 3PL from supply")
@click.option("--no-awd", is_flag=True, help="Exclude AWD from supply")
def pallet_plan_cmd(scenario, pallet_max, target, no_3pl, no_awd):
    """Lip Balm Monthly Pallet Planner — Nov+Dec holiday build."""
    from src.inventory.pallet_planner import build_pallet_plan

    plan = build_pallet_plan(
        pallet_max=pallet_max,
        amazon_in_by=target,
        scenario=scenario,
        include_3pl=not no_3pl,
        include_awd=not no_awd,
    )

    click.echo(f"{'='*65}")
    click.echo(f"  LIP BALM PALLET PLANNER — Holiday {plan['config']['scenario']}")
    click.echo(f"  All units in Amazon by: {plan['config']['amazon_in_by']}")
    click.echo(f"  Pallet max: {plan['config']['pallet_max_units']:,} units")
    click.echo(f"  3PL transfer: {'ON' if plan['config']['include_3pl_transfer'] else 'OFF'}")
    click.echo(f"  AWD in supply: {'ON' if plan['config']['include_awd'] else 'OFF'}")
    click.echo(f"{'='*65}")

    click.echo(f"\n  {'SKU':<16} {'NovDec':>8} {'FBA':>6} {'Inb':>5} {'AWD':>5} {'3PL':>6} {'Supply':>7} {'Gap':>7}")
    click.echo(f"  {'-'*62}")
    for p in plan["sku_plans"]:
        click.echo(
            f"  {p['sku']:<16} {p['nov_dec_demand']:>8,} {p['fba']:>6,} {p['inbound']:>5,} "
            f"{p['awd']:>5,} {p['tpl']:>6,} {p['amazon_supply']:>7,} {p['gap']:>7,}"
        )
    click.echo(f"  {'-'*62}")
    click.echo(f"  {'TOTAL':<16} {plan['total_nov_dec_demand']:>8,} "
               f"{'':>6} {'':>5} {'':>5} {'':>6} {plan['total_amazon_supply']:>7,} {plan['total_gap']:>7,}")

    click.echo(f"\n  Pallets needed: {plan['num_pallets']}")

    if plan["pallets"]:
        click.echo(f"\n  PALLET BREAKDOWN:")
        for p in plan["pallets"]:
            mix_str = " + ".join(f"{s} ×{q:,}" for s, q in p["mix"].items())
            click.echo(f"    Pallet {p['pallet_num']}: {p['total_units']:,} units — {mix_str}")

    if plan["monthly_schedule"]:
        click.echo(f"\n  MONTHLY BUILD SCHEDULE:")
        for month in plan["months"]:
            pallets_in_month = plan["monthly_schedule"].get(month, [])
            if pallets_in_month:
                total = sum(p["total_units"] for p in pallets_in_month)
                nums = ", ".join(f"P{p['pallet_num']}" for p in pallets_in_month)
                click.echo(f"    {month}: {total:,} units ({nums})")

    if plan["pallets"]:
        next_p = plan["pallets"][0]
        click.echo(f"\n  NEXT PALLET TO ORDER:")
        for s, q in next_p["mix"].items():
            click.echo(f"    {s}: {q:,} units")
        click.echo(f"    Total: {next_p['total_units']:,} units")
        click.echo(f"    Ship by: earliest possible (target receipt ≤ {plan['config']['amazon_in_by']})")

    click.echo()


@cli.command("fba-cover")
@click.option("--target-days", default=60, help="Cover target in days")
@click.option("--scenario", default="correction_factor",
              type=click.Choice(["correction_factor", "actual_2025", "optimistic"]))
@click.option("--no-3pl", is_flag=True, help="Exclude 3PL transfers")
@click.option("--no-awd", is_flag=True, help="Exclude AWD transfers")
def fba_cover_cmd(target_days, scenario, no_3pl, no_awd):
    """FBA Cover Projection — flag weeks below 60-day service target."""
    from src.inventory.pallet_planner import build_fba_cover_projection, LIP_BALM_SKUS

    SKU_SHORT = {
        "DDPE0001Shop": "Unscnt",
        "DDPE0002Shop": "Pepper",
        "DDPE0003Shop": "Orange",
        "DDPE0004Shop": "Assrtd",
    }

    proj = build_fba_cover_projection(
        cover_target_days=target_days,
        scenario=scenario,
        include_3pl=not no_3pl,
        include_awd=not no_awd,
    )

    click.echo(f"{'='*70}")
    click.echo(f"  FBA COVER PROJECTION — {target_days}-day target · {scenario}")
    click.echo(f"{'='*70}")

    for sp in proj["sku_projections"]:
        sku = sp["sku"]
        label = SKU_SHORT.get(sku, sku)
        click.echo(f"\n  {label} ({sku})  FBA now: {sp['fba_start']:,}  "
                   f"Inbound: {sp['inbound']:,}  AWD: {sp['awd']:,}  3PL: {sp['tpl']:,}")
        click.echo(f"  {'Week':<12} {'Demand':>7} {'Receipt':>8} {'FBA':>8} {'Rate/d':>7} {'Cover':>7}")
        click.echo(f"  {'-'*52}")
        for w in sp["weeks"]:
            cover_str = f"{w['cover_days']}d" if w["cover_days"] is not None else "—"
            flag = " <<<" if w["flagged"] else ""
            click.echo(
                f"  {w['week']:<12} {w['demand']:>7,} {w['receipt']:>8,} "
                f"{w['fba']:>8,} {w['daily_rate']:>7} {cover_str:>7}{flag}"
            )

    if proj["alerts"]:
        click.echo(f"\n  {'!'*50}")
        click.echo(f"  {len(proj['alerts'])} WEEKS BELOW {target_days}-DAY COVER TARGET:")
        for a in proj["alerts"]:
            click.echo(f"    {SKU_SHORT.get(a['sku'], a['sku'])} {a['week']}: "
                       f"{a['cover_days']}d cover ({a['fba']:,} units @ {a['daily_rate']}/day)")
        click.echo(f"  {'!'*50}")
    else:
        click.echo(f"\n  All weeks maintain ≥{target_days}-day FBA cover.")

    click.echo()


@cli.command("mfg-headsup")
@click.option("--commit", "commit_months", multiple=True, help="Months to mark FIRM (e.g. 2026-08)")
@click.option("--tpl-offsets", is_flag=True, help="Let 3PL reduce manufacture (aggressive low-produce view)")
@click.option("--no-jan", is_flag=True, help="Exclude January from holiday demand")
@click.option("--weights", default="25,35,40", help="Month weights pct (e.g. 25,35,40)")
@click.option("--csv", "csv_out", type=click.Path(), help="Export CSV to file")
@click.option("--sheet", "sheet_out", type=click.Path(), help="Export printable summary to file")
def mfg_headsup_cmd(commit_months, tpl_offsets, no_jan, weights, csv_out, sheet_out):
    """Manufacturer Heads-Up — rolling 3-month production schedule."""
    from src.inventory.pallet_planner import (
        build_manufacturer_headsup, format_manufacturer_csv,
        format_manufacturer_sheet,
    )

    w = tuple(float(x) / 100 for x in weights.split(","))

    headsup = build_manufacturer_headsup(
        month_weights=w,
        include_jan=not no_jan,
        tpl_offsets_production=tpl_offsets,
        committed_months=list(commit_months) if commit_months else None,
    )

    click.echo(format_manufacturer_sheet(headsup))

    if csv_out:
        with open(csv_out, "w") as f:
            f.write(format_manufacturer_csv(headsup))
        click.echo(f"CSV exported to {csv_out}")

    if sheet_out:
        with open(sheet_out, "w") as f:
            f.write(format_manufacturer_sheet(headsup))
        click.echo(f"Planning sheet exported to {sheet_out}")


@cli.command("import-forecast")
@click.argument("file_path")
@click.option("--dry-run", is_flag=True)
def import_forecast_cmd(file_path, dry_run):
    """Import holiday forecast from xlsx into forecast_weekly."""
    from src.parsers.forecast_xlsx import import_forecast

    if dry_run:
        click.echo("DRY RUN\n")

    result = import_forecast(file_path, dry_run=dry_run)
    click.echo(f"File: {result['file']}")
    click.echo(f"Variants: {', '.join(result['variants'])}")
    click.echo(f"SKUs: {', '.join(result['skus'])}")
    click.echo(f"Weeks: {result['weeks']}")
    click.echo(f"Rows: {result['rows_total']} parsed, {result['rows_inserted']} inserted")

    if dry_run:
        # Show sample
        from src.parsers.forecast_xlsx import parse_forecast
        parsed = parse_forecast(file_path)
        click.echo("\nSample rows:")
        for r in parsed["rows"][:9]:
            click.echo(f"  {r['sku']} {r['week_start']} {r['scenario']:<20} {r['units']:>8.0f}")


@cli.command("import-3pl")
@click.argument("file_path")
@click.option("--dry-run", is_flag=True)
def import_3pl_cmd(file_path, dry_run):
    """Import 3PL invoice CSV into cost tracking tables."""
    from src.parsers.tpl_invoice import import_tpl_invoice

    if dry_run:
        click.echo("DRY RUN\n")

    result = import_tpl_invoice(file_path, dry_run=dry_run)
    click.echo(f"File: {result['file']}")
    click.echo(f"Months: {', '.join(result['months_covered'])}")
    click.echo(f"Monthly rows: {result['monthly_count']}")
    click.echo(f"Fee rows: {result['fee_count']}")
    click.echo(f"Detail rows: {result['detail_count']}")
    click.echo(f"Rows inserted: {result['rows_inserted']}")


@cli.command("filing-packet")
@click.option("--state", default=None, help="Single state or all registered")
@click.option("--out", default="exports/filings", help="Output directory")
@click.option("--end-date", default=None, help="Period end (default: yesterday)")
def filing_packet_cmd(state, out, end_date):
    """Export filing packet CSV for registered states.

    Uses actual period end (yesterday or --end-date), not future month-end.
    Current month sales are prorated by days elapsed.
    """
    from datetime import date as d, timedelta
    from pathlib import Path
    from src.db import fetch_all
    from src.channels import normalize_channel, is_seller_responsible, display_label
    import calendar, csv

    yesterday = d.today() - timedelta(days=1)
    cutoff = d.fromisoformat(end_date) if end_date else yesterday

    nexus = fetch_all("nexus_status")
    sales = fetch_all("sales_by_state")
    registered = [n for n in nexus if n.get("is_registered")]
    if state:
        registered = [n for n in registered if n["state_code"] == state.upper()]

    Path(out).mkdir(parents=True, exist_ok=True)

    # Current month boundaries for partial-month detection
    current_month_start = cutoff.replace(day=1).isoformat()

    # Fetch Shopify orders for partial month (actual dated sales)
    partial_month_orders = {}  # {state_code: {channel: {gross, tax, count}}}
    try:
        from src.config import settings
        if settings.shopify_enabled:
            from src.shopify_auth import auth_headers
            from src.channels import classify_shopify_order
            import httpx

            headers = auth_headers()
            base_url = f"https://{settings.shopify_shop_domain}/admin/api/2024-01/orders.json"
            params = {
                "status": "any", "limit": 250,
                "fields": "id,created_at,subtotal_price,total_tax,shipping_address,source_name",
                "created_at_min": current_month_start + "T00:00:00Z",
                "created_at_max": (cutoff + timedelta(days=1)).isoformat() + "T00:00:00Z",
            }
            all_orders = []
            url = base_url
            while url:
                resp = httpx.get(url, headers=headers,
                                 params=params if url == base_url else None, timeout=30)
                if resp.status_code != 200:
                    break
                all_orders.extend(resp.json().get("orders", []))
                link_header = resp.headers.get("link", "")
                url = None
                if 'rel="next"' in link_header:
                    for part in link_header.split(","):
                        if 'rel="next"' in part:
                            url = part.split("<")[1].split(">")[0]
                            break

            for order in all_orders:
                addr = order.get("shipping_address") or {}
                prov = (addr.get("province_code") or "").upper()
                country = addr.get("country_code", "")
                if country != "US" or not prov:
                    continue
                created = order.get("created_at", "")[:10]
                if created > cutoff.isoformat():
                    continue
                source = order.get("source_name", "")
                ch = classify_shopify_order(source, d.fromisoformat(created))
                gross = float(order.get("subtotal_price", 0) or 0)
                tax = float(order.get("total_tax", 0) or 0)

                if prov not in partial_month_orders:
                    partial_month_orders[prov] = {}
                if ch not in partial_month_orders[prov]:
                    partial_month_orders[prov][ch] = {"gross": 0, "tax": 0, "count": 0}
                partial_month_orders[prov][ch]["gross"] += gross
                partial_month_orders[prov][ch]["tax"] += tax
                partial_month_orders[prov][ch]["count"] += 1
    except Exception as e:
        click.echo(f"  Warning: could not fetch partial-month orders: {e}")

    for n in registered:
        sc = n["state_code"]
        lft = n.get("last_filed_through") or ""
        period_start = (d.fromisoformat(lft) + timedelta(days=1)).isoformat() if lft else ""
        rows_out = []

        for s in sales:
            if s.get("state_code") != sc:
                continue
            ps = s.get("period_start", "")
            pe = s.get("period_end", "")
            if not ps:
                continue
            if lft and pe <= lft:
                continue
            if ps > cutoff.isoformat():
                continue

            ch = normalize_channel(s.get("channel", ""))

            # For the current partial month: use actual order data instead
            if pe > cutoff.isoformat() and ps <= cutoff.isoformat():
                continue  # skip the monthly aggregate; we'll add order-level below

            rows_out.append({
                "state": sc,
                "period_start": max(ps, period_start) if period_start else ps,
                "period_end": pe,
                "channel": ch,
                "channel_label": display_label(ch),
                "seller_responsible": is_seller_responsible(ch),
                "gross_sales": float(s.get("gross_sales", 0) or 0),
                "tax_collected": float(s.get("tax_collected", 0) or 0),
                "order_count": int(s.get("order_count", 0) or 0),
            })

        # Add actual partial-month Shopify data from orders
        if sc in partial_month_orders:
            for ch, agg in partial_month_orders[sc].items():
                rows_out.append({
                    "state": sc,
                    "period_start": max(current_month_start, period_start) if period_start else current_month_start,
                    "period_end": cutoff.isoformat(),
                    "channel": ch,
                    "channel_label": display_label(ch),
                    "seller_responsible": is_seller_responsible(ch),
                    "gross_sales": round(agg["gross"], 2),
                    "tax_collected": round(agg["tax"], 2),
                    "order_count": agg["count"],
                })

        if not rows_out:
            click.echo(f"  {sc}: no activity since {lft or 'never'}")
            continue

        fname = Path(out) / f"filing_{sc}_{cutoff.isoformat()}.csv"
        with open(fname, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows_out[0].keys()))
            w.writeheader()
            w.writerows(rows_out)

        seller = sum(r["gross_sales"] for r in rows_out if r["seller_responsible"])
        total = sum(r["gross_sales"] for r in rows_out)
        click.echo(f"  {sc}: {fname.name} ({len(rows_out)} rows, seller=${seller:,.0f}, total=${total:,.0f})")

    click.echo(f"\nDisclaimer: Filing packets are reference data only. Does not submit to any DOR.")


@cli.command("integrity-check")
def integrity_check():
    """Verify data integrity: SKU case, duplicate keys, channel totals."""
    from src.db import fetch_all
    from src.channels import normalize_channel

    issues = 0

    # 1. SKU case check
    click.echo("Checking sales_by_sku SKU case normalization...")
    sku_rows = fetch_all("sales_by_sku")
    bad_case = [r for r in sku_rows if r.get("sku") and r["sku"] != r["sku"].strip().upper()]
    if bad_case:
        click.echo(f"  FAIL: {len(bad_case)} rows with non-uppercase SKU")
        for r in bad_case[:5]:
            click.echo(f"    {r['sku']!r} in {r.get('channel')} {r.get('period_start')}")
        issues += 1
    else:
        click.echo(f"  OK: {len(sku_rows)} rows, all uppercase")

    # 2. Duplicate key check
    click.echo("Checking for duplicate upsert keys in sales_by_sku...")
    seen: dict[tuple, int] = {}
    for r in sku_rows:
        key = (r.get("channel"), r.get("sku"), r.get("state_code"),
               r.get("period_start"), r.get("source"))
        seen[key] = seen.get(key, 0) + 1
    dupes = {k: v for k, v in seen.items() if v > 1}
    if dupes:
        click.echo(f"  FAIL: {len(dupes)} duplicate keys")
        for k, v in list(dupes.items())[:3]:
            click.echo(f"    {k}: {v} rows")
        issues += 1
    else:
        click.echo(f"  OK: {len(seen)} unique keys, no duplicates")

    # 3. Channel totals cross-check
    click.echo("Cross-checking sales_by_state vs sales_by_sku channel totals...")
    state_rows = fetch_all("sales_by_state")
    for ch in ["shopify", "amazon"]:
        state_total = sum(
            float(r.get("gross_sales", 0))
            for r in state_rows
            if normalize_channel(r.get("channel", "")) == ch
        )
        sku_total = sum(
            float(r.get("gross_sales", 0))
            for r in sku_rows
            if normalize_channel(r.get("channel", "")) == ch
        )
        diff = abs(state_total - sku_total)
        pct = (diff / state_total * 100) if state_total > 0 else 0
        # SKU totals can differ from state totals due to line-item vs
        # order-level aggregation (discounts, multi-item orders, etc.)
        # and different time range coverage.  WARN above 10%, NOTE above 50%.
        status = "OK" if pct < 10 else "WARN" if pct < 100 else "FAIL"
        click.echo(f"  {ch}: state=${state_total:,.0f} sku=${sku_total:,.0f} "
                    f"diff=${diff:,.0f} ({pct:.1f}%) [{status}]")
        if status == "FAIL":
            issues += 1

    # 4. Period start sanity
    click.echo("Checking period_start format (must be YYYY-MM-01)...")
    bad_periods_state = [r for r in state_rows
                         if r.get("period_start") and not str(r["period_start"]).endswith("-01")]
    bad_periods_sku = [r for r in sku_rows
                       if r.get("period_start") and not str(r["period_start"]).endswith("-01")]
    if bad_periods_state:
        click.echo(f"  FAIL: {len(bad_periods_state)} sales_by_state rows with non-01 period_start")
        issues += 1
    else:
        click.echo(f"  OK: sales_by_state all YYYY-MM-01")
    if bad_periods_sku:
        click.echo(f"  FAIL: {len(bad_periods_sku)} sales_by_sku rows with non-01 period_start")
        issues += 1
    else:
        click.echo(f"  OK: sales_by_sku all YYYY-MM-01")

    # 5. Refund semantics
    sku_with_refunds = sum(1 for r in sku_rows if float(r.get("refund_sales", 0)) > 0)
    sku_zero_refunds = sum(1 for r in sku_rows if float(r.get("refund_sales", 0)) == 0)
    click.echo(f"Refund coverage: {sku_with_refunds} rows with refund data, "
               f"{sku_zero_refunds} with zero/null (may be missing, not confirmed zero)")

    click.echo(f"\n{'PASSED' if issues == 0 else f'FAILED ({issues} issues)'}")


@cli.command()
def run():
    """Start the background agent (folder watcher + scheduled tasks)."""
    from src.watcher.folder_watcher import start_watcher

    click.echo("Starting Sales Tax Compliance Agent...")
    click.echo("Press Ctrl+C to stop.\n")

    observer = start_watcher(print_fn=click.echo)

    try:
        from apscheduler.schedulers.blocking import BlockingScheduler
        scheduler = BlockingScheduler()

        from src.config import settings

        if settings.shopify_enabled:
            from src.parsers.shopify_orders import fetch_shopify_orders_api
            scheduler.add_job(
                _run_shopify_poll,
                "interval",
                hours=settings.shopify_poll_interval_hours,
                id="shopify_poll",
            )
            click.echo(f"[Scheduler] Shopify polling every {settings.shopify_poll_interval_hours}h")

        scheduler.add_job(
            _run_daily_analysis,
            "cron",
            hour=8,
            minute=0,
            id="daily_analysis",
        )
        click.echo("[Scheduler] Daily analysis at 08:00")

        scheduler.add_job(
            _run_deadline_check,
            "cron",
            hour=9,
            minute=0,
            id="deadline_check",
        )
        click.echo("[Scheduler] Deadline check at 09:00")

        if settings.amazon_sp_enabled:
            scheduler.add_job(
                _run_spapi_refresh,
                "cron",
                hour=6,
                minute=0,
                id="spapi_refresh",
            )
            click.echo("[Scheduler] SP-API refresh daily at 06:00")

        scheduler.add_job(
            _run_source_monitoring,
            "cron",
            day_of_week="mon",
            hour=7,
            minute=0,
            id="source_monitoring",
        )
        click.echo("[Scheduler] Source monitoring every Monday at 07:00")

        # CPA export: daily at 06:30 ET
        scheduler.add_job(
            _run_cpa_exports,
            "cron",
            hour=6,
            minute=30,
            id="cpa_exports",
        )
        click.echo("[Scheduler] CPA exports daily at 06:30")

        # Morning digest at 08:05 (after daily analysis)
        scheduler.add_job(
            _run_daily_digest,
            "cron",
            hour=8,
            minute=5,
            id="daily_digest",
        )
        click.echo("[Scheduler] Daily digest at 08:05")

        # Inventory sync daily at 06:30 (after SP-API refresh)
        if settings.amazon_sp_enabled:
            scheduler.add_job(
                _run_inventory_sync,
                "cron",
                hour=6,
                minute=30,
                id="inventory_sync",
            )
            click.echo("[Scheduler] Inventory sync daily at 06:30")

        # 3PL sync daily at 06:35
        scheduler.add_job(
            _run_3pl_sync,
            "cron",
            hour=6,
            minute=35,
            id="3pl_sync",
        )
        click.echo("[Scheduler] 3PL sync daily at 06:35")

        # Weekly GitHub backup (Sunday 09:00)
        scheduler.add_job(
            _run_github_backup,
            "cron",
            day_of_week="sun",
            hour=9,
            minute=0,
            id="github_backup",
        )
        click.echo("[Scheduler] GitHub backup weekly Sunday 09:00")

        # Agent job worker: poll every 45 seconds
        scheduler.add_job(
            _run_job_worker,
            "interval",
            seconds=45,
            id="job_worker",
        )
        click.echo("[Scheduler] Job worker every 45s")

        # Print full schedule table
        click.echo("\n── Schedule ─────────────────────────────────────")
        for job in scheduler.get_jobs():
            click.echo(f"  {job.id:<20s}  trigger: {job.trigger}")
        click.echo("─────────────────────────────────────────────────")

        click.echo("\nAgent is running. Watching for files and running scheduled tasks.\n")

        def _shutdown(signum, frame):
            click.echo("\nShutting down...")
            observer.stop()
            scheduler.shutdown(wait=False)
            sys.exit(0)

        signal.signal(signal.SIGINT, _shutdown)
        signal.signal(signal.SIGTERM, _shutdown)

        scheduler.start()

    except (KeyboardInterrupt, SystemExit):
        observer.stop()
        click.echo("Agent stopped.")

    observer.join()


def _run_shopify_poll():
    from src.parsers.shopify_orders import fetch_shopify_orders_api
    from src.db import log_ingestion, job_start, job_finish
    from datetime import datetime, timezone
    import time

    run_id = job_start("shopify_poll")
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    attempts = 0
    last_err = None

    for attempt in range(2):  # try twice
        attempts = attempt + 1
        try:
            result = fetch_shopify_orders_api()
            orders = result.get("orders_fetched", 0)
            inserted = result.get("rows_inserted", 0)
            print(f"[Shopify Poll] {ts} OK — {orders} orders, {inserted} rows"
                  + (f" (retry {attempt})" if attempt else ""))
            log_ingestion(
                filename=f"shopify_api_poll_{ts}",
                file_type="shopify_api",
                rows_total=orders,
                rows_inserted=inserted,
                status="success",
            )
            job_finish(run_id, "success", f"{orders} orders, {inserted} rows",
                       {"orders": orders, "rows_inserted": inserted})
            return  # success — done
        except Exception as e:
            last_err = e
            print(f"[Shopify Poll] {ts} attempt {attempts} failed: {e}")
            if attempt == 0:
                time.sleep(30)  # wait 30s before retry

    # Both attempts failed
    err_text = str(last_err)[:500]
    print(f"[Shopify Poll] {ts} FAILED after {attempts} attempts: {err_text}")
    log_ingestion(
        filename=f"shopify_api_poll_{ts}",
        file_type="shopify_api",
        rows_total=0,
        rows_inserted=0,
        status="failed",
        error_message=err_text,
    )
    job_finish(run_id, "fail", err_text)


def _run_daily_analysis():
    """Run physical + economic nexus analysis, gather deadlines, and send
    a SINGLE Telegram summary.  Dedicated threshold-crossed alerts are
    sent only for states that newly exceed their threshold on THIS run.
    """
    from src.db import fetch_all, job_start, job_finish
    from src.engines.physical_nexus import evaluate_physical_nexus
    from src.engines.economic_nexus import evaluate_economic_nexus
    from src.calendar.filing_calendar import get_upcoming_deadlines
    from src.alerts.telegram import (
        send_daily_summary,
        send_threshold_crossed,
        send_telegram,
    )
    from datetime import date

    run_id = job_start("daily_analysis")
    try:
        # Snapshot which states had economic nexus BEFORE this run
        prior_econ = {
            r["state_code"]
            for r in fetch_all("nexus_status")
            if r.get("has_economic_nexus")
        }

        # ── Run engines ──
        phys = evaluate_physical_nexus()
        econ = evaluate_economic_nexus()

        # ── Detect newly crossed thresholds ──
        current_econ = set(econ.get("exceeded_threshold", []))
        newly_crossed = sorted(current_econ - prior_econ)

        # Send dedicated alert per newly crossed state
        for sc in newly_crossed:
            detail = econ.get("details", {}).get(sc, {})
            notes = detail.get("action_notes", "")
            send_threshold_crossed(
                sc,
                detail.get("threshold_amount", 0),
                detail.get("threshold_amount_cfg", 100000),
                notes[:200] if notes else f"${detail.get('threshold_amount',0):,.0f}",
            )

        # ── Gather deadlines ──
        deadlines = get_upcoming_deadlines()
        today = date.today().isoformat()
        overdue = [d for d in deadlines if d.get("days_overdue")]
        upcoming = [d for d in deadlines if d.get("days_until_due") is not None
                    and not d.get("days_overdue")]

        # ── Gather franchise flags ──
        flags = fetch_all("franchise_tax_flags", {"status": "open"})
        critical_flags = [f for f in flags if f.get("severity") == "critical"]
        warning_flags = [f for f in flags if f.get("severity") == "warning"]

        # ── Count action needed (unregistered nexus states) ──
        nexus_all = fetch_all("nexus_status")
        action_needed = sum(
            1 for n in nexus_all
            if not n.get("is_registered")
            and (n.get("has_physical_nexus") or n.get("has_economic_nexus"))
        )

        # ── Send single summary ──
        send_daily_summary(
            phys_nexus_count=len(phys.get("nexus_states", [])),
            new_phys_states=phys.get("new_nexus_states", []),
            econ_exceeded=sorted(current_econ),
            econ_approaching=econ.get("approaching_threshold", []),
            newly_crossed=newly_crossed,
            critical_flags=critical_flags,
            warning_flags=warning_flags,
            overdue_count=len(overdue),
            upcoming_deadlines=upcoming,
            action_needed=action_needed,
        )

        print(f"[Daily Analysis] Physical: {len(phys.get('nexus_states', []))} states, "
              f"Economic exceeded: {len(current_econ)}, "
              f"Newly crossed: {newly_crossed}, "
              f"Overdue: {len(overdue)}")
        job_finish(run_id, "success",
                   f"Phys {len(phys.get('nexus_states', []))}, Econ {len(current_econ)}, Overdue {len(overdue)}")

    except Exception as e:
        print(f"[Daily Analysis] Error: {e}")
        job_finish(run_id, "fail", str(e)[:500])
        try:
            send_telegram(f"🚨 <b>Daily Analysis Failed</b>\n\n{str(e)[:300]}")
        except Exception:
            pass


def _run_deadline_check():
    """Deadline check is now part of the daily summary.
    This function is kept for backward compatibility with the scheduler
    but no longer sends individual alerts.
    """
    from src.calendar.filing_calendar import get_upcoming_deadlines

    try:
        deadlines = get_upcoming_deadlines()
        overdue = [d for d in deadlines if d.get("days_overdue")]
        print(f"[Deadline Check] {len(overdue)} overdue, {len(deadlines)} total (included in daily summary)")
    except Exception as e:
        print(f"[Deadline Check] Error: {e}")


def _run_spapi_refresh():
    from datetime import date, timedelta, datetime, timezone
    from src.amazon_sp.reports import fetch_orders, fetch_inventory
    from src.db import log_ingestion, job_start, job_finish

    run_id = job_start("spapi_refresh")
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=7)
    errors = []
    try:
        orders = fetch_orders(start, end)
        inserted = orders.get("rows_inserted", 0)
        print(f"[SP-API] {ts} Orders: {inserted} rows, "
              f"${orders.get('total_gross_sales', 0):,.0f} sales")
        log_ingestion(
            filename=f"spapi_orders_{ts}",
            file_type="amazon_spapi",
            rows_total=orders.get("rows_total", inserted),
            rows_inserted=inserted,
            status="success",
        )
    except Exception as e:
        errors.append(f"Orders: {e}")
        print(f"[SP-API] {ts} Orders error: {e}")
        log_ingestion(
            filename=f"spapi_orders_{ts}",
            file_type="amazon_spapi",
            rows_total=0, rows_inserted=0,
            status="failed",
            error_message=str(e)[:500],
        )
    try:
        inv = fetch_inventory(start, end)
        inserted = inv.get("rows_inserted", 0)
        print(f"[SP-API] {ts} Inventory: {inserted} rows, "
              f"states: {inv.get('states_found', [])}")
        log_ingestion(
            filename=f"spapi_inventory_{ts}",
            file_type="amazon_inventory",
            rows_total=inv.get("rows_total", inserted),
            rows_inserted=inserted,
            status="success",
        )
    except Exception as e:
        errors.append(f"Inventory: {e}")
        print(f"[SP-API] {ts} Inventory error: {e}")
        log_ingestion(
            filename=f"spapi_inventory_{ts}",
            file_type="amazon_inventory",
            rows_total=0, rows_inserted=0,
            status="failed",
            error_message=str(e)[:500],
        )
    # ── Sync sales_daily (Amazon + Shopify) ──
    try:
        from src.sales_daily import sync_amazon_daily
        amz_daily = sync_amazon_daily(days=7)
        print(f"[SP-API] {ts} Daily sales: {amz_daily.get('rows_upserted', 0)} rows, "
              f"${amz_daily.get('total_gross', 0):,.0f}")
    except Exception as e:
        errors.append(f"Daily sales: {e}")
        print(f"[SP-API] {ts} Daily sales error: {e}")

    try:
        from src.sales_daily import sync_shopify_daily
        shop_daily = sync_shopify_daily(days=7)
        print(f"[SP-API] {ts} Shopify daily: {shop_daily.get('rows_upserted', 0)} rows")
    except Exception as e:
        print(f"[SP-API] {ts} Shopify daily error: {e}")

    # FBA returns (30d window, once daily)
    try:
        from src.amazon_sp.reports import fetch_fba_returns
        returns = fetch_fba_returns(start, end)
        print(f"[SP-API] {ts} Returns: {returns.get('rows_inserted', 0)} rows")
    except Exception as e:
        print(f"[SP-API] {ts} Returns error: {e}")

    # Sales & Traffic (7d window)
    try:
        from src.amazon_sp.reports import fetch_sales_traffic
        st = fetch_sales_traffic(start, end)
        print(f"[SP-API] {ts} Sales&Traffic: {st.get('days', 0)} days, {st.get('asins', 0)} ASINs")
    except Exception as e:
        print(f"[SP-API] {ts} Sales&Traffic error: {e}")

    # Reimbursements (30d window)
    try:
        from src.amazon_sp.reports import fetch_reimbursements
        reimb_start = end - timedelta(days=30)
        reimb = fetch_reimbursements(reimb_start, end)
        print(f"[SP-API] {ts} Reimbursements: {reimb.get('rows_parsed', 0)} rows, ${reimb.get('total_amount', 0):,.2f}")
    except Exception as e:
        print(f"[SP-API] {ts} Reimbursements error: {e}")

    # Subscribe & Save (Replenishment API)
    try:
        from src.amazon_sp.replenishment import fetch_seller_metrics, fetch_offer_metrics
        seller = fetch_seller_metrics(weeks=4)
        print(f"[SP-API] {ts} SnS seller: {seller.get('weeks_fetched', 0)} weeks, "
              f"{seller.get('latest_subs', 0):,} subs")
        offers = fetch_offer_metrics()
        print(f"[SP-API] {ts} SnS offers: {offers.get('offers_fetched', 0)} ASINs")
    except PermissionError as e:
        print(f"[SP-API] {ts} SnS: {e}")
    except Exception as e:
        print(f"[SP-API] {ts} SnS error: {e}")

    if errors:
        job_finish(run_id, "fail", "; ".join(errors[:3]))
        try:
            from src.alerts.telegram import send_telegram
            send_telegram(
                f"🚨 <b>SP-API Sync Failed</b>\n\n"
                + "\n".join(errors[:3])
            )
        except Exception:
            pass
    else:
        job_finish(run_id, "success", f"Orders + inventory + daily sales synced")


def _run_source_monitoring():
    from src.intelligence.monitor import run_monitoring_cycle

    try:
        result = run_monitoring_cycle()
        changes = result.get("changes_detected", 0)
        print(f"[Source Monitor] Checked {result.get('sources_checked', 0)} sources, "
              f"{changes} changes detected")

        if changes > 0:
            try:
                from src.alerts.telegram import send_telegram
                details = [d for d in result.get("details", []) if d.get("change")]
                urls = ", ".join(d.get("title", d.get("url", "?"))[:40] for d in details[:5])
                send_telegram(
                    f"<b>Source Monitor</b>\n"
                    f"{changes} monitored source(s) changed:\n{urls}\n\n"
                    f"Run <code>python -m src.main research-tasks</code> to review.",
                    "source_monitor",
                )
            except Exception:
                pass
    except Exception as e:
        print(f"[Source Monitor] Error: {e}")


def _run_daily_digest():
    """Send morning sales digest via Telegram."""
    from src.db import job_start, job_finish
    run_id = job_start("daily_digest")
    try:
        from src.alerts.daily_digest import send_digest
        result = send_digest()
        if result.get("sent"):
            print("[Digest] Sent")
            job_finish(run_id, "success", "Sent")
        elif result.get("reason"):
            print(f"[Digest] Skipped: {result['reason']}")
            job_finish(run_id, "success", f"Skipped: {result['reason']}")
    except Exception as e:
        print(f"[Digest] Error: {e}")
        job_finish(run_id, "fail", str(e)[:500])


def _run_inventory_sync():
    """Daily inventory sync: FBA summaries + restock + AWD + velocity."""
    from src.db import job_start, job_finish
    run_id = job_start("inventory_sync")
    errors = []
    try:
        from src.inventory.sync import sync_all
        results = sync_all()
        for name in ["fba_summaries", "awd", "restock", "planning"]:
            r = results.get(name, {})
            if "error" in r:
                print(f"[Inventory] {name}: {r['error'][:100]}")
                errors.append(f"{name}: {r['error'][:80]}")
            else:
                print(f"[Inventory] {name}: {r.get('rows_total', 0)} rows")
    except Exception as e:
        print(f"[Inventory Sync] Error: {e}")
        errors.append(str(e)[:200])

    try:
        from src.inventory.velocity import compute_velocity
        r = compute_velocity(amazon_days=100, shopify_days=100)
        print(f"[Velocity] {r['skus']} SKUs, mult={r['avg_forward_mult']:.2f}")
    except Exception as e:
        print(f"[Velocity] Error: {e}")
        errors.append(f"velocity: {e}")

    if errors:
        job_finish(run_id, "fail", "; ".join(errors))
    else:
        job_finish(run_id, "success", "FBA + AWD + restock + velocity synced")


def _run_3pl_sync():
    """Daily 3PL inventory sync from Ship Sidekick."""
    from src.db import job_start, job_finish
    run_id = job_start("3pl_sync")
    try:
        from src.shipsidekick.client import sync_3pl
        r = sync_3pl()
        print(f"[3PL] {r['rows_total']} SKUs, {r['rows_inserted']} upserted")
        job_finish(run_id, "success", f"{r['rows_total']} SKUs, {r['rows_inserted']} upserted")
    except Exception as e:
        print(f"[3PL] Error: {e}")
        job_finish(run_id, "fail", str(e)[:500])


def _run_github_backup():
    """Weekly GitHub backup to backup/* branch."""
    try:
        from src.maintenance.github_backup import run_backup
        r = run_backup()
        if r["status"] == "success":
            print(f"[Backup] {r['message']}")
        elif r["status"] == "nothing_to_backup":
            print("[Backup] Nothing to back up")
        else:
            print(f"[Backup] {r['status']}: {r.get('error', '')[:200]}")
    except Exception as e:
        print(f"[Backup] Error: {e}")


def _run_cpa_exports():
    """Generate CPA exports (inventory presence + triage) and upload to Storage."""
    from src.db import job_start, job_finish
    run_id = job_start("cpa_exports")
    cpa_errors = []
    try:
        from src.exports.inventory_presence import (
            build_markdown, build_csv, build_pdf, build_metadata, upload_exports,
        )
        md = build_markdown()
        csv_content = build_csv()
        pdf_bytes = build_pdf()
        meta = build_metadata()
        results = upload_exports(md, csv_content, pdf_bytes, meta)
        ok = sum(1 for v in results.values() if v)
        print(f"[CPA Export] Inventory presence: {ok}/{len(results)} files uploaded")
    except Exception as e:
        print(f"[CPA Export] Inventory presence error: {e}")
        cpa_errors.append(f"inv presence: {e}")

    try:
        from src.exports.registration_triage import (
            build_markdown as triage_md, build_csv as triage_csv,
            build_triage_rows,
        )
        from src.db import upload_to_storage
        import json as _json
        from datetime import datetime, timezone

        rows = triage_rows = build_triage_rows()
        md = triage_md()
        csv_c = triage_csv()
        meta_t = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "state_count": len(rows),
            "buckets": {},
        }
        from collections import Counter
        for b, cnt in Counter(r["triage_bucket"] for r in rows).items():
            meta_t["buckets"][b] = cnt

        upload_to_storage("cpa-exports", "registration-triage/latest.md",
                          md.encode("utf-8"), "text/markdown")
        upload_to_storage("cpa-exports", "registration-triage/latest.csv",
                          csv_c.encode("utf-8"), "text/csv")
        upload_to_storage("cpa-exports", "registration-triage/meta.json",
                          _json.dumps(meta_t, indent=2).encode("utf-8"), "application/json")
        print(f"[CPA Export] Registration triage: 3 files uploaded")
    except Exception as e:
        print(f"[CPA Export] Registration triage error: {e}")
        cpa_errors.append(f"reg triage: {e}")

    try:
        from src.exports.economic_nexus_audit import build_audit, upload_exports as upload_econ
        audit = build_audit()
        results = upload_econ(audit)
        ok = sum(1 for v in results.values() if v)
        exceeded = [s["state_code"] for s in audit["states"] if s["status"] == "exceeded"]
        print(f"[CPA Export] Economic nexus audit: {ok}/{len(results)} files, {len(exceeded)} exceeded")
    except Exception as e:
        print(f"[CPA Export] Economic nexus audit error: {e}")
        cpa_errors.append(f"econ audit: {e}")

    if cpa_errors:
        job_finish(run_id, "fail", "; ".join(cpa_errors))
    else:
        job_finish(run_id, "success", "All CPA exports uploaded")


def _run_job_worker():
    """Poll agent_jobs for pending work and execute."""
    from src.db import get_client

    try:
        client = get_client()
        # Claim oldest pending job
        result = client.table("agent_jobs") \
            .select("*") \
            .eq("status", "pending") \
            .order("created_at") \
            .limit(1) \
            .execute()

        if not result.data:
            return

        job = result.data[0]
        job_id = job["id"]
        job_type = job["job_type"]

        # Mark as running
        from datetime import datetime, timezone
        client.table("agent_jobs") \
            .update({"status": "running", "started_at": datetime.now(timezone.utc).isoformat()}) \
            .eq("id", job_id) \
            .execute()

        print(f"[Job Worker] Running job {job_id}: {job_type}")

        try:
            if job_type in ("export_cpa", "export_triage", "export_economic_audit"):
                _run_cpa_exports()  # runs all three: inventory, triage, economic
            else:
                raise ValueError(f"Unknown job type: {job_type}")

            client.table("agent_jobs") \
                .update({"status": "done", "finished_at": datetime.now(timezone.utc).isoformat()}) \
                .eq("id", job_id) \
                .execute()
            print(f"[Job Worker] Job {job_id} completed")

        except Exception as e:
            client.table("agent_jobs") \
                .update({
                    "status": "error",
                    "finished_at": datetime.now(timezone.utc).isoformat(),
                    "error_text": str(e)[:500],
                }) \
                .eq("id", job_id) \
                .execute()
            print(f"[Job Worker] Job {job_id} failed: {e}")

    except Exception as e:
        # Table might not exist yet — silently skip
        msg = str(e)
        if "agent_jobs" in msg and ("not exist" in msg or "PGRST205" in msg):
            return  # table not created yet, skip silently
        print(f"[Job Worker] Error: {e}")


# Also trigger CPA export after successful ingest runs
if __name__ == "__main__":
    cli()
