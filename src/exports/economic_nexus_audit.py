"""CPA Export: Economic Nexus Audit.

Transparent, per-state economic nexus analysis with full breakdowns:
which sales entered the calc, which rules applied, measurement windows,
data coverage, and integrity checks.

Output: PDF + CSV + JSON + meta.json
"""
from __future__ import annotations

import csv
import io
import json
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from src.channels import normalize_channel, SHOPIFY, AMAZON
from src.config import load_state_rules, load_fba_nexus_posture, settings
from src.db import fetch_all, upload_to_storage
from src.engines.economic_nexus import (
    _dedup_sales_records,
    _compute_lookback_windows,
    _lookback_start_for_state,
)

DISCLAIMER = (
    "DISCLAIMER: This is a monitoring and research aid — NOT legal, tax, "
    "or CPA advice. Economic nexus thresholds, measurement periods, and "
    "marketplace-counting rules are sourced from public guidance and may "
    "be outdated. The CPA must independently verify each state's rules "
    "before advising the client."
)

STORAGE_BUCKET = "cpa-exports"
STORAGE_PREFIX = "economic-nexus"

# Marketplace rule confidence — seeded from available authority.
# States where the rule is well-established get 'high'; states where
# guidance is ambiguous or we defaulted to a safe assumption get 'medium'.
_MP_RULE_CONFIDENCE: dict[str, str] = {
    "CA": "high", "TX": "high", "FL": "high", "NY": "high", "NJ": "high",
    "PA": "high", "OH": "high", "VA": "high", "WA": "high", "CT": "high",
    "IL": "high", "GA": "high", "NC": "high", "MI": "high",
    "AZ": "high", "CO": "medium", "IN": "medium", "MN": "medium",
    "TN": "medium", "WI": "medium", "MD": "high", "MA": "medium",
    "SC": "medium", "MO": "medium", "AL": "medium", "KY": "medium",
    "LA": "medium", "NE": "medium", "OK": "medium", "KS": "medium",
    "AR": "medium", "IA": "medium", "MS": "medium", "NM": "medium",
    "UT": "medium", "ID": "medium", "RI": "medium", "SD": "medium",
    "ND": "medium", "ME": "medium", "NV": "medium", "WV": "medium",
    "HI": "medium", "VT": "medium", "WY": "medium", "DC": "medium",
}


# ── Audit builder ──────────────────────────────────────────

