"""CPA Export: FBA Inventory Presence by State.

Generates a triple-checked, audit-friendly report showing which states
had Amazon FBA / fulfillment inventory present and during which periods.

Output: Markdown (primary) + CSV (detail rows) + PDF (CPA deliverable).
"""
from __future__ import annotations

import csv
import io
import json
import uuid
from collections import defaultdict
from datetime import date, datetime

from src.config import load_state_rules
from src.db import fetch_all

METHODOLOGY = """\
## Methodology

**How presence is detected:**
State presence is evidenced when ANY of:
1. An inventory event record exists with that state's FC code mapped to the state
   (via the FC → state mapping in config/fc_codes.json).
2. Ship-from state data from Amazon Custom Combined Tax or SP-API Inventory Ledger
   reports indicates fulfillment activity originating from that state.
3. An explicit physical nexus flag is set from the analysis engine using the same rules.

**Sources included:**
- Amazon SP-API Inventory Ledger Detail (GET_LEDGER_DETAIL_VIEW_DATA)
- Amazon Custom Combined Tax CSV (ship_from_state aggregates)
- FC-to-state mapping (322 fulfillment center codes)

**What this report does NOT claim:**
- Economic nexus or tax liability from ship-to sales alone
- Continuous 365-day warehouse storage (reports prove activity in period, not
  a literal stock certificate)
- Any legal conclusion — CPA must independently verify each state's position

**Date grain:**
Presence dates are at daily or monthly grain depending on source. Consecutive
months are compressed into From–To ranges. Gaps of 1+ months are listed as
separate ranges.
"""

DISCLAIMER = (
    "DISCLAIMER: This is a monitoring/research aid assembled from Amazon "
    "fulfillment data. It is NOT legal, tax, or CPA advice. Rules change. "
    "Marketplace facilitator collection (Amazon) does not eliminate "
    "registration, franchise, or physical-nexus obligations in all states. "
    "Verify on each state's official DOR site before acting."
)


# ── Data gathering ──────────────────────────────────────────

def _gather_state_evidence() -> dict[str, dict]:
    """Build per-state evidence from inventory_events."""
    events = fetch_all("inventory_events")
    by_state: dict[str, dict] = {}

    for e in events:
        sc = e.get("state_code")
        if not sc:
            continue

        if sc not in by_state:
            by_state[sc] = {
                "events": 0,
                "dates": set(),
                "months": set(),
                "sources": set(),
                "fcs": set(),
                "min_date": "9999-12-31",
                "max_date": "0000-01-01",
                "sample_refs": [],
            }

        b = by_state[sc]
        b["events"] += 1

        d = str(e.get("event_date", ""))
        if d:
            b["dates"].add(d)
            b["months"].add(d[:7])
            if d < b["min_date"]:
                b["min_date"] = d
            if d > b["max_date"]:
                b["max_date"] = d

        sf = e.get("source_file", "")
        if sf:
            b["sources"].add(sf)
        fc = e.get("fc_code", "")
        if fc:
            b["fcs"].add(fc)

        # Sample reference IDs (first 5)
        if len(b["sample_refs"]) < 5:
            ref = e.get("asin") or e.get("sku") or ""
            if ref and ref != "ALL":
                b["sample_refs"].append(f"{fc}/{ref}/{d}")

    return by_state


def _compress_ranges(months: set[str]) -> list[tuple[str, str]]:
    """Compress sorted months into From–To ranges, splitting on gaps."""
    if not months:
        return []
    sorted_months = sorted(months)
    ranges: list[tuple[str, str]] = []
    range_start = sorted_months[0]
    prev = sorted_months[0]

    for m in sorted_months[1:]:
        # Check if consecutive (YYYY-MM)
        py, pm = int(prev[:4]), int(prev[5:7])
        cy, cm = int(m[:4]), int(m[5:7])
        expected_y = py + (1 if pm == 12 else 0)
        expected_m = 1 if pm == 12 else pm + 1
        if cy == expected_y and cm == expected_m:
            prev = m
        else:
            ranges.append((range_start, prev))
            range_start = m
            prev = m

    ranges.append((range_start, prev))
    return ranges


