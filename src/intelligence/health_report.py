"""
Rules Health Report — periodic assessment of knowledge base currency and completeness.
"""
from __future__ import annotations

from datetime import date, timedelta

from tabulate import tabulate

from src.db import fetch_all
from src.intelligence.knowledge_base import DISCLAIMER


def generate_health_report(stale_threshold_days: int = 90) -> str:
    """
    Generate a comprehensive rules health report covering:
    - Stale rules (not reviewed within threshold)
    - Contested positions needing attention
    - Unreviewed source changes
    - Open research tasks
    - Coverage gaps
    """
    today = date.today()
    stale_cutoff = today - timedelta(days=stale_threshold_days)

    lines = [
        "",
        "═" * 60,
        "RULES HEALTH REPORT",
        f"Generated: {today.isoformat()}",
        f"Stale threshold: {stale_threshold_days} days",
        "═" * 60,
        "",
    ]

    lines.extend(_section_stale_rules(stale_cutoff))
    lines.extend(_section_contested_positions())
    lines.extend(_section_source_changes())
    lines.extend(_section_research_tasks())
    lines.extend(_section_coverage_summary())
    lines.extend(_section_ruling_status())

    lines.extend([
        "",
        "═" * 60,
        "RECOMMENDED ACTIONS",
        "═" * 60,
        "",
    ])
    lines.extend(_generate_recommendations(stale_cutoff))

    lines.extend([
        "",
        "-" * 60,
        DISCLAIMER,
        "-" * 60,
    ])

    return "\n".join(lines)


def _section_stale_rules(cutoff: date) -> list[str]:
    lines = ["--- Stale Rules (not reviewed recently) ---", ""]

    stale = []
    for table, label in [("nexus_rules", "Nexus"), ("franchise_entity_rules", "Franchise"),
                         ("filing_rules", "Filing")]:
        rules = fetch_all(table)
        for r in rules:
            if not r.get("is_active", True):
                continue
            reviewed = r.get("last_reviewed")
            if reviewed:
                if isinstance(reviewed, str):
                    reviewed = date.fromisoformat(reviewed)
                if reviewed < cutoff:
                    stale.append([
                        r.get("state_code", "?"),
                        label,
                        r.get("rule_type", r.get("default_frequency", "?")),
                        str(reviewed),
                        (date.today() - reviewed).days,
                    ])

    if stale:
        stale.sort(key=lambda x: x[4], reverse=True)
        lines.append(tabulate(stale, headers=["State", "Type", "Rule", "Last Reviewed", "Days Ago"],
                              tablefmt="simple"))
    else:
        lines.append("All rules reviewed within threshold.")

    lines.append("")
    return lines


def _section_contested_positions() -> list[str]:
    lines = ["--- Contested Positions ---", ""]

    nexus_rules = fetch_all("nexus_rules")
    contested = [r for r in nexus_rules if r.get("confidence") == "contested" and r.get("is_active")]

    if contested:
        for r in contested:
            lines.append(f"  {r['state_code']} — {r.get('rule_type', '?')}")
            lines.append(f"    {r.get('position_summary', '')[:120]}")
            if r.get("open_questions"):
                lines.append(f"    Open questions: {r['open_questions'][:120]}")
            lines.append("")
    else:
        lines.append("No contested positions in the knowledge base.")
        lines.append("")

    return lines


def _section_source_changes() -> list[str]:
    lines = ["--- Unreviewed Source Changes ---", ""]

    checks = fetch_all("monitoring_checks")
    unreviewed = [c for c in checks if c.get("change_detected") and not c.get("reviewed")]

    if unreviewed:
        rows = []
        for c in unreviewed[:20]:
            rows.append([
                c.get("state_code", "?"),
                c.get("url", "")[:60],
                c.get("checked_at", "?")[:10] if c.get("checked_at") else "?",
            ])
        lines.append(tabulate(rows, headers=["State", "URL", "Detected"],
                              tablefmt="simple"))
    else:
        lines.append("No unreviewed source changes.")

    lines.append("")
    return lines


def _section_research_tasks() -> list[str]:
    lines = ["--- Open Research Tasks ---", ""]

    tasks = fetch_all("research_tasks")
    open_tasks = [t for t in tasks if t.get("status") in ("open", "in_progress")]

    if open_tasks:
        rows = []
        for t in sorted(open_tasks, key=lambda x: {"critical": 0, "high": 1, "medium": 2, "low": 3}.get(x.get("priority", "medium"), 2)):
            rows.append([
                t.get("priority", "?").upper(),
                t.get("state_code", "—"),
                t.get("title", "")[:50],
                t.get("status", "?"),
            ])
        lines.append(tabulate(rows, headers=["Priority", "State", "Task", "Status"],
                              tablefmt="simple"))
    else:
        lines.append("No open research tasks.")

    lines.append("")
    return lines


