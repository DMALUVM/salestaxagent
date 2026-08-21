"""Full PPC brief — everything the system knows, in one paste-ready document.

The previous Grok export carried the action list, four KPIs and a target ACOS.
Everything learned since — organic rank bands, brand vs non-brand share,
placement economics, ad-product split, multi-campaign term overlap, the
break-even derivation — lived in the database and never reached the page the
operator pastes into an AI. So the model was reasoning about a fraction of the
evidence and could not check its own advice against the constraints.

This assembles the whole picture, and is explicit about three things models
otherwise guess at:

  - **provenance** — which figure came from which source, and its scope
  - **the gaps** — what is NOT known, stated as data rather than omitted, so
    the model says "insufficient evidence" instead of inventing a number
  - **the ledger** — what was recommended before, what was applied, and what
    happened, so each week's brief is strictly better informed than the last

The learning loop is the part that compounds. It only works if applied actions
are recorded, so the brief ends by naming the exact command that closes it.
"""
from __future__ import annotations

import json
import logging
from datetime import date, timedelta

log = logging.getLogger(__name__)


def _money(v) -> str:
    try:
        return f"${float(v):,.2f}"
    except (TypeError, ValueError):
        return "—"


def _pct(v, dp=1) -> str:
    try:
        return f"{float(v):.{dp}f}%"
    except (TypeError, ValueError):
        return "—"


def _ev(rec: dict) -> dict:
    e = rec.get("evidence")
    if isinstance(e, str):
        try:
            return json.loads(e) or {}
        except ValueError:
            return {}
    return e or {}


