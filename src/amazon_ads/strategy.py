"""PPC strategy primitives: campaign roles and break-even ACOS.

Roles express *what a campaign is for*, so spend can be judged against the right
bar instead of one global ACOS target:

  discovery — finds new converting terms (auto/broad/phrase). Judged on terms
              harvested, not on ACOS.
  profit    — harvested exact keywords run at or under break-even. The engine.
  ranking   — time-boxed pushes on hero ASINs; tolerates ACOS above break-even
              on purpose.
  defense   — protects own listings and brand terms from conquesting.

Break-even ACOS is the ACOS at which a sale contributes exactly zero, derived
from the same inputs the Contribution P&L uses (referral %, per-unit FBA fee,
sku_costs). It does NOT change the P&L formula — it reads the same numbers to
answer a different question: how much ad spend can this SKU carry?

Config lives in config/ads_strategy.json.
"""
from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from pathlib import Path

from src.rules import PNL_DEFAULT_REFERRAL_PCT, PNL_DEFAULT_FBA_FEE_PER_UNIT

log = logging.getLogger(__name__)

_CONFIG_PATH = Path(__file__).resolve().parents[2] / "config" / "ads_strategy.json"

with open(_CONFIG_PATH) as fh:
    STRATEGY: dict = json.load(fh)

