"""Physical nexus engine — tier-based FBA evaluation.

Tier 1: FBA inventory creates physical nexus for multichannel sellers.
         Register if FBA present + any direct sales into state.
Tier 2: FBA does NOT create nexus when inventory is marketplace-controlled.
         Amazon remits; Shopify must NOT ship from FBA. Economic rules only.
Tier 3: Unsettled — generic inventory nexus, no clear marketplace carve-out.
         Monitor economic thresholds; optional conservative registration.

Always-on:
  MD: home state → always register
  3PL states: physical presence independent of FBA
  CA: $800 franchise tax flag (critical)
  WA: B&O exposure flag
  TX: franchise tax flag (separate from sales tax)
"""
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


# States with physical nexus independent of FBA (home state, 3PL, etc.)
CONFIRMED_PHYSICAL_NEXUS: dict[str, dict] = {
    "MD": {
        "source": "Home state / LLC formation state",
        "since": "2024-01-01",
        "confidence": "high",
        "priority": "P0",
    },
    "OK": {
        "source": "3PL warehouse presence (independent of FBA)",
        "since": "2024-01-01",
        "confidence": "high",
        "priority": "P0",
    },
}

# Entity-level tax flags that fire regardless of sales tax registration strategy
ENTITY_FLAGS = {
    "CA": {
        "flag_type": "franchise_tax",
        "description": "California $800 minimum LLC franchise tax applies if FBA inventory constitutes 'doing business' in CA. Separate from sales tax.",
        "severity": "critical",
        "recommendation": (
            "URGENT: Consult CPA about California $800 minimum LLC franchise tax. "
            "FBA inventory may constitute 'doing business' in CA. This obligation is "
            "separate from sales tax and applies even if Amazon handles tax collection."
        ),
    },
    "WA": {
        "flag_type": "b_and_o_tax",
        "description": "Washington B&O tax exposure if physical or economic presence. Applies to gross receipts, not just sales tax.",
        "severity": "warning",
        "recommendation": "Review WA B&O tax filing obligations with CPA. Applies to gross receipts from WA customers.",
    },
    "TX": {
        "flag_type": "franchise_tax",
        "description": "Texas franchise tax: must FILE No Tax Due Report + Public Information Report annually (due May 15) if TX nexus, even if below ~$2.47M exemption.",
        "severity": "warning",
        "recommendation": "File TX franchise No Tax Due Report + PIR annually (May 15). Failure → forfeiture of right to do business.",
    },
}