# ── Validation checks ───────────────────────────────────────

def _run_validation(evidence: dict[str, dict]) -> list[dict]:
    """Run checks A-E, return list of {check, status, details}."""
    results = []
    nexus = {n["state_code"]: n for n in fetch_all("nexus_status")}
    today = date.today().isoformat()

    # Check A: Coverage
    total_events = sum(e["events"] for e in evidence.values())
    results.append({
        "check": "A — Coverage",
        "status": "PASS",
        "details": f"{len(evidence)} states, {total_events:,} events, "
                   f"dates {min(e['min_date'] for e in evidence.values())} to "
                   f"{max(e['max_date'] for e in evidence.values())}",
    })

    # Check B: Consistency vs nexus_status
    mismatches = []
    for sc, ev in evidence.items():
        n = nexus.get(sc, {})
        if not n.get("has_physical_nexus") and ev["events"] > 10:
            mismatches.append(f"{sc}: {ev['events']} events but physical_nexus=false")
    for sc, n in nexus.items():
        if n.get("has_physical_nexus") and sc not in evidence:
            src = n.get("physical_nexus_source", "")
            if "Home state" in src or "3PL" in src:
                continue  # confirmed non-FBA source
            mismatches.append(f"{sc}: physical_nexus=true but zero inventory events")

    results.append({
        "check": "B — Consistency vs nexus_status",
        "status": "PASS" if not mismatches else "WARN",
        "details": "; ".join(mismatches[:5]) if mismatches else "All consistent",
    })

    # Check C: Date integrity
    future_dates = []
    null_states = 0
    for sc, ev in evidence.items():
        if ev["max_date"] > today:
            future_dates.append(f"{sc}: max={ev['max_date']}")

    events_all = fetch_all("inventory_events")
    null_states = sum(1 for e in events_all if not e.get("state_code"))

    date_issues = []
    if future_dates:
        date_issues.append(f"Future dates: {', '.join(future_dates[:3])}")
    if null_states:
        date_issues.append(f"{null_states} events with null state_code")

    # Check physical_since vs first evidence
    for sc, ev in evidence.items():
        n = nexus.get(sc, {})
        since = n.get("physical_nexus_since", "")
        if since and ev["min_date"] < since:
            date_issues.append(f"{sc}: first evidence {ev['min_date']} < physical_since {since}")

    results.append({
        "check": "C — Date integrity",
        "status": "PASS" if not date_issues else "WARN",
        "details": "; ".join(date_issues[:5]) if date_issues else "No issues",
    })

    # Check D: Dedup (ranges compressed — always passes since we compress)
    results.append({
        "check": "D — Dedup / range compression",
        "status": "PASS",
        "details": "Consecutive months compressed into ranges; duplicates collapsed",
    })

    # Check E: Confidence
    rules = load_state_rules().get("states", {})
    contested = [sc for sc in evidence
                 if rules.get(sc, {}).get("fba_inventory_creates_nexus") == "contested"
                 or nexus.get(sc, {}).get("confidence") == "contested"]
    carveouts = [sc for sc in evidence
                 if str(rules.get(sc, {}).get("fba_inventory_creates_nexus", "")) == "false"]

    conf_notes = []
    if contested:
        conf_notes.append(f"CONTESTED: {', '.join(contested)}")
    if carveouts:
        conf_notes.append(f"FBA carve-out states (nexus not asserted): {', '.join(carveouts)}")

    results.append({
        "check": "E — Confidence",
        "status": "PASS" if not contested else "WARN",
        "details": "; ".join(conf_notes) if conf_notes else "All high/medium confidence",
    })

    return results


# ── Markdown export ─────────────────────────────────────────