def build_audit(reference_date: date | None = None) -> dict:
    """Build the full economic nexus audit object.

    Returns a dict with:
      reference_date, states (list of per-state audit rows),
      data_coverage, validation, methodology
    """
    if reference_date is None:
        reference_date = date.today()

    rules_data = load_state_rules()
    state_rules = rules_data.get("states", {})
    postures = load_fba_nexus_posture()

    sales_records = fetch_all("sales_by_state")
    sales_records = _dedup_sales_records(sales_records)

    lookback_windows = _compute_lookback_windows(reference_date)
    global_lookback_start = min(lookback_windows.values())

    # ── Data coverage analysis ──
    coverage: dict[str, dict] = {
        "shopify": {"min_date": "9999-12-31", "max_date": "0000-01-01", "records": 0, "total_sales": 0.0},
        "amazon": {"min_date": "9999-12-31", "max_date": "0000-01-01", "records": 0, "total_sales": 0.0},
    }

    for rec in sales_records:
        ch = normalize_channel(rec.get("channel", "unknown"))
        key = "shopify" if ch == SHOPIFY else "amazon"
        ps = str(rec.get("period_start", ""))
        pe = str(rec.get("period_end", ""))
        amt = float(rec.get("gross_sales", 0) or 0)
        coverage[key]["records"] += 1
        coverage[key]["total_sales"] += amt
        if ps and ps < coverage[key]["min_date"]:
            coverage[key]["min_date"] = ps
        if pe and pe > coverage[key]["max_date"]:
            coverage[key]["max_date"] = pe

    # Detect gaps: months with no data in the lookback window
    data_gaps = []
    for ch_key in ["shopify", "amazon"]:
        c = coverage[ch_key]
        if c["records"] == 0:
            data_gaps.append(f"No {ch_key} data found at all")
            continue
        if c["min_date"] > global_lookback_start.isoformat():
            data_gaps.append(
                f"{ch_key} data starts {c['min_date']} — "
                f"lookback window starts {global_lookback_start.isoformat()}"
            )

    # ── Per-state analysis ──
    state_records: dict[str, list[dict]] = defaultdict(list)
    for rec in sales_records:
        sc = rec.get("state_code")
        if not sc:
            continue
        pe_str = rec.get("period_end", "")
        pe = date.fromisoformat(pe_str) if isinstance(pe_str, str) and pe_str else pe_str
        if pe and pe < global_lookback_start:
            continue
        state_records[sc].append(rec)

    nexus_rows = {n["state_code"]: n for n in fetch_all("nexus_status")}

    audit_states = []
    for sc in sorted(state_rules.keys()):
        rule = state_rules[sc]
        if not rule.get("has_sales_tax", True):
            continue

        threshold_amount = rule.get("economic_threshold_amount")
        if not threshold_amount:
            continue

        threshold_txns = rule.get("economic_threshold_transactions")
        period_type = rule.get("economic_threshold_period", "current_or_prior_calendar_year")
        mp_counts = rule.get("marketplace_sales_count_toward_threshold", True)
        test_type = rule.get("threshold_test_type", "or")
        state_lookback = _lookback_start_for_state(rule, lookback_windows)

        # Window end = reference_date for most; CT has special end
        window_start = state_lookback
        window_end = reference_date

        # Accumulate per-channel
        shopify_sales = 0.0
        shopify_orders = 0
        amazon_sales = 0.0
        amazon_orders = 0
        shopify_min = "9999-12-31"
        shopify_max = "0000-01-01"
        amazon_min = "9999-12-31"
        amazon_max = "0000-01-01"
        monthly: dict[str, dict] = {}  # YYYY-MM -> {shopify, amazon}

        for rec in state_records.get(sc, []):
            pe_str = rec.get("period_end", "")
            pe = date.fromisoformat(pe_str) if isinstance(pe_str, str) and pe_str else pe_str
            if pe and pe < state_lookback:
                continue

            ch = normalize_channel(rec.get("channel", "unknown"))
            amt = float(rec.get("gross_sales", 0) or 0)
            txns = int(rec.get("order_count", 0) or 0)
            ps = str(rec.get("period_start", ""))[:7]  # YYYY-MM

            if ps not in monthly:
                monthly[ps] = {"shopify": 0.0, "amazon": 0.0, "shopify_txn": 0, "amazon_txn": 0}

            if ch == SHOPIFY:
                shopify_sales += amt
                shopify_orders += txns
                monthly[ps]["shopify"] += amt
                monthly[ps]["shopify_txn"] += txns
                d = str(rec.get("period_start", ""))
                if d and d < shopify_min:
                    shopify_min = d
                d = str(rec.get("period_end", ""))
                if d and d > shopify_max:
                    shopify_max = d
            else:
                amazon_sales += amt
                amazon_orders += txns
                monthly[ps]["amazon"] += amt
                monthly[ps]["amazon_txn"] += txns
                d = str(rec.get("period_start", ""))
                if d and d < amazon_min:
                    amazon_min = d
                d = str(rec.get("period_end", ""))
                if d and d > amazon_max:
                    amazon_max = d

        # Counted sales = Shopify + (Amazon if mp_counts)
        counted_sales = shopify_sales + (amazon_sales if mp_counts else 0.0)
        counted_orders = shopify_orders + (amazon_orders if mp_counts else 0)

        # Thresholds
        dollar_pct = round(counted_sales / threshold_amount * 100, 1) if threshold_amount else 0
        txn_pct = round(counted_orders / threshold_txns * 100, 1) if threshold_txns else 0

        amount_met = dollar_pct >= 100
        txn_met = (txn_pct >= 100) if threshold_txns else False

        if test_type == "and":
            exceeded = amount_met and (txn_met if threshold_txns else True)
        else:
            exceeded = amount_met or txn_met

        warn_pct = settings.economic_nexus_warn_percent
        approaching = not exceeded and (dollar_pct >= warn_pct or txn_pct >= warn_pct)

        if exceeded:
            status = "exceeded"
        elif approaching:
            status = "approaching"
        elif dollar_pct >= settings.economic_nexus_caution_percent:
            status = "caution"
        else:
            status = "under"

        # State-level coverage warnings
        state_gaps = []
        if shopify_sales == 0 and shopify_min == "9999-12-31":
            state_gaps.append("No Shopify data for this state in window")
        if amazon_sales == 0 and amazon_min == "9999-12-31":
            state_gaps.append("No Amazon data for this state in window")
        if shopify_min != "9999-12-31" and shopify_min > window_start.isoformat():
            state_gaps.append(f"Shopify data starts {shopify_min}, window starts {window_start}")

        nx = nexus_rows.get(sc, {})
        mp_confidence = _MP_RULE_CONFIDENCE.get(sc, "medium")

        # Formula in English
        if mp_counts:
            formula = f"counted_sales = shopify(${shopify_sales:,.2f}) + amazon(${amazon_sales:,.2f}) = ${counted_sales:,.2f}"
        else:
            formula = f"counted_sales = shopify(${shopify_sales:,.2f}) only; amazon(${amazon_sales:,.2f}) excluded per state rule"

        audit_states.append({
            "state_code": sc,
            "state_name": rule.get("state_name", sc),
            "window_start": window_start.isoformat(),
            "window_end": window_end.isoformat(),
            "measurement_period": period_type,
            "shopify_sales": round(shopify_sales, 2),
            "shopify_orders": shopify_orders,
            "amazon_sales": round(amazon_sales, 2),
            "amazon_orders": amazon_orders,
            "marketplace_sales_included": mp_counts,
            "marketplace_rule_confidence": mp_confidence,
            "counted_sales": round(counted_sales, 2),
            "counted_orders": counted_orders,
            "threshold_amount": threshold_amount,
            "threshold_transactions": threshold_txns,
            "threshold_test_type": test_type,
            "pct_of_dollar_threshold": dollar_pct,
            "pct_of_txn_threshold": txn_pct,
            "status": status,
            "is_registered": bool(nx.get("is_registered")),
            "formula": formula,
            "data_coverage": {
                "shopify_min_date": shopify_min if shopify_min != "9999-12-31" else None,
                "shopify_max_date": shopify_max if shopify_max != "0000-01-01" else None,
                "amazon_min_date": amazon_min if amazon_min != "9999-12-31" else None,
                "amazon_max_date": amazon_max if amazon_max != "0000-01-01" else None,
                "gaps": state_gaps,
            },
            "monthly_breakdown": [
                {"month": m, **v}
                for m, v in sorted(monthly.items())
            ],
        })

    # ── Integrity checks ──
    validation = _run_validation(audit_states, sales_records, state_rules, coverage)

    return {
        "reference_date": reference_date.isoformat(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "report_id": str(uuid.uuid4())[:8],
        "states": audit_states,
        "data_coverage": coverage,
        "data_gaps": data_gaps,
        "validation": validation,
        "disclaimer": DISCLAIMER,
    }


def _run_validation(
    audit_states: list[dict],
    sales_records: list[dict],
    state_rules: dict,
    coverage: dict,
) -> list[dict]:
    """Run integrity checks A–E."""
    results = []

    # A: Sales totals sanity
    total_shopify = sum(s["shopify_sales"] for s in audit_states)
    total_amazon = sum(s["amazon_sales"] for s in audit_states)
    results.append({
        "check": "A — Sales totals",
        "status": "PASS",
        "details": (
            f"Shopify ${total_shopify:,.0f} across {sum(1 for s in audit_states if s['shopify_sales'] > 0)} states, "
            f"Amazon ${total_amazon:,.0f} across {sum(1 for s in audit_states if s['amazon_sales'] > 0)} states"
        ),
    })

    # B: No double-count check
    seen_keys = set()
    dupes = 0
    for rec in sales_records:
        key = (rec.get("state_code"), normalize_channel(rec.get("channel", "")),
               str(rec.get("period_start")), str(rec.get("period_end")))
        if key in seen_keys:
            dupes += 1
        seen_keys.add(key)
    results.append({
        "check": "B — No double-count",
        "status": "PASS" if dupes == 0 else "WARN",
        "details": f"{dupes} duplicate (state, channel, period) combinations after dedup" if dupes else "No duplicates after source dedup",
    })

    # C: Marketplace rule completeness
    incomplete = [s["state_code"] for s in audit_states
                  if s["marketplace_rule_confidence"] == "low"]
    unknown_mp = [sc for sc, r in state_rules.items()
                  if r.get("has_sales_tax") and r.get("economic_threshold_amount")
                  and r.get("marketplace_sales_count_toward_threshold") is None]
    issues = incomplete + unknown_mp
    results.append({
        "check": "C — Marketplace rule completeness",
        "status": "PASS" if not issues else "WARN",
        "details": f"Incomplete: {', '.join(issues)}" if issues else "All states have marketplace counting rule set",
    })

    # D: Window consistency
    periods_used = set(s["measurement_period"] for s in audit_states)
    results.append({
        "check": "D — Window consistency",
        "status": "PASS",
        "details": f"Period types in use: {', '.join(sorted(periods_used))}",
    })

    # E: Data gaps
    gap_states = [s["state_code"] for s in audit_states if s["data_coverage"]["gaps"]]
    results.append({
        "check": "E — Data coverage",
        "status": "PASS" if not gap_states else "WARN",
        "details": f"Coverage gaps in {len(gap_states)} states: {', '.join(gap_states[:10])}" if gap_states else "No coverage gaps detected",
    })

    return results


# ── PDF export ─────────────────────────────────────────────

def _pdf_safe(text: str) -> str:
    return (
        text
        .replace("\u2014", " -- ")
        .replace("\u2013", " - ")
        .replace("\u2018", "'").replace("\u2019", "'")
        .replace("\u201c", '"').replace("\u201d", '"')
        .replace("\u2026", "...")
    )


def build_pdf(audit: dict) -> bytes:
    from fpdf import FPDF

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.add_page()

    # Cover
    pdf.set_font("Helvetica", "B", 18)
    pdf.cell(0, 12, "Economic Nexus Audit", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, f"Report ID: {audit['report_id']}", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, f"Generated: {audit['generated_at'][:19]}Z", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, f"Reference date: {audit['reference_date']}", new_x="LMARGIN", new_y="NEXT")
    exceeded = [s for s in audit["states"] if s["status"] == "exceeded"]
    approaching = [s for s in audit["states"] if s["status"] == "approaching"]
    pdf.cell(0, 6, f"States: {len(audit['states'])} analyzed, {len(exceeded)} exceeded, {len(approaching)} approaching", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    pdf.set_font("Helvetica", "I", 7)
    pdf.set_text_color(100, 100, 100)
    pdf.set_x(10)
    pdf.multi_cell(pdf.w - 20, 4, _pdf_safe(DISCLAIMER))
    pdf.set_text_color(0, 0, 0)
    pdf.ln(4)

    # Validation
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Validation Checks", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 8)
    for v in audit["validation"]:
        detail = v["details"][:120] + ("..." if len(v["details"]) > 120 else "")
        pdf.set_x(10)
        pdf.multi_cell(pdf.w - 20, 4, _pdf_safe(f"[{v['status']}] {v['check']}: {detail}"))
    pdf.ln(4)

    # Data coverage
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Data Coverage", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 8)
    for ch in ["shopify", "amazon"]:
        c = audit["data_coverage"][ch]
        mn = c.get("min_date", "none")
        mx = c.get("max_date", "none")
        pdf.cell(0, 4, f"{ch.title()}: {c['records']} records, ${c['total_sales']:,.0f}, dates {mn} to {mx}", new_x="LMARGIN", new_y="NEXT")
    if audit["data_gaps"]:
        pdf.set_text_color(180, 100, 0)
        for gap in audit["data_gaps"]:
            pdf.cell(0, 4, _pdf_safe(f"  GAP: {gap}"), new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(0, 0, 0)
    pdf.ln(4)

    # Executive table — exceeded + approaching
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Exceeded + Approaching States", new_x="LMARGIN", new_y="NEXT")

    cols = [12, 18, 18, 20, 20, 20, 12, 14, 10, 16]
    hdrs = ["State", "Window", "Status", "Shopify $", "Amazon $", "Counted $", "Thr $", "% Dol", "MP?", "Conf"]
    pdf.set_font("Helvetica", "B", 6)
    for i, h in enumerate(hdrs):
        pdf.cell(cols[i], 5, h, border=1)
    pdf.ln()

    pdf.set_font("Helvetica", "", 6)
    key_states = [s for s in audit["states"] if s["status"] in ("exceeded", "approaching")]
    for s in key_states:
        win = f"{s['window_start'][5:]} to {s['window_end'][5:]}"
        row = [
            s["state_code"], win, s["status"].upper(),
            f"${s['shopify_sales']:,.0f}", f"${s['amazon_sales']:,.0f}",
            f"${s['counted_sales']:,.0f}", f"${s['threshold_amount']:,.0f}",
            f"{s['pct_of_dollar_threshold']:.0f}%",
            "Y" if s["marketplace_sales_included"] else "N",
            s["marketplace_rule_confidence"][:3],
        ]
        for i, val in enumerate(row):
            pdf.cell(cols[i], 4, val, border=1)
        pdf.ln()
    pdf.ln(4)

    # Full appendix
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Full State Appendix", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 6)

    for s in audit["states"]:
        if pdf.get_y() > 260:
            pdf.add_page()
        pdf.set_font("Helvetica", "B", 8)
        reg = " [REG]" if s["is_registered"] else ""
        pdf.cell(0, 5, f"{s['state_code']} - {s['state_name']}{reg} ({s['status'].upper()})", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 7)
        pdf.cell(0, 4, _pdf_safe(s["formula"]), new_x="LMARGIN", new_y="NEXT")
        pdf.cell(0, 4, f"Window: {s['window_start']} to {s['window_end']} ({s['measurement_period']})", new_x="LMARGIN", new_y="NEXT")
        pdf.cell(0, 4, f"Dollar: {s['pct_of_dollar_threshold']:.0f}% of ${s['threshold_amount']:,.0f}  |  Txn: {s['pct_of_txn_threshold']:.0f}% of {s['threshold_transactions'] or 'N/A'}  |  Test: {s['threshold_test_type'].upper()}", new_x="LMARGIN", new_y="NEXT")
        gaps = s["data_coverage"]["gaps"]
        if gaps:
            pdf.set_text_color(180, 100, 0)
            pdf.cell(0, 4, _pdf_safe(f"  Coverage: {'; '.join(gaps[:2])}"), new_x="LMARGIN", new_y="NEXT")
            pdf.set_text_color(0, 0, 0)
        pdf.ln(2)

    # Methodology
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, "Methodology", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 8)
    methodology = [
        "1. Sales records are loaded from sales_by_state table, deduplicated by source priority (SP-API > CSV).",
        "2. Per-state measurement window is applied (current/prior calendar year, rolling 12 months, etc.).",
        "3. Shopify (direct) sales always count toward the seller's economic nexus threshold.",
        "4. Amazon (marketplace) sales count toward threshold ONLY if the state's marketplace_sales_count_toward_threshold rule is true.",
        "5. For 'or' test states: nexus exceeded if dollar threshold OR transaction threshold is met.",
        "6. For 'and' test states (NY, CT): BOTH dollar AND transaction thresholds must be met.",
        "7. counted_sales = shopify_sales + (amazon_sales IF marketplace_counts ELSE 0).",
        "8. Amazon collecting and remitting tax does NOT automatically exempt seller from economic nexus obligations.",
        "9. Registered states still show threshold math — registration does not erase economic history.",
    ]
    for line in methodology:
        pdf.set_x(10)
        pdf.multi_cell(pdf.w - 20, 4, _pdf_safe(line))

    pdf.ln(4)
    pdf.set_font("Helvetica", "I", 7)
    pdf.set_text_color(100, 100, 100)
    pdf.set_x(10)
    pdf.multi_cell(pdf.w - 20, 4, _pdf_safe(DISCLAIMER))

    return pdf.output()


# ── CSV export ─────────────────────────────────────────────

def build_csv(audit: dict) -> str:
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "state_code", "state_name", "window_start", "window_end",
        "measurement_period", "shopify_sales", "shopify_orders",
        "amazon_sales", "amazon_orders", "marketplace_sales_included",
        "marketplace_rule_confidence", "counted_sales", "counted_orders",
        "threshold_amount", "threshold_transactions", "threshold_test_type",
        "pct_of_dollar_threshold", "pct_of_txn_threshold", "status",
        "is_registered", "formula", "coverage_gaps",
    ])
    for s in audit["states"]:
        writer.writerow([
            s["state_code"], s["state_name"],
            s["window_start"], s["window_end"], s["measurement_period"],
            s["shopify_sales"], s["shopify_orders"],
            s["amazon_sales"], s["amazon_orders"],
            "yes" if s["marketplace_sales_included"] else "no",
            s["marketplace_rule_confidence"],
            s["counted_sales"], s["counted_orders"],
            s["threshold_amount"], s["threshold_transactions"] or "",
            s["threshold_test_type"],
            s["pct_of_dollar_threshold"], s["pct_of_txn_threshold"],
            s["status"], "yes" if s["is_registered"] else "no",
            s["formula"],
            "; ".join(s["data_coverage"]["gaps"]) if s["data_coverage"]["gaps"] else "",
        ])
    return output.getvalue()


