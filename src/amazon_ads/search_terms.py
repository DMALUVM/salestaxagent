"""Search-term loop: aggregate, classify, and turn into actions.

The GNO-style loop is: let discovery campaigns find terms, then every cycle
promote what converts and cut what does not. This module does the aggregation
and classification; src/amazon_ads/actions_engine.py turns the result into the
evidence-backed cards in the Actions queue.

Two windows, both inclusive and ending on the LA closed-day as-of:
  short (14d) — reacts to what is happening now
  long  (60d) — the confirmation window, so one bad week does not cut a term
                that pays over a full cycle

Classification is against BREAK-EVEN ACOS per SKU (src/amazon_ads/strategy.py),
not a flat target: a $14 3-pack and a $30 bundle do not carry the same ad cost.

Nothing here writes to Amazon. Every output is a recommendation with the
numbers that produced it attached.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date

from src.amazon_ads.strategy import (
    THRESHOLDS, WINDOWS, classify_campaign,
)
from src.rules import amazon_as_of, window_start

log = logging.getLogger(__name__)


def _fetch_terms(start: date, end: date) -> list[dict]:
    """Search-term rows in [start..end], paginated."""
    from src.db import get_client

    client = get_client()
    rows: list[dict] = []
    offset, page_size = 0, 1000
    while True:
        resp = (client.table("ads_search_terms_daily")
                .select("date,search_term,campaign_id,campaign_name,ad_group_id,"
                        "ad_group_name,keyword,match_type,spend,sales_14d,"
                        "orders_14d,clicks,impressions")
                .gte("date", start.isoformat())
                .lte("date", end.isoformat())
                .range(offset, offset + page_size - 1)
                .execute())
        page = resp.data or []
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return rows


def aggregate_terms(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """Roll rows up to one entry per (search_term, campaign_id).

    Same grain as the recommendations table's UNIQUE (type, entity_name,
    campaign_id), so a term can never produce two colliding actions.
    """
    agg: dict[tuple[str, str], dict] = {}
    for r in rows:
        term = r.get("search_term") or ""
        campaign_id = str(r.get("campaign_id") or "")
        if not term:
            continue
        key = (term, campaign_id)
        e = agg.get(key)
        if e is None:
            e = {
                "search_term": term, "campaign_id": campaign_id,
                "campaign_name": r.get("campaign_name") or "",
                "ad_group_ids": set(), "ad_group_names": set(),
                "match_types": set(), "keyword": r.get("keyword") or "",
                "spend": 0.0, "sales": 0.0, "orders": 0,
                "clicks": 0, "impressions": 0,
            }
            agg[key] = e
        e["spend"] += float(r.get("spend") or 0)
        e["sales"] += float(r.get("sales_14d") or 0)
        e["orders"] += int(r.get("orders_14d") or 0)
        e["clicks"] += int(r.get("clicks") or 0)
        e["impressions"] += int(r.get("impressions") or 0)
        if r.get("ad_group_id"):
            e["ad_group_ids"].add(str(r["ad_group_id"]))
        if r.get("ad_group_name"):
            e["ad_group_names"].add(str(r["ad_group_name"]))
        if r.get("match_type"):
            e["match_types"].add(str(r["match_type"]).lower())
        if not e["keyword"] and r.get("keyword"):
            e["keyword"] = str(r["keyword"])

    for e in agg.values():
        e["acos"] = (e["spend"] / e["sales"] * 100) if e["sales"] > 0 else None
        e["cvr"] = (e["orders"] / e["clicks"] * 100) if e["clicks"] else None
        e["cpc"] = (e["spend"] / e["clicks"]) if e["clicks"] else 0.0
        e["role"] = classify_campaign(e["campaign_name"], e["match_types"])
    return agg


def classify(short: dict[tuple[str, str], dict],
             long: dict[tuple[str, str], dict],
             target_acos: float) -> dict[str, list[dict]]:
    """Split terms into winners / losers / watch against break-even.

    A term is judged on the short window and CONFIRMED against the long one:
      winner — converts at or under the scale bar in the short window, and has
               not been a loser over the long window
      loser  — burned money with no orders, or ran far above break-even with
               weak conversion, in BOTH windows where long data exists
      watch  — disagreement between windows; surfaced, never auto-actioned

    Requiring agreement across windows is the point of the long window: it
    stops a single slow week from cutting a term that pays over a cycle.
    """
    cut = THRESHOLDS["cut"]
    scale = THRESHOLDS["scale"]

    winners: list[dict] = []
    losers: list[dict] = []
    watch: list[dict] = []

    scale_bar = target_acos * float(scale["max_acos_pct_of_breakeven"])
    cut_bar = target_acos * float(cut["acos_multiple_of_breakeven"])

    for key, s in short.items():
        l = long.get(key)

        def is_loser(e: dict) -> tuple[bool, str | None]:
            if e["spend"] >= float(cut["min_spend_zero_orders"]) and e["orders"] == 0:
                return True, (f"${e['spend']:.2f} spend, 0 orders "
                              f"over {e['clicks']} clicks")
            if (e["acos"] is not None and e["acos"] > cut_bar
                    and e["clicks"] >= int(cut["min_clicks_for_cvr_judgement"])
                    and (e["cvr"] or 0) < float(cut["weak_cvr_pct"])):
                return True, (f"ACOS {e['acos']:.0f}% vs {cut_bar:.0f}% cut bar "
                              f"with {e['cvr']:.1f}% CVR on {e['clicks']} clicks")
            return False, None

        def is_winner(e: dict) -> tuple[bool, str | None]:
            if (e["orders"] >= int(scale["min_orders"])
                    and e["acos"] is not None and e["acos"] <= scale_bar
                    and e["spend"] >= float(scale["min_spend"])):
                return True, (f"{e['orders']} orders at {e['acos']:.0f}% ACOS "
                              f"(scale bar {scale_bar:.0f}%)")
            return False, None

        s_loser, s_loser_why = is_loser(s)
        s_winner, s_winner_why = is_winner(s)
        l_loser = is_loser(l)[0] if l else None
        l_winner = is_winner(l)[0] if l else None

        record = dict(s)
        record["long"] = {
            "spend": round(l["spend"], 2), "orders": l["orders"],
            "acos": round(l["acos"], 1) if l and l["acos"] is not None else None,
            "clicks": l["clicks"],
        } if l else None
        record["target_acos"] = target_acos
        record["scale_bar"] = round(scale_bar, 1)
        record["cut_bar"] = round(cut_bar, 1)

        if s_loser and (l_loser is None or l_loser):
            record["verdict"] = "loser"
            record["why"] = s_loser_why
            losers.append(record)
        elif s_winner and not l_loser:
            record["verdict"] = "winner"
            record["why"] = s_winner_why
            winners.append(record)
        elif s_loser or s_winner:
            # Windows disagree — the long window says otherwise. Surface it,
            # never act on it automatically.
            record["verdict"] = "watch"
            record["why"] = (f"{'loser' if s_loser else 'winner'} over "
                             f"{WINDOWS['short_days']}d but not confirmed over "
                             f"{WINDOWS['long_days']}d")
            watch.append(record)

    winners.sort(key=lambda e: -e["sales"])
    losers.sort(key=lambda e: -e["spend"])
    watch.sort(key=lambda e: -e["spend"])
    return {"winners": winners, "losers": losers, "watch": watch}


def run_loop(target_acos: float | None = None,
             short_days: int | None = None,
             long_days: int | None = None) -> dict:
    """Fetch both windows, aggregate, classify. Pure read — writes nothing."""
    from src.amazon_ads.strategy import account_target_acos

    as_of = amazon_as_of()
    sd = short_days or int(WINDOWS["short_days"])
    ld = long_days or int(WINDOWS["long_days"])

    basis = "explicit"
    if target_acos is None:
        target_acos, basis = account_target_acos()

    short_rows = _fetch_terms(window_start(as_of, sd), as_of)
    long_rows = _fetch_terms(window_start(as_of, ld), as_of)
    short = aggregate_terms(short_rows)
    long = aggregate_terms(long_rows)
    result = classify(short, long, target_acos)

    result["meta"] = {
        "as_of": as_of.isoformat(),
        "short_window": [window_start(as_of, sd).isoformat(), as_of.isoformat()],
        "long_window": [window_start(as_of, ld).isoformat(), as_of.isoformat()],
        "short_rows": len(short_rows), "long_rows": len(long_rows),
        "short_terms": len(short), "long_terms": len(long),
        "target_acos": target_acos, "target_basis": basis,
    }
    log.info("Search-term loop as_of=%s: %d terms -> %d winners, %d losers, %d watch "
             "(target ACOS %.1f%%, %s)",
             as_of, len(short), len(result["winners"]), len(result["losers"]),
             len(result["watch"]), target_acos, basis)
    return result