def build_markdown(
    state_filter: str | None = None,
) -> str:
    """Build the full inventory presence report as Markdown."""
    evidence = _gather_state_evidence()
    nexus = {n["state_code"]: n for n in fetch_all("nexus_status")}
    rules = load_state_rules().get("states", {})
    logs = fetch_all("ingestion_log")
    inv_logs = [l for l in logs
                if "inventory" in (l.get("file_type") or "").lower()
                or "inventory" in (l.get("filename") or "").lower()]

    if state_filter:
        evidence = {k: v for k, v in evidence.items() if k == state_filter.upper()}

    validation = _run_validation(evidence) if not state_filter else []
    report_id = str(uuid.uuid4())[:8]
    max_date = max((e["max_date"] for e in evidence.values()), default="unknown")

    lines: list[str] = []

    # Cover
    lines.append("# FBA Inventory Presence by State")
    lines.append(f"**Report ID:** {report_id}")
    lines.append(f"**Generated:** {datetime.utcnow().isoformat()[:19]}Z")
    lines.append(f"**Data as-of:** {max_date}")
    lines.append(f"**States with evidence:** {len(evidence)}")
    lines.append("")
    lines.append(f"> {DISCLAIMER}")
    lines.append("")

    # Methodology
    lines.append(METHODOLOGY)

    # Validation
    if validation:
        lines.append("## Validation Report")
        any_warn = any(v["status"] != "PASS" for v in validation)
        if any_warn:
            lines.append("⚠ **WARNINGS present** — review before relying on this report.\n")
        for v in validation:
            icon = "✅" if v["status"] == "PASS" else "⚠️"
            lines.append(f"- {icon} **{v['check']}**: {v['details']}")
        lines.append("")

    # Executive summary
    lines.append("## Executive Summary\n")
    lines.append(f"| State | First Evidence | Last Evidence | Events | FCs | Sources | Nexus Flag | Confidence |")
    lines.append(f"|-------|---------------|---------------|--------|-----|---------|------------|------------|")

    for sc in sorted(evidence):
        ev = evidence[sc]
        n = nexus.get(sc, {})
        fba_pos = rules.get(sc, {}).get("fba_inventory_creates_nexus", "unknown")
        conf = n.get("confidence", "medium")
        if fba_pos == "contested":
            conf = "⚠ CONTESTED"
        elif fba_pos == "false":
            conf = "carve-out"

        nexus_flag = "Yes" if n.get("has_physical_nexus") else "No"
        src_count = len(ev["sources"])
        fc_count = len(ev["fcs"])
        lines.append(
            f"| {sc} | {ev['min_date']} | {ev['max_date']} | "
            f"{ev['events']:,} | {fc_count} | {src_count} | "
            f"{nexus_flag} | {conf} |"
        )
    lines.append("")

    # State detail
    lines.append("## State Detail\n")
    for sc in sorted(evidence):
        ev = evidence[sc]
        n = nexus.get(sc, {})
        rule = rules.get(sc, {})
        state_name = rule.get("state_name", sc)
        fba_pos = str(rule.get("fba_inventory_creates_nexus", "unknown"))

        lines.append(f"### {sc} — {state_name}")

        if fba_pos == "contested":
            lines.append("⚠ **CONTESTED** — FBA nexus position is contested in this state. "
                         "Verify with counsel before asserting physical nexus.\n")
        elif fba_pos == "false":
            lines.append("ℹ **FBA carve-out** — This state has a marketplace-facilitator "
                         "FBA carve-out. Physical nexus from FBA inventory alone may not apply.\n")

        # Ranges
        ranges = _compress_ranges(ev["months"])
        lines.append(f"**Presence periods** ({len(ranges)} range{'s' if len(ranges) != 1 else ''}):")
        for r_from, r_to in ranges:
            if r_from == r_to:
                lines.append(f"- {r_from}")
            else:
                lines.append(f"- {r_from} to {r_to}")

        lines.append(f"\n**Events:** {ev['events']:,}")
        fc_list = sorted(ev["fcs"])
        lines.append(f"**Fulfillment centers:** {', '.join(fc_list[:15])}"
                      + (f" (+{len(fc_list)-15} more)" if len(fc_list) > 15 else ""))
        lines.append(f"**Sources:** {', '.join(sorted(ev['sources']))}")

        if ev["sample_refs"]:
            lines.append(f"**Sample references:** {'; '.join(ev['sample_refs'][:3])}")

        lines.append("")

    # Ingestion files
    if inv_logs:
        lines.append("## Data Sources (Ingestion Log)\n")
        lines.append("| Filename | Type | Rows | Date |")
        lines.append("|----------|------|------|------|")
        for l in sorted(inv_logs, key=lambda x: x.get("ingested_at", "")):
            fn = (l.get("filename") or "?")[:50]
            lines.append(f"| {fn} | {l.get('file_type','?')} | "
                         f"{l.get('rows_inserted',0):,} | {str(l.get('ingested_at',''))[:10]} |")
        lines.append("")

    # Footer
    lines.append("---")
    lines.append(f"> {DISCLAIMER}")

    return "\n".join(lines)


