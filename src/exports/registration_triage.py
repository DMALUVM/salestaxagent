"""CPA Export: Registration Triage.

Generates a research-aid triage report for CPA review. Does NOT
auto-recommend registration — buckets states for discussion.

Output: Markdown + CSV.
"""
from __future__ import annotations

import csv
import io
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta

from src.config import load_state_rules, load_fba_nexus_posture, settings
from src.db import fetch_all

DISCLAIMER = (
    "DISCLAIMER: This is a research and monitoring aid — NOT legal, tax, "
    "or CPA advice. It does NOT recommend registration. Postures reflect "
    "best-available interpretation of public guidance and may be wrong or "
    "outdated. The CPA must independently verify each state's position "
    "before advising the client."
)

TRIAGE_DESCRIPTIONS = {
    "A_discuss": "Discuss with CPA — inventory nexus asserted or contested, and Shopify direct sales or entity tax flag present.",
    "B_monitor": "Monitor — carve-out state, low Shopify exposure, under economic threshold.",
    "C_economic_watch": "Economic watch — approaching or exceeding economic nexus threshold.",
    "D_entity_tax": "Entity tax flag — franchise, B&O, CAT, or FTB obligation independent of sales tax.",
}


# ── Data gathering ──────────────────────────────────────────

def _gather_inventory_presence() -> dict[str, dict]:
    """Build per-state inventory evidence from inventory_events."""
    events = fetch_all("inventory_events")
    by_state: dict[str, dict] = {}

    for e in events:
        sc = e.get("state_code")
        if not sc:
            continue

        if sc not in by_state:
            by_state[sc] = {
                "events": 0,
                "min_date": "9999-12-31",
                "max_date": "0000-01-01",
                "fcs": set(),
            }

        b = by_state[sc]
        b["events"] += 1
        d = str(e.get("event_date", ""))
        if d:
            if d < b["min_date"]:
                b["min_date"] = d
            if d > b["max_date"]:
                b["max_date"] = d
        fc = e.get("fc_code", "")
        if fc:
            b["fcs"].add(fc)

    return by_state


def _gather_sales_12m(reference_date: date | None = None) -> dict[str, dict]:
    """Aggregate trailing-12-month sales by state and channel."""
    if reference_date is None:
        reference_date = date.today()
    cutoff = reference_date - timedelta(days=365)

    sales = fetch_all("sales_by_state")
    by_state: dict[str, dict] = defaultdict(
        lambda: {"shopify": 0.0, "amazon": 0.0}
    )

    for r in sales:
        pe_str = r.get("period_end", "")
        if isinstance(pe_str, str) and pe_str:
            pe = date.fromisoformat(pe_str)
        else:
            pe = pe_str
        if pe and pe < cutoff:
            continue

        sc = r.get("state_code")
        if not sc:
            continue
        ch = (r.get("channel") or "").lower()
        amt = float(r.get("gross_sales") or 0)
        if "shopify" in ch:
            by_state[sc]["shopify"] += amt
        elif "amazon" in ch:
            by_state[sc]["amazon"] += amt
        else:
            by_state[sc]["amazon"] += amt  # default to amazon

    return dict(by_state)


def _get_entity_tax_flags() -> dict[str, list[dict]]:
    """Group open franchise/entity tax flags by state."""
    flags = fetch_all("franchise_tax_flags")
    by_state: dict[str, list[dict]] = defaultdict(list)
    for f in flags:
        if f.get("status") == "open":
            by_state[f["state_code"]].append(f)
    return dict(by_state)


# ── Triage bucketing ────────────────────────────────────────

