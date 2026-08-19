"""PPC Action Engine — generates ranked recommendations from ads data.

Phase 1: READ + RECOMMEND only.  No auto-apply.

Action types:
  NEGATE_SEARCH_TERM — high spend, 0 orders
  HARVEST_SEARCH_TERM — converting search terms → exact keyword
  REDUCE_BID — keywords with ACOS >> target
  INCREASE_BID — winners under-served (ACOS < target, limited budget)
  STARVE_OOS — campaigns on ASINs with low inventory
  WASTED_SPEND_ROLLUP — top wasted $ summary
"""
from __future__ import annotations

import json
import logging
from datetime import date
from collections import defaultdict

from src.db import fetch_all, upsert_rows

log = logging.getLogger(__name__)

# Defaults (overridable via ads_settings table or config)
DEFAULT_TARGET_ACOS = 30.0  # %
MIN_SPEND_NEGATE = 15.0
MIN_SPEND_HARVEST = 5.0
MIN_CLICKS_REDUCE = 10
MIN_ORDERS_HARVEST = 2


def generate_recommendations(
    target_acos: float = DEFAULT_TARGET_ACOS,
    lookback_days: int = 14,
) -> list[dict]:
    """Generate ranked PPC action recommendations."""
    recs: list[dict] = []

    try:
        search_terms = fetch_all("ads_search_terms_daily")
    except Exception:
        search_terms = []

    try:
        campaigns = fetch_all("ads_campaigns_daily")
    except Exception:
        campaigns = []

    # Inventory for OOS check
    try:
        snaps = {r["sku"]: r for r in fetch_all("inventory_snapshots")}
    except Exception:
        snaps = {}

    if not search_terms and not campaigns:
        return []

    # ── NEGATE_SEARCH_TERM: high spend, 0 orders ──
    for st in search_terms:
        spend = float(st.get("spend", 0) or 0)
        orders = int(st.get("orders_14d", 0) or 0)
        if spend >= MIN_SPEND_NEGATE and orders == 0:
            recs.append({
                "type": "NEGATE_SEARCH_TERM",
                "priority": "P0",
                "impact_estimate": round(spend, 2),
                "entity_type": "search_term",
                "entity_name": st.get("search_term", ""),
                "campaign_name": st.get("campaign_name", ""),
                "campaign_id": st.get("campaign_id", ""),
                "ad_group_id": st.get("ad_group_id", ""),
                "evidence": {
                    "spend": spend,
                    "orders": orders,
                    "clicks": int(st.get("clicks", 0) or 0),
                    "window_days": lookback_days,
                },
                "suggested_action": f"Add as negative exact in campaign '{st.get('campaign_name', '')}' ad group",
                "status": "open",
            })

    # ── HARVEST_SEARCH_TERM: converting with good ACOS ──
    for st in search_terms:
        orders = int(st.get("orders_14d", 0) or 0)
        acos = float(st.get("acos", 0) or 0)
        spend = float(st.get("spend", 0) or 0)
        match_type = st.get("match_type", "").lower()
        if orders >= MIN_ORDERS_HARVEST and acos <= target_acos and spend >= MIN_SPEND_HARVEST:
            if match_type != "exact":  # already exact → skip
                recs.append({
                    "type": "HARVEST_SEARCH_TERM",
                    "priority": "P1",
                    "impact_estimate": round(float(st.get("sales_14d", 0) or 0), 2),
                    "entity_type": "search_term",
                    "entity_name": st.get("search_term", ""),
                    "campaign_name": st.get("campaign_name", ""),
                    "campaign_id": st.get("campaign_id", ""),
                    "evidence": {
                        "spend": spend,
                        "orders": orders,
                        "acos": acos,
                        "sales_14d": float(st.get("sales_14d", 0) or 0),
                        "match_type": match_type,
                    },
                    "suggested_action": f"Add '{st.get('search_term', '')}' as exact keyword in dedicated exact ad group",
                    "status": "open",
                })

    # ── REDUCE_BID / WASTED_SPEND: keywords with ACOS >> target ──
    for st in search_terms:
        acos = float(st.get("acos", 0) or 0)
        spend = float(st.get("spend", 0) or 0)
        clicks = int(st.get("clicks", 0) or 0)
        orders = int(st.get("orders_14d", 0) or 0)
        if acos > target_acos * 2 and clicks >= MIN_CLICKS_REDUCE and spend >= 10:
            recs.append({
                "type": "REDUCE_BID",
                "priority": "P1",
                "impact_estimate": round(spend * (1 - target_acos / max(acos, 1)), 2),
                "entity_type": "keyword",
                "entity_name": st.get("keyword") or st.get("search_term", ""),
                "campaign_name": st.get("campaign_name", ""),
                "campaign_id": st.get("campaign_id", ""),
                "evidence": {
                    "spend": spend, "acos": acos,
                    "orders": orders, "clicks": clicks,
                    "target_acos": target_acos,
                },
                "suggested_action": f"Reduce bid on keyword '{st.get('keyword', '')}' (ACOS {acos:.0f}% vs target {target_acos:.0f}%)",
                "status": "open",
            })

    # ── WASTED_SPEND_ROLLUP: top campaigns by wasted $ ──
    campaign_waste: dict[str, float] = defaultdict(float)
    for st in search_terms:
        orders = int(st.get("orders_14d", 0) or 0)
        if orders == 0:
            campaign_waste[st.get("campaign_name", "")] += float(st.get("spend", 0) or 0)
    for name, waste in sorted(campaign_waste.items(), key=lambda x: -x[1])[:5]:
        if waste >= 10:
            recs.append({
                "type": "WASTED_SPEND_ROLLUP",
                "priority": "P1",
                "impact_estimate": round(waste, 2),
                "entity_type": "campaign",
                "entity_name": name,
                "campaign_name": name,
                "evidence": {"wasted_spend": waste, "window_days": lookback_days},
                "suggested_action": f"Review campaign '{name}' — ${waste:.0f} spent with 0 orders on non-converting terms",
                "status": "open",
            })

    # Sort by priority then impact
    priority_order = {"P0": 0, "P1": 1, "P2": 2}
    recs.sort(key=lambda r: (priority_order.get(r["priority"], 9), -r["impact_estimate"]))

    # Persist to ads_recommendations
    if recs:
        for r in recs:
            r["evidence"] = json.dumps(r["evidence"])
        try:
            upsert_rows("ads_recommendations", recs,
                         on_conflict="type,entity_name,campaign_id")
        except Exception as e:
            log.warning("Failed to persist recommendations: %s", e)
            # Restore evidence to dict for return
            for r in recs:
                if isinstance(r["evidence"], str):
                    r["evidence"] = json.loads(r["evidence"])

    return recs
