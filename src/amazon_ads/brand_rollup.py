"""Branded vs non-branded weekly rollups.

The automated equivalent of the DASHBOARD sheet in the manual Branded Market
Share Tracker. Pure functions over sqp_weekly rows so the numbers are testable
and the CLI, dashboard and any export agree.

Three different ratios get confused constantly, so they are named explicitly:

  **branded mix**  — of OUR purchases, what fraction came from branded queries.
                     Denominator is us. High mix means growth depends on people
                     already searching our name.

  **market share** — of the whole marketplace's purchases on the queries we
                     appear in, what fraction were ours. Denominator is the
                     market.

  **share, branded vs non-branded** — the same market-share ratio computed
                     within each bucket. This is the interesting one: high
                     branded share plus tiny non-brand share is the classic
                     "we own our name and nothing else" position.

SCOPE GAP, stated rather than buried: SP-API SQP is the ASIN view. It only
covers queries where our ASINs actually appeared. Brand View — the Seller
Central screen the manual tracker pastes from — also lists queries where the
brand has zero impressions. So "market share" here means share of the queries
we show up in, which is systematically FLATTERING versus true category share.
Trend over time is trustworthy; the absolute level is not Brand View parity.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field


# A single impression on a 20,000-purchase query is not "presence". Requiring a
# meaningful impression share is what separates queries we genuinely compete on
# from ones our ASIN merely brushed against. 1% is a judgement call, not a
# derived constant — tune it with the operator rather than treating it as fact.
PRESENCE_MIN_IMPRESSION_SHARE = 0.01


def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def _i(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


@dataclass
class Bucket:
    purchases: int = 0            # ours
    market_purchases: int = 0     # whole marketplace, same queries
    clicks: int = 0
    market_clicks: int = 0
    impressions: int = 0
    market_impressions: int = 0
    queries: int = 0
    # Same figures restricted to queries where we actually had presence.
    # Without this the denominator is dominated by huge queries our ASIN
    # merely brushed against ("baking soda", "aquaphor", competitor brands) —
    # 73% of the live non-brand denominator came from queries with ~0%
    # impression share and zero sales, which makes the headline share number
    # look catastrophic for reasons that have nothing to do with performance.
    market_purchases_present: int = 0
    purchases_present: int = 0
    queries_present: int = 0

    @property
    def share(self) -> float | None:
        """Our purchases as a fraction of market purchases on these queries."""
        if self.market_purchases <= 0:
            return None
        return self.purchases / self.market_purchases

    @property
    def share_present(self) -> float | None:
        """Share on queries where we actually appeared (impression share > 0).

        The business-meaningful figure. `share` is the raw aggregate and is
        reported alongside so the scoping is visible rather than hidden.
        """
        if self.market_purchases_present <= 0:
            return None
        return self.purchases_present / self.market_purchases_present

    @property
    def click_share(self) -> float | None:
        if self.market_clicks <= 0:
            return None
        return self.clicks / self.market_clicks


@dataclass
class WeekRollup:
    week_start: str
    branded: Bucket = field(default_factory=Bucket)
    non_branded: Bucket = field(default_factory=Bucket)

    @property
    def total_purchases(self) -> int:
        return self.branded.purchases + self.non_branded.purchases

    @property
    def branded_mix(self) -> float | None:
        """Of OUR purchases, the fraction from branded queries."""
        total = self.total_purchases
        if total <= 0:
            return None
        return self.branded.purchases / total

    @property
    def non_branded_mix(self) -> float | None:
        m = self.branded_mix
        return None if m is None else 1.0 - m

    def as_dict(self) -> dict:
        return {
            "week_start": self.week_start,
            "branded_purchases": self.branded.purchases,
            "non_branded_purchases": self.non_branded.purchases,
            "total_purchases": self.total_purchases,
            "branded_mix": self.branded_mix,
            "non_branded_mix": self.non_branded_mix,
            "branded_share": self.branded.share,
            "non_branded_share": self.non_branded.share,
            "branded_share_present": self.branded.share_present,
            "non_branded_share_present": self.non_branded.share_present,
            "non_branded_queries_present": self.non_branded.queries_present,
            "branded_queries": self.branded.queries,
            "non_branded_queries": self.non_branded.queries,
        }


def rollup_weeks(rows: list[dict]) -> list[WeekRollup]:
    """Aggregate sqp_weekly rows into one rollup per week, oldest first.

    Rows are per (asin, query, week). Summing across ASINs double-counts the
    market denominator when two of our ASINs surface on the same query, so the
    denominator is taken once per (week, query) while our own counts are summed.
    """
    weeks: dict[str, WeekRollup] = {}
    seen_market: set[tuple] = set()

    for r in sorted(rows, key=lambda x: (str(x.get("week_start")),
                                         str(x.get("query_normalized")))):
        wk = str(r.get("week_start") or "")
        if not wk:
            continue
        w = weeks.get(wk)
        if w is None:
            w = WeekRollup(week_start=wk)
            weeks[wk] = w

        b = w.branded if r.get("is_branded") else w.non_branded
        b.purchases += _i(r.get("asin_purchases"))
        b.clicks += _i(r.get("asin_clicks"))
        b.impressions += _i(r.get("asin_impressions"))

        present = _f(r.get("impression_share")) >= PRESENCE_MIN_IMPRESSION_SHARE
        if present:
            b.purchases_present += _i(r.get("asin_purchases"))

        # Market totals are a property of the QUERY, not of our ASIN. Counting
        # them once per (week, query) is what keeps share from collapsing when
        # a query is served by several of our ASINs.
        key = (wk, str(r.get("query_normalized")))
        if key not in seen_market:
            seen_market.add(key)
            b.queries += 1
            b.market_purchases += _i(r.get("total_purchases"))
            if present:
                b.queries_present += 1
                b.market_purchases_present += _i(r.get("total_purchases"))
            b.market_clicks += _i(r.get("total_clicks"))
            b.market_impressions += _i(r.get("total_impressions"))

    return [weeks[k] for k in sorted(weeks)]


@dataclass
class Opportunity:
    query: str
    market_purchases: int
    our_purchases: int
    share: float | None
    rank_band: int | None
    week_start: str

    def as_dict(self) -> dict:
        return {"query": self.query, "market_purchases": self.market_purchases,
                "our_purchases": self.our_purchases, "share": self.share,
                "rank_band": self.rank_band, "week_start": self.week_start}


def top_opportunities(rows: list[dict], ranks: dict | None = None,
                      limit: int = 20,
                      max_share: float = 0.10) -> list[Opportunity]:
    """Non-brand queries with real market volume where our share is small.

    The meeting list: big category demand we are barely capturing. Branded
    queries are excluded by construction — we already win those, and "increase
    share of your own name" is not a growth plan.

    Ranked by the market purchases we are NOT getting, which is the size of the
    prize rather than merely the size of the query.
    """
    ranks = ranks or {}
    latest = max((str(r.get("week_start") or "") for r in rows), default="")
    if not latest:
        return []

    agg: dict[str, dict] = defaultdict(
        lambda: {"market": 0, "ours": 0, "counted": False})
    for r in rows:
        if str(r.get("week_start")) != latest or r.get("is_branded"):
            continue
        q = str(r.get("query_normalized") or "")
        if not q:
            continue
        a = agg[q]
        a["ours"] += _i(r.get("asin_purchases"))
        if not a["counted"]:
            a["counted"] = True
            a["market"] += _i(r.get("total_purchases"))

    out: list[Opportunity] = []
    for q, a in agg.items():
        if a["market"] <= 0:
            continue
        share = a["ours"] / a["market"]
        if share > max_share:
            continue
        band = None
        row = ranks.get(q)
        if row is not None:
            band = row.get("organic_rank")
        out.append(Opportunity(query=q, market_purchases=a["market"],
                               our_purchases=a["ours"], share=share,
                               rank_band=band, week_start=latest))

    out.sort(key=lambda o: -(o.market_purchases - o.our_purchases))
    return out[:limit]


def callouts(weeks: list[WeekRollup],
             high_mix: float = 0.50,
             low_non_brand_share: float = 0.05) -> list[str]:
    """Plain-language findings for a leadership meeting."""
    if not weeks:
        return ["No SQP weeks stored yet — run the weekly sync."]

    latest = weeks[-1]
    out: list[str] = []
    mix = latest.branded_mix
    nb_share = latest.non_branded.share
    b_share = latest.branded.share

    if mix is not None and mix >= high_mix:
        out.append(
            f"{mix:.0%} of our purchases come from branded queries — demand is "
            f"largely people already looking for us, not category discovery.")
    if nb_share is not None and nb_share <= low_non_brand_share:
        out.append(
            f"Non-brand share is {nb_share:.1%} of the market on queries we "
            f"appear in — the category is essentially uncaptured.")
    if b_share is not None and nb_share is not None and b_share > 0 and nb_share > 0:
        out.append(
            f"We convert {b_share:.0%} of branded demand vs {nb_share:.1%} of "
            f"non-brand demand — a {b_share / nb_share:.0f}x gap.")

    if len(weeks) >= 2:
        prev = weeks[-2]
        if prev.branded_mix is not None and mix is not None:
            delta = mix - prev.branded_mix
            if abs(delta) >= 0.02:
                direction = "more" if delta > 0 else "less"
                out.append(
                    f"Branded mix moved {delta:+.1%} week over week — we are "
                    f"getting {direction} dependent on brand demand.")
    return out or ["No threshold callouts this week."]
