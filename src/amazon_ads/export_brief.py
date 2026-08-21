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
    out["applied_recs"] = applied
    if not out["outcomes"]:
        out["gaps"].append(
            "No recorded outcomes yet. Until applied actions are marked, the "
            "system cannot measure which recommendations worked, and this brief "
            "cannot improve week over week.")

    # ── Prior comparable window, for week-over-week deltas ──
    #     Same length, immediately before this one, so the comparison is
    #     like-for-like rather than "this week vs a month".
    prior_end = start - timedelta(days=1)
    prior_start = window_start(prior_end, days)
    out["prior_start"], out["prior_end"] = prior_start.isoformat(), prior_end.isoformat()
    prior = {"spend": 0.0, "sales": 0.0, "orders": 0, "clicks": 0}
    try:
        off = 0
        while True:
            p = (client.table("ads_campaigns_daily")
                 .select("date,campaign_id,spend,sales_14d,orders_14d,clicks")
                 .gte("date", str(prior_start)).lte("date", str(prior_end))
                 .order("date").order("campaign_id")
                 .range(off, off + 999).execute().data) or []
            for r in p:
                prior["spend"] += float(r.get("spend") or 0)
                prior["sales"] += float(r.get("sales_14d") or 0)
                prior["orders"] += int(r.get("orders_14d") or 0)
                prior["clicks"] += int(r.get("clicks") or 0)
            if len(p) < 1000:
                break
            off += 1000
    except Exception as e:
        out["gaps"].append(f"Prior window unavailable, so no week-over-week "
                           f"comparison: {str(e)[:90]}")
        prior = {}
    out["prior"] = prior

    # ── Brand / rank classification of terms, for the grade and the gate ──
    #     Classified once here so the tables, the score and the action plan can
    #     never disagree about which terms are branded.
    try:
        from src.amazon_ads.brand_terms import is_branded, load_rules
        rules = load_rules()
    except Exception:
        rules, is_branded = None, None            # type: ignore[assignment]

    try:
        from src.amazon_ads.organic_rank import fetch_ranks, normalize_keyword
        rank_map = fetch_ranks()
    except Exception:
        rank_map, normalize_keyword = {}, None    # type: ignore[assignment]

    # Ranks are keyed by (asin, keyword); the brief is account-level, so collapse
    # to the BEST (numerically lowest) band any ASIN holds for that query.
    rank_by_kw: dict[str, int] = {}
    for (_asin, kw), row in (rank_map or {}).items():
        band = row.get("organic_rank")
        if band is None:
            continue
        prev = rank_by_kw.get(kw)
        if prev is None or int(band) < prev:
            rank_by_kw[kw] = int(band)

    brand_spend = 0.0 if is_branded else None
    waste_spend = 0.0 if terms else None
    nb_rank_spend = nb_rank_sales = 0.0
    nb_rank_terms = 0
    nb_total = nb_with_rank = 0
    eligible_min = int(
        (_score_cfg()["grade"]["components"]["non_brand_efficiency"]["eligible_rank_min"]))

    for t, v in terms.items():
        branded = bool(is_branded(t, rules)) if is_branded else False
        v["branded"] = branded
        kw = normalize_keyword(t) if normalize_keyword else t
        v["rank"] = rank_by_kw.get(kw)
        if branded:
            if brand_spend is not None:
                brand_spend += v["spend"]
        else:
            nb_total += 1
            if v["rank"] is not None:
                nb_with_rank += 1
            # Only where organic coverage is weak is paid traffic additive.
            if v["rank"] is not None and v["rank"] >= eligible_min:
                nb_rank_spend += v["spend"]
                nb_rank_sales += v["sales"]
                nb_rank_terms += 1
        if waste_spend is not None and v["orders"] == 0:
            waste_spend += v["spend"]

    out["brand_spend"] = brand_spend
    out["waste_spend"] = waste_spend
    # Denominator for the waste and brand-share ratios. Amazon reports search
    # terms for Sponsored Products only, so dividing term-level waste by
    # all-product spend mixes scopes and flatters the number — SB and SD spend
    # would sit in the denominator with no chance of appearing in the numerator.
    out["term_spend"] = sum(v["spend"] for v in terms.values()) if terms else 0.0
    out["non_brand_rank_eligible"] = {
        "spend": nb_rank_spend, "sales": nb_rank_sales, "terms": nb_rank_terms,
        "acos": (nb_rank_spend / nb_rank_sales * 100) if nb_rank_sales else None,
    }
    out["rank_coverage_pct"] = (nb_with_rank / nb_total * 100) if nb_total else None

    # ── Freshness ──
    out["freshness"] = _freshness(client, asof)
    if out["freshness"].get("ads_age_days") is None:
        out["gaps"].append("Last ads sync time unknown — data may be stale.")

    return out


