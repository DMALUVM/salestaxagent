"""
Knowledge base query interface for the intelligence layer.

Provides structured queries over nexus rules, court/admin rulings,
franchise rules, and filing rules — always returning citations,
confidence levels, and provenance.
"""
from __future__ import annotations

from datetime import date
from typing import Any

from src.db import fetch_all, fetch_one

DISCLAIMER = (
    "This is a monitoring and research aid, not legal or tax advice. "
    "Rules change. Consult a qualified multi-state tax professional / CPA "
    "before registering, filing, or relying on any position."
)


def query_state_nexus(state_code: str) -> dict:
    """Return all nexus rules, rulings, franchise rules, and filing rules for a state."""
    sc = state_code.upper()

    nexus_rules = fetch_all("nexus_rules", {"state_code": sc, "is_active": True})
    franchise_rules = fetch_all("franchise_entity_rules", {"state_code": sc, "is_active": True})
    filing_rules = fetch_all("filing_rules", {"state_code": sc, "is_active": True})

    court_rulings = _fetch_rulings_for_state("court_rulings", sc)
    admin_rulings = _fetch_rulings_for_state("admin_rulings", sc)

    state_rule = fetch_one("state_rules", {"state_code": sc})

    contested = any(
        r.get("confidence") == "contested" for r in nexus_rules
    )
    has_franchise_risk = bool(franchise_rules)

    return {
        "state_code": sc,
        "state_name": state_rule.get("state_name", sc) if state_rule else sc,
        "has_sales_tax": state_rule.get("has_sales_tax", True) if state_rule else True,
        "nexus_rules": nexus_rules,
        "franchise_entity_rules": franchise_rules,
        "filing_rules": filing_rules,
        "court_rulings": court_rulings,
        "admin_rulings": admin_rulings,
        "has_contested_positions": contested,
        "has_franchise_risk": has_franchise_risk,
        "disclaimer": DISCLAIMER,
    }


def query_fba_nexus_position(state_code: str) -> dict:
    """Return the specific FBA inventory nexus position for a state with full citations."""
    sc = state_code.upper()

    fba_rules = [
        r for r in fetch_all("nexus_rules", {"state_code": sc, "is_active": True})
        if r.get("rule_type") == "physical_inventory_fba"
    ]

    related_rulings = _fetch_rulings_for_state("court_rulings", sc)
    fba_rulings = [
        r for r in related_rulings
        if r.get("relevance_to_fba")
    ]

    admin = _fetch_rulings_for_state("admin_rulings", sc)
    fba_admin = [r for r in admin if r.get("relevance_to_fba")]

    if not fba_rules:
        state_rule = fetch_one("state_rules", {"state_code": sc})
        creates_nexus = state_rule.get("fba_inventory_creates_nexus", True) if state_rule else True
        return {
            "state_code": sc,
            "position": "creates_nexus" if creates_nexus else "unclear",
            "confidence": "medium",
            "summary": f"FBA inventory {'likely creates' if creates_nexus else 'may not create'} nexus in {sc}. "
                       f"No detailed intelligence-layer rule seeded yet.",
            "sources": [],
            "rulings": [],
            "disclaimer": DISCLAIMER,
        }

    rule = fba_rules[0]
    return {
        "state_code": sc,
        "position": _classify_position(rule),
        "confidence": rule.get("confidence", "medium"),
        "summary": rule.get("position_summary", ""),
        "detail": rule.get("position_detail"),
        "conservative_position": rule.get("conservative_position"),
        "aggressive_position": rule.get("aggressive_position"),
        "primary_sources": rule.get("primary_sources", []),
        "secondary_sources": rule.get("secondary_sources", []),
        "rulings": fba_rulings + fba_admin,
        "open_questions": rule.get("open_questions"),
        "last_reviewed": rule.get("last_reviewed"),
        "notes": rule.get("notes"),
        "disclaimer": DISCLAIMER,
    }


def query_economic_threshold(state_code: str) -> dict:
    """Return the economic nexus threshold for a state with citations."""
    sc = state_code.upper()

    econ_rules = [
        r for r in fetch_all("nexus_rules", {"state_code": sc, "is_active": True})
        if r.get("rule_type") == "economic_threshold"
    ]

    state_rule = fetch_one("state_rules", {"state_code": sc})

    if econ_rules:
        rule = econ_rules[0]
        return {
            "state_code": sc,
            "threshold_amount": state_rule.get("economic_threshold_amount") if state_rule else None,
            "threshold_transactions": state_rule.get("economic_threshold_transactions") if state_rule else None,
            "measurement_period": state_rule.get("economic_threshold_period") if state_rule else None,
            "marketplace_sales_count": state_rule.get("marketplace_sales_count_toward_threshold", False) if state_rule else False,
            "confidence": rule.get("confidence", "high"),
            "summary": rule.get("position_summary", ""),
            "primary_sources": rule.get("primary_sources", []),
            "notes": rule.get("notes"),
            "last_reviewed": rule.get("last_reviewed"),
            "disclaimer": DISCLAIMER,
        }

    if state_rule:
        return {
            "state_code": sc,
            "threshold_amount": state_rule.get("economic_threshold_amount"),
            "threshold_transactions": state_rule.get("economic_threshold_transactions"),
            "measurement_period": state_rule.get("economic_threshold_period"),
            "marketplace_sales_count": state_rule.get("marketplace_sales_count_toward_threshold", False),
            "confidence": "medium",
            "summary": f"Economic nexus threshold for {sc} from base state rules (no detailed intelligence-layer citation).",
            "primary_sources": [],
            "notes": state_rule.get("notes"),
            "last_reviewed": state_rule.get("last_reviewed"),
            "disclaimer": DISCLAIMER,
        }

    return {"state_code": sc, "error": "No data available", "disclaimer": DISCLAIMER}


