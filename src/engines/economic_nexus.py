from __future__ import annotations

from datetime import date, timedelta

from src.db import fetch_all, upsert_rows, log_audit
from src.channels import AMAZON, SHOPIFY, normalize_channel, is_marketplace
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


def _dedup_sales_records(records: list[dict]) -> list[dict]:
    """When multiple sources provide data for the same (state, channel, period),
    keep the one from the best source.

    Priority: amazon_spapi > amazon_custom_combined_tax > other.
    This prevents double-counting when both SP-API and CSV data coexist.
    """
    SOURCE_RANK = {
        "amazon_spapi": 0,
        "amazon_custom_combined_tax": 1,
    }

    best: dict[tuple, dict] = {}
    for rec in records:
        key = (
            rec.get("state_code"),
            rec.get("channel"),
            str(rec.get("period_start")),
            str(rec.get("period_end")),
        )
        existing = best.get(key)
        if existing is None:
            best[key] = rec
        else:
            # Lower rank = better source
            old_rank = SOURCE_RANK.get(existing.get("source", ""), 99)
            new_rank = SOURCE_RANK.get(rec.get("source", ""), 99)
            if new_rank < old_rank:
                best[key] = rec
    return list(best.values())


def _compute_lookback_windows(ref: date) -> dict[str, date]:
    """Return the start date for each threshold-period type.

    Most states use "current_or_prior_calendar_year" which means
    nexus is triggered if the threshold was met in either the
    current calendar year OR the immediately prior calendar year.
    """
    # CT uses a 12-month period ending September 30
    if ref.month >= 10:
        ct_start = date(ref.year - 1, 10, 1)
    else:
        ct_start = date(ref.year - 2, 10, 1)

    return {
        "current_or_prior_calendar_year": date(ref.year - 1, 1, 1),
        "prior_calendar_year":           date(ref.year - 1, 1, 1),
        "prior_12_months":               ref - timedelta(days=365),
        "prior_4_quarters":              ref - timedelta(days=365),
        "12mo_ending_sep30":             ct_start,
    }


def _lookback_start_for_state(
    rule: dict,
    windows: dict[str, date],
) -> date:
    """Return the lookback start date for a specific state's threshold period."""
    period = rule.get("economic_threshold_period", "current_or_prior_calendar_year")
    return windows.get(period, windows["current_or_prior_calendar_year"])