def _score_cfg() -> dict:
    from src.amazon_ads.brief_score import CONFIG
    return CONFIG


ADS_JOBS = ["ads_sync", "ads_campaigns_sync", "ads_search_terms_sync",
            "ads_placements_sync", "ads_campaigns_backfill"]


def _freshness(client, asof: date) -> dict:
    """When each feed last produced data, in days before the as-of date."""
    out: dict = {"ads_last_sync": None, "ads_age_days": None, "ads_last_job": None,
                 "sqp_last_week_end": None, "sqp_age_days": None,
                 "ads_last_date": None}
    # job_runs / job_name — the same table and the same job list the dashboard
    # header reads, so "last sync" cannot say one thing on /ppc and another in
    # the brief. An earlier version of this guessed at a `sync_log` table that
    # does not exist, and silently reported freshness as unknown.
    try:
        r = (client.table("job_runs").select("job_name,started_at,status")
             .in_("job_name", ADS_JOBS).eq("status", "success")
             .order("started_at", desc=True).limit(1).execute().data) or []
        if r:
            stamp = str(r[0].get("started_at") or "")[:10]
            out["ads_last_sync"] = stamp
            out["ads_last_job"] = r[0].get("job_name")
            if stamp:
                # Clamped at 0: the as-of date is the last CLOSED day, so a sync
                # that ran today is legitimately newer than as-of. Reporting
                # that as "-1 days old" reads like a clock bug.
                out["ads_age_days"] = max(0, (asof - date.fromisoformat(stamp)).days)
    except Exception:
        pass
    try:
        r = (client.table("sqp_weekly").select("week_end")
             .order("week_end", desc=True).limit(1).execute().data) or []
        if r and r[0].get("week_end"):
            out["sqp_last_week_end"] = str(r[0]["week_end"])
            out["sqp_age_days"] = (asof - date.fromisoformat(out["sqp_last_week_end"])).days
    except Exception:
        pass
    try:
        r = (client.table("ads_campaigns_daily").select("date")
             .order("date", desc=True).limit(1).execute().data) or []
        if r:
            out["ads_last_date"] = str(r[0].get("date"))
    except Exception:
        pass
    return out


def grade_window(d: dict):
    """Score the gathered window. Kept separate so the arithmetic is testable."""
    from src.amazon_ads.brief_score import compute_grade

    spend, sales = d["spend"], d["ad_sales"]
    acos = (spend / sales * 100) if sales else None
    tacos = (spend / d["amazon_sales"] * 100) if d.get("amazon_sales") else None
    fresh = d.get("freshness") or {}
    # Scope-matched denominator: search terms are Sponsored Products only.
    term_spend = d.get("term_spend") or 0.0
    return compute_grade(
        acos=acos, breakeven_acos=d.get("target_acos"), tacos=tacos,
        waste_spend=d.get("waste_spend"), total_spend=(term_spend or spend),
        placements=d.get("placements"), brand_spend=d.get("brand_spend"),
        non_brand_acos=(d.get("non_brand_rank_eligible") or {}).get("acos"),
        non_brand_terms=(d.get("non_brand_rank_eligible") or {}).get("terms", 0),
        rank_coverage_pct=d.get("rank_coverage_pct"),
        sqp_age_days=fresh.get("sqp_age_days"), ads_age_days=fresh.get("ads_age_days"))


NO_DATA = "**No data — do not invent.**"