def query_franchise_risk(state_code: str) -> dict:
    """Return franchise/entity tax risks for a state with citations."""
    sc = state_code.upper()
    rules = fetch_all("franchise_entity_rules", {"state_code": sc, "is_active": True})
    related_rulings = [
        r for r in _fetch_rulings_for_state("court_rulings", sc)
        if any(t in (r.get("tax_types_affected") or [])
               for t in ["franchise_tax", "llc_tax", "gross_receipts_tax",
                         "business_occupation_tax", "commercial_activity_tax"])
    ]

    return {
        "state_code": sc,
        "has_franchise_risk": bool(rules),
        "rules": rules,
        "related_rulings": related_rulings,
        "disclaimer": DISCLAIMER,
    }


def search_rulings(query: str, ruling_type: str = "all") -> list[dict]:
    """Search court and admin rulings by keyword in case name, summary, and tags."""
    results = []
    q_lower = query.lower()

    if ruling_type in ("all", "court"):
        court = fetch_all("court_rulings")
        for r in court:
            if _matches_ruling(r, q_lower, "case_name"):
                r["_ruling_type"] = "court"
                results.append(r)

    if ruling_type in ("all", "admin"):
        admin = fetch_all("admin_rulings")
        for r in admin:
            if _matches_ruling(r, q_lower, "title"):
                r["_ruling_type"] = "admin"
                results.append(r)

    return results


def get_all_contested_positions() -> list[dict]:
    """Return all nexus rules with contested confidence for review."""
    rules = fetch_all("nexus_rules", {"confidence": "contested", "is_active": True})
    results = []
    for rule in rules:
        rulings = _fetch_rulings_for_state("court_rulings", rule["state_code"])
        results.append({
            "state_code": rule["state_code"],
            "rule_type": rule["rule_type"],
            "summary": rule.get("position_summary"),
            "conservative": rule.get("conservative_position"),
            "aggressive": rule.get("aggressive_position"),
            "open_questions": rule.get("open_questions"),
            "related_rulings": [r["case_name"] for r in rulings],
            "last_reviewed": rule.get("last_reviewed"),
        })
    return results


def build_citation_block(state_code: str, nexus_type: str = "physical") -> str:
    """Build a human-readable citation block for alerts and reports."""
    sc = state_code.upper()

    if nexus_type == "physical":
        position = query_fba_nexus_position(sc)
    elif nexus_type == "economic":
        position = query_economic_threshold(sc)
    elif nexus_type == "franchise":
        risk = query_franchise_risk(sc)
        if not risk["rules"]:
            return f"[{sc}] No franchise/entity tax rules in knowledge base."
        position = {
            "summary": risk["rules"][0].get("position_summary", ""),
            "primary_sources": risk["rules"][0].get("primary_sources", []),
            "confidence": risk["rules"][0].get("confidence", "medium"),
            "last_reviewed": risk["rules"][0].get("last_reviewed"),
        }
    else:
        return f"[{sc}] Unknown nexus type: {nexus_type}"

    lines = [f"[{sc}] {position.get('summary', 'No summary available.')}"]
    lines.append(f"  Confidence: {position.get('confidence', 'unknown')}")
    lines.append(f"  Last reviewed: {position.get('last_reviewed', 'unknown')}")

    sources = position.get("primary_sources", [])
    if sources:
        lines.append("  Sources:")
        for src in sources[:5]:
            if isinstance(src, dict):
                lines.append(f"    - {src.get('citation', src.get('title', 'N/A'))} "
                             f"({src.get('type', '')})")
            else:
                lines.append(f"    - {src}")

    rulings = position.get("rulings", [])
    if rulings:
        lines.append("  Related rulings:")
        for r in rulings[:3]:
            name = r.get("case_name") or r.get("title", "N/A")
            lines.append(f"    - {name}")

    if position.get("open_questions"):
        lines.append(f"  Open questions: {position['open_questions'][:200]}")

    lines.append(f"  {DISCLAIMER}")
    return "\n".join(lines)


def _fetch_rulings_for_state(table: str, state_code: str) -> list[dict]:
    """Fetch rulings that affect a state (stored as JSON array)."""
    all_rulings = fetch_all(table)
    results = []
    for r in all_rulings:
        affected = r.get("states_affected", [])
        if state_code in affected or "ALL" in affected or "ALL_SST" in affected:
            results.append(r)
    return results


def _classify_position(rule: dict) -> str:
    confidence = rule.get("confidence", "medium")
    if confidence == "contested":
        return "contested"
    summary = (rule.get("position_summary") or "").lower()
    if "does not create" in summary or "insufficient" in summary:
        return "does_not_create_nexus"
    if "creates" in summary or "triggers" in summary:
        return "creates_nexus"
    return "unclear"


def _matches_ruling(ruling: dict, query_lower: str, name_field: str) -> bool:
    searchable = " ".join([
        (ruling.get(name_field) or ""),
        (ruling.get("holding_summary") or ruling.get("summary") or ""),
        (ruling.get("relevance_to_fba") or ""),
        " ".join(ruling.get("tags") or []),
        " ".join(ruling.get("states_affected") or []),
    ]).lower()
    return query_lower in searchable
