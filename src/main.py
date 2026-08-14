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


@cli.command("populate-calendar")
@click.option("--year", type=int, default=None, help="Calendar year")
def populate_calendar(year):
    """Generate filing calendar entries for registered states."""
    from src.calendar.filing_calendar import populate_calendar_for_registered_states
    result = populate_calendar_for_registered_states(year)
    click.echo(f"Calendar populated: {result}")


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
    from datetime import date, timedelta
    from src.parsers.shopify_orders import fetch_shopify_orders_api
    since = date.today() - timedelta(days=7)
    try:
        result = fetch_shopify_orders_api(since_date=since)
        print(f"[Shopify Poll] {result.get('orders_fetched', 0)} orders, "
              f"{result.get('rows_inserted', 0)} rows inserted")
    except Exception as e:
        print(f"[Shopify Poll] Error: {e}")


def _run_daily_analysis():
    from src.engines.physical_nexus import evaluate_physical_nexus
    from src.engines.economic_nexus import evaluate_economic_nexus
    from src.alerts.telegram import send_nexus_alert, send_threshold_alert

    try:
        phys = evaluate_physical_nexus()
        for state in phys.get("new_nexus_states", []):
            details = phys.get("details", {}).get(state, {})
            send_nexus_alert(
                state, "physical",
                f"FBA inventory detected since {details.get('first_seen', '?')}. "
                f"FCs: {details.get('fc_codes', [])}"
            )

        econ = evaluate_economic_nexus()
        for alert in econ.get("alerts", []):
            detail = econ.get("details", {}).get(alert["state"], {})
            send_threshold_alert(
                alert["state"],
                detail.get("progress_percent", 0),
                detail.get("total_amount", 0),
                detail.get("threshold_amount", 100000),
            )

        print(f"[Daily Analysis] Physical: {len(phys.get('nexus_states', []))} states, "
              f"Economic alerts: {len(econ.get('alerts', []))}")
    except Exception as e:
        print(f"[Daily Analysis] Error: {e}")


def _run_deadline_check():
    from src.calendar.filing_calendar import get_upcoming_deadlines
    from src.alerts.telegram import send_deadline_alert

    try:
        deadlines = get_upcoming_deadlines()
        sent = 0
        for d in deadlines:
            days = d.get("days_until_due", d.get("days_overdue", 0))
            if d.get("days_overdue"):
                days = -d["days_overdue"]

            if not d.get("reminder_sent") or days <= 3:
                send_deadline_alert(
                    d["state_code"], d["period_label"],
                    str(d["due_date"]), days,
                )
                sent += 1

        print(f"[Deadline Check] {len(deadlines)} upcoming, {sent} alerts sent")
    except Exception as e:
        print(f"[Deadline Check] Error: {e}")


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