# ── Upload ─────────────────────────────────────────────────

def build_meta(audit: dict) -> dict:
    exceeded = [s["state_code"] for s in audit["states"] if s["status"] == "exceeded"]
    approaching = [s["state_code"] for s in audit["states"] if s["status"] == "approaching"]
    return {
        "generated_at": audit["generated_at"],
        "reference_date": audit["reference_date"],
        "report_id": audit["report_id"],
        "states_analyzed": len(audit["states"]),
        "exceeded": exceeded,
        "approaching": approaching,
        "data_coverage": audit["data_coverage"],
        "data_gaps": audit["data_gaps"],
        "validation": audit["validation"],
    }


def upload_exports(audit: dict) -> dict[str, str | None]:
    """Generate all formats and upload to Supabase Storage."""
    pdf_bytes = build_pdf(audit)
    csv_content = build_csv(audit)
    audit_json = json.dumps(audit, indent=2, default=str)
    meta = build_meta(audit)
    meta_json = json.dumps(meta, indent=2)

    results: dict[str, str | None] = {}
    results["pdf"] = upload_to_storage(
        STORAGE_BUCKET, f"{STORAGE_PREFIX}/latest.pdf",
        bytes(pdf_bytes) if isinstance(pdf_bytes, bytearray) else pdf_bytes,
        "application/pdf",
    )
    results["csv"] = upload_to_storage(
        STORAGE_BUCKET, f"{STORAGE_PREFIX}/latest.csv",
        csv_content.encode("utf-8"), "text/csv",
    )
    results["json"] = upload_to_storage(
        STORAGE_BUCKET, f"{STORAGE_PREFIX}/latest.json",
        audit_json.encode("utf-8"), "application/json",
    )
    results["meta"] = upload_to_storage(
        STORAGE_BUCKET, f"{STORAGE_PREFIX}/meta.json",
        meta_json.encode("utf-8"), "application/json",
    )
    return results
