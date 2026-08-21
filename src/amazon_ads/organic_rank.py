"""Organic search rank, and the bid policy that uses it.

The PPC action plan only sees paid metrics, so it cannot tell whether a click
would have arrived from an organic placement anyway. On head and brand terms
where we already rank #1–3, bidding harder buys traffic we largely own.

**Amazon's Advertising API does not expose organic SERP rank.** Nothing here
infers it from ads data. Rank arrives from one of:

  - `sqp`    Brand Analytics Search Query Performance export (official, weekly)
  - `manual` an operator-entered override
  - other    an external rank tracker, via the stub interface below

What this buys and what it does not:

  It buys a **cannibalization guard** — "we may already get this click for
  free, so do not chase it hard." It is NOT an incrementality measurement. It
  cannot say a given ad click was wasted; only a holdout test can. Rank is also
  a snapshot of a moving target, which is why stale data is treated as unknown
  rather than trusted.

The gate is deliberately one-directional: it only ever restrains bid INCREASES.
Negatives, pauses and bid decreases are how waste gets cut, and they are never
blocked by rank — a keyword we rank #1 for is if anything a better candidate
for cutting paid spend, not a worse one.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import date, timedelta

log = logging.getLogger(__name__)

TABLE = "keyword_organic_rank"

# Cannibalization risk bands. The boundaries are policy, not physics — they
# live in config so they can be tuned without touching this logic.
RISK_HIGH = "high"
RISK_MEDIUM = "medium"
RISK_LOW = "low"
RISK_UNKNOWN = "unknown"

# What the gate decided, recorded on every action for review.
POLICY_FULL = "full_increase"
POLICY_CAPPED = "capped"
POLICY_HOLD = "hold"
POLICY_NEEDS_CHECK = "needs_rank_check"
POLICY_UNKNOWN_OK = "rank_unknown_allowed"
POLICY_DISABLED = "gating_disabled"


def normalize_keyword(text: str | None) -> str:
    """Lowercase, trim, collapse whitespace.

    The join key between rank data and search terms. Search terms are stored
    raw, so both sides are normalised at lookup time rather than at write time —
    changing the stored form would break the recommendations table's UNIQUE
    (type, entity_name, campaign_id) against history.
    """
    if not text:
        return ""
    return re.sub(r"\s+", " ", str(text).strip().lower())


def load_config() -> dict:
    """Gating config, merged with any operator overrides."""
    from src.amazon_ads.strategy import load_strategy

    try:
        cfg = (load_strategy() or {}).get("organic_rank_gating") or {}
    except Exception:
        cfg = {}
    return {
        "enabled": cfg.get("enabled", True),
        "high_bid_threshold": float(cfg.get("high_bid_threshold", 2.30)),
        "rank_1_3_max_increase_pct": float(cfg.get("rank_1_3_max_increase_pct", 8)),
        "rank_4_7_max_increase_pct": float(cfg.get("rank_4_7_max_increase_pct", 12)),
        "stale_after_days": int(cfg.get("stale_after_days", 14)),
        "brand_tokens": [normalize_keyword(t) for t in (cfg.get("brand_tokens") or [])],
        "default_asin": cfg.get("default_asin") or "",
        # Automated SQP pull settings; consumed by src/amazon_sp/sqp.py.
        "sqp_auto": cfg.get("sqp_auto") or {},
    }


def is_branded(keyword: str, brand_tokens: list[str] | None = None) -> bool:
    """Does the query name our brand?

    Branded head terms are the worst cannibalization case — we almost always
    rank #1 for our own name — so they are treated as rank 1–3 until rank data
    says otherwise, rather than waiting for an SQP export to prove it.

    Delegates to src/amazon_ads/brand_terms.py so the PPC gate and the branded
    market-share tracker cannot disagree about what "branded" means. The old
    behaviour here was a naive substring test, which classified "beef tallow
    lip balm" as branded because "tallow" is inside "tallowbourn" — capping
    bids on exactly the generic head terms we want to win. `brand_tokens` is
    still accepted for callers that pass an explicit list (tests, overrides).
    """
    k = normalize_keyword(keyword)
    if not k:
        return False

    if brand_tokens:
        # Explicit list: whole-word match, never substring.
        from src.amazon_ads.brand_terms import BrandRules, normalize as _bn

        toks = {_bn(t) for t in brand_tokens if _bn(t)}
        rules = BrandRules(
            phrases=tuple(sorted((t for t in toks if " " in t), key=lambda s: -len(s))),
            tokens=frozenset(t for t in toks if " " not in t))
        return rules.match(keyword) is not None

    from src.amazon_ads.brand_terms import is_branded as _shared
    return _shared(keyword)


@dataclass
class RankInfo:
    """What is known about our organic position for one query."""
    rank: int | None = None
    page: int | None = None
    source: str | None = None
    as_of: str | None = None
    stale: bool = False
    branded: bool = False
    # The rank actually used for gating. Stale rows keep `rank` for display but
    # gate as unknown, so the operator still sees the last known position.
    effective_rank: int | None = None

    @property
    def risk(self) -> str:
        r = self.effective_rank
        if r is None:
            return RISK_UNKNOWN
        if r <= 3:
            return RISK_HIGH
        if r <= 7:
            return RISK_MEDIUM
        return RISK_LOW


def build_rank_info(row: dict | None, keyword: str, cfg: dict,
                    today: date) -> RankInfo:
    """Turn a stored rank row (or its absence) into a gating decision input."""
    branded = is_branded(keyword, cfg["brand_tokens"])

    if not row:
        # No rank on file. A branded query is assumed to be one we own.
        return RankInfo(branded=branded,
                        effective_rank=1 if branded else None)

    rank = row.get("organic_rank")
    rank = int(rank) if rank is not None else None
    as_of = str(row.get("as_of") or "")
    stale = False
    if as_of:
        try:
            stale = (today - date.fromisoformat(as_of)).days > cfg["stale_after_days"]
        except ValueError:
            stale = True

    # Page 2+ with no explicit rank still means "not on page 1" — low risk.
    page = row.get("page")
    page = int(page) if page is not None else None
    if rank is None and page is not None and page >= 2:
        rank = 99

    effective = None if stale else rank
    if effective is None and branded:
        effective = 1

    return RankInfo(rank=rank, page=page, source=row.get("source"), as_of=as_of or None,
                    stale=stale, branded=branded, effective_rank=effective)


@dataclass
class GateResult:
    """Outcome of applying the rank policy to one proposed bid increase."""
    allowed_bid: float
    policy: str
    risk: str
    note: str
    needs_manual_check: bool = False


def apply_rank_policy(current_bid: float, proposed_bid: float,
                      info: RankInfo, cfg: dict) -> GateResult:
    """Cap, hold, or allow a proposed bid increase. Pure.

    Only increases reach here — callers must not gate decreases (see module
    docstring). A proposal that is not actually an increase is returned intact.
    """
    if not cfg.get("enabled", True):
        return GateResult(proposed_bid, POLICY_DISABLED, info.risk,
                          "organic-rank gating disabled in config")

    if proposed_bid <= current_bid or current_bid <= 0:
        return GateResult(proposed_bid, POLICY_FULL, info.risk,
                          "not an increase — rank gate does not apply")

    rank = info.effective_rank

    def capped(pct: float, band: str) -> GateResult:
        cap = round(current_bid * (1 + pct / 100.0), 2)
        if cap >= proposed_bid:
            return GateResult(proposed_bid, POLICY_FULL, info.risk,
                              f"organic rank {rank} ({band}) — plan increase is "
                              f"already within the +{pct:.0f}% cap")
        return GateResult(cap, POLICY_CAPPED, info.risk,
                          f"organic rank {rank} ({band}) — increase capped to "
                          f"+{pct:.0f}% (${current_bid:.2f}→${cap:.2f}) instead of "
                          f"${proposed_bid:.2f}; we already win this query "
                          f"organically, so defend rather than conquer")

    if rank is not None and rank <= 3:
        pct = cfg["rank_1_3_max_increase_pct"]
        if pct <= 0:
            return GateResult(current_bid, POLICY_HOLD, info.risk,
                              f"organic rank {rank} — holding bid; paying more "
                              f"for traffic we already own organically")
        band = "top 3 organically" + (" / branded" if info.branded else "")
        return capped(pct, band)

    if rank is not None and rank <= 7:
        return capped(cfg["rank_4_7_max_increase_pct"], "page 1, positions 4-7")

    if rank is not None:
        return GateResult(proposed_bid, POLICY_FULL, info.risk,
                          f"organic rank {rank} — little organic coverage, full "
                          f"plan increase allowed (still subject to ACOS rules)")

    # Rank unknown: the size of the bet decides whether a human looks at it.
    if proposed_bid >= cfg["high_bid_threshold"]:
        return GateResult(
            current_bid, POLICY_NEEDS_CHECK, RISK_UNKNOWN,
            f"organic rank unknown and proposed bid ${proposed_bid:.2f} is at or "
            f"above the ${cfg['high_bid_threshold']:.2f} review threshold — check "
            f"rank before raising. Not auto-applied.",
            needs_manual_check=True)

    return GateResult(proposed_bid, POLICY_UNKNOWN_OK, RISK_UNKNOWN,
                      f"organic rank unknown, but proposed bid ${proposed_bid:.2f} "
                      f"is below the ${cfg['high_bid_threshold']:.2f} threshold — "
                      f"allowed (rank_unknown)")


# ── Storage ─────────────────────────────────────────────────────

def fetch_ranks(asin: str | None = None) -> dict[tuple[str, str], dict]:
    """All stored ranks, keyed by (asin, normalized keyword).

    Returns {} when the table is absent so the gate degrades to "rank unknown"
    rather than breaking the plan.
    """
    from src.db import get_client

    try:
        q = get_client().table(TABLE).select("*")
        if asin:
            q = q.eq("asin", asin)
        rows = q.execute().data or []
    except Exception as e:
        if TABLE in str(e):
            log.info("%s missing — run supabase/migration_organic_rank.sql to "
                     "enable rank gating (plan still runs, rank reads as unknown)", TABLE)
            return {}
        raise

    out: dict[tuple[str, str], dict] = {}
    for r in rows:
        key = (str(r.get("asin") or ""), normalize_keyword(r.get("keyword_normalized")))
        prev = out.get(key)
        # Keep the freshest row per key.
        if prev is None or str(r.get("as_of") or "") > str(prev.get("as_of") or ""):
            out[key] = r
    return out


def lookup(ranks: dict, keyword: str, asin: str, cfg: dict,
           today: date | None = None) -> RankInfo:
    """Rank for one (asin, keyword), falling back to the branded assumption."""
    k = normalize_keyword(keyword)
    row = ranks.get((asin, k))
    if row is None and asin:
        # A rank recorded without an ASIN still applies to the query.
        row = ranks.get(("", k))
    return build_rank_info(row, keyword, cfg, today or date.today())


class RankSchemaError(RuntimeError):
    """The table exists but rejected the rows — constraint or column mismatch."""


def table_exists() -> bool:
    """Cheap existence probe. A rejected WRITE is not a missing table."""
    from src.db import get_client

    try:
        get_client().table(TABLE).select("id").limit(1).execute()
        return True
    except Exception as e:
        if "does not exist" in str(e) or "schema cache" in str(e):
            return False
        # Anything else means the table is there and something else is wrong.
        return True


# Values the live CHECK constraint accepts before
# supabase/migration_organic_rank_source.sql widens it.
_LEGACY_SOURCES = {"sqp", "manual", "helium", "other"}
_SOURCE_FALLBACK = {"sqp_spapi": "sqp"}


def upsert_ranks(rows: list[dict]) -> int:
    """Write rank rows, keyed on (asin, keyword_normalized, source, as_of).

    Distinguishes a missing table from a rejected write. The two used to be
    conflated: any error mentioning the table name was reported as "table
    missing", so a CHECK-constraint violation on `source` looked like a schema
    gap and 623 perfectly good rows silently became `written: 0`.
    """
    from src.db import upsert_rows

    if not rows:
        return 0

    def _write(payload: list[dict]) -> int:
        return upsert_rows(TABLE, payload,
                           on_conflict="asin,keyword_normalized,source,as_of")

    try:
        return _write(rows)
    except Exception as e:
        msg = str(e)

        if not table_exists():
            raise RankSchemaError(
                f"{TABLE} does not exist — run supabase/migration_organic_rank.sql"
            ) from e

        # The known, fixable case: the CHECK predates the sqp_spapi source.
        if "source_check" in msg or "23514" in msg:
            fallback = [r for r in rows
                        if str(r.get("source")) in _SOURCE_FALLBACK]
            if fallback:
                mapped = [{**r, "source": _SOURCE_FALLBACK[str(r["source"])]}
                          for r in rows]
                log.warning(
                    "%s CHECK rejects source=%s — writing as '%s' for now. Run "
                    "supabase/migration_organic_rank_source.sql to record the "
                    "true source.", TABLE,
                    sorted({str(r.get("source")) for r in fallback}),
                    _SOURCE_FALLBACK[str(fallback[0]["source"])])
                return _write(mapped)

        raise RankSchemaError(
            f"{TABLE} rejected the write ({msg[:220]}). The table exists — this "
            f"is a constraint or column mismatch, not a missing table."
        ) from e


# ── External tracker interface (stub) ───────────────────────────

class RankProvider:
    """Interface for an external rank tracker (Helium 10, DataDive, ...).

    Declared so the ingestion path has a shape to grow into. Deliberately not
    implemented: there are no credentials for any provider here, and a stub
    that silently returned fabricated ranks would be worse than no provider at
    all, because rank is what decides whether we raise a bid.
    """

    name = "unimplemented"

    def fetch(self, asin: str, keywords: list[str]) -> list[dict]:
        raise NotImplementedError(
            "No external rank provider is configured. Use "
            "`sqp-import` (Brand Analytics) or `rank-set` (manual) instead.")
