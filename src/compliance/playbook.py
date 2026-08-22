"""Compliance playbook generator.

Merges state-specific step-by-step guides with live nexus / sales /
filing context to produce an actionable markdown document.
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from src.config import PROJECT_ROOT, load_state_rules
from src.db import fetch_all
from src.channels import is_quarantined_source, normalize_channel, SHOPIFY, AMAZON

PLAYBOOK_DIR = PROJECT_ROOT / "config" / "compliance_playbooks"

DISCLAIMER = (
    "---\n"
    "**DISCLAIMER:** This is a research/monitoring aid assembled from "
    "configured state rules and public portal patterns. It is NOT legal, "
    "tax, or CPA advice. Rules change. Verify on the official state site "
    "before filing or paying. Marketplace facilitator collection (Amazon) "
    "does not always eliminate registration, franchise, or economic-nexus "
    "obligations.\n"
    "---"
)


def _load_playbook_config(state_code: str) -> dict:
    """Load the playbook JSON for a state, falling back to the generic template."""
    path = PLAYBOOK_DIR / f"{state_code}.json"
    if path.exists():
        with open(path) as f:
            return json.load(f)

    generic = PLAYBOOK_DIR / "_GENERIC.json"
    if generic.exists():
        with open(generic) as f:
            data = json.load(f)
        # Substitute state name from rules
        rules = load_state_rules().get("states", {})
        name = rules.get(state_code, {}).get("state_name", state_code)
        raw = json.dumps(data)
        raw = raw.replace("{state_name}", name).replace("_GENERIC", state_code)
        result = json.loads(raw)
        result["state_name"] = name
        result["state_code"] = state_code
        return result

    return {"state_code": state_code, "scenarios": {}}


def _get_context(state_code: str) -> dict:
    """Gather live context from the DB for this state."""
    nexus_rows = fetch_all("nexus_status", {"state_code": state_code})
    nexus = nexus_rows[0] if nexus_rows else {}

    rules = load_state_rules().get("states", {}).get(state_code, {})

    # Sales totals
    sales = fetch_all("sales_by_state")
    shopify_total = 0.0
    amazon_total = 0.0
    for s in sales:
        if s.get("state_code") != state_code:
            continue
        if is_quarantined_source(s.get("source")):
            continue
        ch = normalize_channel(s.get("channel", ""))
        if ch == SHOPIFY:
            shopify_total += float(s.get("gross_sales", 0))
        elif ch == AMAZON:
            amazon_total += float(s.get("gross_sales", 0))

    # Filing context
    filings = fetch_all("filing_calendar")
    state_filings = [f for f in filings if f.get("state_code") == state_code]
    today = date.today().isoformat()
    next_due = None
    for f in sorted(state_filings, key=lambda x: x.get("due_date", "9999")):
        if f.get("status") == "pending" and f.get("due_date", "") >= today:
            next_due = f
            break
    overdue = [f for f in state_filings
               if f.get("status") in ("pending", "late") and f.get("due_date", "9") < today]

    # Franchise flags
    flags = fetch_all("franchise_tax_flags", {"state_code": state_code})
    open_flags = [f for f in flags if f.get("status") == "open"]

    return {
        "nexus": nexus,
        "rules": rules,
        "shopify_total": shopify_total,
        "amazon_total": amazon_total,
        "total_sales": shopify_total + amazon_total,
        "next_due": next_due,
        "overdue_count": len(overdue),
        "franchise_flags": open_flags,
        "is_registered": nexus.get("is_registered", False),
        "has_physical_nexus": nexus.get("has_physical_nexus", False),
        "has_economic_nexus": nexus.get("has_economic_nexus", False),
        "confidence": nexus.get("confidence", "medium"),
    }


def build_playbook(state_code: str) -> str:
    """Build a complete markdown playbook for a state."""
    config = _load_playbook_config(state_code)
    ctx = _get_context(state_code)
    rules = ctx["rules"]

    lines: list[str] = []
    state_name = config.get("state_name", rules.get("state_name", state_code))

    # Header
    lines.append(f"# Compliance Playbook: {state_name} ({state_code})")
    lines.append(f"*Generated {date.today().isoformat()} — "
                 f"Last reviewed: {config.get('last_reviewed', 'unknown')} — "
                 f"Confidence: {config.get('confidence', 'medium')}*\n")
    lines.append(DISCLAIMER)
    lines.append("")

    # Section 1: Why this state appears
    lines.append("## 1. Why This State Appears")
    reasons = []
    if ctx["has_physical_nexus"]:
        src = ctx["nexus"].get("physical_nexus_source", "FBA inventory")
        reasons.append(f"**Physical nexus**: {src}")
    if ctx["has_economic_nexus"]:
        amt = ctx["nexus"].get("economic_progress_amount", 0)
        thresh = rules.get("economic_threshold_amount", 100000)
        reasons.append(f"**Economic nexus**: ${amt:,.0f} / ${thresh:,.0f} threshold")
    if ctx["franchise_flags"]:
        for f in ctx["franchise_flags"]:
            reasons.append(f"**Franchise flag ({f.get('severity', '?')})**: {f.get('description', '')[:120]}")
    if not reasons:
        reasons.append("No current nexus flags — review for monitoring purposes.")
    for r in reasons:
        lines.append(f"- {r}")

    lines.append(f"\n**Sales in {state_code}** (all time in database):")
    lines.append(f"- Shopify/direct: ${ctx['shopify_total']:,.2f}")
    lines.append(f"- Amazon marketplace: ${ctx['amazon_total']:,.2f}")
    lines.append(f"- Total: ${ctx['total_sales']:,.2f}")

    if ctx["is_registered"]:
        freq = ctx["nexus"].get("assigned_frequency", "unknown")
        lines.append(f"\n**Registration status**: Registered (filing {freq})")
        if ctx["next_due"]:
            lines.append(f"**Next filing due**: {ctx['next_due'].get('due_date')} "
                         f"({ctx['next_due'].get('period_label')})")
        if ctx["overdue_count"] > 0:
            lines.append(f"**⚠ Overdue filings: {ctx['overdue_count']}**")
    else:
        lines.append(f"\n**Registration status**: Not registered")
    lines.append("")

    # Section 2: Decision tree
    lines.append("## 2. Decision Tree")
    if ctx["confidence"] == "contested":
        lines.append("⚠ **This state's FBA nexus position is CONTESTED.** "
                     "Consult CPA before deciding on registration.\n")

    if ctx["is_registered"]:
        lines.append("You are **already registered** in this state. Focus on:")
        lines.append("- Filing returns on time")
        lines.append("- Paying the $800 FTB franchise tax (CA)" if state_code == "CA" else "")
        lines.append("- Monitoring for any entity-level obligations\n")
    elif ctx["has_physical_nexus"] or ctx["has_economic_nexus"]:
        lines.append("**Registration is likely required.** You have nexus in this state.")
        lines.append("Recommended next step: register for sales tax and begin filing.\n")
    else:
        lines.append("**Monitor only.** No current nexus triggers. "
                     "Review if sales volume increases or FBA inventory moves.\n")

    # Sections 3+: Render scenarios
    section_num = 3
    for scenario_key, scenario in config.get("scenarios", {}).items():
        title = scenario.get("title", scenario_key)
        lines.append(f"## {section_num}. {title}")
        if scenario.get("summary"):
            lines.append(f"\n{scenario['summary']}\n")
        if scenario.get("severity") == "critical":
            lines.append("**⚠ CRITICAL** — Do not delay action on this item.\n")

        for step in scenario.get("steps", []):
            lines.append(f"### Step {step['order']}: {step['title']}")
            if step.get("detail"):
                lines.append(f"\n{step['detail']}\n")
            if step.get("url"):
                lines.append(f"🔗 [{step.get('url_label', 'Official link')}]({step['url']})\n")
            if step.get("account_to_create"):
                lines.append(f"**Account to create:** {step['account_to_create']}")
            if step.get("form_name"):
                lines.append(f"**Form:** {step['form_name']}")
            if step.get("deadline_rule"):
                lines.append(f"**Deadline:** {step['deadline_rule']}")
            if step.get("frequency"):
                lines.append(f"**Frequency:** {step['frequency']}")
            if step.get("documents_needed"):
                lines.append("**Documents needed:**")
                for doc in step["documents_needed"]:
                    lines.append(f"  - {doc}")
            if step.get("common_pitfalls"):
                lines.append("**Common pitfalls:**")
                for pitfall in step["common_pitfalls"]:
                    lines.append(f"  - ⚠ {pitfall}")
            if step.get("verification_check"):
                lines.append(f"**✓ Done when:** {step['verification_check']}")
            lines.append("")

        # Related URLs
        urls = scenario.get("related_urls", {})
        if urls:
            lines.append("**Official links:**")
            for label, url in urls.items():
                lines.append(f"- [{label}]({url})")
            lines.append("")

        section_num += 1

    # Footer
    lines.append("---")
    lines.append(f"*Sources: {', '.join(config.get('sources', ['See state DOR']))}*")
    lines.append(f"*Confidence: {config.get('confidence', 'medium')}*")
    lines.append("")
    lines.append(DISCLAIMER)

    return "\n".join(lines)
