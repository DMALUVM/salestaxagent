from __future__ import annotations

import csv
import json
from datetime import date
from io import StringIO
from pathlib import Path

from tabulate import tabulate

from src.db import fetch_all


def nexus_summary() -> str:
    records = fetch_all("nexus_status", order="state_code")
    if not records:
        return "No nexus data available. Run 'analyze' after ingesting data."

    lines = ["", "═══ NEXUS STATUS SUMMARY ═══", ""]

    physical = [r for r in records if r.get("has_physical_nexus")]
    economic = [r for r in records if r.get("has_economic_nexus")]
    registered = [r for r in records if r.get("is_registered")]
    action_needed = [r for r in records if r.get("requires_action") and not r.get("is_registered")]

    lines.append(f"Physical nexus:  {len(physical)} states")
    lines.append(f"Economic nexus:  {len(economic)} states")
    lines.append(f"Registered:      {len(registered)} states")
    lines.append(f"Action needed:   {len(action_needed)} states")
    lines.append("")

    if physical:
        rows = []
        for r in physical:
            rows.append([
                r["state_code"],
                r.get("physical_nexus_since", "?"),
                "Yes" if r.get("is_registered") else "NO",
                r.get("confidence", "?"),
            ])
        lines.append("Physical Nexus States (FBA Inventory):")
        lines.append(tabulate(rows, headers=["State", "Since", "Registered", "Confidence"],
                              tablefmt="simple"))
        lines.append("")

    approaching = [r for r in records
                   if not r.get("has_economic_nexus")
                   and r.get("economic_progress_percent", 0) >= 50]
    if approaching:
        rows = []
        for r in sorted(approaching, key=lambda x: x.get("economic_progress_percent", 0), reverse=True):
            pct = r.get("economic_progress_percent", 0)
            amt = r.get("economic_progress_amount", 0)
            rows.append([
                r["state_code"],
                f"${amt:,.2f}",
                f"{pct:.0f}%",
                "⚠️" if pct >= 80 else "📊",
            ])
        lines.append("Approaching Economic Nexus:")
        lines.append(tabulate(rows, headers=["State", "Sales", "Progress", "Alert"],
                              tablefmt="simple"))
        lines.append("")

    if action_needed:
        lines.append("═══ ACTION REQUIRED ═══")
        for r in action_needed:
            lines.append(f"\n  {r['state_code']}: {r.get('action_notes', 'Review needed')}")
        lines.append("")

    return "\n".join(lines)


def deadlines_report(days_ahead: int = 30) -> str:
    from src.calendar.filing_calendar import get_upcoming_deadlines
    deadlines = get_upcoming_deadlines(days_ahead)

    if not deadlines:
        return f"No upcoming filing deadlines in the next {days_ahead} days."

    lines = ["", "═══ FILING DEADLINES ═══", ""]

    overdue = [d for d in deadlines if d.get("days_overdue")]
    upcoming = [d for d in deadlines if d.get("days_until_due") is not None]

    if overdue:
        rows = [[d["state_code"], d["period_label"], d["due_date"],
                 f"{d['days_overdue']} days overdue", "🚨"]
                for d in overdue]
        lines.append("OVERDUE:")
        lines.append(tabulate(rows, headers=["State", "Period", "Due Date", "Status", ""],
                              tablefmt="simple"))
        lines.append("")

    if upcoming:
        rows = [[d["state_code"], d["period_label"], d["due_date"],
                 f"{d['days_until_due']} days",
                 "⏰" if d["days_until_due"] <= 3 else "📅"]
                for d in upcoming]
        lines.append("Upcoming:")
        lines.append(tabulate(rows, headers=["State", "Period", "Due Date", "Days Left", ""],
                              tablefmt="simple"))

    return "\n".join(lines)


def franchise_flags_report() -> str:
    flags = fetch_all("franchise_tax_flags", order="severity")
    if not flags:
        return "No franchise tax flags."

    lines = ["", "═══ FRANCHISE / ENTITY TAX FLAGS ═══", ""]

    for flag in flags:
        severity_icon = {"critical": "🚨", "warning": "⚠️", "info": "ℹ️"}.get(
            flag.get("severity", ""), "")
        lines.append(f"{severity_icon} {flag['state_code']} — {flag.get('flag_type', '')} [{flag.get('status', '')}]")
        lines.append(f"   {flag.get('description', '')}")
        if flag.get("recommended_action"):
            lines.append(f"   → {flag['recommended_action']}")
        lines.append("")

    return "\n".join(lines)


def full_report() -> str:
    parts = [
        nexus_summary(),
        franchise_flags_report(),
        deadlines_report(),
    ]
    return "\n".join(parts)


def export_csv(output_path: str | Path) -> str:
    records = fetch_all("nexus_status", order="state_code")
    if not records:
        return "No data to export."

    path = Path(output_path)
    fields = [
        "state_code", "has_physical_nexus", "physical_nexus_since",
        "has_economic_nexus", "economic_nexus_since",
        "economic_progress_amount", "economic_progress_percent",
        "is_registered", "assigned_frequency",
        "requires_action", "action_notes", "confidence",
    ]

    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for record in records:
            writer.writerow(record)

    return f"Exported {len(records)} records to {path}"


def export_json(output_path: str | Path) -> str:
    records = fetch_all("nexus_status", order="state_code")
    flags = fetch_all("franchise_tax_flags")
    filings = fetch_all("filing_calendar", order="due_date")

    data = {
        "generated": date.today().isoformat(),
        "nexus_status": records,
        "franchise_flags": flags,
        "filing_calendar": filings,
        "disclaimer": "This data is for informational purposes only and does not constitute tax advice.",
    }

    path = Path(output_path)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, default=str)

    return f"Exported full report to {path}"