def build_triage_rows(reference_date: date | None = None) -> list[dict]:
    """Build the triage dataset. Returns list of row dicts."""
    if reference_date is None:
        reference_date = date.today()

    inventory = _gather_inventory_presence()
    sales = _gather_sales_12m(reference_date)
    entity_flags = _get_entity_tax_flags()
    postures = load_fba_nexus_posture()
    rules = load_state_rules().get("states", {})
    nexus_rows = {n["state_code"]: n for n in fetch_all("nexus_status")}

    # Union of all states that appear in any source
    all_states = set(inventory) | set(sales) | set(entity_flags)

    # Also include states with nexus_status records
    for sc in nexus_rows:
        if nexus_rows[sc].get("has_physical_nexus") or nexus_rows[sc].get("has_economic_nexus"):
            all_states.add(sc)

    warn_pct = settings.economic_nexus_warn_percent

    rows = []
    for sc in sorted(all_states):
        rule = rules.get(sc, {})
        posture_data = postures.get(sc, {})
        inv = inventory.get(sc)
        sale = sales.get(sc, {"shopify": 0.0, "amazon": 0.0})
        flags = entity_flags.get(sc, [])
        nx = nexus_rows.get(sc, {})

        # Inventory presence
        has_inventory = inv is not None and inv["events"] > 0
        inv_first = inv["min_date"] if has_inventory else None
        inv_last = inv["max_date"] if has_inventory else None

        # Posture
        posture = posture_data.get("posture", "unknown")
        posture_confidence = posture_data.get("confidence", "low")
        posture_citation = posture_data.get("citation", "")
        posture_notes = posture_data.get("notes", "")

        # Sales
        shopify_12m = round(sale["shopify"], 2)
        amazon_12m = round(sale["amazon"], 2)

        # Economic status
        econ_exceeded = bool(nx.get("has_economic_nexus"))
        econ_pct = float(nx.get("economic_progress_percent") or 0)
        econ_approaching = econ_pct >= warn_pct and not econ_exceeded
        mp_counts = rule.get("marketplace_sales_count_toward_threshold", True)

        # Is registered?
        is_registered = bool(nx.get("is_registered"))

        # Has entity tax flags?
        has_entity_flags = len(flags) > 0
        entity_flag_types = [f.get("flag_type", "") for f in flags]
        entity_flag_descriptions = [f.get("description", "")[:80] for f in flags]

        # ── Triage bucket ──
        # Multiple buckets can apply; we pick the highest-priority one.
        # Priority: A > D > C > B
        triage = "B_monitor"  # default

        if posture in ("asserts", "contested") and (shopify_12m > 0 or has_entity_flags):
            triage = "A_discuss"
        elif has_entity_flags:
            triage = "D_entity_tax"
        elif econ_approaching or econ_exceeded:
            triage = "C_economic_watch"
        elif posture == "carve_out" and shopify_12m < 1000 and not econ_exceeded:
            triage = "B_monitor"
        elif posture in ("asserts", "contested"):
            # Inventory nexus asserted but no Shopify sales — still flag for discussion
            if has_inventory:
                triage = "A_discuss"

        # Override: if registered, downgrade to B_monitor (already handled)
        if is_registered:
            triage = "B_monitor"

        # Build notes
        notes_parts = []
        if posture_notes:
            notes_parts.append(posture_notes)
        if has_entity_flags:
            for desc in entity_flag_descriptions:
                notes_parts.append(f"Entity tax: {desc}")
        if is_registered:
            notes_parts.append("Already registered.")

        # Sources
        sources = []
        if has_inventory:
            sources.append("inventory_events")
        if shopify_12m > 0 or amazon_12m > 0:
            sources.append("sales_by_state")
        if has_entity_flags:
            sources.append("franchise_tax_flags")
        if posture_citation:
            sources.append("fba_nexus_posture.json")

        rows.append({
            "state_code": sc,
            "state_name": rule.get("state_name", sc),
            "has_inventory": has_inventory,
            "inventory_first": inv_first,
            "inventory_last": inv_last,
            "inventory_events": inv["events"] if has_inventory else 0,
            "posture": posture,
            "posture_confidence": posture_confidence,
            "posture_citation": posture_citation,
            "shopify_sales_12m": shopify_12m,
            "amazon_sales_12m": amazon_12m,
            "economic_nexus_status": "exceeded" if econ_exceeded else (
                "approaching" if econ_approaching else "under"
            ),
            "economic_progress_pct": round(econ_pct, 1),
            "marketplace_counts": mp_counts,
            "is_registered": is_registered,
            "has_entity_tax_flag": has_entity_flags,
            "entity_flag_types": "|".join(entity_flag_types),
            "triage_bucket": triage,
            "notes": " | ".join(notes_parts),
            "sources": ", ".join(sources),
        })

    return rows


# ── Markdown export ─────────────────────────────────────────

