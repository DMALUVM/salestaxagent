"""PPC Action Engine — generates ranked recommendations from ads data.

Phase 1: READ + RECOMMEND only. No auto-apply.

Action types (DB `type` → `evidence.action_type` used by the dashboard):
  NEGATE_SEARCH_TERM   → negate_exact     — spend with 0 orders_14d (not Exact KW)
  PAUSE_KEYWORD        → pause_keyword    — Exact KW equals the search term
  REVIEW_SEARCH_TERM   → review_campaign  — stale 0-order; do not apply yet
  HARVEST_SEARCH_TERM  → harvest_exact    — converting + ACOS <= target
  REDUCE_BID           → reduce_bid       — ACOS >> target with enough data
  WASTED_SPEND_ROLLUP  → review_campaign  — top wasted $ by campaign

KEEP IN SYNC WITH `dashboard/src/lib/ppc-actions-generate.ts` (called from
POST /api/ppc action=generate). The dashboard cannot call Python; both must
emit the same closed-day window, orders_14d attribution, pause-vs-negate
lever, and stale-warehouse guard. Change one, change the other.
"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from datetime import date

from src.db import fetch_all, get_client
from src.rules import amazon_as_of, window_start

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

# Search-term orders/sales are Amazon's 14-day click attribution. The card
# must name this field so Dave can pull the same column in the Ads ST report.
ATTRIBUTION_FIELD = "orders_14d"
ATTRIBUTION_NOTE = (
    "Amazon Ads 14-day click attribution from ads_search_terms_daily.orders_14d"
)


def _usd(n: float) -> str:
    return f"${n:.2f}"


def normalize_term(text: str | None) -> str:
    """Same join key the bleeders / rank gate use: trim, lower, collapse space."""
    return " ".join((text or "").strip().lower().split())


def terms_equal(a: str | None, b: str | None) -> bool:
    na, nb = normalize_term(a), normalize_term(b)
    return bool(na) and na == nb


def closed_lookback_window(as_of: date, lookback_days: int) -> dict:
    """Inclusive LA closed-day window of `lookback_days` ending on `as_of`.

    Never uses the machine UTC date. `date.today() - 7` both includes today
    (still accruing) and is one day longer than seven closed days.
    """
    start = window_start(as_of, lookback_days)
    return {
        "start": start.isoformat(),
        "end": as_of.isoformat(),
        "days": lookback_days,
        "as_of": as_of.isoformat(),
        "timezone": "America/Los_Angeles",
        "closed_days_only": True,
        "attribution": ATTRIBUTION_FIELD,
        "attribution_note": ATTRIBUTION_NOTE,
    }


def filter_closed_window(rows: list[dict], start: str, end: str) -> list[dict]:
    """Keep rows whose `date` is inside the inclusive closed window."""
    out: list[dict] = []
    for st in rows:
        d = str(st.get("date") or "")
        if d and start <= d <= end:
            out.append(st)
    return out


def warehouse_freshness(rows: list[dict], expected_end: str) -> dict:
    """ST warehouse coverage vs the closed as-of Dave would pull in Ads."""
    dates = [str(st.get("date")) for st in rows if st.get("date")]
    fresh_through = max(dates) if dates else None
    return {
        "st_fresh_through": fresh_through,
        "st_min": min(dates) if dates else None,
        "st_stale": fresh_through is None or fresh_through < expected_end,
    }


def resolve_zero_order_lever(
    keyword: str | None,
    search_term: str | None,
    match_types: set[str] | list[str] | tuple[str, ...],
) -> str:
    """pause_keyword when Exact KW equals the search term; else negate_exact.

    Negating the query on an Exact campaign whose keyword IS the query is the
    wrong lever — that is a pause. Matches dashboard bleeders resolveBleederAction.
    """
    types = {str(m).lower() for m in (match_types or [])}
    if "exact" in types and terms_equal(keyword, search_term):
        return "pause_keyword"
    return "negate_exact"


def sibling_exact_converters(
    agg: dict[tuple[str, str], dict],
    search_term: str,
    campaign_id: str,
) -> list[str]:
    """Other Exact campaigns where this term has in-window orders_14d."""
    key = normalize_term(search_term)
    names: list[str] = []
    for e in agg.values():
        if e["campaign_id"] == campaign_id:
            continue
        if normalize_term(e["search_term"]) != key:
            continue
        if int(e.get("orders") or 0) <= 0:
            continue
        if "exact" not in (e.get("match_types") or set()):
            continue
        if e.get("campaign_name"):
            names.append(str(e["campaign_name"]))
    return sorted(set(names))


def _aggregate_terms(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """Roll daily search-term rows up to one entry per (term, campaign).

    Thresholds are stated in whole-window dollars ("$5 spend, 0 orders_14d"), so
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
                "dates": set(),
                "keyword": st.get("keyword") or "",
                "spend": 0.0, "sales": 0.0, "orders": 0, "clicks": 0,
            }
            agg[key] = e
        e["spend"] += float(st.get("spend") or 0)
        e["sales"] += float(st.get("sales_14d") or 0)
        e["orders"] += int(st.get("orders_14d") or 0)
        e["clicks"] += int(st.get("clicks") or 0)
        if st.get("date"):
            e["dates"].add(str(st["date"]))
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


