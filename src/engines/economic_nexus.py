from __future__ import annotations

from datetime import date, timedelta

from src.db import fetch_all, upsert_rows, log_audit
from src.config import load_state_rules, settings


def _get_economic_citations(state_code: str) -> dict:
    """Fetch economic nexus citations from the intelligence layer if available."""
    try:
        from src.intelligence.knowledge_base import query_economic_threshold, build_citation_block
        position = query_economic_threshold(state_code)
        citation_text = build_citation_block(state_code, "economic")
        return {
            "citation_block": citation_text,
            "sources": position.get("primary_sources", []),
            "notes": position.get("notes"),
            "last_reviewed": position.get("last_reviewed"),
        }
    except Exception:
        return {}


def evaluate_economic_nexus(reference_date: date | None = None) -> dict:
    if reference_date is None:
        reference_date = date.today()

    sales_records = fetch_all("sales_by_state")
    if not sales_records:
        return {"states": [], "message": "No sales data found. Ingest Shopify/Amazon data first."}

    rules_data = load_state_rules()
    state_rules = rules_data.get("states", {})

    lookback_start = reference_date - timedelta(days=365)

    state_sales: dict[str, dict] = {}
    for record in sales_records:
        sc = record.get("state_code")
        if not sc:
            continue

        period_end_str = record.get("period_end")
        if isinstance(period_end_str, str):
            period_end = date.fromisoformat(period_end_str)
        else:
            period_end = period_end_str

        if period_end and period_end < lookback_start:
            continue

        channel = record.get("channel", "unknown")
        rule = state_rules.get(sc, {})
        mp_counts = rule.get("marketplace_sales_count_toward_threshold", False)

        if channel == "amazon" and not mp_counts:
            continue

        if sc not in state_sales:
            state_sales[sc] = {
                "total_amount": 0.0,
                "total_transactions": 0,
                "shopify_amount": 0.0,
                "shopify_transactions": 0,
                "amazon_amount": 0.0,
                "amazon_transactions": 0,
            }

        amount = float(record.get("gross_sales", 0) or 0)
        transactions = int(record.get("order_count", 0) or 0)

        state_sales[sc]["total_amount"] += amount
        state_sales[sc]["total_transactions"] += transactions

        if channel == "shopify":
            state_sales[sc]["shopify_amount"] += amount
            state_sales[sc]["shopify_transactions"] += transactions
        elif channel == "amazon":
            state_sales[sc]["amazon_amount"] += amount
            state_sales[sc]["amazon_transactions"] += transactions

    nexus_updates = []
    alerts_needed = []
    warn_pct = settings.economic_nexus_warn_percent
    caution_pct = settings.economic_nexus_caution_percent

    for state_code, sales in state_sales.items():
        rule = state_rules.get(state_code, {})
        if not rule.get("has_sales_tax", True):
            continue

        threshold_amount = rule.get("economic_threshold_amount")
        threshold_transactions = rule.get("economic_threshold_transactions")

        if not threshold_amount:
            continue

        amount_pct = (sales["total_amount"] / threshold_amount * 100) if threshold_amount else 0
        txn_pct = 0
        if threshold_transactions and threshold_transactions > 0:
            txn_pct = (sales["total_transactions"] / threshold_transactions * 100)

        progress_pct = max(amount_pct, txn_pct)
        has_economic = amount_pct >= 100 or txn_pct >= 100

        requires_action = False
        action_notes = None

        if has_economic:
            requires_action = True
            triggers = []
            if amount_pct >= 100:
                triggers.append(f"${sales['total_amount']:,.2f} >= ${threshold_amount:,.0f} threshold")
            if txn_pct >= 100:
                triggers.append(f"{sales['total_transactions']} transactions >= {threshold_transactions} threshold")
            action_notes = (
                f"Economic nexus EXCEEDED in {state_code}: {'; '.join(triggers)}. "
                f"Registration required. Consult CPA for effective date and filing obligations."
            )
            alerts_needed.append({
                "state": state_code,
                "level": "critical",
                "message": action_notes,
            })
        elif progress_pct >= warn_pct:
            action_notes = (
                f"Approaching economic nexus in {state_code}: "
                f"${sales['total_amount']:,.2f} / ${threshold_amount:,.0f} ({amount_pct:.0f}%)"
            )
            if threshold_transactions:
                action_notes += f", {sales['total_transactions']} / {threshold_transactions} transactions ({txn_pct:.0f}%)"
            action_notes += ". Monitor closely."
            alerts_needed.append({
                "state": state_code,
                "level": "warning",
                "message": action_notes,
            })
        elif progress_pct >= caution_pct:
            action_notes = (
                f"Halfway to economic nexus in {state_code}: "
                f"${sales['total_amount']:,.2f} / ${threshold_amount:,.0f} ({amount_pct:.0f}%)"
            )

        nexus_row = {
            "state_code": state_code,
            "has_economic_nexus": has_economic,
            "economic_progress_amount": round(sales["total_amount"], 2),
            "economic_progress_transactions": sales["total_transactions"],
            "economic_progress_percent": round(progress_pct, 1),
        }

        if has_economic:
            nexus_row["economic_nexus_since"] = reference_date.isoformat()

        existing_records = fetch_all("nexus_status", {"state_code": state_code})
        if existing_records:
            existing = existing_records[0]
            if existing.get("has_physical_nexus"):
                nexus_row["has_physical_nexus"] = True
                nexus_row["physical_nexus_since"] = existing.get("physical_nexus_since")
                nexus_row["physical_nexus_source"] = existing.get("physical_nexus_source")
            if existing.get("is_registered"):
                nexus_row["is_registered"] = True
                nexus_row["registration_date"] = existing.get("registration_date")
                nexus_row["assigned_frequency"] = existing.get("assigned_frequency")

            if existing.get("has_economic_nexus") and not has_economic:
                nexus_row["has_economic_nexus"] = True
                nexus_row["economic_nexus_since"] = existing.get("economic_nexus_since")

        if action_notes:
            nexus_row["requires_action"] = True
            nexus_row["action_notes"] = action_notes

        nexus_updates.append(nexus_row)

    if nexus_updates:
        upsert_rows("nexus_status", nexus_updates, on_conflict="state_code")

    exceeded = [sc for sc, s in state_sales.items()
                if state_rules.get(sc, {}).get("economic_threshold_amount")
                and s["total_amount"] >= state_rules[sc]["economic_threshold_amount"]]

    approaching = [sc for sc, s in state_sales.items()
                   if state_rules.get(sc, {}).get("economic_threshold_amount")
                   and s["total_amount"] < state_rules[sc]["economic_threshold_amount"]
                   and (s["total_amount"] / state_rules[sc]["economic_threshold_amount"] * 100) >= warn_pct]

    log_audit(
        action="evaluate_economic_nexus",
        category="nexus_engine",
        details={
            "states_analyzed": sorted(state_sales.keys()),
            "exceeded_threshold": exceeded,
            "approaching_threshold": approaching,
            "reference_date": reference_date.isoformat(),
        },
    )

    citations = {}
    for sc in state_sales:
        intel = _get_economic_citations(sc)
        if intel.get("citation_block"):
            citations[sc] = intel["citation_block"]

    return {
        "states_analyzed": sorted(state_sales.keys()),
        "exceeded_threshold": exceeded,
        "approaching_threshold": approaching,
        "alerts": alerts_needed,
        "citations": citations,
        "details": {
            sc: {
                "total_amount": round(s["total_amount"], 2),
                "total_transactions": s["total_transactions"],
                "threshold_amount": state_rules.get(sc, {}).get("economic_threshold_amount"),
                "threshold_transactions": state_rules.get(sc, {}).get("economic_threshold_transactions"),
                "progress_percent": round(
                    max(
                        (s["total_amount"] / state_rules.get(sc, {}).get("economic_threshold_amount", 1) * 100)
                        if state_rules.get(sc, {}).get("economic_threshold_amount") else 0,
                        (s["total_transactions"] / state_rules.get(sc, {}).get("economic_threshold_transactions", 1) * 100)
                        if state_rules.get(sc, {}).get("economic_threshold_transactions") else 0,
                    ), 1,
                ),
                "marketplace_sales_included": state_rules.get(sc, {}).get("marketplace_sales_count_toward_threshold", False),
                "shopify_amount": round(s["shopify_amount"], 2),
                "amazon_amount": round(s["amazon_amount"], 2),
            }
            for sc, s in state_sales.items()
            if state_rules.get(sc, {}).get("has_sales_tax", True)
        },
        "disclaimer": "This is a monitoring and research aid, not legal or tax advice. Rules change. Consult a qualified CPA.",
    }