def gather(days: int = 7) -> dict:
    """Pull every input the brief needs. One place, so the CLI and API agree."""
    from collections import defaultdict

    from src.db import fetch_all, get_client
    from src.rules import amazon_as_of, window_start

    client = get_client()
    asof = amazon_as_of()
    start = window_start(asof, days)
    out: dict = {"as_of": asof.isoformat(), "start": start.isoformat(),
                 "days": days, "gaps": []}

    def page(table, cols, order=("date",)):
        rows, off = [], 0
        while True:
            q = client.table(table).select(cols).gte("date", str(start)).lte("date", str(asof))
            for c in order:
                q = q.order(c)
            p = (q.range(off, off + 999).execute().data) or []
            rows.extend(p)
            if len(p) < 1000:
                break
            off += 1000
        return rows

    # ── Spend, by day and by ad product ──
    camp = page("ads_campaigns_daily",
                "date,campaign_id,campaign_name,campaign_type,spend,sales_14d,"
                "orders_14d,clicks,impressions", ("date", "campaign_id"))
    by_type = defaultdict(lambda: {"spend": 0.0, "sales": 0.0, "clicks": 0})
    for r in camp:
        t = (r.get("campaign_type") or "SP").upper()
        by_type[t]["spend"] += float(r.get("spend") or 0)
        by_type[t]["sales"] += float(r.get("sales_14d") or 0)
        by_type[t]["clicks"] += int(r.get("clicks") or 0)
    out["by_type"] = {k: v for k, v in sorted(by_type.items())}
    out["spend"] = sum(v["spend"] for v in by_type.values())
    out["ad_sales"] = sum(v["sales"] for v in by_type.values())
    out["clicks"] = sum(v["clicks"] for v in by_type.values())
    out["orders"] = sum(int(r.get("orders_14d") or 0) for r in camp)
    for t in ("SP", "SB", "SD"):
        if t not in by_type:
            out["gaps"].append(
                f"No {t} rows for this window — Seller Central totals include it, "
                f"so account spend here may read low.")

    # ── Amazon sales (TACoS denominator) ──
    total_sales = 0.0
    try:
        off = 0
        while True:
            p = (client.table("sales_daily").select("sale_date,gross_sales,channel")
                 .eq("channel", "amazon")
                 .gte("sale_date", str(start)).lte("sale_date", str(asof))
                 .order("sale_date").range(off, off + 999).execute().data) or []
            total_sales += sum(float(x.get("gross_sales") or 0) for x in p)
            if len(p) < 1000:
                break
            off += 1000
    except Exception as e:
        out["gaps"].append(f"Amazon sales unavailable, so TACoS is unknown: {str(e)[:90]}")
    out["amazon_sales"] = total_sales

    # ── Placement economics ──
    pl = defaultdict(lambda: {"spend": 0.0, "sales": 0.0, "clicks": 0})
    try:
        for r in page("ads_placement_daily",
                      "date,campaign_id,placement,spend,sales_14d,clicks",
                      ("date", "campaign_id", "placement")):
            k = r.get("placement") or "Unknown"
            pl[k]["spend"] += float(r.get("spend") or 0)
            pl[k]["sales"] += float(r.get("sales_14d") or 0)
            pl[k]["clicks"] += int(r.get("clicks") or 0)
    except Exception as e:
        out["gaps"].append(f"Placement data unavailable: {str(e)[:90]}")
    out["placements"] = dict(sorted(pl.items(), key=lambda kv: -kv[1]["spend"]))
    out["placement_spend"] = sum(v["spend"] for v in pl.values())
    out["unallocated"] = round(out["spend"] - out["placement_spend"], 2)

    # ── Search terms, rolled up, with campaign overlap ──
    terms: dict[str, dict] = {}
    try:
        for r in page("ads_search_terms_daily",
                      "date,search_term,campaign_id,campaign_name,match_type,"
                      "spend,sales_14d,orders_14d,clicks",
                      ("date", "search_term", "campaign_id")):
            t = (r.get("search_term") or "").strip().lower()
            if not t:
                continue
            e = terms.setdefault(t, {"term": r.get("search_term"), "spend": 0.0,
                                     "sales": 0.0, "orders": 0, "clicks": 0,
                                     "campaigns": {}, "match_types": set()})
            e["spend"] += float(r.get("spend") or 0)
            e["sales"] += float(r.get("sales_14d") or 0)
            e["orders"] += int(r.get("orders_14d") or 0)
            e["clicks"] += int(r.get("clicks") or 0)
            if r.get("match_type"):
                e["match_types"].add(str(r["match_type"]).lower())
            cid = str(r.get("campaign_id") or "")
            c = e["campaigns"].setdefault(cid, {"name": r.get("campaign_name") or "",
                                                "spend": 0.0})
            c["spend"] += float(r.get("spend") or 0)
    except Exception as e:
        out["gaps"].append(f"Search terms unavailable: {str(e)[:90]}")
    out["terms"] = terms

    # ── Break-even target ──
    try:
        from src.amazon_ads.strategy import account_target_acos
        t, basis = account_target_acos()
        out["target_acos"], out["target_basis"] = float(t), basis
    except Exception:
        out["target_acos"], out["target_basis"] = 30.0, "fallback"

    # ── Recommendations (carry the rank-gate evidence) ──
    out["recs"] = [{**r, "evidence": _ev(r)} for r in fetch_all("ads_recommendations")]

    # ── Organic rank + brand share ──
    try:
        from src.amazon_ads.organic_rank import fetch_ranks
        ranks = fetch_ranks()
        out["rank_rows"] = len(ranks)
        out["rank_as_of"] = max((str(v.get("as_of") or "") for v in ranks.values()),
                                default=None)
    except Exception:
        out["rank_rows"], out["rank_as_of"] = 0, None
    if not out["rank_rows"]:
        out["gaps"].append("No organic rank data — every bid increase gates as "
                           "'rank unknown'.")

    try:
        from src.amazon_ads.brand_rollup import rollup_weeks
        rows, off = [], 0
        while True:
            p = (client.table("sqp_weekly").select("*")
                 .order("week_start").range(off, off + 999).execute().data) or []
            rows.extend(p)
            if len(p) < 1000:
                break
            off += 1000
        out["brand_weeks"] = [w.as_dict() for w in rollup_weeks(rows)]
    except Exception:
        out["brand_weeks"] = []
    if len(out["brand_weeks"]) < 4:
        out["gaps"].append(
            f"Only {len(out['brand_weeks'])} week(s) of SQP stored — brand-mix "
            f"trend is not yet reliable. Backfill with `sqp-backfill`.")

    # ── Outcome ledger: the learning loop ──
    try:
        out["outcomes"] = fetch_all("ads_action_outcomes")
    except Exception:
        out["outcomes"] = []
    applied = [r for r in out["recs"] if str(r.get("status")) in ("applied", "dismissed")]
    out["applied_count"] = len(applied)
    if not out["outcomes"]:
        out["gaps"].append(
            "No recorded outcomes yet. Until applied actions are marked, the "
            "system cannot measure which recommendations worked, and this brief "
            "cannot improve week over week.")
    return out


