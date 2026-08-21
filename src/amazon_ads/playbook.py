"""PPC playbook — turn current metrics into an ordered list of decisions.

The dashboard already shows plenty of numbers. What it did not say is what to
DO first, so this reads the live KPIs and emits a small, ordered set of actions
with the figures that justified each one. Nothing here is a hardcoded dollar
amount: every threshold comes from config, and every number in the copy is read
from the database at call time.

The ordering is the opinion. Waste is cut before growth is funded, because a
bid raise on a losing placement compounds the loss, and because negatives and
placement cuts are reversible in a way that a bidding war is not:

  P0  stop the bleeding      — pure-waste negatives, placement cuts
  P1  defend what we own     — brand coverage, capped, never "scaled"
  P2  fund growth            — non-brand raises that pass rank + ACOS gates
  P3  rebalance              — discovery share back inside its target band

Brand terms are never a growth lever. We already win our own name; bidding
harder there buys traffic we would mostly get free, and after the 2025-10-31
rename that includes the legacy "Dr. Dave's Primal Essence" queries too.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

log = logging.getLogger(__name__)

P0, P1, P2, P3 = "P0", "P1", "P2", "P3"


@dataclass
class Action:
    priority: str
    title: str
    why: str
    do: str
    impact: float = 0.0
    evidence: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {"priority": self.priority, "title": self.title, "why": self.why,
                "do": self.do, "impact": round(self.impact, 2),
                "evidence": self.evidence}


_ORDER = {P0: 0, P1: 1, P2: 2, P3: 3}


def _usd(v: float) -> str:
    return f"${v:,.2f}"


def placement_actions(placements: list[dict], target_acos: float,
                      min_spend: float = 25.0) -> list[Action]:
    """Cut or bid down placements running well above break-even.

    Detail Page in particular tends to carry high ACOS on this account, and it
    is a placement modifier — one setting per campaign — so it is the cheapest
    large lever available. Spend floor keeps a single unlucky click off the list.
    """
    out: list[Action] = []
    for p in placements:
        spend = float(p.get("spend") or 0)
        sales = float(p.get("sales") or 0)
        name = str(p.get("placement") or "Unknown")
        if spend < min_spend:
            continue
        acos = (spend / sales * 100) if sales > 0 else None

        if acos is None:
            out.append(Action(
                P0, f"Cut {name} — {_usd(spend)} spent, zero attributed sales",
                f"{_usd(spend)} on {name} with no attributed sales in this window. "
                f"Not a bid problem; the placement is not converting at all.",
                f"In Campaign Manager set the {name} placement modifier to 0% "
                f"(or the lowest available) on the campaigns driving that spend, "
                f"then re-check in 7 days.",
                impact=spend,
                evidence={"placement": name, "spend": spend, "sales": 0.0,
                          "acos": None, "target_acos": target_acos}))
            continue

        if acos > target_acos * 1.5:
            excess = spend - (sales * target_acos / 100.0)
            out.append(Action(
                P0, f"Bid down {name} — {acos:.0f}% ACOS vs {target_acos:.0f}% target",
                f"{name} is running {acos:.0f}% ACOS on {_usd(spend)} spend against a "
                f"{target_acos:.0f}% break-even target — roughly {_usd(max(excess, 0))} "
                f"above what that revenue supports.",
                f"Reduce the {name} placement modifier on the heaviest-spending "
                f"campaigns until ACOS approaches {target_acos:.0f}%. Placement "
                f"modifiers are per-campaign, so this is one setting per campaign, "
                f"not a per-keyword sweep.",
                impact=max(excess, 0),
                evidence={"placement": name, "spend": spend, "sales": sales,
                          "acos": round(acos, 1), "target_acos": target_acos}))
    return out


def brand_actions(recs: list[dict]) -> list[Action]:
    """Defend brand terms: cap, negate waste, never scale.

    Brand queries — both the current name and the pre-rename "Dr. Dave's Primal
    Essence" era — are already won organically. The action is to hold coverage
    cheaply, not to spend into it.
    """
    out: list[Action] = []
    capped = [r for r in recs
              if (r.get("evidence") or {}).get("rank_policy_applied") in
              ("capped", "hold")]
    if not capped:
        return out

    def _saved(rows: list[dict]) -> float:
        return sum(
            float((r.get("evidence") or {}).get("proposed_bid_before_rank_gate") or 0)
            - float((r.get("evidence") or {}).get("suggested_bid") or 0)
            for r in rows)

    # A term capped for being BRANDED and one capped for ranking 4-7 organically
    # are different decisions with different follow-ups, so they are never
    # merged into one "brand" card. Calling a generic head term like "chap
    # stick" a brand term would misrepresent the catalogue to the operator.
    branded = [r for r in capped
               if (r.get("evidence") or {}).get("rank_branded")]
    rank_only = [r for r in capped if r not in branded]

    if branded:
        names = ", ".join(str(r.get("entity_name"))[:28] for r in branded[:4])
        out.append(Action(
            P1, f"Defend brand — {len(branded)} brand term(s) capped, not scaled",
            f"{len(branded)} proposed raises are on BRAND queries (current name and "
            f"the pre-2025-10-31 'Dr. Dave's Primal Essence' era both count). We "
            f"already win these organically; bidding harder buys clicks we would "
            f"largely get free.",
            f"Leave these at the capped bid: {names}. Brand defense is cheap "
            f"coverage, not conquest — growth has to come from non-brand terms.",
            impact=_saved(branded),
            evidence={"capped_count": len(branded), "reason": "branded",
                      "terms": [str(r.get("entity_name")) for r in branded[:10]]}))

    if rank_only:
        names = ", ".join(str(r.get("entity_name"))[:28] for r in rank_only[:4])
        out.append(Action(
            P1, f"Cap {len(rank_only)} term(s) we already rank for organically",
            f"{len(rank_only)} raises were capped because our organic rank band is "
            f"top-7 on those queries — NOT because they are brand terms. Paid "
            f"traffic there is partly cannibalising our own organic placement.",
            f"Hold at the capped bid: {names}. Re-check after the next SQP sync: "
            f"if the band drops, the cap loosens automatically.",
            impact=_saved(rank_only),
            evidence={"capped_count": len(rank_only), "reason": "organic_rank",
                      "terms": [str(r.get("entity_name")) for r in rank_only[:10]]}))
    return out


def growth_actions(recs: list[dict]) -> list[Action]:
    """Fund the non-brand raises that already passed both gates."""
    out: list[Action] = []
    full = [r for r in recs
            if (r.get("evidence") or {}).get("rank_policy_applied") == "full_increase"]
    if full:
        impact = sum(float(r.get("impact") or 0) for r in full)
        out.append(Action(
            P2, f"Scale {len(full)} non-brand term(s) that passed both gates",
            f"{len(full)} bid increases cleared the ACOS rules AND the organic-rank "
            f"gate — low organic coverage, so paid traffic here is additive rather "
            f"than cannibalised.",
            "Apply these raises in Campaign Manager. They are the only increases "
            "on the list backed by both conversion economics and rank evidence.",
            impact=impact,
            evidence={"count": len(full),
                      "terms": [str(r.get("entity_name")) for r in full[:10]]}))

    pending = [r for r in recs
               if (r.get("evidence") or {}).get("needs_rank_check")]
    if pending:
        out.append(Action(
            P3, f"{len(pending)} raise(s) waiting on a manual rank check",
            "These are above the high-bid review threshold with no organic rank on "
            "file, so they were held rather than raised blind.",
            "Check the SERP for each, or wait for Monday's SQP sync to fill the "
            "rank in. Do not auto-apply these.",
            impact=0.0,
            evidence={"count": len(pending),
                      "terms": [str(r.get("entity_name")) for r in pending[:10]]}))
    return out


def waste_actions(recs: list[dict]) -> list[Action]:
    """Pure-waste negatives — the cheapest, most reversible win available."""
    out: list[Action] = []
    waste = [r for r in recs
             if str(r.get("type") or "").upper() in
             ("ADD_NEGATIVE", "WASTED_SPEND_ROLLUP", "PAUSE_KEYWORD")]
    if waste:
        impact = sum(float(r.get("impact") or 0) for r in waste)
        out.append(Action(
            P0, f"Apply {len(waste)} negative/pause action(s) — {_usd(impact)} at stake",
            f"{len(waste)} queued actions target spend with no conversions. This is "
            f"recovered budget, not a trade-off.",
            "Work the Actions tab top-down and apply the negatives first. They are "
            "reversible and take effect immediately, unlike bid changes which need "
            "a week to read.",
            impact=impact,
            evidence={"count": len(waste)}))
    return out


def discovery_actions(roles: list[dict], target_max_pct: float = 30.0) -> list[Action]:
    """Pull discovery/prospecting spend back inside its target band."""
    out: list[Action] = []
    for r in roles:
        if str(r.get("role")) != "discovery":
            continue
        share = float(r.get("budgetSharePct") or 0)
        band = r.get("targetSharePct") or {}
        ceiling = float(band.get("max") or target_max_pct)
        if share <= ceiling:
            continue
        spend = float(r.get("spend") or 0)
        over = (share - ceiling) / 100.0 * spend if share else 0
        out.append(Action(
            P3, f"Discovery is {share:.0f}% of spend vs a {ceiling:.0f}% ceiling",
            f"Discovery/prospecting is taking {share:.0f}% of budget ({_usd(spend)}) "
            f"against a {ceiling:.0f}% target ceiling — roughly {_usd(over)} above band.",
            "Tighten prospecting: convert proven discovery search terms to exact "
            "campaigns, then lower broad/auto budgets. More broad spend is not the "
            "growth lever here — harvesting what discovery already found is.",
            impact=over,
            evidence={"share_pct": share, "ceiling_pct": ceiling, "spend": spend}))
    return out


def build_playbook(target_acos: float, recs: list[dict],
                   placements: list[dict], roles: list[dict]) -> list[Action]:
    """Assemble and order the whole playbook. Pure — callers fetch the inputs."""
    actions: list[Action] = []
    actions += waste_actions(recs)
    actions += placement_actions(placements, target_acos)
    actions += brand_actions(recs)
    actions += growth_actions(recs)
    actions += discovery_actions(roles)
    actions.sort(key=lambda a: (_ORDER.get(a.priority, 9), -a.impact))
    return actions


WEEKLY_CADENCE = [
    "Monday: the SQP sync runs automatically at 10:00 America/Los_Angeles, "
    "after Amazon publishes the prior Sunday-Saturday week.",
    "Then rebuild recommendations (`ads-actions`) so the rank gate sees the "
    "fresh bands.",
    "Apply P0 first — negatives and Detail Page / high-ACOS placement cuts. "
    "Recovered budget, reversible, immediate.",
    "Then P2 — the non-brand raises that passed BOTH the ACOS rules and the "
    "rank gate.",
    "Leave needs_rank_check items manual. They are above the high-bid threshold "
    "with no rank on file; raising them blind is the mistake the gate exists to "
    "prevent.",
    "Never scale brand terms as a growth lever — cap them and move on.",
]
