"""PPC Action Engine — generates ranked recommendations from ads data.

Phase 1: READ + RECOMMEND only. No auto-apply.

Action types (DB `type` → `evidence.action_type` used by the dashboard):
  NEGATE_SEARCH_TERM   → negate_exact     — spend with 0 orders
  HARVEST_SEARCH_TERM  → harvest_exact    — converting + ACOS <= target
  REDUCE_BID           → reduce_bid       — ACOS >> target with enough data
  WASTED_SPEND_ROLLUP  → review_campaign  — top wasted $ by campaign

KEEP IN SYNC WITH `dashboard/src/app/api/ppc/route.ts` (POST action=generate).
That TypeScript copy exists because the dashboard runs serverless and cannot
call Python; both must emit the same thresholds, the same evidence keys and the
same Seller Central wording, because either one may have written the row the
user is reading. Change one, change the other.
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import date, timedelta

from src.db import fetch_all, get_client

log = logging.getLogger(__name__)

# Configurable thresholds (lowered from original to produce actionable recs)
DEFAULT_TARGET_ACOS = 30.0
DEFAULT_LOOKBACK_DAYS = 7
MIN_SPEND_NEGATE = 5.0       # was 15 — too aggressive for small accounts
MIN_SPEND_HARVEST = 3.0
MIN_SPEND_REDUCE = 5.0
MIN_CLICKS_REDUCE = 5
MIN_ORDERS_HARVEST = 1
MIN_WASTE_ROLLUP = 5.0
MAX_WASTE_ROLLUPS = 5
MIN_BID = 0.02


def _usd(n: float) -> str:
    return f"${n:.2f}"


def _aggregate_terms(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """Roll daily search-term rows up to one entry per (term, campaign).

    Thresholds are stated in whole-window dollars ("$5 spend, 0 orders"), so
    scoring each daily row on its own both under-fires — a term bleeding
    $0.50/day for 30 days never trips $5 — and emits a duplicate rec per day.

    (term, campaign) is also exactly the grain of the ads_recommendations
    UNIQUE (type, entity_name, campaign_id); a finer key would make the insert
    fail once a campaign serves one term through two ad groups.
    """
    agg: dict[tuple[str, str], dict] = {}
    for st in rows:
        term = st.get("search_term") or ""
        campaign_id = str(st.get("campaign_id") or "")
        key = (term, campaign_id)
        e = agg.get(key)
        if e is None:
            e = {
                "search_term": term,
                "campaign_id": campaign_id,
                "campaign_name": st.get("campaign_name") or "",
                "ad_group_ids": set(),
                "ad_group_names": set(),
                "match_types": set(),
                "keyword": st.get("keyword") or "",
                "spend": 0.0, "sales": 0.0, "orders": 0, "clicks": 0,
            }
            agg[key] = e
        e["spend"] += float(st.get("spend") or 0)
        e["sales"] += float(st.get("sales_14d") or 0)
        e["orders"] += int(st.get("orders_14d") or 0)
        e["clicks"] += int(st.get("clicks") or 0)
        if st.get("ad_group_id"):
            e["ad_group_ids"].add(str(st["ad_group_id"]))
        if st.get("ad_group_name"):
            e["ad_group_names"].add(str(st["ad_group_name"]))
        if st.get("match_type"):
            e["match_types"].add(str(st["match_type"]).lower())
        if not e["keyword"] and st.get("keyword"):
            e["keyword"] = str(st["keyword"])
    return agg


def _ad_group_phrase(e: dict) -> str:
    """Name the ad group in an instruction, honestly when there are several."""
    names = sorted(n for n in e["ad_group_names"] if n)
    if len(names) == 1:
        return f'ad group "{names[0]}"'
    if len(names) > 1:
        return f"each of the {len(names)} ad groups that served it"
    return "the ad group that served it"


def generate_recommendations(
    target_acos: float = DEFAULT_TARGET_ACOS,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
) -> list[dict]:
    """Generate ranked PPC action recommendations from current DB data.

    Only search-term rows dated within `lookback_days` are considered. Returns
    the recommendations and replaces the open queue in ads_recommendations.
    """
    recs: list[dict] = []

    try:
        search_terms = fetch_all("ads_search_terms_daily")
    except Exception:
        log.exception("Could not read ads_search_terms_daily")
        search_terms = []

    if not search_terms:
        log.warning("No search term data — run ads-sync first")
        return []

    cutoff = (date.today() - timedelta(days=lookback_days)).isoformat()
    in_window = [st for st in search_terms if str(st.get("date") or "") >= cutoff]
    if not in_window:
        log.warning("No search term data inside the %d-day window (since %s)",
                    lookback_days, cutoff)
        return []

    window = {"days": lookback_days, "from": cutoff}
    window_suffix = f" over the last {lookback_days} days"
    agg = _aggregate_terms(in_window)

    for e in agg.values():
        # ACOS is recomputed from window totals — the stored per-row acos column
        # is rounded to 1dp and cannot be summed across days.
        acos = (e["spend"] / e["sales"] * 100) if e["sales"] > 0 else 0.0
        cpc = (e["spend"] / e["clicks"]) if e["clicks"] > 0 else 0.0
        ad_group_id = sorted(e["ad_group_ids"])[0] if e["ad_group_ids"] else ""
        ad_groups = sorted(n for n in e["ad_group_names"] if n)
        match_types = sorted(e["match_types"])
        camp = f'"{e["campaign_name"]}"'
        term = f'"{e["search_term"]}"'
        where = _ad_group_phrase(e)

        # ── P0: NEGATE — spend with 0 orders ──
        if e["spend"] >= MIN_SPEND_NEGATE and e["orders"] == 0:
            recs.append(_make_rec(
                type="NEGATE_SEARCH_TERM",
                priority="P0",
                impact=e["spend"],
                entity_type="search_term",
                entity_name=e["search_term"],
                campaign_name=e["campaign_name"],
                campaign_id=e["campaign_id"],
                ad_group_id=ad_group_id,
                evidence={
                    "action_type": "negate_exact",
                    "why": (f"Spent {_usd(e['spend'])} on {e['clicks']} clicks "
                            f"with 0 orders{window_suffix}."),
                    "spend": round(e["spend"], 2), "orders": 0,
                    "clicks": e["clicks"], "sales": 0, "acos": None,
                    "cpc": round(cpc, 2), "match_types": match_types,
                    "ad_groups": ad_groups, "window": window,
                },
                action=(f"In Campaign Manager, open campaign {camp} → {where} → "
                        f"Negative keywords, and add {term} as a Negative exact keyword. "
                        f"It has spent {_usd(e['spend'])} with 0 orders{window_suffix}."),
            ))

        # ── P1: HARVEST — converting, good ACOS ──
        # Skipped when the term already runs as an exact keyword: nothing left
        # to harvest.
        if (e["orders"] >= MIN_ORDERS_HARVEST and acos > 0 and acos <= target_acos
                and e["spend"] >= MIN_SPEND_HARVEST and "exact" not in e["match_types"]):
            start_bid = round(max(cpc, MIN_BID), 2)
            recs.append(_make_rec(
                type="HARVEST_SEARCH_TERM",
                priority="P1",
                impact=e["sales"],
                entity_type="search_term",
                entity_name=e["search_term"],
                campaign_name=e["campaign_name"],
                campaign_id=e["campaign_id"],
                ad_group_id=ad_group_id,
                evidence={
                    "action_type": "harvest_exact",
                    "why": (f"{e['orders']} order(s) at {acos:.0f}% ACOS on "
                            f"{_usd(e['spend'])} spend (target {target_acos:.0f}%)"
                            f"{window_suffix}."),
                    "spend": round(e["spend"], 2), "orders": e["orders"],
                    "clicks": e["clicks"], "sales": round(e["sales"], 2),
                    "acos": round(acos, 2), "cpc": round(cpc, 2),
                    "suggested_bid": start_bid, "target_acos": target_acos,
                    "match_types": match_types, "ad_groups": ad_groups,
                    "window": window,
                },
                action=(f"Add {term} as an Exact match keyword in campaign {camp} → "
                        f"{where} (or your manual exact campaign), starting near its "
                        f"current CPC of {_usd(start_bid)}. Then add it as a Negative "
                        f"exact in {where}, where it currently serves, so the two do "
                        f"not compete."),
            ))

        # ── P1: REDUCE_BID — ACOS >> target ──
        if (acos > target_acos * 1.5 and e["clicks"] >= MIN_CLICKS_REDUCE
                and e["orders"] > 0 and e["spend"] >= MIN_SPEND_REDUCE):
            savings = round(e["spend"] * (1 - target_acos / max(acos, 1)), 2)
            # Scale the current CPC by how far ACOS overshoots the target.
            new_bid = round(max(cpc * (target_acos / acos), MIN_BID), 2)
            kw = e["keyword"] or e["search_term"]
            recs.append(_make_rec(
                type="REDUCE_BID",
                priority="P1",
                impact=savings,
                entity_type="keyword",
                entity_name=kw,
                campaign_name=e["campaign_name"],
                campaign_id=e["campaign_id"],
                ad_group_id=ad_group_id,
                evidence={
                    "action_type": "reduce_bid",
                    "why": (f"ACOS {acos:.0f}% vs {target_acos:.0f}% target on "
                            f"{_usd(e['spend'])} spend, {e['orders']} order(s), "
                            f"{e['clicks']} clicks{window_suffix}."),
                    "spend": round(e["spend"], 2), "orders": e["orders"],
                    "clicks": e["clicks"], "sales": round(e["sales"], 2),
                    "acos": round(acos, 2), "cpc": round(cpc, 2),
                    "suggested_bid": new_bid, "target_acos": target_acos,
                    "match_types": match_types, "ad_groups": ad_groups,
                    "window": window,
                },
                action=(f"Open campaign {camp} → {where} → Keywords, and lower the bid "
                        f'on "{kw}" from about {_usd(cpc)} to {_usd(new_bid)} to pull it '
                        f"toward the {target_acos:.0f}% ACOS target. Re-check in 7 days "
                        f"before cutting further."),
            ))

    # ── P1: INCREASE_BID — scale confirmed winners ──
    # Sourced from the two-window search-term loop rather than this single
    # window: a term only earns more budget if the short window says it
    # converts under the scale bar AND the long window does not contradict it.
    # Emitted for terms already running as exact (nothing left to harvest) —
    # non-exact winners get a HARVEST card above instead, so the two never
    # collide on the same (type, entity, campaign) key.
    try:
        from src.amazon_ads.search_terms import run_loop
        from src.amazon_ads.strategy import THRESHOLDS as _TH

        loop = run_loop(target_acos=target_acos)
        bump = float(_TH["scale"]["bid_increase_pct"])
        for w in loop["winners"]:
            if "exact" not in w["match_types"]:
                continue  # harvest first; bid up once it is an exact keyword
            cpc = w["cpc"]
            if cpc <= 0:
                continue
            new_bid = round(max(cpc * (1 + bump), MIN_BID), 2)
            kw = w["keyword"] or w["search_term"]
            long_note = ""
            if w.get("long"):
                long_note = (f" Confirmed over {loop['meta']['long_window'][0]}→"
                             f"{loop['meta']['long_window'][1]}: {w['long']['orders']} orders, "
                             f"ACOS {w['long']['acos']}%.")
            recs.append(_make_rec(
                type="INCREASE_BID",
                priority="P1",
                impact=w["sales"],
                entity_type="keyword",
                entity_name=kw,
                campaign_name=w["campaign_name"],
                campaign_id=w["campaign_id"],
                ad_group_id=sorted(w["ad_group_ids"])[0] if w["ad_group_ids"] else "",
                evidence={
                    "action_type": "increase_bid",
                    "why": (f"{w['orders']} orders at {w['acos']:.0f}% ACOS on "
                            f"{_usd(w['spend'])} spend — under the {w['scale_bar']}% scale "
                            f"bar (break-even target {target_acos:.0f}%)."),
                    "spend": round(w["spend"], 2), "orders": w["orders"],
                    "clicks": w["clicks"], "sales": round(w["sales"], 2),
                    "acos": round(w["acos"], 2), "cpc": round(cpc, 2),
                    "suggested_bid": new_bid, "target_acos": target_acos,
                    "scale_bar": w["scale_bar"], "role": w["role"],
                    "match_types": sorted(w["match_types"]),
                    "ad_groups": sorted(w["ad_group_names"]),
                    "short_window": loop["meta"]["short_window"],
                    "long_window": loop["meta"]["long_window"],
                    "long": w.get("long"),
                    "window": window,
                },
                action=(f'Raise the bid on "{kw}" in campaign "{w["campaign_name"]}" from '
                        f"about {_usd(cpc)} to {_usd(new_bid)} (+{bump * 100:.0f}%) to take "
                        f"more of this traffic while it converts under target.{long_note} "
                        f"Re-check ACOS in 7 days."),
            ))
    except Exception:
        log.exception("Winner scaling skipped — search-term loop unavailable")

    # ── P1: ADJUST_TOS_MODIFIER — Top of Search placement efficiency ──
    # Recommendation only, and only when ads_placement_daily has data: an
    # absent or empty table yields zero cards rather than an error or a guess.
    # One card per campaign; the table's UNIQUE (type, entity_name, campaign_id)
    # backs that up.
    try:
        from src.amazon_ads.placement import recommend_tos_modifiers

        tos_cards, tos_meta = recommend_tos_modifiers(target_acos)
        seen_campaigns: set[str] = set()
        for card in tos_cards:
            if card["campaign_id"] in seen_campaigns:
                continue
            seen_campaigns.add(card["campaign_id"])
            recs.append(card)
        if tos_meta.get("available") and not tos_cards:
            log.info("TOS placement: no modifier changes justified (%s)",
                     tos_meta.get("verdicts"))
    except Exception:
        log.exception("TOS placement recommendations skipped")

    # ── P1: WASTED_SPEND_ROLLUP — top campaigns by zero-order spend ──
    campaign_waste: dict[str, dict] = defaultdict(
        lambda: {"spend": 0.0, "terms": 0, "campaign_id": ""})
    for e in agg.values():
        if e["orders"] != 0:
            continue
        w = campaign_waste[e["campaign_name"]]
        w["spend"] += e["spend"]
        w["terms"] += 1
        w["campaign_id"] = w["campaign_id"] or e["campaign_id"]
    top_waste = sorted(campaign_waste.items(), key=lambda x: -x[1]["spend"])[:MAX_WASTE_ROLLUPS]
    for name, w in top_waste:
        if w["spend"] < MIN_WASTE_ROLLUP:
            continue
        recs.append(_make_rec(
            type="WASTED_SPEND_ROLLUP",
            priority="P1",
            impact=w["spend"],
            entity_type="campaign",
            entity_name=name,
            campaign_name=name,
            campaign_id=w["campaign_id"],
            ad_group_id="",
            evidence={
                "action_type": "review_campaign",
                "why": (f"{_usd(w['spend'])} across {w['terms']} search terms "
                        f"with 0 orders{window_suffix}."),
                "spend": round(w["spend"], 2), "orders": 0,
                "zero_order_terms": w["terms"], "window": window,
            },
            action=(f'Open campaign "{name}" → Search terms report for the last '
                    f"{lookback_days} days, sort by Spend, and add Negative exact "
                    f"keywords for the {w['terms']} terms with 0 orders "
                    f"({_usd(w['spend'])} of wasted spend). The individual P0 rows "
                    f"below list the biggest offenders."),
        ))

    # Sort by priority then $ impact
    priority_order = {"P0": 0, "P1": 1, "P2": 2}
    recs.sort(key=lambda r: (priority_order.get(r["priority"], 9), -r["impact_estimate"]))

    # ── Persist: clear old open recs, insert fresh ──
    _persist(recs)

    return recs


def _persist(recs: list[dict]) -> None:
    """Replace the open queue. Raises if the write fails.

    The delete happens first, so a silent insert failure would leave the user
    with an empty Actions tab and no error — the caller needs to hear about it.
    """
    client = get_client()
    client.table("ads_recommendations").delete().eq("status", "open").execute()
    if not recs:
        return
    payload = []
    for r in recs:
        row = dict(r)
        # evidence is a jsonb column; send the object, not a JSON string.
        if isinstance(row.get("evidence"), str):
            try:
                row["evidence"] = json.loads(row["evidence"])
            except Exception:
                pass
        payload.append(row)
    for i in range(0, len(payload), 500):
        client.table("ads_recommendations").insert(payload[i:i + 500]).execute()


def _make_rec(*, type: str, priority: str, impact: float,
              entity_type: str, entity_name: str, campaign_name: str,
              campaign_id: str, ad_group_id: str, evidence: dict,
              action: str) -> dict:
    return {
        "type": type,
        "priority": priority,
        "impact_estimate": round(impact, 2),
        "entity_type": entity_type,
        "entity_name": entity_name,
        "campaign_name": campaign_name,
        "campaign_id": campaign_id,
        "ad_group_id": ad_group_id or "",
        "evidence": evidence,
        "suggested_action": action,
        "status": "open",
    }