def _delta(now: float, before: float | None, money: bool = True) -> str:
    """Week-over-week delta, or an explicit note that there is nothing to compare."""
    if before is None:
        return "no prior window"
    if not before:
        return "no prior spend"
    change = (now - before) / before * 100
    arrow = "▲" if change > 0 else "▼" if change < 0 else "="
    was = _money(before) if money else f"{before:,.0f}"
    return f"{arrow} {abs(change):.0f}% (was {was})"


def build_brief(d: dict) -> str:
    """Render the gathered data as a paste-ready markdown brief.

    Every section that has no rows prints NO_DATA rather than being omitted.
    A silently absent section reads to a model as "nothing to worry about
    here"; an explicit "No data" reads as a constraint, which is what it is.
    """
    from src.amazon_ads.brief_score import CONFIG

    L: list[str] = []
    A = L.append

    spend, sales = d["spend"], d["ad_sales"]
    acos = (spend / sales * 100) if sales else None
    tacos = (spend / d["amazon_sales"] * 100) if d.get("amazon_sales") else None
    target = d["target_acos"]
    prior = d.get("prior") or {}
    fresh = d.get("freshness") or {}
    grade = grade_window(d)

    A("# Amazon PPC — Command Brief")
    A("")
    A(f"**Window graded:** {d['start']} → {d['as_of']} "
      f"({d['days']} closed days, America/Los_Angeles)  ")
    A(f"**Compared against:** {d.get('prior_start')} → {d.get('prior_end')} "
      f"(the {d['days']} closed days immediately before)  ")
    A("**Day boundary:** closed days only. Today is still accruing and is "
      "excluded from every figure below.  ")
    A(f"**Break-even ACOS:** {_pct(target)} (basis: {d['target_basis']}) — "
      f"unit-weighted from COGS, referral and FBA fees per SKU. Above this line "
      f"a sale loses money; it is a floor, not a goal to beat by any margin.")
    A("")

    # ── Freshness, first: everything below inherits it ──
    A("## 0. Data freshness")
    A("")
    A("| Feed | Latest | Age at as-of |")
    A("| --- | --- | --- |")
    A(f"| Ads sync | {fresh.get('ads_last_sync') or '—'} | "
      f"{fresh.get('ads_age_days') if fresh.get('ads_age_days') is not None else '—'} d |")
    A(f"| Ads data through | {fresh.get('ads_last_date') or '—'} | |")
    A(f"| SQP newest week ends | {fresh.get('sqp_last_week_end') or '—'} | "
      f"{fresh.get('sqp_age_days') if fresh.get('sqp_age_days') is not None else '—'} d |")
    A("")
    A("_Amazon publishes Search Query Performance about a week in arrears, so an "
      "SQP age of 7-14 days is current, not stale._")
    A("")

    # ── 1. Grade ──
    A("## 1. Performance grade")
    A("")
    A(f"# {grade.score:.0f}/100 — {grade.letter}")
    A("")
    A(f"_{grade.reading}_")
    A("")
    A(f"Formula version **{grade.formula_version}** — fixed arithmetic over the "
      f"figures in this brief. No model judgement is involved, and a score from a "
      f"different formula version is not comparable.")
    A("")
    A("| Component | Weight | Score | Working |")
    A("| --- | ---: | ---: | --- |")
    for c in grade.components:
        s = "dropped" if c.score is None else f"{c.score:.0f}"
        A(f"| {c.label} | {c.weight:.0f} | {s} | {c.detail} |")
    A("")
    A(f"Weighted over available components: **{grade.weighted_before_modifier:.1f}** "
      f"× completeness modifier **{grade.modifier:.3f}** = **{grade.score:.1f}**")
    A("")
    if grade.dropped:
        A(f"Dropped for lack of data (NOT scored zero — absence is not failure): "
          f"{', '.join(grade.dropped)}. The remaining weights were renormalised.")
        A("")
    A(f"Data completeness **{grade.completeness:.0f}/100** — "
      + "; ".join(getattr(grade, "completeness_notes", [])) + ".")
    A("")

    # ── 2. Economics ──
    A("## 2. Account economics")
    A("")
    A("| Metric | This window | vs prior window |")
    A("| --- | --- | --- |")
    A(f"| Ad spend | {_money(spend)} | {_delta(spend, prior.get('spend'))} |")
    A(f"| Ad sales (14d attr.) | {_money(sales)} | {_delta(sales, prior.get('sales'))} |")
    p_acos = (prior["spend"] / prior["sales"] * 100) if prior.get("sales") else None
    A(f"| ACOS | {_pct(acos) if acos else '—'} | "
      f"{('was ' + _pct(p_acos)) if p_acos else 'no prior window'} |")
    p_roas = (prior["sales"] / prior["spend"]) if prior.get("spend") else None
    roas_now = f"{(sales / spend):.2f}x" if spend else "—"
    roas_was = f"was {p_roas:.2f}x" if p_roas else "no prior window"
    A(f"| ROAS | {roas_now} | {roas_was} |")
    A(f"| TACoS | {_pct(tacos) if tacos is not None else '—'} | "
      f"ad spend ÷ total Amazon sales {_money(d.get('amazon_sales'))} |")
    A(f"| Orders | {d['orders']:,} | {_delta(d['orders'], prior.get('orders'), money=False)} |")
    A(f"| Clicks | {d['clicks']:,} | {_delta(d['clicks'], prior.get('clicks'), money=False)} |")
    A("")
    A("**By ad product** — Seller Central totals span SP + SB + SD; a missing "
      "product means this brief understates account spend:")
    A("")
    if d["by_type"]:
        A("| Product | Spend | Sales | ACOS |")
        A("| --- | --- | --- | --- |")
        for t, v in d["by_type"].items():
            a = (v["spend"] / v["sales"] * 100) if v["sales"] else None
            A(f"| {t} | {_money(v['spend'])} | {_money(v['sales'])} | "
              f"{_pct(a, 0) if a else '—'} |")
    else:
        A(NO_DATA)
    A("")

    # ── 3. Placement ──
    A("## 3. Placement economics")
    A("")
    if d.get("placements"):
        A("Placement modifiers are ONE setting per campaign — the cheapest large "
          "lever available.")
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
            A(f"_{_money(d['unallocated'])} of spend has no placement row. Amazon "
              f"publishes placement breakdowns for Sponsored Products ONLY, so SB "
              f"and SD spend can never appear here. This is expected, not missing "
              f"data, and must not be read as unallocated waste._")
            A("")
    else:
        A(NO_DATA)
        A("")

    # ── 4. Search terms ──
    A("## 4. Search terms")
    A("")
    terms = d.get("terms") or {}
    if not terms:
        A(NO_DATA)
        A("")
    else:
        waste = sorted((v for v in terms.values() if v["orders"] == 0 and v["spend"] > 0),
                       key=lambda v: -v["spend"])[:15]
        A("### Top waste — spend with zero attributed orders")
        A("")
        if waste:
            A("| Term | Spend | Clicks | Campaigns | Brand? | Rank band |")
            A("| --- | ---: | ---: | ---: | --- | --- |")
            for v in waste:
                A(f"| {v['term']} | {_money(v['spend'])} | {v['clicks']:,} | "
                  f"{len(v['campaigns'])} | {'brand' if v.get('branded') else 'non-brand'} | "
                  f"{v.get('rank') if v.get('rank') is not None else 'unknown'} |")
        else:
            A(NO_DATA)
        A("")

        conv = sorted((v for v in terms.values() if v["orders"] > 0),
                      key=lambda v: -v["sales"])[:15]
        A("### Top converters")
        A("")
        if conv:
            A("| Term | Spend | Sales | Orders | ACOS | Brand? | Rank band |")
            A("| --- | ---: | ---: | ---: | ---: | --- | --- |")
            for v in conv:
                a = (v["spend"] / v["sales"] * 100) if v["sales"] else None
                A(f"| {v['term']} | {_money(v['spend'])} | {_money(v['sales'])} | "
                  f"{v['orders']} | {_pct(a, 0) if a else '—'} | "
                  f"{'brand' if v.get('branded') else 'non-brand'} | "
                  f"{v.get('rank') if v.get('rank') is not None else 'unknown'} |")
        else:
            A(NO_DATA)
        A("")

        multi = sorted(((t, v) for t, v in terms.items() if len(v["campaigns"]) > 1),
                       key=lambda kv: -kv[1]["spend"])[:12]
        A("### Running in more than one campaign")
        A("")
        if multi:
            A("The same query bidding against itself. Consolidating usually lowers "
              "CPC without losing impressions.")
            A("")
            A("| term_key | Campaigns (id — name — spend) | Total spend | Orders |")
            A("| --- | --- | ---: | ---: |")
            for t, v in multi:
                cs = "; ".join(
                    f"`{cid}` {c['name'][:30]} {_money(c['spend'])}"
                    for cid, c in sorted(v["campaigns"].items(),
                                         key=lambda kv: -kv[1]["spend"]))
                A(f"| `{t}` | {cs} | {_money(v['spend'])} | {v['orders']} |")
        else:
            A(NO_DATA)
        A("")

    # ── 5. Rank gate ──
    A("## 5. Organic rank gate")
    A("")
    A(f"Rank rows stored: **{d.get('rank_rows', 0):,}**"
      + (f" (newest {d['rank_as_of']})" if d.get("rank_as_of") else ""))
    cov = d.get("rank_coverage_pct")
    A(f"Coverage: **{_pct(cov, 0) if cov is not None else '—'}** of non-brand terms "
      f"carry a rank band.")
    A("")
    A("Rank is a BAND derived from SQP click share (≥40% → 1, ≥15% → 5, else 99), "
      "NOT a measured SERP position. The Amazon Advertising API publishes no "
      "organic rank; do not treat these as literal positions.")
    A("")
    A("Policy, applied to bid INCREASES only — never to negatives, pauses or cuts:")
    A("")
    A("- rank 1–3 or branded → capped at +8%")
    A("- rank 4–7 → capped at +12%")
    A("- rank 8+ → full increase allowed")
    A("- rank unknown and bid ≥ $2.30 → HELD for manual check, never auto-applied")
    A("")
    counts: dict[str, int] = {}
    for r in d["recs"]:
        p = _ev(r).get("rank_policy_applied")
        if p:
            counts[p] = counts.get(p, 0) + 1
    if counts:
        A("| Gate outcome | Count |")
        A("| --- | ---: |")
        for k, v in sorted(counts.items()):
            A(f"| {k} | {v} |")
    else:
        A(NO_DATA)
    A("")

    blocked = [r for r in d["recs"]
               if _ev(r).get("rank_policy_applied") in ("capped", "hold")
               or _ev(r).get("needs_rank_check")]
    A("### Raises the gate is blocking")
    A("")
    if blocked:
        A("These are NOT actions. They are listed so the reason a raise is absent "
          "is visible rather than looking like an oversight.")
        A("")
        A("| Term | Campaign | Gate | Rank | Planned bid | Held at |")
        A("| --- | --- | --- | --- | ---: | ---: |")
        for r in blocked[:25]:
            e = _ev(r)
            gate = ("needs_rank_check" if e.get("needs_rank_check")
                    else str(e.get("rank_policy_applied")))
            A(f"| {r.get('entity_name')} | {r.get('campaign_name') or '—'} | {gate} | "
              f"{e.get('organic_rank') if e.get('organic_rank') is not None else 'unknown'}"
              f"{' (brand)' if e.get('rank_branded') else ''} | "
              f"{_money(e.get('proposed_bid_before_rank_gate'))} | "
              f"{_money(e.get('suggested_bid'))} |")
    else:
        A(NO_DATA)
    A("")

    # ── 6. Brand share ──
    A("## 6. Branded vs non-branded demand (SQP)")
    A("")
    if d.get("brand_weeks"):
        A("Brand was renamed ~2025-10-31: \"Dr. Dave's Primal Essence\" → "
          "\"Tallowbourn\", same ASINs. BOTH eras count as branded, so mix is "
          "continuous across the rename.")
        A("")
        A(f"Weeks stored: **{len(d['brand_weeks'])}**")
        A("")
        A("| Week | Branded purch. | Non-brand purch. | Branded mix | Non-brand share* |")
        A("| --- | ---: | ---: | ---: | ---: |")
        for w in d["brand_weeks"][-8:]:
            A(f"| {w['week_start']} | {w['branded_purchases']:,} | "
              f"{w['non_branded_purchases']:,} | "
              f"{_pct((w['branded_mix'] or 0) * 100, 0)} | "
              f"{_pct((w.get('non_branded_share_present') or 0) * 100, 2)} |")
        A("")
        A("_*Share of market purchases on queries where we held ≥1% impression "
          "share. Source is SP-API SQP, the **ASIN view**: it covers only queries "
          "our ASINs appeared in, NOT the full category. This is not Brand View "
          "parity and must not be described as category market share. The trend is "
          "reliable; the absolute level is flattering._")
    else:
        A(NO_DATA)
    A("")

    # ── 7. Action plan ──
    A("## 7. Action plan — do these, in this order")
    A("")
    plan = _action_plan(d, CONFIG["action_plan"]["max_actions"])
    if not plan:
        A(NO_DATA)
        A("")
        A("_Run `python -m src.main ads-actions --apply` to regenerate "
          "recommendations from current data._")
        A("")
    else:
        A(f"{len(plan)} action(s), P0 first. Rank-blocked raises are deliberately "
          f"absent — they are listed in section 5 instead.")
        A("")
        for i, a in enumerate(plan, 1):
            A(f"### {i}. [{a['priority']}] {a['title']}")
            A("")
            A(f"- **Where:** {a['where']}")
            A(f"- **Do:** {a['do']}")
            A(f"- **Evidence:** {a['evidence']}")
            A(f"- **Why:** {a['why']}")
            A(f"- **Risk if ignored:** {a['risk']}")
            A("")

    # ── 8. Learning ledger ──
    A("## 8. Learning ledger")
    A("")
    A(f"- Recommendations on file: **{len(d['recs'])}** (each carries a frozen "
      f"evidence snapshot, so later analysis cannot leak future data into a past "
      f"decision)")
    A(f"- Marked applied or dismissed: **{d['applied_count']}**")
    A(f"- Outcomes measured at 7/14/30d: **{len(d.get('outcomes') or [])}**")
    A("")
    if d.get("outcomes"):
        from collections import Counter
        by_type = Counter(str(o.get("action_type") or "?") for o in d["outcomes"])
        A("| Action type | Outcomes measured |")
        A("| --- | ---: |")
        for k, v in sorted(by_type.items()):
            A(f"| {k} | {v} |")
        A("")
        A("_Observational, not causal. These are before/after windows around a "
          "change, with no holdout and no control for seasonality, price or "
          "competitor behaviour. Treat a consistent direction across many actions "
          "as signal; treat a single action's swing as noise._")
    else:
        A(NO_DATA)
        A("")
        A("**The loop is not closed.** Every recommendation is recorded, but none "
          "has been marked applied, so there is no before/after to measure and no "
          "basis for saying which advice worked. Everything in this brief is "
          "RULES-BASED ONLY — it is not evidence-weighted, and it must not be "
          "presented as proven.")
        A("")
        A("To start the compounding, after applying a batch in Seller Central:")
        A("")
        A("```")
        A("python -m src.main ads-mark --priority P0 --apply     # or --type / --id")
        A("```")
    A("")

    # ── 9. Questions for the manager ──
    A("## 9. Questions for the PPC manager")
    A("")
    A("These cover what the data cannot answer. They are questions, not claims — "
      "do not answer them from this brief.")
    A("")
    for q in _manager_questions(d, grade):
        A(f"- {q}")
    A("")

    # ── 10. Gaps ──
    A("## 10. Known gaps")
    A("")
    if d.get("gaps"):
        A("State these as limits rather than reasoning past them:")
        A("")
        for g in d["gaps"]:
            A(f"- {g}")
    else:
        A("_None recorded for this window._")
    A("")

    return "\n".join(L)