def build_brief(d: dict) -> str:
    """Render the gathered data as a paste-ready markdown brief."""
    L: list[str] = []
    A = L.append

    spend, sales = d["spend"], d["ad_sales"]
    acos = (spend / sales * 100) if sales else 0
    tacos = (spend / d["amazon_sales"] * 100) if d.get("amazon_sales") else None
    target = d["target_acos"]

    A("# Amazon PPC — full account brief")
    A("")
    A(f"**Window:** {d['start']} → {d['as_of']} ({d['days']} closed days)  ")
    A("**Day boundary:** America/Los_Angeles, closed days only. Today is still "
      "accruing and is excluded from every figure below.  ")
    A(f"**Break-even target ACOS:** {target:.1f}% (basis: {d['target_basis']}) — "
      f"derived from COGS, referral and FBA fees per SKU, unit-weighted. Above "
      f"this a sale loses money.")
    A("")

    # ── 1. Economics ──
    A("## 1. Account economics")
    A("")
    A("| Metric | Value | Note |")
    A("| --- | --- | --- |")
    A(f"| Ad spend | {_money(spend)} | all ad products present below |")
    A(f"| Ad sales (14d attr.) | {_money(sales)} | Amazon's 14-day attribution window |")
    A(f"| ACOS | {_pct(acos)} | vs {_pct(target)} break-even |")
    A(f"| TACoS | {_pct(tacos) if tacos is not None else '—'} | ad spend / total Amazon sales |")
    A(f"| Clicks / Orders | {d['clicks']:,} / {d['orders']:,} | |")
    A(f"| Amazon sales (all) | {_money(d.get('amazon_sales'))} | TACoS denominator |")
    A("")
    A("**By ad product** — Seller Central totals span all three; a missing one "
      "means this brief understates account spend:")
    A("")
    A("| Product | Spend | Sales | ACOS |")
    A("| --- | --- | --- | --- |")
    for t, v in d["by_type"].items():
        a = (v["spend"] / v["sales"] * 100) if v["sales"] else 0
        A(f"| {t} | {_money(v['spend'])} | {_money(v['sales'])} | {_pct(a, 0)} |")
    A("")

    # ── 2. Placement ──
    if d.get("placements"):
        A("## 2. Placement economics")
        A("")
        A("Placement modifiers are ONE setting per campaign, so this is the "
          "cheapest large lever available.")
        A("")
        A("| Placement | Spend | Sales | ACOS | vs break-even |")
        A("| --- | --- | --- | --- | --- |")
        for k, v in d["placements"].items():
            a = (v["spend"] / v["sales"] * 100) if v["sales"] else None
            verdict = ("no sales" if a is None
                       else "OVER" if a > target * 1.5
                       else "over" if a > target else "ok")
            A(f"| {k} | {_money(v['spend'])} | {_money(v['sales'])} | "
              f"{_pct(a, 0) if a is not None else '—'} | {verdict} |")
        A("")
        if abs(d["unallocated"]) >= 0.01:
            A(f"_{_money(d['unallocated'])} of spend has no placement row: Amazon "
              f"publishes placement data for Sponsored Products only, so SB/SD "
              f"spend can never appear here. This is expected, not missing data._")
            A("")

    # ── 3. Brand vs non-brand ──
    if d.get("brand_weeks"):
        A("## 3. Branded vs non-branded demand")
        A("")
        A("Brand was renamed ~2025-10-31: \"Dr. Dave's Primal Essence\" → "
          "\"Tallowbourn\", same ASINs. BOTH eras count as branded, so mix is "
          "continuous across the rename.")
        A("")
        A("| Week | Branded purch. | Non-brand purch. | Branded mix | Non-brand share* |")
        A("| --- | --- | --- | --- | --- |")
        for w in d["brand_weeks"][-8:]:
            A(f"| {w['week_start']} | {w['branded_purchases']:,} | "
              f"{w['non_branded_purchases']:,} | "
              f"{_pct((w['branded_mix'] or 0) * 100, 0)} | "
              f"{_pct((w.get('non_branded_share_present') or 0) * 100, 2)} |")
        A("")
        A("_*Share of market purchases on queries where we had ≥1% impression "
          "share. Source is SP-API SQP (ASIN view): it covers queries our ASINs "
          "appeared in, NOT the full category, so this is not Brand View parity. "
          "Trend is reliable; the absolute level is not._")
        A("")

    # ── 4. Cannibalization gate ──
    A("## 4. Organic rank / cannibalization gate")
    A("")
    A(f"Rank rows stored: **{d.get('rank_rows', 0):,}**"
      + (f" (newest {d['rank_as_of']})" if d.get("rank_as_of") else ""))
    A("")
    A("Rank is a BAND derived from SQP click share (≥40% → 1, ≥15% → 5, else 99), "
      "not a measured SERP position. Amazon's Ads API publishes no organic rank.")
    A("")
    A("Policy applied to bid INCREASES only — never to negatives, pauses or cuts:")
    A("")
    A("- rank 1–3 or branded → capped at +8%")
    A("- rank 4–7 → capped at +12%")
    A("- rank 8+ → full increase allowed")
    A("- rank unknown and bid ≥ $2.30 → held for manual check, never auto-applied")
    A("")
    counts: dict[str, int] = {}
    for r in d["recs"]:
        p = _ev(r).get("rank_policy_applied")
        if p:
            counts[p] = counts.get(p, 0) + 1
    if counts:
        A("Current gate outcomes: "
          + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
        A("")

    # ── 5. Term overlap ──
    multi = sorted(
        ((t, v) for t, v in (d.get("terms") or {}).items() if len(v["campaigns"]) > 1),
        key=lambda kv: -kv[1]["spend"])[:12]
    if multi:
        A("## 5. Search terms running in multiple campaigns")
        A("")
        A("The same query bidding against itself. Consolidating usually lowers "
          "CPC without losing impressions.")
        A("")
        A("| Term | Campaigns | Spend | Sales | Orders | ACOS |")
        A("| --- | --- | --- | --- | --- | --- |")
        for t, v in multi:
            a = (v["spend"] / v["sales"] * 100) if v["sales"] else 0
            A(f"| {v['term']} | {len(v['campaigns'])} | {_money(v['spend'])} | "
              f"{_money(v['sales'])} | {v['orders']} | {_pct(a, 0)} |")
        A("")
        top = multi[0]
        A(f"Example — \"{top[1]['term']}\" splits across:")
        for cid, c in sorted(top[1]["campaigns"].items(),
                             key=lambda kv: -kv[1]["spend"]):
            A(f"- {c['name']} (`{cid}`) — {_money(c['spend'])}")
        A("")

    # ── 6. Actions ──
    A("## 6. Recommended actions")
    A("")
    rank = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    ordered = sorted(d["recs"],
                     key=lambda r: (rank.get(str(r.get("priority")), 9),
                                    -float(r.get("impact_estimate") or 0)))
    if not ordered:
        A("_No open recommendations. Run `ads-actions` to regenerate._")
        A("")
    for r in ordered[:40]:
        e = _ev(r)
        A(f"### [{r.get('priority')}] {r.get('type')} — {r.get('entity_name')}")
        A("")
        A(f"- **Campaign:** {r.get('campaign_name')} "
          f"(`{e.get('campaign_id') or r.get('campaign_id') or '—'}`)")
        if e.get("why"):
            A(f"- **Why:** {e['why']}")
        A(f"- **Do:** {r.get('suggested_action')}")
        if e.get("cpc") is not None:
            A(f"- **Economics:** spend {_money(e.get('spend'))}, "
              f"sales {_money(e.get('sales'))}, {e.get('orders', 0)} orders, "
              f"ACOS {_pct(e.get('acos'), 0)}, CPC {_money(e.get('cpc'))}")
        if e.get("rank_policy_applied"):
            A(f"- **Rank gate:** {e.get('rank_policy_applied')} "
              f"(risk {e.get('cannibalization_risk')}, "
              f"rank {e.get('organic_rank') if e.get('organic_rank') is not None else 'unknown'}"
              + (", branded" if e.get("rank_branded") else "") + ")")
            if e.get("proposed_bid_before_rank_gate"):
                A(f"- **Bid:** plan {_money(e['proposed_bid_before_rank_gate'])} → "
                  f"applied {_money(e.get('suggested_bid'))}")
        A(f"- **Estimated impact:** {_money(r.get('impact_estimate'))}")
        A("")

    # ── 7. Learning ledger ──
    A("## 7. What the system has learned so far")
    A("")
    A(f"- Recommendations logged: **{len(d['recs'])}** "
      f"(all carry a frozen evidence snapshot, so later analysis cannot leak "
      f"future data into a past decision)")
    A(f"- Marked applied or dismissed: **{d['applied_count']}**")
    A(f"- Outcomes measured: **{len(d.get('outcomes') or [])}**")
    A("")
    if d.get("outcomes"):
        from collections import Counter
        by_type = Counter(str(o.get("action_type") or "?") for o in d["outcomes"])
        A("Measured outcomes by action type: "
          + ", ".join(f"{k} {v}" for k, v in sorted(by_type.items())))
        A("")
        A("_Observational, not causal: these are before/after windows around a "
          "change, not a holdout test. Treat a consistent direction across many "
          "actions as signal and a single action's swing as noise._")
        A("")

    if not d.get("outcomes"):
        A("**The loop is not closed yet.** Every recommendation is recorded, but "
          "none has been marked applied, so there is no before/after to measure "
          "and no basis for saying which advice worked. Nothing below is "
          "evidence-weighted yet — it is rules-based only.")
        A("")
        A("To start the compounding, after applying a batch in Seller Central:")
        A("")
        A("```")
        A("python -m src.main ads-mark --priority P0 --apply     # or --type / --id")
        A("```")
        A("")
        A("Outcomes are then snapshotted automatically at the 7/14/30-day "
          "horizons, and next week's brief reports what each recommendation "
          "actually did rather than only what it predicted.")
        A("")

    # ── 8. Known gaps ──
    if d.get("gaps"):
        A("## 8. Known gaps in this brief")
        A("")
        A("State these as limits rather than reasoning past them:")
        A("")
        for g in d["gaps"]:
            A(f"- {g}")
        A("")

    return "\n".join(L)


def build_prompt(brief: str) -> str:
    """Wrap the brief with instructions that constrain the model to the evidence."""
    return "\n".join([
        "You are a senior Amazon Ads strategist reviewing my account.",
        "",
        "Below is a complete brief generated from my own account data. Use ONLY "
        "what is in it. Where the brief says something is unknown or a gap, treat "
        "that as a real constraint — say \"insufficient evidence\" rather than "
        "estimating. Do not invent metrics, competitor data, or benchmarks.",
        "",
        "Produce, in this order:",
        "",
        "1. **The three things costing me the most money right now**, each with the "
        "   figure from the brief that proves it and the specific change to make.",
        "2. **A 7-day execution plan** — which actions on which day, grouped by "
        "   campaign so I am not jumping around. Waste and placement cuts before "
        "   bid raises; explain the sequencing.",
        "3. **What you would NOT do** from my recommendation list, and why. Call "
        "   out anything contradictory, risky, or too small to be worth the click.",
        "4. **Growth**: given my branded vs non-branded mix and the organic-rank "
        "   gate, where is real incremental growth available? Be specific about "
        "   which terms and why the rank band supports spending there.",
        "5. **Monitoring**: for each change, the metric to watch, the cadence, and "
        "   the threshold that means revert.",
        "6. **What data would most improve this analysis next week**, ranked by how "
        "   much it would change your advice.",
        "",
        "Constraints to respect:",
        "- Break-even ACOS is the profitability line, not a target to beat by any margin.",
        "- Brand terms are defended, never scaled — we already win them organically.",
        "- Rank-unknown high bids are held deliberately; do not tell me to raise them blind.",
        "- All figures are closed days in America/Los_Angeles.",
        "",
        "--- ACCOUNT BRIEF ---",
        "",
        brief,
    ])