def evaluate_economic_nexus(reference_date: date | None = None) -> dict:
    if reference_date is None:
        reference_date = date.today()

    sales_records = fetch_all("sales_by_state")
    if not sales_records:
        return {"states": [], "message": "No sales data found. Ingest Shopify/Amazon data first."}

    rules_data = load_state_rules()
    state_rules = rules_data.get("states", {})

    # Compute per-period-type lookback boundaries.
    # Most states use "current_or_prior_calendar_year" which means
    # any sales in the current OR prior calendar year can trigger nexus.
    # We load data using the widest window, then apply the state-specific
    # window during threshold evaluation.
    lookback_windows = _compute_lookback_windows(reference_date)
    # For the initial data load, use the most generous window so we
    # never discard records that a state might still count.
    global_lookback_start = min(lookback_windows.values())

    # Deduplicate: prefer amazon_spapi over amazon_custom_combined_tax
    # for the same (state, channel, period) to avoid double-counting.
    sales_records = _dedup_sales_records(sales_records)

    # First pass: bucket every record by state, filtering only by the
    # widest lookback so we don't throw anything away prematurely.
    # We store the period_end alongside each record so the per-state
    # window can be applied in the second pass.
    state_records: dict[str, list[tuple[date | None, dict]]] = {}
    for record in sales_records:
        sc = record.get("state_code")
        if not sc:
            continue

        period_end_str = record.get("period_end")
        if isinstance(period_end_str, str):
            period_end = date.fromisoformat(period_end_str)
        else:
            period_end = period_end_str

        # Global filter: discard records older than ANY state could need
        if period_end and period_end < global_lookback_start:
            continue

        state_records.setdefault(sc, []).append((period_end, record))

    # Second pass: for each state, apply its specific lookback window
    # and accumulate amounts.  The threshold base depends on whether
    # the state counts marketplace-facilitated sales toward the
    # seller's own economic nexus threshold.
    state_sales: dict[str, dict] = {}
    for sc, tagged_records in state_records.items():
        rule = state_rules.get(sc, {})
        state_lookback = _lookback_start_for_state(rule, lookback_windows)
        mp_counts = rule.get("marketplace_sales_count_toward_threshold", True)

        for period_end, record in tagged_records:
            if period_end and period_end < state_lookback:
                continue

            channel = normalize_channel(record.get("channel", "unknown"))

            if sc not in state_sales:
                state_sales[sc] = {
                    # Threshold base: Shopify always counts.
                    # Amazon counts only when mp_counts is true.
                    "threshold_amount": 0.0,
                    "threshold_transactions": 0,
                    # Full totals across all channels (for display).
                    "total_amount": 0.0,
                    "total_transactions": 0,
                    # Per-channel breakdown.
                    "shopify_amount": 0.0,
                    "shopify_transactions": 0,
                    "amazon_amount": 0.0,
                    "amazon_transactions": 0,
                }

            amount = float(record.get("gross_sales", 0) or 0)
            transactions = int(record.get("order_count", 0) or 0)

            # Always accumulate totals and channel breakdown
            state_sales[sc]["total_amount"] += amount
            state_sales[sc]["total_transactions"] += transactions

            if channel == SHOPIFY:
                state_sales[sc]["shopify_amount"] += amount
                state_sales[sc]["shopify_transactions"] += transactions
                # Shopify/direct always counts toward threshold
                state_sales[sc]["threshold_amount"] += amount
                state_sales[sc]["threshold_transactions"] += transactions
            elif channel == AMAZON:
                state_sales[sc]["amazon_amount"] += amount
                state_sales[sc]["amazon_transactions"] += transactions
                # Amazon counts toward threshold only per state rule
                if mp_counts:
                    state_sales[sc]["threshold_amount"] += amount
                    state_sales[sc]["threshold_transactions"] += transactions

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

        # Use threshold_amount for nexus determination (all channels)
        amt = sales["threshold_amount"]
        txns = sales["threshold_transactions"]
        test_type = rule.get("threshold_test_type", "or")  # "or" (default) or "and"

        amount_pct = (amt / threshold_amount * 100) if threshold_amount else 0
        txn_pct = 0
        if threshold_transactions and threshold_transactions > 0:
            txn_pct = (txns / threshold_transactions * 100)

        amount_met = amount_pct >= 100
        txn_met = txn_pct >= 100 if threshold_transactions else False

        if test_type == "and":
            # Both conditions must be met (NY, CT)
            progress_pct = min(amount_pct, txn_pct) if threshold_transactions else amount_pct
            has_economic = amount_met and (txn_met if threshold_transactions else True)
        else:
            # Either condition triggers nexus (most states)
            progress_pct = max(amount_pct, txn_pct)
            has_economic = amount_met or txn_met

        requires_action = False
        action_notes = None

        # Build a clear description of which metric drives the status
        def _metric_summary() -> str:
            parts = [f"${amt:,.0f} / ${threshold_amount:,.0f} ({amount_pct:.0f}%)"]
            if threshold_transactions:
                parts.append(f"{txns} / {threshold_transactions} transactions ({txn_pct:.0f}%)")
            return "; ".join(parts)

        # Check if already registered (suppress "register" language)
        existing_records = fetch_all("nexus_status", {"state_code": state_code})
        existing = existing_records[0] if existing_records else None
        is_registered = existing.get("is_registered") if existing else False

        if has_economic:
            requires_action = not is_registered
            triggers = []
            if amount_met:
                triggers.append(f"sales ${amt:,.0f} >= ${threshold_amount:,.0f}")
            if txn_met:
                triggers.append(f"{txns} transactions >= {threshold_transactions}")
            if is_registered:
                action_notes = (
                    f"{state_code}: Economic nexus exceeded ({'; '.join(triggers)}). "
                    f"Already registered."
                )
            else:
                action_notes = (
                    f"Economic nexus EXCEEDED in {state_code}: {'; '.join(triggers)}. "
                    f"Registration required. Consult CPA."
                )
                alerts_needed.append({
                    "state": state_code,
                    "level": "critical",
                    "message": action_notes,
                })
        elif amount_pct >= warn_pct or (threshold_transactions and txn_pct >= warn_pct):
            action_notes = f"Approaching in {state_code}: {_metric_summary()}."
            if not is_registered:
                alerts_needed.append({
                    "state": state_code,
                    "level": "warning",
                    "message": action_notes,
                })
        elif amount_pct >= caution_pct or (threshold_transactions and txn_pct >= caution_pct):
            action_notes = f"Monitoring {state_code}: {_metric_summary()}"

        # Store dollar-based progress % for the primary display bar.
        # Transaction progress is a separate metric shown in its own bar
        # via the threshold_transactions field.
        nexus_row = {
            "state_code": state_code,
            "has_economic_nexus": has_economic,
            "economic_progress_amount": round(amt, 2),
            "economic_progress_transactions": txns,
            "economic_progress_percent": round(amount_pct, 1),
        }

        if has_economic:
            nexus_row["economic_nexus_since"] = reference_date.isoformat()

        # Preserve physical nexus + registration from existing record
        if existing:
            if existing.get("has_physical_nexus"):
                nexus_row["has_physical_nexus"] = True
                nexus_row["physical_nexus_since"] = existing.get("physical_nexus_since")
                nexus_row["physical_nexus_source"] = existing.get("physical_nexus_source")
            if existing.get("is_registered"):
                nexus_row["is_registered"] = True
                nexus_row["registration_date"] = existing.get("registration_date")
                nexus_row["assigned_frequency"] = existing.get("assigned_frequency")
                nexus_row["last_filed_through"] = existing.get("last_filed_through")

            # If previously exceeded but not currently: CLEAR the flag.
            # Do not carry forward stale exceedances under rules that
            # may have changed (e.g. transaction test repealed).
            # Note the prior exceedance for CPA review but do not
            # assert ongoing obligation without current evidence.
            if existing.get("has_economic_nexus") and not has_economic:
                since = existing.get("economic_nexus_since", "unknown")
                action_notes = (
                    f"{state_code}: Previously exceeded ({since}) but not "
                    f"currently met under current rules. Current: "
                    f"{_metric_summary()}. Review with CPA whether prior "
                    f"obligation continues."
                )

        if action_notes:
            nexus_row["requires_action"] = requires_action
            nexus_row["action_notes"] = action_notes

        nexus_updates.append(nexus_row)

    if nexus_updates:
        upsert_rows("nexus_status", nexus_updates, on_conflict="state_code")

    def _is_exceeded(sc: str, s: dict) -> bool:
        r = state_rules.get(sc, {})
        ta = r.get("economic_threshold_amount")
        if not ta:
            return False
        tt = r.get("economic_threshold_transactions")
        test = r.get("threshold_test_type", "or")
        amt_met = s["threshold_amount"] >= ta
        txn_met = (s["threshold_transactions"] >= tt) if tt else False
        if test == "and":
            return amt_met and (txn_met if tt else True)
        return amt_met or txn_met

    exceeded = [sc for sc, s in state_sales.items() if _is_exceeded(sc, s)]

    approaching = [sc for sc, s in state_sales.items()
                   if not _is_exceeded(sc, s)
                   and state_rules.get(sc, {}).get("economic_threshold_amount")
                   and max(
                       s["threshold_amount"] / state_rules[sc]["economic_threshold_amount"] * 100,
                       (s["threshold_transactions"] / state_rules[sc]["economic_threshold_transactions"] * 100)
                       if state_rules[sc].get("economic_threshold_transactions") else 0,
                   ) >= warn_pct]

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
                "threshold_amount": round(s["threshold_amount"], 2),
                "threshold_transactions": s["threshold_transactions"],
                "total_amount": round(s["total_amount"], 2),
                "total_transactions": s["total_transactions"],
                "threshold_amount_cfg": state_rules.get(sc, {}).get("economic_threshold_amount"),
                "threshold_transactions_cfg": state_rules.get(sc, {}).get("economic_threshold_transactions"),
                "progress_percent": round(
                    (s["threshold_amount"] / state_rules.get(sc, {}).get("economic_threshold_amount", 1) * 100)
                    if state_rules.get(sc, {}).get("economic_threshold_amount") else 0,
                    1,
                ),
                "progress_txn_percent": round(
                    (s["threshold_transactions"] / state_rules.get(sc, {}).get("economic_threshold_transactions", 1) * 100)
                    if state_rules.get(sc, {}).get("economic_threshold_transactions") else 0,
                    1,
                ),
                "marketplace_included": state_rules.get(sc, {}).get("marketplace_sales_count_toward_threshold", True),
                "shopify_amount": round(s["shopify_amount"], 2),
                "amazon_amount": round(s["amazon_amount"], 2),
            }
            for sc, s in state_sales.items()
            if state_rules.get(sc, {}).get("has_sales_tax", True)
        },
        "disclaimer": "This is a monitoring and research aid, not legal or tax advice. Rules change. Consult a qualified CPA.",
    }