def _action_plan(d: dict, limit: int) -> list[dict]:
    """Concrete Seller Central steps, P0 first.

    Sourced ONLY from ads_recommendations plus its frozen evidence snapshot —
    never synthesised here — so every action traces to a stored row the operator
    can audit. Rank-blocked raises are excluded by construction: telling someone
    to "raise the bid" on a term the gate is holding would contradict the gate.
    """
    rank = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    out: list[dict] = []
    ordered = sorted(
        (r for r in d["recs"] if str(r.get("status") or "open") == "open"),
        key=lambda r: (rank.get(str(r.get("priority")), 9),
                       -float(r.get("impact_estimate") or 0)))

    for r in ordered:
        if len(out) >= limit:
            break
        e = _ev(r)
        typ = str(r.get("type") or "").upper()
        gate = e.get("rank_policy_applied")
        is_raise = "INCREASE" in typ or "RAISE" in typ

        # The one hard exclusion: a raise the gate is holding is not an action.
        if is_raise and (e.get("needs_rank_check") or gate in ("capped", "hold")):
            continue

        cid = e.get("campaign_id") or r.get("campaign_id") or "—"
        cname = r.get("campaign_name") or e.get("campaign_name") or "unknown campaign"
        ag = e.get("ad_group_name") or e.get("ad_group_id")
        where = f"Campaign **{cname}** (`{cid}`)"
        if ag:
            where += f" › ad group {ag}"
        where += f" › term `{r.get('entity_name')}`"

        ev_bits = []
        for label, key, fmt in (("spend", "spend", _money), ("sales", "sales", _money),
                                ("orders", "orders", str), ("ACOS", "acos", _pct),
                                ("CPC", "cpc", _money)):
            if e.get(key) is not None:
                ev_bits.append(f"{label} {fmt(e[key])}")
        if e.get("organic_rank") is not None:
            ev_bits.append(f"organic rank band {e['organic_rank']}")
        elif not is_raise:
            ev_bits.append("organic rank unknown (not required for a cut)")
        if e.get("placement"):
            ev_bits.append(f"placement {e['placement']}")

        risk = _risk_for(typ, e)

        out.append({
            "priority": str(r.get("priority") or "P3"),
            "title": f"{typ.replace('_', ' ').title()} — {r.get('entity_name')}",
            "where": where,
            "do": r.get("suggested_action") or "—",
            "evidence": ", ".join(ev_bits) if ev_bits else "no evidence snapshot stored",
            "why": e.get("why") or "—",
            "risk": risk,
        })
    return out