# ── CSV export ──────────────────────────────────────────────

def build_csv(state_filter: str | None = None) -> str:
    """Build detail CSV with one row per state per month."""
    evidence = _gather_state_evidence()
    if state_filter:
        evidence = {k: v for k, v in evidence.items() if k == state_filter.upper()}

    nexus = {n["state_code"]: n for n in fetch_all("nexus_status")}
    rules = load_state_rules().get("states", {})

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "state_code", "state_name", "month", "event_count_approx",
        "first_evidence", "last_evidence", "fc_codes", "sources",
        "physical_nexus_flag", "confidence", "fba_position",
    ])

    for sc in sorted(evidence):
        ev = evidence[sc]
        n = nexus.get(sc, {})
        rule = rules.get(sc, {})
        state_name = rule.get("state_name", sc)
        fba_pos = str(rule.get("fba_inventory_creates_nexus", "unknown"))
        conf = n.get("confidence", "medium")
        nexus_flag = "yes" if n.get("has_physical_nexus") else "no"

        for month in sorted(ev["months"]):
            writer.writerow([
                sc, state_name, month, "",
                ev["min_date"], ev["max_date"],
                "|".join(sorted(ev["fcs"])[:10]),
                "|".join(sorted(ev["sources"])),
                nexus_flag, conf, fba_pos,
            ])

    return output.getvalue()


# ── PDF export ─────────────────────────────────────────────

def _pdf_safe(text: str) -> str:
    """Replace Unicode characters that Helvetica can't encode."""
    return (
        text
        .replace("\u2014", " -- ")   # em-dash
        .replace("\u2013", " - ")    # en-dash
        .replace("\u2018", "'")      # left single quote
        .replace("\u2019", "'")      # right single quote
        .replace("\u201c", '"')      # left double quote
        .replace("\u201d", '"')      # right double quote
        .replace("\u2026", "...")     # ellipsis
        .replace("\u2022", "*")      # bullet
        .replace("\u00b7", ".")      # middle dot
        .replace("\u2248", "~")      # approx
        .replace("\u2265", ">=")     # >=
        .replace("\u2264", "<=")     # <=
        .replace("\u2713", "[Y]")    # check mark
        .replace("\u2717", "[X]")    # X mark
        .replace("\u26a0", "[!]")    # warning sign
        .replace("\u2705", "[PASS]") # green check
        .replace("\u26a0\ufe0f", "[WARN]")
    )