def _window_phrase(window: dict, freshness: dict) -> str:
    """Named closed-day range Dave can type into the Ads ST report."""
    start, end, days = window["start"], window["end"], window["days"]
    phrase = (f" in {start} → {end} ({days} closed days, America/Los_Angeles; "
              f"{ATTRIBUTION_FIELD} attribution)")
    through = freshness.get("st_fresh_through")
    if freshness.get("st_stale"):
        phrase += (f". ST warehouse through {through or 'none'} — Ads may show "
                   f"later orders; do not treat 0 {ATTRIBUTION_FIELD} as gospel")
    elif through and through != end:
        phrase += f". ST warehouse through {through}"
    return phrase


def _scope_phrase(campaign_name: str, ad_group_phrase: str) -> str:
    return f'Campaign "{campaign_name}" · {ad_group_phrase}'


def score_search_term_actions(
    rows: list[dict],
    *,
    target_acos: float = DEFAULT_TARGET_ACOS,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    as_of: date,
    st_fresh_through: str | None = None,
) -> list[dict]:
    """Pure scoring: closed-day window rollup → waste / harvest / reduce / rollup.

    `rows` may be the full warehouse or already window-filtered. Dates outside
    `[window_start(as_of, lookback_days) .. as_of]` are dropped. Today is never
    scored. `st_fresh_through` is the warehouse max date (possibly after as-of);
    when omitted it is taken from `rows`.
    """
    window = closed_lookback_window(as_of, lookback_days)
    freshness = warehouse_freshness(rows, window["end"])
    if st_fresh_through:
        freshness["st_fresh_through"] = st_fresh_through
        freshness["st_stale"] = st_fresh_through < window["end"]
    window = {**window, **freshness}
    window_suffix = _window_phrase(window, freshness)

    in_window = filter_closed_window(rows, window["start"], window["end"])
    if not in_window:
        return []

    agg = _aggregate_terms(in_window)
    recs: list[dict] = []

    for e in agg.values():
        acos = (e["spend"] / e["sales"] * 100) if e["sales"] > 0 else 0.0
        cpc = (e["spend"] / e["clicks"]) if e["clicks"] > 0 else 0.0
        ad_group_id = sorted(e["ad_group_ids"])[0] if e["ad_group_ids"] else ""
        ad_groups = sorted(n for n in e["ad_group_names"] if n)
        match_types = sorted(e["match_types"])
        camp = f'"{e["campaign_name"]}"'
        term = f'"{e["search_term"]}"'
        where = _ad_group_phrase(e)
        scope = _scope_phrase(e["campaign_name"], where)
        dates = e.get("dates") or set()
        term_min = min(dates) if dates else None
        term_max = max(dates) if dates else None
        siblings = sibling_exact_converters(agg, e["search_term"], e["campaign_id"])
        evidence_window = {
            **window,
            "from": window["start"],
            "term_date_min": term_min,
            "term_date_max": term_max,
            "term_days_with_rows": len(dates),
        }

        waste = _zero_order_rec(
            e, acos=acos, cpc=cpc, ad_group_id=ad_group_id,
            ad_groups=ad_groups, match_types=match_types, camp=camp, term=term,
            where=where, scope=scope, window=evidence_window,
            window_suffix=window_suffix, freshness=freshness, siblings=siblings,
        )
        if waste:
            recs.append(waste)

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
                    "why": (f"{e['orders']} order(s)_14d at {acos:.0f}% ACOS on "
                            f"{_usd(e['spend'])} spend (target {target_acos:.0f}%)"
                            f"{window_suffix}. {scope}."),
                    "spend": round(e["spend"], 2), "orders": e["orders"],
                    "clicks": e["clicks"], "sales": round(e["sales"], 2),
                    "acos": round(acos, 2), "cpc": round(cpc, 2),
                    "suggested_bid": start_bid, "target_acos": target_acos,
                    "match_types": match_types, "ad_groups": ad_groups,
                    "window": evidence_window, "verified": not freshness["st_stale"],
                    "attribution": ATTRIBUTION_FIELD,
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
                            f"{_usd(e['spend'])} spend, {e['orders']} order(s)_14d, "
                            f"{e['clicks']} clicks{window_suffix}. {scope}."),
                    "spend": round(e["spend"], 2), "orders": e["orders"],
                    "clicks": e["clicks"], "sales": round(e["sales"], 2),
                    "acos": round(acos, 2), "cpc": round(cpc, 2),
                    "suggested_bid": new_bid,
                    "target_acos": target_acos,
                    "match_types": match_types, "ad_groups": ad_groups,
                    "window": evidence_window, "verified": not freshness["st_stale"],
                    "attribution": ATTRIBUTION_FIELD,
                },
                action=(f"Open campaign {camp} → {where} → Keywords, and lower the bid "
                        f'on "{kw}" from about {_usd(cpc)} to {_usd(new_bid)} to pull it '
                        f"toward the {target_acos:.0f}% ACOS target. Re-check in 7 days "
                        f"before cutting further."),
            ))

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
                        f"with 0 {ATTRIBUTION_FIELD}{window_suffix}."),
                "spend": round(w["spend"], 2), "orders": 0,
                "zero_order_terms": w["terms"], "window": window,
                "verified": not freshness["st_stale"],
                "attribution": ATTRIBUTION_FIELD,
            },
            action=(f'Open campaign "{name}" → Search terms report for '
                    f"{window['start']} → {window['end']} (closed days, "
                    f"America/Los_Angeles), sort by Spend, and review the "
                    f"{w['terms']} terms with 0 {ATTRIBUTION_FIELD} "
                    f"({_usd(w['spend'])} of wasted spend). The individual "
                    f"rows list the biggest offenders — pause Exact KW=term, "
                    f"do not negate those."),
        ))
    return recs