def _risk_for(typ: str, e: dict) -> str:
    """What happens if this action is skipped, matched to the action's direction.

    Matched on substrings of the stored type rather than an exact allow-list:
    an earlier version listed types that do not exist in this account
    ("ADD_NEGATIVE", "PAUSE_KEYWORD"), so every negate fell through to the
    growth branch and told the operator that failing to negate a waste term
    would "leave incremental volume unclaimed".
    """
    spend = _money(e["spend"]) if e.get("spend") is not None else None
    if "NEGATE" in typ or "PAUSE" in typ or "WASTED" in typ:
        return (f"Spend continues with no attributed return"
                + (f" — {spend} in this window alone." if spend else "."))
    if "REDUCE" in typ or "DECREASE" in typ:
        return ("Keeps running above the break-even line, so each additional "
                "sale loses money.")
    if "MODIFIER" in typ:
        return ("The placement keeps spending at its current efficiency. This is "
                "one setting per campaign, so it is cheap to change and cheap to "
                "revert.")
    if "HARVEST" in typ:
        return ("A converting query keeps running on broad/auto match, paying "
                "discovery CPC for traffic already proven.")
    if "INCREASE" in typ or "RAISE" in typ:
        return ("Leaves incremental volume unclaimed while the rank band says "
                "paid traffic here is additive.")
    return "Unaddressed; see the evidence above for the cost of leaving it."


