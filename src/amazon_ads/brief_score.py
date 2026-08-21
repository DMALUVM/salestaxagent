"""PPC performance grade — fixed arithmetic, no model judgement.

The brief is pasted into an LLM, so the score must not come FROM an LLM. A
number a model invented cannot be compared week over week: it drifts with
phrasing, and there is no way to audit why last week was 72 and this week is
68. Everything here is arithmetic over figures the brief already prints, with
weights and breakpoints in config/ppc_brief.json.

Three properties the callers depend on:

  **Auditable** — every component reports the raw inputs it scored, so the
  brief can show its own working and the operator can recompute by hand.

  **Honest about absence** — a component with no data is DROPPED and the
  remaining weights renormalised, never scored zero. Zero means "measured and
  bad"; dropped means "not measured". Conflating them would let a missing SQP
  sync look like a performance collapse.

  **Versioned** — formula_version travels with the score. Comparing a 1.0.0
  score to a 1.1.0 score is meaningless and the brief says so.

The completeness signals deliberately sit in a small multiplier rather than a
component: thin data should temper confidence in the grade, not manufacture a
performance result.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

_CONFIG_PATH = Path(__file__).resolve().parent.parent.parent / "config" / "ppc_brief.json"


def load_config() -> dict:
    with open(_CONFIG_PATH) as f:
        return json.load(f)


CONFIG = load_config()


def _clamp(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _lerp_down(value: float, full_at: float, zero_at: float) -> float:
    """100 at full_at, 0 at zero_at, linear between. Handles either direction."""
    if zero_at == full_at:
        return 100.0 if value <= full_at else 0.0
    return _clamp((zero_at - value) / (zero_at - full_at) * 100.0)


@dataclass
class Component:
    key: str
    label: str
    weight: float
    score: float | None          # None = no data, dropped from the weighting
    detail: str                  # the raw arithmetic, printed in the brief
    inputs: dict = field(default_factory=dict)

    @property
    def available(self) -> bool:
        return self.score is not None


@dataclass
class Grade:
    score: float
    letter: str
    reading: str
    components: list[Component]
    weighted_before_modifier: float
    completeness: float
    modifier: float
    formula_version: str
    dropped: list[str]

    def as_dict(self) -> dict:
        return {
            "score": round(self.score, 1),
            "letter": self.letter,
            "reading": self.reading,
            "weighted_before_modifier": round(self.weighted_before_modifier, 1),
            "completeness": round(self.completeness, 1),
            "modifier": round(self.modifier, 4),
            "formula_version": self.formula_version,
            "dropped": list(self.dropped),
            "components": [
                {"key": c.key, "label": c.label, "weight": c.weight,
                 "score": None if c.score is None else round(c.score, 1),
                 "detail": c.detail, "inputs": c.inputs}
                for c in self.components
            ],
        }


# ── individual components ────────────────────────────────────────────────

def _acos_component(cfg: dict, acos: float | None, breakeven: float | None) -> Component:
    c = cfg["acos_vs_breakeven"]
    if not acos or not breakeven:
        return Component("acos_vs_breakeven", c["label"], c["weight"], None,
                         "No attributed ad sales in the window — ACOS is undefined, "
                         "not zero. Component dropped.")
    ratio = acos / breakeven
    return Component(
        "acos_vs_breakeven", c["label"], c["weight"],
        _lerp_down(ratio, c["full_credit_at_ratio"], c["zero_credit_at_ratio"]),
        f"ACOS {acos:.1f}% ÷ break-even {breakeven:.1f}% = {ratio:.2f}x "
        f"(full credit ≤{c['full_credit_at_ratio']:.2f}x, zero at "
        f"{c['zero_credit_at_ratio']:.2f}x)",
        {"acos": round(acos, 2), "breakeven": round(breakeven, 2),
         "ratio": round(ratio, 3)})


def _tacos_component(cfg: dict, tacos: float | None) -> Component:
    c = cfg["tacos_vs_band"]
    if tacos is None:
        return Component("tacos_vs_band", c["label"], c["weight"], None,
                         "Total Amazon sales unavailable, so TACoS cannot be "
                         "computed. Component dropped.")
    lo, hi = c["band_min_pct"], c["band_max_pct"]
    if tacos < lo:
        score = float(c["below_band_score"])
        detail = (f"TACoS {tacos:.1f}% is BELOW the {lo:.0f}–{hi:.0f}% band — "
                  f"scored {score:.0f}, not 100: under-investment reads as "
                  f"efficiency but caps growth.")
    elif tacos <= hi:
        score, detail = 100.0, f"TACoS {tacos:.1f}% is inside the {lo:.0f}–{hi:.0f}% band."
    else:
        score = _lerp_down(tacos, hi, c["zero_credit_at_pct"])
        detail = (f"TACoS {tacos:.1f}% is ABOVE the {hi:.0f}% ceiling "
                  f"(zero at {c['zero_credit_at_pct']:.0f}%).")
    return Component("tacos_vs_band", c["label"], c["weight"], score, detail,
                     {"tacos": round(tacos, 2), "band": [lo, hi]})


def _waste_component(cfg: dict, waste_spend: float | None, total_spend: float) -> Component:
    c = cfg["wasted_spend"]
    if waste_spend is None or total_spend <= 0:
        return Component("wasted_spend", c["label"], c["weight"], None,
                         "No search-term rows for the window, so wasted spend "
                         "cannot be measured. Component dropped.")
    pct = waste_spend / total_spend * 100.0
    return Component(
        "wasted_spend", c["label"], c["weight"],
        _lerp_down(pct, c["full_credit_at_pct"], c["zero_credit_at_pct"]),
        f"${waste_spend:,.2f} on zero-order terms ÷ ${total_spend:,.2f} of "
        f"search-term spend (Sponsored Products only — Amazon reports no search "
        f"terms for SB/SD, so the denominator is scope-matched) = "
        f"{pct:.1f}% (full credit ≤{c['full_credit_at_pct']:.0f}%, zero at "
        f"{c['zero_credit_at_pct']:.0f}%)",
        {"waste_spend": round(waste_spend, 2), "total_spend": round(total_spend, 2),
         "waste_pct": round(pct, 2)})


def _placement_component(cfg: dict, placements: dict, account_acos: float | None) -> Component:
    c = cfg["placement_health"]
    if not placements or not account_acos:
        return Component("placement_health", c["label"], c["weight"], None,
                         "No placement rows clearing the spend floor. Component dropped.")
    worst_name, worst_ratio = None, None
    for name, v in placements.items():
        spend = float(v.get("spend") or 0)
        if spend < c["min_spend"]:
            continue
        sales = float(v.get("sales") or 0)
        # Spend with no sales is the worst case, not a missing case — skipping it
        # would hide exactly the placement most worth cutting.
        ratio = (c["no_sales_ratio"] if sales <= 0
                 else (spend / sales * 100.0) / account_acos)
        if worst_ratio is None or ratio > worst_ratio:
            worst_name, worst_ratio = name, ratio
    if worst_ratio is None:
        return Component("placement_health", c["label"], c["weight"], None,
                         f"No placement cleared the ${c['min_spend']:.0f} spend "
                         f"floor. Component dropped.")
    return Component(
        "placement_health", c["label"], c["weight"],
        _lerp_down(worst_ratio, c["full_credit_at_ratio"], c["zero_credit_at_ratio"]),
        f"Worst placement '{worst_name}' runs {worst_ratio:.2f}x the account ACOS "
        f"of {account_acos:.1f}% (full credit ≤{c['full_credit_at_ratio']:.1f}x, "
        f"zero at {c['zero_credit_at_ratio']:.1f}x)",
        {"placement": worst_name, "ratio": round(worst_ratio, 3),
         "account_acos": round(account_acos, 2)})


def _brand_component(cfg: dict, brand_spend: float | None, total_spend: float) -> Component:
    c = cfg["brand_defense"]
    if brand_spend is None or total_spend <= 0:
        return Component("brand_defense", c["label"], c["weight"], None,
                         "Search terms could not be classified as brand / non-brand. "
                         "Component dropped.")
    pct = brand_spend / total_spend * 100.0
    ceiling = c["spend_share_ceiling_pct"]
    return Component(
        "brand_defense", c["label"], c["weight"],
        _lerp_down(pct, ceiling, ceiling * c["zero_credit_multiple"]),
        f"${brand_spend:,.2f} of ${total_spend:,.2f} ({pct:.1f}%) goes to branded "
        f"queries (ceiling {ceiling:.0f}%, zero at "
        f"{ceiling * c['zero_credit_multiple']:.0f}%). We already win our own name "
        f"organically; spend here defends, it does not grow.",
        {"brand_spend": round(brand_spend, 2), "brand_share_pct": round(pct, 2),
         "ceiling_pct": ceiling})


def _non_brand_component(cfg: dict, acos: float | None, breakeven: float | None,
                         term_count: int) -> Component:
    c = cfg["non_brand_efficiency"]
    if not acos or not breakeven or term_count <= 0:
        return Component("non_brand_efficiency", c["label"], c["weight"], None,
                         f"No non-brand terms with a rank band of "
                         f"{c['eligible_rank_min']}+ and attributed sales. Rank-unknown "
                         f"terms are excluded rather than assumed. Component dropped.")
    ratio = acos / breakeven
    return Component(
        "non_brand_efficiency", c["label"], c["weight"],
        _lerp_down(ratio, c["full_credit_at_ratio"], c["zero_credit_at_ratio"]),
        f"{term_count} non-brand term(s) ranked {c['eligible_rank_min']}+ organically "
        f"run {acos:.1f}% ACOS = {ratio:.2f}x break-even. This is where paid traffic "
        f"is additive rather than cannibalising our own organic placement.",
        {"acos": round(acos, 2), "ratio": round(ratio, 3), "terms": term_count})


# ── completeness ─────────────────────────────────────────────────────────

def _completeness(cfg: dict, rank_coverage_pct: float | None,
                  sqp_age_days: int | None, ads_age_days: int | None) -> tuple[float, list[str]]:
    """0-100 data-completeness score plus the notes explaining it."""
    sig = cfg["signals"]
    parts: list[tuple[float, float]] = []
    notes: list[str] = []

    if rank_coverage_pct is not None:
        s = sig["rank_coverage"]
        v = _clamp(rank_coverage_pct / s["full_credit_at_pct"] * 100.0)
        parts.append((v, s["weight"]))
        notes.append(f"rank coverage {rank_coverage_pct:.0f}% of non-brand terms "
                     f"(full credit at {s['full_credit_at_pct']:.0f}%)")
    else:
        notes.append("rank coverage unknown")

    if sqp_age_days is not None:
        s = sig["sqp_freshness"]
        v = _lerp_down(float(sqp_age_days), s["full_credit_at_days"], s["zero_credit_at_days"])
        parts.append((v, s["weight"]))
        notes.append(f"newest SQP week ends {sqp_age_days}d before as-of "
                     f"(Amazon publishes ~7d in arrears)")
    else:
        notes.append("no SQP weeks stored")

    if ads_age_days is not None:
        s = sig["ads_freshness"]
        v = _lerp_down(float(ads_age_days), s["full_credit_at_days"], s["zero_credit_at_days"])
        parts.append((v, s["weight"]))
        notes.append(f"last ads sync {ads_age_days}d ago")
    else:
        notes.append("last ads sync unknown")

    if not parts:
        return 0.0, notes
    total_w = sum(w for _, w in parts)
    return sum(v * w for v, w in parts) / total_w, notes


# ── entry point ──────────────────────────────────────────────────────────

def compute_grade(*, acos: float | None, breakeven_acos: float | None,
                  tacos: float | None, waste_spend: float | None,
                  total_spend: float, placements: dict | None,
                  brand_spend: float | None, non_brand_acos: float | None,
                  non_brand_terms: int, rank_coverage_pct: float | None,
                  sqp_age_days: int | None, ads_age_days: int | None,
                  config: dict | None = None) -> Grade:
    """Score the window. Pure arithmetic over already-computed figures.

    Every argument is a number the brief prints elsewhere, so the grade can
    always be checked by hand against the tables above it.
    """
    cfg = (config or CONFIG)["grade"]
    comps = cfg["components"]

    components = [
        _acos_component(comps, acos, breakeven_acos),
        _tacos_component(comps, tacos),
        _waste_component(comps, waste_spend, total_spend),
        _placement_component(comps, placements or {}, acos),
        _brand_component(comps, brand_spend, total_spend),
        _non_brand_component(comps, non_brand_acos, breakeven_acos, non_brand_terms),
    ]

    live = [c for c in components if c.available]
    dropped = [c.key for c in components if not c.available]
    if live:
        total_w = sum(c.weight for c in live)
        weighted = sum((c.score or 0) * c.weight for c in live) / total_w
    else:
        # Nothing measurable. Zero would read as "terrible account"; this is
        # "no account data", and the brief must say which.
        weighted = 0.0

    completeness, notes = _completeness(
        cfg["completeness_modifier"], rank_coverage_pct, sqp_age_days, ads_age_days)
    m = cfg["completeness_modifier"]
    modifier = m["min_multiplier"] + (m["max_multiplier"] - m["min_multiplier"]) * (
        completeness / 100.0)
    final = _clamp(weighted * modifier)

    letter, reading = "F", ""
    for row in cfg["letters"]:
        if final >= row["min"]:
            letter, reading = row["letter"], row["reading"]
            break

    g = Grade(score=final, letter=letter, reading=reading, components=components,
              weighted_before_modifier=weighted, completeness=completeness,
              modifier=modifier,
              formula_version=(config or CONFIG)["formula_version"], dropped=dropped)
    g.completeness_notes = notes            # type: ignore[attr-defined]
    return g