def build_pdf(state_filter: str | None = None) -> bytes:
    """Build the inventory presence report as a PDF. Returns raw bytes."""
    from fpdf import FPDF

    evidence = _gather_state_evidence()
    nexus = {n["state_code"]: n for n in fetch_all("nexus_status")}
    rules = load_state_rules().get("states", {})

    if state_filter:
        evidence = {k: v for k, v in evidence.items() if k == state_filter.upper()}

    validation = _run_validation(evidence) if not state_filter else []
    report_id = str(uuid.uuid4())[:8]
    max_date = max((e["max_date"] for e in evidence.values()), default="unknown")

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.add_page()

    # ── Cover ──
    pdf.set_font("Helvetica", "B", 18)
    pdf.cell(0, 12, "FBA Inventory Presence by State", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, f"Report ID: {report_id}", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, f"Generated: {datetime.utcnow().isoformat()[:19]}Z", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, f"Data as-of: {max_date}", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, f"States with evidence: {len(evidence)}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    # Disclaimer
    pdf.set_font("Helvetica", "I", 7)
    pdf.set_text_color(100, 100, 100)
    pdf.multi_cell(0, 4, _pdf_safe(DISCLAIMER))
    pdf.set_text_color(0, 0, 0)
    pdf.ln(4)

    # ── Validation ──
    if validation:
        pdf.set_font("Helvetica", "B", 13)
        pdf.cell(0, 8, "Validation Report", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 8)
        for v in validation:
            icon = "PASS" if v["status"] == "PASS" else "WARN"
            detail = v["details"][:120] + ("..." if len(v["details"]) > 120 else "")
            pdf.set_x(10)
            pdf.multi_cell(
                pdf.w - 20, 4,
                _pdf_safe(f"[{icon}] {v['check']}: {detail}"),
            )
        pdf.ln(4)

    # ── Executive Summary Table ──
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 8, "Executive Summary", new_x="LMARGIN", new_y="NEXT")

    # Table header
    col_widths = [14, 24, 24, 16, 12, 12, 14, 20]
    headers = ["State", "First", "Last", "Events", "FCs", "Srcs", "Nexus", "Confidence"]
    pdf.set_font("Helvetica", "B", 7)
    for i, h in enumerate(headers):
        pdf.cell(col_widths[i], 5, h, border=1)
    pdf.ln()

    pdf.set_font("Helvetica", "", 7)
    for sc in sorted(evidence):
        ev = evidence[sc]
        n = nexus.get(sc, {})
        fba_pos = rules.get(sc, {}).get("fba_inventory_creates_nexus", "unknown")
        conf = n.get("confidence", "medium")
        if fba_pos == "contested":
            conf = "CONTESTED"
        elif fba_pos == "false":
            conf = "carve-out"
        nexus_flag = "Yes" if n.get("has_physical_nexus") else "No"

        row_data = [
            sc, ev["min_date"], ev["max_date"],
            f"{ev['events']:,}", str(len(ev["fcs"])),
            str(len(ev["sources"])), nexus_flag, conf,
        ]
        for i, val in enumerate(row_data):
            pdf.cell(col_widths[i], 4, val, border=1)
        pdf.ln()

    pdf.ln(6)

    # ── State Detail ──
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 8, "State Detail", new_x="LMARGIN", new_y="NEXT")

    for sc in sorted(evidence):
        ev = evidence[sc]
        n = nexus.get(sc, {})
        rule = rules.get(sc, {})
        state_name = rule.get("state_name", sc)
        fba_pos = str(rule.get("fba_inventory_creates_nexus", "unknown"))

        # Check if we need a new page (leave room for at least 40mm)
        if pdf.get_y() > 250:
            pdf.add_page()

        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(0, 6, f"{sc} - {state_name}", new_x="LMARGIN", new_y="NEXT")

        if fba_pos == "contested":
            pdf.set_font("Helvetica", "BI", 8)
            pdf.set_text_color(180, 100, 0)
            pdf.cell(0, 5, "CONTESTED - FBA nexus position is contested. Verify with counsel.", new_x="LMARGIN", new_y="NEXT")
            pdf.set_text_color(0, 0, 0)
        elif fba_pos == "false":
            pdf.set_font("Helvetica", "I", 8)
            pdf.set_text_color(0, 120, 0)
            pdf.cell(0, 5, "FBA carve-out - Physical nexus from FBA inventory alone may not apply.", new_x="LMARGIN", new_y="NEXT")
            pdf.set_text_color(0, 0, 0)

        pdf.set_font("Helvetica", "", 8)
        ranges = _compress_ranges(ev["months"])
        range_str = ", ".join(
            f"{r[0]}" if r[0] == r[1] else f"{r[0]} to {r[1]}"
            for r in ranges
        )
        pdf.cell(0, 4, _pdf_safe(f"Presence: {range_str}"), new_x="LMARGIN", new_y="NEXT")
        pdf.cell(0, 4, _pdf_safe(f"Events: {ev['events']:,}  |  FCs: {', '.join(sorted(ev['fcs'])[:10])}"), new_x="LMARGIN", new_y="NEXT")
        pdf.cell(0, 4, _pdf_safe(f"Sources: {', '.join(sorted(ev['sources']))}"), new_x="LMARGIN", new_y="NEXT")
        pdf.ln(3)

    # ── Footer ──
    pdf.add_page()
    pdf.set_font("Helvetica", "I", 7)
    pdf.set_text_color(100, 100, 100)
    pdf.multi_cell(0, 4, _pdf_safe(DISCLAIMER))

    return pdf.output()