def _zero_order_rec(
    e: dict, *, acos: float, cpc: float, ad_group_id: str,
    ad_groups: list[str], match_types: list[str], camp: str, term: str,
    where: str, scope: str, window: dict, window_suffix: str,
    freshness: dict, siblings: list[str],
) -> dict | None:
    """P0/P1 pause-or-negate, or P2 review when ST is stale. None if no spend."""
    if e["spend"] < MIN_SPEND_NEGATE or e["orders"] != 0:
        return None

    lever = resolve_zero_order_lever(e.get("keyword"), e["search_term"], e["match_types"])
    sibling_note = ""
    if siblings:
        sibling_note = (
            " Converts elsewhere — campaign-scoped only "
            f"(orders_14d on: {', '.join(siblings)})."
        )

    metrics = (f"Spent {_usd(e['spend'])} on {e['clicks']} clicks with "
               f"0 {ATTRIBUTION_FIELD}{window_suffix}. {scope}.{sibling_note}")
    common_ev = {
        "spend": round(e["spend"], 2), "orders": 0,
        "clicks": e["clicks"], "sales": 0, "acos": None,
        "cpc": round(cpc, 2), "match_types": match_types, "ad_groups": ad_groups,
        "window": window, "attribution": ATTRIBUTION_FIELD,
        "keyword": e.get("keyword") or "",
        "converts_elsewhere": bool(siblings),
        "sibling_campaigns": siblings,
        "stale": bool(freshness.get("st_stale")),
        "verified": not freshness.get("st_stale"),
        "st_fresh_through": freshness.get("st_fresh_through"),
    }

    if freshness.get("st_stale"):
        intended = "pause the keyword" if lever == "pause_keyword" else "negate"
        return _make_rec(
            type="REVIEW_SEARCH_TERM",
            priority="P2",
            impact=e["spend"],
            entity_type="search_term",
            entity_name=e["search_term"],
            campaign_name=e["campaign_name"],
            campaign_id=e["campaign_id"],
            ad_group_id=ad_group_id,
            evidence={
                **common_ev,
                "action_type": "review_campaign",
                "intended_lever": lever,
                "why": (f"UNVERIFIED — ST warehouse through "
                        f"{freshness.get('st_fresh_through') or 'none'}, expected "
                        f"closed as-of {window['end']}. {metrics} Refresh "
                        f"ads_search_terms_daily before any "
                        f"{'keyword pause' if lever == 'pause_keyword' else 'negate'}."),
            },
            action=(f"Do not {intended} yet. Search-term warehouse ends "
                    f"{freshness.get('st_fresh_through') or 'none'}; Ads may have "
                    f"later {ATTRIBUTION_FIELD}. Re-run Ads ST sync through "
                    f"{window['end']}, then regenerate. If the refresh still "
                    f"shows 0 {ATTRIBUTION_FIELD} on {window['start']} → "
                    f"{window['end']} in campaign {camp} → {where}, then "
                    + ("pause keyword " + term if lever == "pause_keyword"
                       else "add " + term + " as a Negative exact") + "."),
        )

    if lever == "pause_keyword":
        kw = e.get("keyword") or e["search_term"]
        return _make_rec(
            type="PAUSE_KEYWORD",
            priority="P1" if siblings else "P0",
            impact=e["spend"],
            entity_type="keyword",
            entity_name=kw,
            campaign_name=e["campaign_name"],
            campaign_id=e["campaign_id"],
            ad_group_id=ad_group_id,
            evidence={
                **common_ev,
                "action_type": "pause_keyword",
                "why": (f"{metrics} Exact keyword equals the search term — "
                        f"pause the keyword, do not negate."),
            },
            action=(f"In Campaign Manager, open campaign {camp} → {where} → "
                    f'Keywords, and pause "{kw}". Do not add a Negative exact — '
                    f"this Exact campaign's keyword is the search term. It has "
                    f"spent {_usd(e['spend'])} with 0 {ATTRIBUTION_FIELD}"
                    f"{window_suffix}."),
        )

    return _make_rec(
        type="NEGATE_SEARCH_TERM",
        priority="P1" if siblings else "P0",
        impact=e["spend"],
        entity_type="search_term",
        entity_name=e["search_term"],
        campaign_name=e["campaign_name"],
        campaign_id=e["campaign_id"],
        ad_group_id=ad_group_id,
        evidence={
            **common_ev,
            "action_type": "negate_exact",
            "why": metrics if not siblings else (
                f"{metrics} Negate on this campaign only — the term converts "
                f"on sibling Exact campaigns."),
        },
        action=(f"In Campaign Manager, open campaign {camp} → {where} → "
                f"Negative keywords, and add {term} as a Negative exact keyword. "
                f"It has spent {_usd(e['spend'])} with 0 {ATTRIBUTION_FIELD}"
                f"{window_suffix}."),
    )