#: Settings the operator may override from the dashboard. Anything outside this
#: allowlist is rejected by the settings API, so every key that reaches the DB
#: is one both readers actually honour — no silently-ignored overrides.
OVERRIDABLE_PATHS: tuple[tuple[str, ...], ...] = (("roles", "targets"),)


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursive merge; override wins, missing keys fall through to base."""
    out = dict(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_overrides() -> dict:
    """Operator overrides from ads_strategy_settings, or {} if unavailable.

    A missing table, missing row or unreachable DB all mean "no overrides" —
    the file defaults still apply, so tuning is additive and never a hard
    dependency for the nightly jobs.
    """
    try:
        from src.db import get_client
        resp = (get_client().table("ads_strategy_settings")
                .select("settings").eq("id", "default").limit(1).execute())
        row = (resp.data or [{}])[0]
        settings = row.get("settings") or {}
        return settings if isinstance(settings, dict) else {}
    except Exception as e:
        if "ads_strategy_settings" in str(e):
            log.debug("ads_strategy_settings not present — using file defaults")
        else:
            log.warning("Could not read ads_strategy_settings: %s", str(e)[:160])
        return {}


def load_strategy() -> dict:
    """File defaults deep-merged with operator overrides.

    Read fresh each call: the nightly jobs run once, and the dashboard hits its
    own route, so there is no hot loop to cache for — and a stale cache here
    would mean a saved target silently not applying.
    """
    return _deep_merge(STRATEGY, load_overrides())


def role_target(role: str, strategy: dict | None = None) -> dict | None:
    """Target spend-share band {min,max} for a role, or None if unset."""
    cfg = strategy or load_strategy()
    t = (cfg.get("roles", {}).get("targets") or {}).get(role)
    if not isinstance(t, dict):
        return None
    if not isinstance(t.get("min"), (int, float)) or not isinstance(t.get("max"), (int, float)):
        return None
    return {"min": float(t["min"]), "max": float(t["max"])}


def share_status(role: str, share_pct: float,
                 strategy: dict | None = None) -> str | None:
    """'above' / 'below' / 'in_range' against the configured band.

    Same comparison the dashboard renders, so both sides agree by construction.
    """
    t = role_target(role, strategy)
    if not t:
        return None
    if share_pct > t["max"]:
        return "above"
    if share_pct < t["min"]:
        return "below"
    return "in_range"


ROLE_ORDER: list[str] = STRATEGY["roles"]["order"]
ROLE_LABELS: dict[str, str] = STRATEGY["roles"]["labels"]
ROLE_DEFAULT: str = STRATEGY["roles"]["default"]
THRESHOLDS: dict = STRATEGY["thresholds"]
WINDOWS: dict = STRATEGY["windows"]

# Compile once; first match in ROLE_ORDER wins.
_ROLE_PATTERNS: list[tuple[str, list[re.Pattern]]] = [
    (role, [re.compile(p, re.I) for p in STRATEGY["roles"]["patterns"].get(role, [])])
    for role in ROLE_ORDER
]


def classify_campaign(campaign_name: str, match_types: set[str] | None = None) -> str:
    """Role for a campaign, from its name (and match types when known).

    Name patterns are checked in ROLE_ORDER so the most specific intent wins:
    a campaign called "Hero KW - Exact" is ranking, not profit, because ranking
    is evaluated first. Falls back to match type, then to the configured
    default (discovery) — an unclassified campaign is exploratory until named
    otherwise, which is the safe assumption for budget decisions.
    """
    name = campaign_name or ""
    for role, patterns in _ROLE_PATTERNS:
        if any(p.search(name) for p in patterns):
            return role
    if match_types:
        lowered = {m.lower() for m in match_types}
        if "exact" in lowered:
            return "profit"
        if lowered & {"broad", "phrase"} or any("targeting" in m for m in lowered):
            return "discovery"
    return ROLE_DEFAULT


def role_rollup(campaign_rows: list[dict], total_amazon_sales: float = 0.0) -> list[dict]:
    """Aggregate campaign rows into per-role budget share.

    `campaign_rows` need campaign_name, spend, sales (ad sales), clicks, orders.
    TACoS per role is that role's spend over TOTAL Amazon sales — i.e. what
    share of the business's revenue this role consumes, which is the number
    that decides whether a role is affordable.
    """
    buckets: dict[str, dict] = defaultdict(
        lambda: {"spend": 0.0, "sales": 0.0, "clicks": 0, "orders": 0, "campaigns": 0}
    )
    for r in campaign_rows:
        role = r.get("role") or classify_campaign(str(r.get("campaign_name", "")))
        b = buckets[role]
        b["spend"] += float(r.get("spend") or 0)
        b["sales"] += float(r.get("sales") or r.get("sales_14d") or 0)
        b["clicks"] += int(r.get("clicks") or 0)
        b["orders"] += int(r.get("orders") or r.get("orders_14d") or 0)
        b["campaigns"] += 1

    total_spend = sum(b["spend"] for b in buckets.values())
    out = []
    for role in ROLE_ORDER:
        b = buckets.get(role)
        if not b:
            continue
        out.append({
            "role": role,
            "label": ROLE_LABELS.get(role, role),
            "campaigns": b["campaigns"],
            "spend": round(b["spend"], 2),
            "sales": round(b["sales"], 2),
            "clicks": b["clicks"],
            "orders": b["orders"],
            "budget_share_pct": round(b["spend"] / total_spend * 100, 1) if total_spend else 0.0,
            "acos": round(b["spend"] / b["sales"] * 100, 1) if b["sales"] > 0 else None,
            "roas": round(b["sales"] / b["spend"], 2) if b["spend"] > 0 else None,
            "cvr": round(b["orders"] / b["clicks"] * 100, 1) if b["clicks"] else None,
            "tacos": round(b["spend"] / total_amazon_sales * 100, 2) if total_amazon_sales > 0 else None,
        })
    return out


def breakeven_acos(asp: float, cogs_per_unit: float,
                   referral_pct: float | None = None,
                   fba_fee_per_unit: float | None = None) -> float | None:
    """ACOS at which one more sale contributes exactly zero, as a percentage.

        contribution before ads = asp - referral - fba - cogs
        break-even ACOS         = contribution_before_ads / asp

    Same inputs as the Contribution P&L, asked in the other direction. Returns
    None when the unit is already unprofitable before any ad spend — there is
    no ACOS that makes it work, and callers must not silently treat that as 0.
    """
    if asp <= 0:
        return None
    referral = asp * (PNL_DEFAULT_REFERRAL_PCT if referral_pct is None else referral_pct)
    fba = PNL_DEFAULT_FBA_FEE_PER_UNIT if fba_fee_per_unit is None else fba_fee_per_unit
    margin = asp - referral - fba - cogs_per_unit
    if margin <= 0:
        return None
    return round(margin / asp * 100, 1)


def breakeven_by_sku(window_days: int = 30) -> dict[str, dict]:
    """{sku: {asp, cogs_per_unit, breakeven_acos, target_acos, units}}.

    ASP comes from the stored SKU-grain P&L rows (gross_sales / units) over a
    window ending at the LA closed-day as-of, so it reflects what the SKU
    actually sold for including promos — not a list price. Target ACOS applies
    a safety margin so recommendations aim below break-even, not at it.
    """
    from src.db import fetch_all, get_client
    from src.rules import amazon_as_of, window_start

    as_of = amazon_as_of()
    start = window_start(as_of, window_days)

    try:
        costs = {r["sku"]: float(r.get("cogs_per_unit") or 0) for r in fetch_all("sku_costs")}
    except Exception:
        log.exception("Could not read sku_costs")
        costs = {}

    agg: dict[str, dict] = defaultdict(lambda: {"sales": 0.0, "units": 0})
    try:
        client = get_client()
        offset, page_size = 0, 1000
        while True:
            resp = (client.table("pnl_daily")
                    .select("sku,gross_sales,units")
                    .eq("grain", "sku")
                    .gte("date", start.isoformat())
                    .lte("date", as_of.isoformat())
                    .range(offset, offset + page_size - 1)
                    .execute())
            page = resp.data or []
            for r in page:
                sku = r.get("sku") or ""
                if not sku or sku.startswith("__"):
                    continue
                agg[sku]["sales"] += float(r.get("gross_sales") or 0)
                agg[sku]["units"] += int(r.get("units") or 0)
            if len(page) < page_size:
                break
            offset += page_size
    except Exception:
        log.exception("Could not read SKU-grain P&L rows; break-even unavailable")
        return {}

    safety = float(THRESHOLDS.get("breakeven_safety_margin", 0.9))
    fallback = float(THRESHOLDS.get("target_acos_fallback", 30.0))

    out: dict[str, dict] = {}
    for sku, a in agg.items():
        if a["units"] <= 0:
            continue
        asp = round(a["sales"] / a["units"], 2)
        cogs = costs.get(sku)
        be = breakeven_acos(asp, cogs) if cogs is not None else None
        out[sku] = {
            "asp": asp,
            "units": a["units"],
            "cogs_per_unit": cogs,
            "breakeven_acos": be,
            # Aim under break-even; without a cost we cannot compute one, so
            # fall back to the configured global target rather than guessing.
            "target_acos": round(be * safety, 1) if be else fallback,
            "target_basis": "breakeven" if be else "fallback",
        }
    return out


def account_target_acos(breakevens: dict[str, dict] | None = None) -> tuple[float, str]:
    """Unit-weighted account target ACOS, for terms that span SKUs.

    Search terms are not attributable to one SKU, so a single account-level bar
    is needed. Weighting by units keeps a low-volume outlier from moving it.
    Returns (target_acos, basis).
    """
    be = breakevens if breakevens is not None else breakeven_by_sku()
    priced = [(v["target_acos"], v["units"]) for v in be.values()
              if v.get("target_basis") == "breakeven"]
    total_units = sum(u for _, u in priced)
    if not total_units:
        return float(THRESHOLDS.get("target_acos_fallback", 30.0)), "fallback"
    weighted = sum(t * u for t, u in priced) / total_units
    return round(weighted, 1), "breakeven_weighted"