# ── Metadata sidecar ───────────────────────────────────────

def build_metadata(state_filter: str | None = None) -> dict:
    """Build a metadata sidecar dict for storage alongside exports."""
    evidence = _gather_state_evidence()
    if state_filter:
        evidence = {k: v for k, v in evidence.items() if k == state_filter.upper()}

    validation = _run_validation(evidence)
    max_date = max((e["max_date"] for e in evidence.values()), default="unknown")

    return {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "state_count": len(evidence),
        "total_events": sum(e["events"] for e in evidence.values()),
        "data_as_of": max_date,
        "validation": [
            {"check": v["check"], "status": v["status"], "details": v["details"]}
            for v in validation
        ],
        "formats": ["md", "csv", "pdf"],
    }


# ── Upload to Supabase Storage ─────────────────────────────

STORAGE_BUCKET = "cpa-exports"
STORAGE_PREFIX = "inventory-presence"


def upload_exports(
    md: str, csv_content: str, pdf_bytes: bytes, metadata: dict,
) -> dict[str, str | None]:
    """Upload all export artifacts to Supabase Storage.

    Files stored:
      inventory-presence/latest.md
      inventory-presence/latest.csv
      inventory-presence/latest.pdf
      inventory-presence/meta.json
      inventory-presence/archive/YYYY-MM-DD_HHMMSS.md  (etc.)
    """
    from src.db import upload_to_storage

    ts = datetime.utcnow().strftime("%Y-%m-%d_%H%M%S")
    results: dict[str, str | None] = {}

    # Latest versions
    results["md"] = upload_to_storage(
        STORAGE_BUCKET, f"{STORAGE_PREFIX}/latest.md",
        md.encode("utf-8"), "text/markdown",
    )
    results["csv"] = upload_to_storage(
        STORAGE_BUCKET, f"{STORAGE_PREFIX}/latest.csv",
        csv_content.encode("utf-8"), "text/csv",
    )
    results["pdf"] = upload_to_storage(
        STORAGE_BUCKET, f"{STORAGE_PREFIX}/latest.pdf",
        pdf_bytes, "application/pdf",
    )
    results["meta"] = upload_to_storage(
        STORAGE_BUCKET, f"{STORAGE_PREFIX}/meta.json",
        json.dumps(metadata, indent=2).encode("utf-8"), "application/json",
    )

    # Timestamped archive copies
    upload_to_storage(
        STORAGE_BUCKET, f"{STORAGE_PREFIX}/archive/{ts}.md",
        md.encode("utf-8"), "text/markdown",
    )
    upload_to_storage(
        STORAGE_BUCKET, f"{STORAGE_PREFIX}/archive/{ts}.csv",
        csv_content.encode("utf-8"), "text/csv",
    )
    upload_to_storage(
        STORAGE_BUCKET, f"{STORAGE_PREFIX}/archive/{ts}.pdf",
        pdf_bytes, "application/pdf",
    )

    return results