def _manager_questions(d: dict, grade) -> list[str]:
    """Questions a human manager can answer and the data cannot.

    Deliberately non-numeric: every one asks for context, constraint or intent.
    Asking the manager to confirm a figure already in the brief would invite the
    model to treat the answer as new evidence.
    """
    qs: list[str] = [
        "What is the monthly ad budget ceiling, and is it a hard cap or a target? "
        "The plan below cuts waste before funding growth, which frees budget "
        "rather than requesting it.",
        "Which SKUs are supply-constrained in the next 60 days? Scaling spend on "
        "a SKU that will stock out wastes the spend and damages rank.",
        "Are there brand guidelines that forbid bidding on specific competitor or "
        "category terms, regardless of what the economics say?",
        "What seasonality should we expect in the next 8 weeks, and has any "
        "promotion, coupon or Lightning Deal been scheduled that would distort "
        "attributed sales?",
        "Is there new creative or A+ content planned? Placement ACOS is partly a "
        "conversion-rate problem, and no bid change fixes a listing that does not "
        "convert.",
        "What price changes are planned? Break-even ACOS is derived from current "
        "COGS and fees, so a price move re-bases every target in this brief.",
    ]
    if (d.get("non_brand_rank_eligible") or {}).get("terms", 0) == 0:
        qs.append("We have no non-brand terms with a usable organic rank band. Is "
                  "there a rank-tracking source you trust that we could feed in, "
                  "given the Ads API does not publish organic position?")
    if not d.get("outcomes"):
        qs.append("Who applies the changes in Seller Central, and can they run "
                  "`ads-mark` afterwards? Without that, the system can never "
                  "measure which recommendations actually worked.")
    if grade.dropped:
        qs.append(f"The grade dropped {', '.join(grade.dropped)} for lack of data. "
                  f"Which of these matters most to you? That decides what we "
                  f"instrument first.")
    if any("SB" in g or "SD" in g for g in d.get("gaps", [])):
        qs.append("Sponsored Brands / Display reporting is incomplete here. Do you "
                  "have console-level totals for those products we can reconcile "
                  "against?")
    return qs


