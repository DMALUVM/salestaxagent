from __future__ import annotations

from datetime import date

from src.db import fetch_all, upsert_rows, log_audit
from src.config import load_state_rules
from src.models.schema import NexusStatus, FranchiseTaxFlag


def _get_intelligence_citations(state_code: str) -> dict:
    """Fetch citations from the intelligence layer if available."""
    try:
        from src.intelligence.knowledge_base import query_fba_nexus_position, build_citation_block
        position = query_fba_nexus_position(state_code)
        citation_text = build_citation_block(state_code, "physical")
        return {
            "confidence": position.get("confidence", "medium"),
            "citation_block": citation_text,
            "sources": position.get("primary_sources", []),
            "open_questions": position.get("open_questions"),
            "conservative_position": position.get("conservative_position"),
            "aggressive_position": position.get("aggressive_position"),
        }
    except Exception:
        return {}


CONFIRMED_PHYSICAL_NEXUS: dict[str, dict] = {
    "MD": {
        "source": "Home state / LLC formation state",
        "since": "2024-01-01",
        "confidence": "high",
    },
    "OK": {
        "source": "3PL warehouse presence (independent of FBA)",
        "since": "2024-01-01",
        "confidence": "high",
    },
}


def evaluate_physical_nexus() -> dict:
    inventory_events = fetch_all("inventory_events", order="event_date")
    if not inventory_events and not CONFIRMED_PHYSICAL_NEXUS:
        return {"states": [], "flags": [], "message": "No inventory events found. Ingest Amazon data first."}

    rules_data = load_state_rules()
    state_rules = rules_data.get("states", {})

    state_presence: dict[str, dict] = {}
    for event in inventory_events:
        sc = event.get("state_code")
        if not sc:
            continue

        event_date_str = event.get("event_date")
        if isinstance(event_date_str, str):
            event_date = date.fromisoformat(event_date_str)
        else:
            event_date = event_date_str

        if sc not in state_presence:
            state_presence[sc] = {
                "first_seen": event_date,
                "last_seen": event_date,
                "total_events": 0,
                "total_units_in": 0,
                "fc_codes": set(),
            }

        sp = state_presence[sc]
        if event_date and event_date < sp["first_seen"]:
            sp["first_seen"] = event_date
        if event_date and event_date > sp["last_seen"]:
            sp["last_seen"] = event_date
        sp["total_events"] += 1

        qty = event.get("quantity", 0)
        if qty and qty > 0:
            sp["total_units_in"] += qty

        fc = event.get("fc_code")
        if fc:
            sp["fc_codes"].add(fc)

    nexus_updates = []
    franchise_flags = []
    new_nexus_states = []

    for state_code, presence in state_presence.items():
        rule = state_rules.get(state_code, {})

        if not rule.get("has_sales_tax", True):
            continue

        fba_position = str(rule.get("fba_inventory_creates_nexus", "unknown_default_true"))

        # Map the string enum to nexus determination
        # true / unknown_default_true → nexus, high/medium confidence
        # false → no nexus from FBA
        # contested → nexus (conservative) but contested confidence
        # conditional → nexus (conservative) but medium confidence with note
        if fba_position == "false":
            creates_nexus = False
            confidence = "low"
        elif fba_position == "contested":
            creates_nexus = True  # conservative
            confidence = "contested"
        elif fba_position == "conditional":
            creates_nexus = True  # conservative
            confidence = "medium"
        elif fba_position == "true":
            creates_nexus = True
            confidence = "high"
        else:  # unknown_default_true or legacy boolean True
            creates_nexus = fba_position not in ("False", "false")
            confidence = "medium"

        intel = _get_intelligence_citations(state_code)
        if intel.get("confidence"):
            confidence = intel["confidence"]

        action_notes = None
        requires_action = False

        if creates_nexus and presence["total_units_in"] > 0:
            requires_action = True
            fc_list = sorted(presence["fc_codes"])
            action_notes = (
                f"FBA inventory detected in {state_code} since {presence['first_seen']}. "
                f"FCs: {fc_list}. "
            )
            if fba_position == "contested":
                action_notes += (
                    "FBA nexus position is CONTESTED in this state. "
                )
                if intel.get("conservative_position"):
                    action_notes += f"Conservative: {intel['conservative_position'][:120]} "
            elif fba_position == "conditional":
                action_notes += (
                    "FBA nexus is CONDITIONAL — may not apply if marketplace "
                    "facilitator certifies collection. Confirm with CPA."
                )
            elif fba_position == "false":
                # Inventory detected but state has carve-out
                creates_nexus = False
                requires_action = False
                action_notes = (
                    f"FBA inventory present in {state_code} (FCs: {fc_list}), "
                    f"but state has marketplace-facilitator FBA carve-out. "
                    f"Physical nexus not asserted. Amazon remits as facilitator."
                )
            else:
                action_notes += "Physical nexus from FBA inventory."

            existing = None
            existing_records = fetch_all("nexus_status", {"state_code": state_code})
            if existing_records:
                existing = existing_records[0]

            if creates_nexus and (not existing or not existing.get("has_physical_nexus")):
                new_nexus_states.append(state_code)
        elif not creates_nexus and presence["total_units_in"] > 0 and fba_position == "false":
            # Note the carve-out even though no nexus asserted
            action_notes = (
                f"FBA inventory present in {state_code} "
                f"(FCs: {sorted(presence['fc_codes'])}), "
                f"but state has FBA/marketplace carve-out. No physical nexus asserted."
            )

        nexus_row = {
            "state_code": state_code,
            "has_physical_nexus": creates_nexus and presence["total_units_in"] > 0,
            "physical_nexus_since": presence["first_seen"].isoformat() if presence["first_seen"] else None,
            "physical_nexus_source": f"FBA inventory: {sorted(presence['fc_codes'])}",
            "requires_action": requires_action,
            "action_notes": action_notes,
            "confidence": confidence,
        }

        # Preserve registration + compliance + economic fields from existing row.
        # Engine must NEVER overwrite user-set registration or compliance state.
        if not existing:
            existing_records = fetch_all("nexus_status", {"state_code": state_code})
            existing = existing_records[0] if existing_records else None
        if existing:
            for keep_field in (
                "is_registered", "registration_date", "assigned_frequency",
                "last_filed_through", "has_economic_nexus", "economic_nexus_since",
                "economic_progress_amount", "economic_progress_transactions",
                "economic_progress_percent", "compliance_resolved",
                "compliance_resolved_at", "compliance_hidden", "compliance_notes",
            ):
                val = existing.get(keep_field)
                if val is not None:
                    nexus_row[keep_field] = val

        nexus_updates.append(nexus_row)

        franchise_notes = rule.get("franchise_tax_notes")
        if franchise_notes and creates_nexus and presence["total_units_in"] > 0:
            severity = "critical" if state_code in ("CA", "TX") else "warning"
            flag = {
                "state_code": state_code,
                "flag_type": "franchise_tax",
                "description": franchise_notes,
                "severity": severity,
                "trigger_reason": f"FBA inventory present since {presence['first_seen']}",
                "recommended_action": _franchise_recommendation(state_code, rule),
                "confidence": "high" if state_code in ("CA", "TX") else "medium",
                "status": "open",
            }
            franchise_flags.append(flag)

    # Inject confirmed physical nexus (home state, 3PL, etc.)
    # These have nexus independent of FBA inventory data.
    already_covered = {u["state_code"] for u in nexus_updates}
    for sc, info in CONFIRMED_PHYSICAL_NEXUS.items():
        rule = state_rules.get(sc, {})
        if not rule.get("has_sales_tax", True):
            continue

        since = info.get("since", date.today().isoformat())
        source = info.get("source", "Confirmed physical presence")
        conf = info.get("confidence", "high")

        if sc in already_covered:
            # Merge: keep FBA data but ensure has_physical_nexus=True
            for u in nexus_updates:
                if u["state_code"] == sc:
                    u["has_physical_nexus"] = True
                    u["confidence"] = conf
                    existing_src = u.get("physical_nexus_source", "")
                    u["physical_nexus_source"] = f"{source}; {existing_src}" if existing_src else source
                    if not u.get("action_notes"):
                        u["action_notes"] = f"Physical nexus: {source}"
                        u["requires_action"] = True
                    break
        else:
            existing_records = fetch_all("nexus_status", {"state_code": sc})
            existing = existing_records[0] if existing_records else None
            if not existing or not existing.get("has_physical_nexus"):
                new_nexus_states.append(sc)

            confirmed_row = {
                "state_code": sc,
                "has_physical_nexus": True,
                "physical_nexus_since": since,
                "physical_nexus_source": source,
                "requires_action": True,
                "action_notes": f"Physical nexus: {source}",
                "confidence": conf,
            }
            # Preserve registration + compliance + economic fields
            if existing:
                for keep_field in (
                    "is_registered", "registration_date", "assigned_frequency",
                    "last_filed_through", "has_economic_nexus", "economic_nexus_since",
                    "economic_progress_amount", "economic_progress_transactions",
                    "economic_progress_percent", "compliance_resolved",
                    "compliance_resolved_at", "compliance_hidden", "compliance_notes",
                ):
                    val = existing.get(keep_field)
                    if val is not None:
                        confirmed_row[keep_field] = val
            nexus_updates.append(confirmed_row)

        # Check for franchise flags
        franchise_notes = rule.get("franchise_tax_notes")
        if franchise_notes and sc not in {f["state_code"] for f in franchise_flags}:
            severity = "critical" if sc in ("CA", "TX") else "warning"
            franchise_flags.append({
                "state_code": sc,
                "flag_type": "franchise_tax",
                "description": franchise_notes,
                "severity": severity,
                "trigger_reason": source,
                "recommended_action": _franchise_recommendation(sc, rule),
                "confidence": conf,
                "status": "open",
            })

    if nexus_updates:
        upsert_rows("nexus_status", nexus_updates, on_conflict="state_code")

    if franchise_flags:
        for flag in franchise_flags:
            existing = fetch_all("franchise_tax_flags", {
                "state_code": flag["state_code"],
                "flag_type": flag["flag_type"],
            })
            if not existing:
                from src.db import insert_rows
                insert_rows("franchise_tax_flags", [flag])

    log_audit(
        action="evaluate_physical_nexus",
        category="nexus_engine",
        details={
            "states_with_inventory": sorted(state_presence.keys()),
            "new_nexus_states": new_nexus_states,
            "franchise_flags_created": len(franchise_flags),
        },
    )

    citations = {}
    for sc in state_presence:
        intel = _get_intelligence_citations(sc)
        if intel.get("citation_block"):
            citations[sc] = intel["citation_block"]

    return {
        "states_with_inventory": sorted(state_presence.keys()),
        "new_nexus_states": new_nexus_states,
        "nexus_states": sorted(
            sc for sc, p in state_presence.items()
            if str(state_rules.get(sc, {}).get("fba_inventory_creates_nexus", "unknown_default_true"))
               not in ("false", "False")
            and p["total_units_in"] > 0
        ),
        "franchise_flags": franchise_flags,
        "citations": citations,
        "details": {
            sc: {
                "first_seen": str(p["first_seen"]),
                "last_seen": str(p["last_seen"]),
                "total_events": p["total_events"],
                "total_units_in": p["total_units_in"],
                "fc_codes": sorted(p["fc_codes"]),
            }
            for sc, p in state_presence.items()
        },
        "disclaimer": "This is a monitoring and research aid, not legal or tax advice. Rules change. Consult a qualified CPA.",
    }


def _franchise_recommendation(state_code: str, rule: dict) -> str:
    if state_code == "CA":
        return (
            "URGENT: Consult CPA about California $800 minimum LLC franchise tax. "
            "FBA inventory may constitute 'doing business' in CA. This obligation is "
            "separate from sales tax and applies even if Amazon handles tax collection. "
            "Consider whether to register, file, and pay the $800 minimum, or seek "
            "a formal opinion on whether your FBA arrangement triggers it."
        )
    if state_code == "TX":
        return (
            "Review Texas franchise tax obligations. Even if below the ~$2.47M revenue "
            "exemption, you must FILE the No Tax Due report and Public Information Report "
            "annually (due May 15) if you have Texas nexus. Failure to file can result in "
            "forfeiture of right to do business in TX. Consult CPA."
        )
    return f"Review {rule.get('state_name', state_code)} entity-level tax obligations with CPA."