def build_markdown(reference_date: date | None = None) -> str:
    """Build registration triage report as Markdown."""
    rows = build_triage_rows(reference_date)
    report_id = str(uuid.uuid4())[:8]

    lines: list[str] = []

    # Cover
    lines.append("# Registration Triage — CPA Research Aid")
    lines.append(f"**Report ID:** {report_id}")
    lines.append(f"**Generated:** {datetime.utcnow().isoformat()[:19]}Z")
    lines.append(f"**States evaluated:** {len(rows)}")
    lines.append("")
    lines.append(f"> {DISCLAIMER}")
    lines.append("")

    # Methodology
    lines.append("## Methodology")
    lines.append("")
    lines.append("This report triages states into discussion buckets for CPA review.")
    lines.append("It does **not** recommend registration. Buckets are:")
    lines.append("")
    for bucket, desc in TRIAGE_DESCRIPTIONS.items():
        lines.append(f"- **{bucket}**: {desc}")
    lines.append("")
    lines.append("**Posture classifications** (from `config/fba_nexus_posture.json`):")
    lines.append("- **asserts**: Majority position — state treats FBA inventory as physical nexus")
    lines.append("- **carve_out**: Marketplace facilitator provisions may shield FBA-only seller")
    lines.append("- **contested**: Active litigation or conflicting guidance")
    lines.append("- **unknown**: Insufficient authority to determine")
    lines.append("")
    lines.append("**Data sources**: inventory_events (FBA presence), sales_by_state ")
    lines.append("(trailing 12-month Shopify + Amazon), franchise_tax_flags (entity taxes), ")
    lines.append("nexus_status (economic nexus engine output).")
    lines.append("")

    # Summary by bucket
    bucket_groups: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        bucket_groups[r["triage_bucket"]].append(r)

    lines.append("## Summary by Triage Bucket")
    lines.append("")
    for bucket in ["A_discuss", "D_entity_tax", "C_economic_watch", "B_monitor"]:
        group = bucket_groups.get(bucket, [])
        if not group:
            continue
        lines.append(f"### {bucket} — {TRIAGE_DESCRIPTIONS[bucket]}")
        lines.append(f"*{len(group)} state{'s' if len(group) != 1 else ''}*")
        lines.append("")
        lines.append("| State | Posture | Conf. | Shopify 12m | Amazon 12m | Econ Status | Entity Tax | Registered |")
        lines.append("|-------|---------|-------|-------------|------------|-------------|------------|------------|")
        for r in group:
            reg = "Yes" if r["is_registered"] else ""
            entity = "Yes" if r["has_entity_tax_flag"] else ""
            lines.append(
                f"| {r['state_code']} — {r['state_name'][:15]} "
                f"| {r['posture']} | {r['posture_confidence']} "
                f"| ${r['shopify_sales_12m']:,.0f} | ${r['amazon_sales_12m']:,.0f} "
                f"| {r['economic_nexus_status']} ({r['economic_progress_pct']:.0f}%) "
                f"| {entity} | {reg} |"
            )
        lines.append("")

    # Detail section — only A_discuss and D_entity_tax get full detail
    detail_rows = bucket_groups.get("A_discuss", []) + bucket_groups.get("D_entity_tax", [])
    if detail_rows:
        lines.append("## State Detail (Bucket A + D)")
        lines.append("")
        for r in detail_rows:
            lines.append(f"### {r['state_code']} — {r['state_name']}")
            lines.append("")
            lines.append(f"**Triage bucket:** {r['triage_bucket']}")
            lines.append(f"**FBA posture:** {r['posture']} (confidence: {r['posture_confidence']})")
            if r["posture_citation"]:
                lines.append(f"**Citation:** {r['posture_citation']}")
            if r["has_inventory"]:
                lines.append(f"**Inventory presence:** {r['inventory_first']} to {r['inventory_last']} ({r['inventory_events']:,} events)")
            else:
                lines.append("**Inventory presence:** None detected")
            lines.append(f"**Shopify sales (12m):** ${r['shopify_sales_12m']:,.2f}")
            lines.append(f"**Amazon sales (12m):** ${r['amazon_sales_12m']:,.2f}")
            lines.append(f"**Economic nexus:** {r['economic_nexus_status']} ({r['economic_progress_pct']:.0f}%)")
            lines.append(f"**Marketplace counts toward threshold:** {'Yes' if r['marketplace_counts'] else 'No'}")
            if r["is_registered"]:
                lines.append("**Registration:** Already registered")
            if r["has_entity_tax_flag"]:
                lines.append(f"**Entity tax flags:** {r['entity_flag_types']}")
            if r["notes"]:
                lines.append(f"**Notes:** {r['notes']}")
            lines.append("")

    # Footer
    lines.append("---")
    lines.append(f"> {DISCLAIMER}")

    return "\n".join(lines)


# ── CSV export ──────────────────────────────────────────────

def build_csv(reference_date: date | None = None) -> str:
    """Build registration triage CSV."""
    rows = build_triage_rows(reference_date)

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "state_code", "state_name",
        "inventory_first", "inventory_last", "inventory_events",
        "posture", "posture_confidence", "posture_citation",
        "shopify_sales_12m", "amazon_sales_12m",
        "economic_nexus_status", "economic_progress_pct",
        "marketplace_counts_toward_threshold",
        "is_registered", "has_entity_tax_flag", "entity_flag_types",
        "triage_bucket", "notes", "sources",
    ])

    for r in rows:
        writer.writerow([
            r["state_code"], r["state_name"],
            r["inventory_first"] or "", r["inventory_last"] or "", r["inventory_events"],
            r["posture"], r["posture_confidence"], r["posture_citation"],
            r["shopify_sales_12m"], r["amazon_sales_12m"],
            r["economic_nexus_status"], r["economic_progress_pct"],
            "yes" if r["marketplace_counts"] else "no",
            "yes" if r["is_registered"] else "no",
            "yes" if r["has_entity_tax_flag"] else "no",
            r["entity_flag_types"],
            r["triage_bucket"], r["notes"], r["sources"],
        ])

    return output.getvalue()