def build_prompt(brief: str) -> str:
    """Wrap the brief with hard constraints for the receiving model."""
    from src.amazon_ads.brief_score import CONFIG

    L = [
        "You are a senior Amazon Ads strategist reviewing my account.",
        "",
        "Everything you need is in the brief below. It was generated from my own "
        "account data at export time. Treat it as the complete and only evidence "
        "available to you.",
        "",
        "## Hard rules",
        "",
    ]
    for i, rule in enumerate(CONFIG["receiving_model_rules"], 1):
        L.append(f"{i}. {rule}")
    L += [
        "",
        "## Produce exactly these sections, in this order",
        "",
    ]
    for s in CONFIG["required_output_sections"]:
        L.append(f"- **{s}**")
    L += [
        "",
        "Section B must be an ordered checklist a human can execute in Seller "
        "Central, drawn from the action plan in the brief. Section D must be "
        "questions, never assertions. Section E must name what data would most "
        "change your advice, ranked.",
        "",
        "--- ACCOUNT BRIEF ---",
        "",
        brief,
    ]
    return "\n".join(L)


def publish_brief(d: dict, brief: str, prompt: str) -> dict:
    """Store a rendered brief so the dashboard can serve it without Python.

    Vercel has no interpreter, so the "Copy full AI brief" button cannot build
    one. Reimplementing the builder in TypeScript would give the operator two
    grades for the same week whenever the two drifted, so instead the agent
    publishes what it rendered and the dashboard reads the newest row. The
    stored copy always carries generated_at, so a stale brief says so rather
    than passing as live.
    """
    from src.db import get_client

    grade = grade_window(d)
    row = {
        "as_of": d["as_of"], "window_start": d["start"], "days": d["days"],
        "score": round(grade.score, 1), "letter": grade.letter,
        "formula_version": grade.formula_version, "grade": grade.as_dict(),
        "brief_md": brief, "prompt_md": prompt, "chars": len(prompt),
    }
    try:
        get_client().table("ppc_briefs").insert(row).execute()
        return {"published": True, "score": row["score"], "letter": row["letter"]}
    except Exception as e:
        msg = str(e)
        if "ppc_briefs" in msg:
            return {"published": False,
                    "error": "Table ppc_briefs is missing — run "
                             "supabase/migration_ppc_briefs.sql."}
        return {"published": False, "error": msg[:200]}