def generate_recommendations(
    target_acos: float = DEFAULT_TARGET_ACOS,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
    as_of: date | None = None,
) -> list[dict]:
    """Generate ranked PPC action recommendations from current DB data.

    Only closed LA days in the lookback (ending `amazon_as_of()`) are scored.
    Returns the recommendations and replaces the open queue in ads_recommendations.
    """
    recs: list[dict] = []
    as_of = as_of or amazon_as_of()
    window = closed_lookback_window(as_of, lookback_days)

    try:
        search_terms = fetch_all("ads_search_terms_daily")
    except Exception:
        log.exception("Could not read ads_search_terms_daily")
        search_terms = []

    if not search_terms:
        log.warning("No search term data — run ads-sync first")
        return []

    freshness = warehouse_freshness(search_terms, window["end"])
    in_window = filter_closed_window(search_terms, window["start"], window["end"])
    if not in_window:
        log.warning("No search term data inside the %d closed-day window (%s → %s)",
                    lookback_days, window["start"], window["end"])
        return []

    recs.extend(score_search_term_actions(
        search_terms,
        target_acos=target_acos,
        lookback_days=lookback_days,
        as_of=as_of,
        st_fresh_through=freshness.get("st_fresh_through"),
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

        from src.amazon_ads.organic_rank import (
            apply_rank_policy, fetch_ranks, load_config, lookup,
            POLICY_NEEDS_CHECK,
        )

        loop = run_loop(target_acos=target_acos)
        bump = float(_TH["scale"]["bid_increase_pct"])

        # Organic-rank gate. Amazon's Ads API does not expose SERP rank, so this
        # reads whatever SQP/manual data exists; an absent table simply means
        # every keyword gates as "unknown" and the plan still runs.
        rank_cfg = load_config()
        rank_asin = rank_cfg.get("default_asin") or ""
        ranks = fetch_ranks() if rank_cfg.get("enabled", True) else {}

        for w in loop["winners"]:
            if "exact" not in w["match_types"]:
                continue  # harvest first; bid up once it is an exact keyword
            cpc = w["cpc"]
            if cpc <= 0:
                continue
            proposed_bid = round(max(cpc * (1 + bump), MIN_BID), 2)
            kw = w["keyword"] or w["search_term"]

            # Gate the INCREASE only. Negatives, pauses and bid cuts elsewhere
            # in this engine never consult rank — a query we already rank #1
            # for is a better candidate for cutting paid spend, not a worse one.
            info = lookup(ranks, kw, rank_asin, rank_cfg)
            gate = apply_rank_policy(cpc, proposed_bid, info, rank_cfg)
            new_bid = gate.allowed_bid

            long_note = ""
            if w.get("long"):
                long_note = (f" Confirmed over {loop['meta']['long_window'][0]}→"
                             f"{loop['meta']['long_window'][1]}: {w['long']['orders']} orders, "
                             f"ACOS {w['long']['acos']}%.")
            recs.append(_make_rec(
                type="INCREASE_BID",
                priority="P2" if gate.needs_manual_check else "P1",
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
                    "suggested_bid": new_bid,
                    "proposed_bid_before_rank_gate": proposed_bid,
                    "organic_rank": info.rank,
                    "organic_rank_effective": info.effective_rank,
                    "rank_source": info.source,
                    "rank_as_of": info.as_of,
                    "rank_stale": info.stale,
                    "rank_branded": info.branded,
                    "rank_policy_applied": gate.policy,
                    "cannibalization_risk": gate.risk,
                    "rank_note": gate.note,
                    "needs_rank_check": gate.needs_manual_check,
                    "target_acos": target_acos,
                    "scale_bar": w["scale_bar"], "role": w["role"],
                    "match_types": sorted(w["match_types"]),
                    "ad_groups": sorted(w["ad_group_names"]),
                    "short_window": loop["meta"]["short_window"],
                    "long_window": loop["meta"]["long_window"],
                    "long": w.get("long"),
                    "window": window,
                },
                action=(
                    (f'CHECK ORGANIC RANK before raising "{kw}" in campaign '
                     f'"{w["campaign_name"]}". The plan wanted {_usd(cpc)} → '
                     f"{_usd(proposed_bid)}, but rank is unknown and that is at or "
                     f"above the {_usd(rank_cfg['high_bid_threshold'])} review "
                     f"threshold. Confirm we do not already rank top-3 organically, "
                     f"then raise manually.{long_note}")
                    if gate.needs_manual_check else
                    (f'Raise the bid on "{kw}" in campaign "{w["campaign_name"]}" from '
                     f"about {_usd(cpc)} to {_usd(new_bid)} to take more of this "
                     f"traffic while it converts under target. {gate.note}.{long_note} "
                     f"Re-check ACOS in 7 days.")),
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

    # Sort by priority then $ impact
    priority_order = {"P0": 0, "P1": 1, "P2": 2}
    recs.sort(key=lambda r: (priority_order.get(r["priority"], 9), -r["impact_estimate"]))

    # ── Persist: clear old open recs, insert fresh ──
    _persist(recs)

    # ── Append to the decision log (never deleted) ──
    # The queue above holds only "what to do now"; this records what was
    # recommended on this as-of date, with evidence frozen, so outcomes can be
    # attributed later. Best-effort: a logging failure must not lose the queue.
    try:
        from src.amazon_ads.learning import log_decisions, link_recommendations
        logged = log_decisions(recs)
        if logged.get("logged"):
            link_recommendations()
    except Exception:
        log.exception("Decision logging skipped")

    return recs


#: Lowest number wins when two rules produce the same queue key.
_PRIORITY_RANK = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}


def _dedupe_queue_key(recs: list[dict]) -> tuple[list[dict], list[dict]]:
    """Collapse recs sharing ads_recommendations' UNIQUE key.

    The key is (type, entity_name, campaign_id). Two rules can legitimately
    land on it: REDUCE_BID and INCREASE_BID use the KEYWORD as entity_name, and
    one campaign routinely serves many search terms through a single keyword
    (this account has 69 such (keyword, campaign) pairs, one of them covering
    224 terms). Two qualifying terms would then emit the same row twice.

    Keeps the highest priority, then the largest impact estimate — the version
    of the action worth showing first. Returns (kept, dropped).
    """
    best: dict[tuple[str, str, str], dict] = {}
    dropped: list[dict] = []
    for r in recs:
        key = (str(r.get("type") or ""), str(r.get("entity_name") or ""),
               str(r.get("campaign_id") or ""))
        incumbent = best.get(key)
        if incumbent is None:
            best[key] = r
            continue
        challenger_rank = (_PRIORITY_RANK.get(str(r.get("priority")), 9),
                           -float(r.get("impact_estimate") or 0))
        incumbent_rank = (_PRIORITY_RANK.get(str(incumbent.get("priority")), 9),
                          -float(incumbent.get("impact_estimate") or 0))
        if challenger_rank < incumbent_rank:
            best[key] = r
            dropped.append(incumbent)
        else:
            dropped.append(r)
    return list(best.values()), dropped


def _persist(recs: list[dict]) -> None:
    """Replace the whole queue. Raises if the write fails.

    The queue is rewritten every run, so the clear must be TOTAL. It used to
    delete only `status='open'`, which left applied and dismissed rows behind —
    and the next run re-emitting one of those same actions collided with the
    surviving row:

        duplicate key value violates unique constraint
        "ads_recommendations_type_entity_name_campaign_id_key"

    Clearing everything is safe because the durable history lives in
    ads_action_decisions (with its own key and its own applied/dismissed
    timestamps); this table is only ever "what to do now".

    The delete happens first, so a silent insert failure would leave the user
    with an empty Actions tab and no error — the caller needs to hear about it.
    """
    client = get_client()
    # PostgREST refuses an unfiltered DELETE, so match every row explicitly.
    # One statement, not a per-status pass: a partial clear is what broke this.
    client.table("ads_recommendations").delete().neq(
        "id", "00000000-0000-0000-0000-000000000000").execute()
    if not recs:
        return

    kept, dropped = _dedupe_queue_key(recs)
    if dropped:
        log.warning("Queue dedupe: dropped %d recommendation(s) colliding on "
                    "(type, entity_name, campaign_id); kept the highest priority. "
                    "Examples: %s", len(dropped),
                    [f"{d.get('type')}/{d.get('entity_name')}" for d in dropped[:3]])

    payload = []
    for r in kept:
        row = dict(r)
        # evidence is a jsonb column; send the object, not a JSON string.
        if isinstance(row.get("evidence"), str):
            try:
                row["evidence"] = json.loads(row["evidence"])
            except Exception:
                pass
        payload.append(row)

    # upsert, not insert: the full clear above should make every row new, but a
    # concurrent run (scheduler and a manual CLI overlapping) must degrade to
    # overwriting a row rather than aborting the whole batch.
    for i in range(0, len(payload), 500):
        client.table("ads_recommendations").upsert(
            payload[i:i + 500], on_conflict="type,entity_name,campaign_id").execute()


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
