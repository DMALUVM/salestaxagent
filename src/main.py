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
    try:
        # Always pull ALL orders (no since_date) to ensure complete
        # monthly totals.  The delete-then-upsert pattern in the
        # parser replaces all shopify rows atomically.
        result = fetch_shopify_orders_api()
        print(f"[Shopify Poll] {result.get('orders_fetched', 0)} orders, "
              f"{result.get('rows_inserted', 0)} rows inserted")
    except Exception as e:
        print(f"[Shopify Poll] Error: {e}")


def _run_daily_analysis():
    """Run physical + economic nexus analysis, gather deadlines, and send
    a SINGLE Telegram summary.  Dedicated threshold-crossed alerts are
    sent only for states that newly exceed their threshold on THIS run.
    """
    from src.db import fetch_all
    from src.engines.physical_nexus import evaluate_physical_nexus
    from src.engines.economic_nexus import evaluate_economic_nexus
    from src.calendar.filing_calendar import get_upcoming_deadlines
    from src.alerts.telegram import (
        send_daily_summary,
        send_threshold_crossed,
        send_telegram,
    )
    from datetime import date

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

    except Exception as e:
        print(f"[Daily Analysis] Error: {e}")
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
    from datetime import date, timedelta
    from src.amazon_sp.reports import fetch_orders, fetch_inventory
    end = date.today() - timedelta(days=1)
    start = end - timedelta(days=7)
    errors = []
    try:
        orders = fetch_orders(start, end)
        print(f"[SP-API] Orders: {orders.get('rows_inserted', 0)} rows, "
              f"${orders.get('total_gross_sales', 0):,.0f} sales")
    except Exception as e:
        errors.append(f"Orders: {e}")
        print(f"[SP-API] Orders error: {e}")
    try:
        inv = fetch_inventory(start, end)
        print(f"[SP-API] Inventory: {inv.get('rows_inserted', 0)} rows, "
              f"states: {inv.get('states_found', [])}")
    except Exception as e:
        errors.append(f"Inventory: {e}")
        print(f"[SP-API] Inventory error: {e}")
    if errors:
        try:
            from src.alerts.telegram import send_telegram
            send_telegram(
                f"🚨 <b>SP-API Sync Failed</b>\n\n"
                + "\n".join(errors[:3])
            )
        except Exception:
            pass


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


if __name__ == "__main__":
    cli()
