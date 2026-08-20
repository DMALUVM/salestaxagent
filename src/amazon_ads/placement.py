"""Top-of-Search placement modifier recommendations.

Question this answers: for a given campaign, is Top of Search buying cheaper
conversions than the other on-Amazon placements? If it clearly is, the TOS bid
modifier is worth raising; if it clearly is not, it is worth lowering.

RECOMMENDATION ONLY. Nothing here calls the Ads API to change a bid, a budget
or a placement modifier. Output is evidence-bearing cards for the same
confirm-only Actions queue that harvest/negate/increase-bid use.

Every threshold comes from config/ads_strategy.json -> thresholds.placement.
There are no tuning constants in this file.

One caveat stated on every card: the CURRENT modifier is not readable from the
reporting API, so recommendations are directional ("raise by N points from its
current value"), never absolute.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date

from src.amazon_ads.strategy import THRESHOLDS, classify_campaign
from src.rules import amazon_as_of, window_start

log = logging.getLogger(__name__)

PLACEMENT_CFG: dict = THRESHOLDS["placement"]

TOS = PLACEMENT_CFG["tos_placement"]
COMPARE = list(PLACEMENT_CFG["compare_placements"])
if PLACEMENT_CFG.get("include_off_amazon"):
    COMPARE.append("Off Amazon")


def load_placement_rows(days: int | None = None) -> tuple[list[dict], dict]:
    """Placement rows for the closed window ending at the LA as-of date.

    Returns (rows, meta). An absent or empty table yields ([], meta) — a setup
    state, not an error, so the caller emits nothing and logs cleanly.
    """
    from src.db import get_client

    lookback = int(days or PLACEMENT_CFG["lookback_days"])
    as_of = amazon_as_of()
    start = window_start(as_of, lookback)
    meta = {
        "as_of": as_of.isoformat(),
        "window": [start.isoformat(), as_of.isoformat()],
        "lookback_days": lookback,
        "available": False,
    }

    rows: list[dict] = []
    try:
        client = get_client()
        offset, page_size = 0, 1000
        while True:
            resp = (client.table("ads_placement_daily")
                    .select("date,campaign_id,campaign_name,placement,spend,"
                            "sales_14d,orders_14d,clicks,impressions")
                    .gte("date", start.isoformat())
                    .lte("date", as_of.isoformat())
                    .range(offset, offset + page_size - 1)
                    .execute())
            page = resp.data or []
            rows.extend(page)
            if len(page) < page_size:
                break
            offset += page_size
        meta["available"] = True
    except Exception as e:
        if "ads_placement_daily" in str(e):
            log.info("ads_placement_daily not present — no TOS recommendations "
                     "(run supabase/migration_ads_placement.sql)")
        else:
            log.warning("Could not read ads_placement_daily: %s", str(e)[:200])
        return [], meta

    meta["rows"] = len(rows)
    if not rows:
        log.info("ads_placement_daily empty for %s..%s — no TOS recommendations",
                 start, as_of)
    return rows, meta


def analyse(rows: list[dict], target_acos: float) -> list[dict]:
    """Per-campaign TOS verdict. Pure: no DB, no network.

    Verdicts:
      increase — TOS ACOS is at least (1 - advantage) better than the other
                 on-Amazon placements AND is at or under target. Buying more of
                 the efficient placement is the point of the modifier.
      decrease — TOS ACOS is worse than the benchmark by the penalty multiple,
                 or is above target while the benchmark is not.
      hold     — neither bar fired, or the data is too thin to judge.
    """
    min_clicks = int(PLACEMENT_CFG["min_clicks"])
    min_bench_clicks = int(PLACEMENT_CFG["min_benchmark_clicks"])
    min_spend = float(PLACEMENT_CFG["min_spend"])
    adv = float(PLACEMENT_CFG["tos_acos_advantage_pct"])
    pen = float(PLACEMENT_CFG["tos_acos_penalty_pct"])
    step_up = float(PLACEMENT_CFG["modifier_step_pct"])
    step_down = float(PLACEMENT_CFG["decrease_step_pct"])
    max_mod = float(PLACEMENT_CFG["max_modifier_pct"])

    # campaign_id -> placement -> totals
    per_campaign: dict[str, dict] = defaultdict(
        lambda: {"name": "", "placements": defaultdict(
            lambda: {"spend": 0.0, "sales": 0.0, "orders": 0, "clicks": 0, "impressions": 0})}
    )
    for r in rows:
        cid = str(r.get("campaign_id") or "")
        if not cid:
            continue
        c = per_campaign[cid]
        c["name"] = c["name"] or (r.get("campaign_name") or "")
        p = c["placements"][str(r.get("placement") or "Unknown")]
        p["spend"] += float(r.get("spend") or 0)
        p["sales"] += float(r.get("sales_14d") or 0)
        p["orders"] += int(r.get("orders_14d") or 0)
        p["clicks"] += int(r.get("clicks") or 0)
        p["impressions"] += int(r.get("impressions") or 0)

    def stats(d: dict) -> dict:
        return {
            "spend": round(d["spend"], 2), "sales": round(d["sales"], 2),
            "orders": d["orders"], "clicks": d["clicks"],
            "impressions": d["impressions"],
            "acos": round(d["spend"] / d["sales"] * 100, 1) if d["sales"] > 0 else None,
            "cvr": round(d["orders"] / d["clicks"] * 100, 1) if d["clicks"] else None,
            "cpc": round(d["spend"] / d["clicks"], 2) if d["clicks"] else None,
        }

    out: list[dict] = []
    for cid, c in per_campaign.items():
        tos_raw = c["placements"].get(TOS)
        if not tos_raw:
            continue
        tos = stats(tos_raw)

        bench_raw = {"spend": 0.0, "sales": 0.0, "orders": 0, "clicks": 0, "impressions": 0}
        by_placement = {}
        for name in COMPARE:
            praw = c["placements"].get(name)
            if not praw:
                continue
            by_placement[name] = stats(praw)
            for k in bench_raw:
                bench_raw[k] += praw[k]
        bench = stats(bench_raw)

        verdict, reasons, step = "hold", [], 0.0

        # Data sufficiency first — thin data holds, it never recommends.
        if tos["clicks"] < min_clicks:
            reasons.append(f"TOS has {tos['clicks']} clicks, below the "
                           f"{min_clicks}-click minimum to judge")
        elif tos["spend"] < min_spend:
            reasons.append(f"TOS spend ${tos['spend']:.2f} below the "
                           f"${min_spend:.2f} minimum to judge")
        elif bench["clicks"] < min_bench_clicks:
            reasons.append(f"comparison placements have {bench['clicks']} clicks, "
                           f"below the {min_bench_clicks}-click minimum")
        elif tos["acos"] is None and tos["spend"] > 0:
            verdict = "decrease"
            step = step_down
            reasons.append(f"TOS spent ${tos['spend']:.2f} with no attributed sales")
        elif tos["acos"] is not None and bench["acos"] is not None:
            if tos["acos"] <= bench["acos"] * adv and tos["acos"] <= target_acos:
                verdict = "increase"
                step = step_up
                reasons.append(
                    f"TOS ACOS {tos['acos']}% vs {bench['acos']}% on the other "
                    f"on-Amazon placements — at or better than the "
                    f"{adv:.0%} advantage bar ({round(bench['acos'] * adv, 1)}%)")
                reasons.append(f"and at or under the {target_acos:.1f}% break-even target")
            elif tos["acos"] >= bench["acos"] * pen:
                verdict = "decrease"
                step = step_down
                reasons.append(
                    f"TOS ACOS {tos['acos']}% vs {bench['acos']}% elsewhere — past the "
                    f"{pen:.0%} penalty bar ({round(bench['acos'] * pen, 1)}%)")
            elif tos["acos"] > target_acos and bench["acos"] <= target_acos:
                verdict = "decrease"
                step = step_down
                reasons.append(
                    f"TOS ACOS {tos['acos']}% is above the {target_acos:.1f}% target while "
                    f"the other placements hold {bench['acos']}%")
            else:
                reasons.append(
                    f"TOS ACOS {tos['acos']}% vs {bench['acos']}% elsewhere — inside the "
                    f"{adv:.0%}–{pen:.0%} band, no change justified")
        else:
            reasons.append("not enough attributed sales to compare ACOS")

        out.append({
            "campaign_id": cid,
            "campaign_name": c["name"],
            "role": classify_campaign(c["name"]),
            "verdict": verdict,
            "step_pct": step,
            "max_modifier_pct": max_mod,
            "target_acos": target_acos,
            "tos": tos,
            "benchmark": bench,
            "by_placement": by_placement,
            "reasons": reasons,
        })

    order = {"increase": 0, "decrease": 1, "hold": 2}
    out.sort(key=lambda r: (order[r["verdict"]], -r["tos"]["spend"]))
    return out


def recommend_tos_modifiers(target_acos: float,
                            days: int | None = None) -> tuple[list[dict], dict]:
    """(action-card dicts, meta). Empty list when placement data is absent.

    One card per campaign at most, and only for increase/decrease: a "hold" is
    the absence of an action, and filling the queue with them would bury the
    cards that need doing. Holds stay visible in the meta counts and the log.
    """
    rows, meta = load_placement_rows(days)
    if not rows:
        meta["verdicts"] = {}
        return [], meta

    analysis = analyse(rows, target_acos)
    counts: dict[str, int] = defaultdict(int)
    for a in analysis:
        counts[a["verdict"]] += 1
    meta["verdicts"] = dict(counts)
    meta["campaigns_analysed"] = len(analysis)

    cards: list[dict] = []
    for a in analysis:
        if a["verdict"] == "hold":
            continue
        tos, bench = a["tos"], a["benchmark"]
        direction = "Raise" if a["verdict"] == "increase" else "Lower"
        why = "; ".join(a["reasons"])
        window = meta["window"]

        cards.append({
            "type": "ADJUST_TOS_MODIFIER",
            "priority": "P1",
            "impact_estimate": round(tos["spend"], 2),
            "entity_type": "campaign",
            "entity_name": a["campaign_name"],
            "campaign_name": a["campaign_name"],
            "campaign_id": a["campaign_id"],
            "ad_group_id": "",
            "status": "open",
            "evidence": {
                "action_type": "adjust_tos_modifier",
                "why": (f"{why}. Window {window[0]}→{window[1]} "
                        f"({meta['lookback_days']} closed days)."),
                "verdict": a["verdict"],
                "role": a["role"],
                "step_pct": a["step_pct"],
                "max_modifier_pct": a["max_modifier_pct"],
                "target_acos": a["target_acos"],
                "placement_tos": tos,
                "placement_benchmark": bench,
                "by_placement": a["by_placement"],
                "spend": tos["spend"], "sales": tos["sales"],
                "orders": tos["orders"], "clicks": tos["clicks"],
                "acos": tos["acos"],
                "window": {"days": meta["lookback_days"], "from": window[0], "to": window[1]},
                "thresholds_fired": {
                    "tos_acos_advantage_pct": PLACEMENT_CFG["tos_acos_advantage_pct"],
                    "tos_acos_penalty_pct": PLACEMENT_CFG["tos_acos_penalty_pct"],
                    "min_clicks": PLACEMENT_CFG["min_clicks"],
                    "min_spend": PLACEMENT_CFG["min_spend"],
                },
                "note": ("Current modifier is not exposed by the reporting API, so this "
                         "is a directional change from whatever it is set to now."),
            },
            "suggested_action": (
                f'In Campaign Manager open campaign "{a["campaign_name"]}" → Placements, and '
                f"{direction.lower()} the Top of Search bid modifier by about "
                f"{a['step_pct']:.0f} percentage points from its current value "
                f"(cap {a['max_modifier_pct']:.0f}%). "
                f"TOS: ${tos['spend']:.2f} spend, ${tos['sales']:.2f} sales, "
                f"ACOS {tos['acos'] if tos['acos'] is not None else '—'}%, {tos['orders']} orders, "
                f"{tos['clicks']} clicks. Other on-Amazon placements: ${bench['spend']:.2f} spend, "
                f"ACOS {bench['acos'] if bench['acos'] is not None else '—'}%. "
                f"Re-check after 7 days before moving it again."
            ),
        })

    log.info("TOS placement: %d campaigns analysed, verdicts=%s, %d card(s)",
             len(analysis), dict(counts), len(cards))
    return cards, meta