def evaluate_physical_nexus() -> dict:
    """Evaluate physical nexus using tier-based FBA analysis.

    Returns dict with nexus determinations, flags, and tier annotations.
    """
    inventory_events = fetch_all("inventory_events", order="event_date")
    if not inventory_events and not CONFIRMED_PHYSICAL_NEXUS:
        return {"states": [], "flags": [], "message": "No inventory events found."}

    rules_data = load_state_rules()
    state_rules = rules_data.get("states", {})

    # Build state presence from FBA inventory events
    state_presence: dict[str, dict] = {}
    for event in inventory_events:
        sc = event.get("state_code")
        if not sc:
            continue

        event_date_str = event.get("event_date")
        event_date = (
            date.fromisoformat(event_date_str)
            if isinstance(event_date_str, str)
            else event_date_str
        )

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

        tier = rule.get("fba_nexus_tier", 0)
        fba_position = str(rule.get("fba_inventory_creates_nexus", "uncertain"))
        tier_note = rule.get("fba_nexus_note", "")
        fc_list = sorted(presence["fc_codes"])

        intel = _get_intelligence_citations(state_code)
        confidence = intel.get("confidence") or ("high" if tier == 1 else "medium")

        # ── Tier-based determination ──
        if fba_position == "true":
            # Tier 1: physical nexus from FBA + direct sales
            creates_nexus = True
            action_notes = (
                f"[Tier {tier}] FBA inventory in {state_code} since "
                f"{presence['first_seen']} (FCs: {fc_list}). "
                f"Physical nexus for multichannel sellers with direct sales. "
                f"Register for direct-channel obligations."
            )
        elif fba_position == "contested":
            # Tier 1 contested (PA)
            creates_nexus = True  # conservative
            confidence = "medium"
            action_notes = (
                f"[Tier {tier} CONTESTED] FBA inventory in {state_code} "
                f"(FCs: {fc_list}). Position contested — do not auto-force "
                f"same treatment as Tier 1 clear states. Confirm with CPA."
            )
        elif fba_position == "false":
            # Tier 2: no physical nexus from FBA
            creates_nexus = False
            action_notes = (
                f"[Tier {tier}] FBA inventory present in {state_code} "
                f"(FCs: {fc_list}), but state has marketplace-controlled "
                f"inventory carve-out. No physical nexus asserted. "
                f"Economic threshold rules still apply. "
                f"Shopify must NOT ship from FBA in this state."
            )
        elif fba_position == "uncertain":
            # Tier 3: uncertain
            creates_nexus = False  # don't force registration
            confidence = "medium"
            action_notes = (
                f"[Tier {tier}] FBA inventory present in {state_code} "
                f"(FCs: {fc_list}). Inventory nexus unsettled — no clear "
                f"marketplace carve-out. Monitor economic thresholds. "
                f"Conservative option: register voluntarily."
            )
        else:
            creates_nexus = False
            action_notes = f"FBA inventory in {state_code}. Position: {fba_position}."

        requires_action = creates_nexus and presence["total_units_in"] > 0

        # Check for new nexus
        existing = None
        existing_records = fetch_all("nexus_status", {"state_code": state_code})
        if existing_records:
            existing = existing_records[0]
        if creates_nexus and presence["total_units_in"] > 0:
            if not existing or not existing.get("has_physical_nexus"):
                new_nexus_states.append(state_code)

        nexus_row = {
            "state_code": state_code,
            "has_physical_nexus": creates_nexus and presence["total_units_in"] > 0,
            "physical_nexus_since": presence["first_seen"].isoformat() if presence["first_seen"] else None,
            "physical_nexus_source": f"FBA inventory: {fc_list} [Tier {tier}]",
            "requires_action": requires_action,
            "action_notes": action_notes,
            "confidence": confidence,
        }

        # Preserve user-set fields
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

        # ── Entity-level flags (fire regardless of sales tax strategy) ──
        if state_code in ENTITY_FLAGS and presence["total_units_in"] > 0:
            ef = ENTITY_FLAGS[state_code]
            franchise_flags.append({
                "state_code": state_code,
                "flag_type": ef["flag_type"],
                "description": ef["description"],
                "severity": ef["severity"],
                "trigger_reason": f"FBA inventory present since {presence['first_seen']}",
                "recommended_action": ef["recommendation"],
                "confidence": "high",
                "status": "open",
            })
        elif rule.get("franchise_tax_notes") and creates_nexus and presence["total_units_in"] > 0:
            franchise_flags.append({
                "state_code": state_code,
                "flag_type": "franchise_tax",
                "description": rule["franchise_tax_notes"],
                "severity": "warning",
                "trigger_reason": f"FBA inventory present since {presence['first_seen']}",
                "recommended_action": f"Review {rule.get('state_name', state_code)} entity-level tax obligations with CPA.",
                "confidence": "medium",
                "status": "open",
            })

    # ── Confirmed physical nexus (home state, 3PL) ──
    already_covered = {u["state_code"] for u in nexus_updates}
    for sc, info in CONFIRMED_PHYSICAL_NEXUS.items():
        rule = state_rules.get(sc, {})
        if not rule.get("has_sales_tax", True):
            continue

        since = info.get("since", date.today().isoformat())
        source = info.get("source", "Confirmed physical presence")
        conf = info.get("confidence", "high")

        if sc in already_covered:
            for u in nexus_updates:
                if u["state_code"] == sc:
                    u["has_physical_nexus"] = True
                    u["confidence"] = conf
                    existing_src = u.get("physical_nexus_source", "")
                    u["physical_nexus_source"] = f"{source}; {existing_src}" if existing_src else source
                    u["requires_action"] = True
                    if not u.get("action_notes") or "[Tier" in u.get("action_notes", ""):
                        u["action_notes"] = f"[P0] {source}. " + (u.get("action_notes") or "")
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
                "action_notes": f"[P0] {source}",
                "confidence": conf,
            }
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

        if rule.get("franchise_tax_notes") and sc not in {f["state_code"] for f in franchise_flags}:
            franchise_flags.append({
                "state_code": sc,
                "flag_type": "franchise_tax",
                "description": rule["franchise_tax_notes"],
                "severity": "critical" if sc in ENTITY_FLAGS else "warning",
                "trigger_reason": source,
                "recommended_action": f"Review {rule.get('state_name', sc)} obligations with CPA.",
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

    # Build return summary with tier info
    tier1_nexus = []
    tier2_carveout = []
    tier3_uncertain = []

    for sc, p in state_presence.items():
        rule = state_rules.get(sc, {})
        tier = rule.get("fba_nexus_tier", 0)
        if tier == 1:
            tier1_nexus.append(sc)
        elif tier == 2:
            tier2_carveout.append(sc)
        elif tier == 3:
            tier3_uncertain.append(sc)

    log_audit(
        action="evaluate_physical_nexus",
        category="nexus_engine",
        details={
            "states_with_inventory": sorted(state_presence.keys()),
            "tier1_nexus": sorted(tier1_nexus),
            "tier2_carveout": sorted(tier2_carveout),
            "tier3_uncertain": sorted(tier3_uncertain),
            "new_nexus_states": new_nexus_states,
            "franchise_flags_created": len(franchise_flags),
        },
    )

    return {
        "states_with_inventory": sorted(state_presence.keys()),
        "new_nexus_states": new_nexus_states,
        "nexus_states": sorted(tier1_nexus),
        "tier1_nexus": sorted(tier1_nexus),
        "tier2_carveout": sorted(tier2_carveout),
        "tier3_uncertain": sorted(tier3_uncertain),
        "franchise_flags": franchise_flags,
        "details": {
            sc: {
                "tier": state_rules.get(sc, {}).get("fba_nexus_tier", 0),
                "first_seen": str(p["first_seen"]),
                "last_seen": str(p["last_seen"]),
                "total_events": p["total_events"],
                "total_units_in": p["total_units_in"],
                "fc_codes": sorted(p["fc_codes"]),
            }
            for sc, p in state_presence.items()
        },
        "disclaimer": (
            "Tier-based FBA nexus analysis per Tallowbourn research memo. "
            "Monitoring aid — not legal or tax advice. Confirm with SALT CPA before registering."
        ),
    }
