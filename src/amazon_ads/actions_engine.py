"""PPC Action Engine — generates ranked recommendations from ads data.

Phase 1: READ + RECOMMEND only. No auto-apply.

Action types:
  NEGATE_SEARCH_TERM — spend with 0 orders → add negative exact
  HARVEST_SEARCH_TERM — converting + ACOS <= target → exact keyword
  REDUCE_BID — ACOS >> target with sufficient data
  WASTED_SPEND_ROLLUP — top wasted $ by campaign
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict

from src.db import fetch_all, get_client

log = logging.getLogger(__name__)

# Configurable thresholds (lowered from original to produce actionable recs)
DEFAULT_TARGET_ACOS = 30.0
MIN_SPEND_NEGATE = 5.0       # was 15 — too aggressive for small accounts
MIN_SPEND_HARVEST = 3.0
MIN_CLICKS_REDUCE = 5
MIN_ORDERS_HARVEST = 1


def generate_recommendations(
    target_acos: float = DEFAULT_TARGET_ACOS,
    lookback_days: int = 14,
) -> list[dict]:
    """Generate ranked PPC action recommendations from current DB data."""
    recs: list[dict] = []

    try:
        search_terms = fetch_all("ads_search_terms_daily")
    except Exception:
        search_terms = []

    if not search_terms:
        return []

    # ── P0: NEGATE — spend with 0 orders ──
    for st in search_terms:
        spend = float(st.get("spend", 0) or 0)
        orders = int(st.get("orders_14d", 0) or 0)
        clicks = int(st.get("clicks", 0) or 0)
        if spend >= MIN_SPEND_NEGATE and orders == 0:
            recs.append(_make_rec(
                type="NEGATE_SEARCH_TERM",
                priority="P0",
                impact=spend,
                entity_name=st.get("search_term", ""),
                campaign_name=st.get("campaign_name", ""),
                campaign_id=st.get("campaign_id", ""),
                ad_group_id=st.get("ad_group_id", ""),
                evidence={"spend": spend, "orders": 0, "clicks": clicks,
                          "window_days": lookback_days},
                action=f"Add negative exact: \"{st.get('search_term', '')}\"",
            ))

    # ── P1: HARVEST — converting, good ACOS ──
    for st in search_terms:
        orders = int(st.get("orders_14d", 0) or 0)
        acos = float(st.get("acos", 0) or 0)
        spend = float(st.get("spend", 0) or 0)
        sales = float(st.get("sales_14d", 0) or 0)
        match_type = (st.get("match_type") or "").lower()
        if orders >= MIN_ORDERS_HARVEST and acos > 0 and acos <= target_acos and spend >= MIN_SPEND_HARVEST:
            if match_type != "exact":
                recs.append(_make_rec(
                    type="HARVEST_SEARCH_TERM",
                    priority="P1",
                    impact=sales,
                    entity_name=st.get("search_term", ""),
                    campaign_name=st.get("campaign_name", ""),
                    campaign_id=st.get("campaign_id", ""),
                    ad_group_id=st.get("ad_group_id", ""),
                    evidence={"spend": spend, "orders": orders, "acos": acos,
                              "sales_14d": sales, "match_type": match_type},
                    action=f"Add exact keyword: \"{st.get('search_term', '')}\" (ACOS {acos:.0f}%, {orders} orders)",
                ))

    # ── P1: REDUCE_BID — ACOS >> target ──
    for st in search_terms:
        acos = float(st.get("acos", 0) or 0)
        spend = float(st.get("spend", 0) or 0)
        clicks = int(st.get("clicks", 0) or 0)
        orders = int(st.get("orders_14d", 0) or 0)
        if acos > target_acos * 1.5 and clicks >= MIN_CLICKS_REDUCE and orders > 0 and spend >= 5:
            savings = round(spend * (1 - target_acos / max(acos, 1)), 2)
            recs.append(_make_rec(
                type="REDUCE_BID",
                priority="P1",
                impact=savings,
                entity_name=st.get("keyword") or st.get("search_term", ""),
                campaign_name=st.get("campaign_name", ""),
                campaign_id=st.get("campaign_id", ""),
                ad_group_id=st.get("ad_group_id", ""),
                evidence={"spend": spend, "acos": acos, "orders": orders,
                          "clicks": clicks, "target_acos": target_acos},
                action=f"Reduce bid: ACOS {acos:.0f}% vs target {target_acos:.0f}% → save ~${savings:.2f}",
            ))

    # ── P1: WASTED_SPEND_ROLLUP ──
    campaign_waste: dict[str, float] = defaultdict(float)
    for st in search_terms:
        if int(st.get("orders_14d", 0) or 0) == 0:
            campaign_waste[st.get("campaign_name", "")] += float(st.get("spend", 0) or 0)
    for name, waste in sorted(campaign_waste.items(), key=lambda x: -x[1])[:5]:
        if waste >= 5:
            recs.append(_make_rec(
                type="WASTED_SPEND_ROLLUP",
                priority="P1",
                impact=waste,
                entity_name=name,
                campaign_name=name,
                campaign_id="",
                ad_group_id="",
                evidence={"wasted_spend": waste, "window_days": lookback_days},
                action=f"Review campaign: ${waste:.0f} on zero-order terms",
            ))

    # Sort by priority then $ impact
    priority_order = {"P0": 0, "P1": 1, "P2": 2}
    recs.sort(key=lambda r: (priority_order.get(r["priority"], 9), -r["impact_estimate"]))

    # ── Persist: clear old open recs, insert fresh ──
    try:
        client = get_client()
        # Delete old open recommendations (replaced by fresh analysis)
        client.table("ads_recommendations").delete().eq("status", "open").execute()
        # Insert new
        if recs:
            for r in recs:
                r["evidence"] = json.dumps(r["evidence"]) if isinstance(r["evidence"], dict) else r["evidence"]
            client.table("ads_recommendations").insert(recs).execute()
    except Exception as e:
        log.warning("Failed to persist recommendations: %s", e)

    # Restore evidence dicts for return
    for r in recs:
        if isinstance(r.get("evidence"), str):
            try:
                r["evidence"] = json.loads(r["evidence"])
            except Exception:
                pass

    return recs


def _make_rec(*, type: str, priority: str, impact: float,
              entity_name: str, campaign_name: str, campaign_id: str,
              ad_group_id: str, evidence: dict, action: str) -> dict:
    return {
        "type": type,
        "priority": priority,
        "impact_estimate": round(impact, 2),
        "entity_type": "search_term" if "SEARCH" in type else "campaign",
        "entity_name": entity_name,
        "campaign_name": campaign_name,
        "campaign_id": campaign_id,
        "ad_group_id": ad_group_id or "",
        "evidence": evidence,
        "suggested_action": action,
        "status": "open",
    }