def _section_coverage_summary() -> list[str]:
    lines = ["--- Knowledge Base Coverage ---", ""]

    nexus_rules = fetch_all("nexus_rules")
    franchise_rules = fetch_all("franchise_entity_rules")
    filing_rules = fetch_all("filing_rules")
    court_rulings = fetch_all("court_rulings")
    admin_rulings = fetch_all("admin_rulings")
    source_docs = fetch_all("source_documents")
    registry = fetch_all("source_registry")

    active_nexus = [r for r in nexus_rules if r.get("is_active")]
    nexus_states = set(r["state_code"] for r in active_nexus)
    franchise_states = set(r["state_code"] for r in franchise_rules if r.get("is_active"))
    filing_states = set(r["state_code"] for r in filing_rules if r.get("is_active"))

    lines.append(f"  Nexus rules:       {len(active_nexus)} rules across {len(nexus_states)} states")
    lines.append(f"  Franchise rules:   {len([r for r in franchise_rules if r.get('is_active')])} rules across {len(franchise_states)} states")
    lines.append(f"  Filing rules:      {len([r for r in filing_rules if r.get('is_active')])} rules across {len(filing_states)} states")
    lines.append(f"  Court rulings:     {len([r for r in court_rulings if r.get('is_active')])}")
    lines.append(f"  Admin rulings:     {len([r for r in admin_rulings if r.get('is_active')])}")
    lines.append(f"  Source documents:  {len(source_docs)}")
    lines.append(f"  Monitored sources: {len([s for s in registry if s.get('is_active')])}")

    all_sales_tax_states = {
        "AL", "AZ", "AR", "CA", "CO", "CT", "FL", "GA", "HI", "ID", "IL", "IN",
        "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "NE",
        "NV", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "PA", "RI", "SC", "SD",
        "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
    }
    missing_nexus = all_sales_tax_states - nexus_states
    if missing_nexus:
        lines.append(f"\n  States without detailed nexus rules: {', '.join(sorted(missing_nexus))}")
        lines.append(f"  (These states use base state_rules data — lower citation depth)")

    lines.append("")
    return lines


def _section_ruling_status() -> list[str]:
    lines = ["--- Ruling Status Summary ---", ""]

    court = fetch_all("court_rulings")
    if court:
        status_counts = {}
        for r in court:
            s = r.get("status", "unknown")
            status_counts[s] = status_counts.get(s, 0) + 1
        for status, count in sorted(status_counts.items()):
            lines.append(f"  Court — {status}: {count}")

    admin = fetch_all("admin_rulings")
    if admin:
        status_counts = {}
        for r in admin:
            s = r.get("status", "unknown")
            status_counts[s] = status_counts.get(s, 0) + 1
        for status, count in sorted(status_counts.items()):
            lines.append(f"  Admin — {status}: {count}")

    if not court and not admin:
        lines.append("No rulings in the knowledge base.")

    lines.append("")
    return lines


def _generate_recommendations(stale_cutoff: date) -> list[str]:
    recs = []

    nexus_rules = fetch_all("nexus_rules")
    contested = [r for r in nexus_rules if r.get("confidence") == "contested" and r.get("is_active")]
    if contested:
        recs.append(f"1. Review {len(contested)} contested position(s) with CPA — especially PA FBA inventory nexus.")

    stale_count = 0
    for table in ("nexus_rules", "franchise_entity_rules", "filing_rules"):
        for r in fetch_all(table):
            reviewed = r.get("last_reviewed")
            if reviewed:
                if isinstance(reviewed, str):
                    reviewed = date.fromisoformat(reviewed)
                if reviewed < stale_cutoff:
                    stale_count += 1
    if stale_count:
        recs.append(f"2. Update {stale_count} stale rule(s) — review primary sources for changes.")

    checks = fetch_all("monitoring_checks")
    unreviewed = [c for c in checks if c.get("change_detected") and not c.get("reviewed")]
    if unreviewed:
        recs.append(f"3. Review {len(unreviewed)} detected source change(s) — potential rule updates.")

    tasks = fetch_all("research_tasks")
    open_tasks = [t for t in tasks if t.get("status") == "open"]
    if open_tasks:
        recs.append(f"4. Address {len(open_tasks)} open research task(s).")

    if not recs:
        recs.append("No immediate actions needed. Knowledge base is current.")

    recs.append("")
    recs.append("Recommended review cadence: Monthly for rules, weekly for source monitoring.")
    return recs
