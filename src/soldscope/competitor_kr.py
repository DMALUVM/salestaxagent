"""Competitor reverse-ASIN Keyword Research — reuse saved searchType0, capped create.

Observe / recommend only. Never writes Amazon Ads. Never Rank Tracker
create. Never Product Research. HTTP 402 stops clean with no retry.

Weekly job: cache-first. Cached reverse snapshots are enough unless an
ASIN is missing or stale. No full KR re-hit of all 30 on a healthy week.
First fill: CLI `--create-missing` — max 1 POST per ASIN (durable
sentinel) and a hard cap (default 5 / run). Created searches are not
polled — the next weekly reuse GETs them.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Iterable

from src.config import PROJECT_ROOT
from src.soldscope.client import (
    AuthError,
    QuotaExceeded,
    SoldScopeError,
    check_auth,
    create_single_asin_search,
    token_present,
)
from src.soldscope.sync import (
    _int,
    _num,
    collect_kr_results,
    collect_saved_kr_search_ids,
)

log = logging.getLogger(__name__)

TABLE = "soldscope_competitor_kr"
CONFLICT = "competitor_asin,marketplace,keyword_normalized,as_of"

FAMILIES = frozenset({"lip", "balm", "deo"})
EXCLUDED_OURS = frozenset({"B0CLF5B27Y"})
DEFAULT_CREATE_CAP = 5
DEFAULT_KR_MAX_KEYWORDS = 80
DEFAULT_MIN_SEARCH_VOLUME = 1
DEFAULT_OPPORTUNITY_FLOOR = 100
DEFAULT_STALE_AFTER_DAYS = 8
DEFAULT_BLAKE_FAMILY_CAP = 5
DEFAULT_BLAKE_TOTAL_CAP = 15
OUTLIER_CAP = 30
LEVERS = frozenset({"harvest_exact", "watch", "skip"})
SENTINEL_KEYWORD = "__kr_created__"

MISSING_TOKEN_MESSAGE = (
    "SOLDSCOPE_API_TOKEN is not set. Add it to the Mini .env (launchd). "
    "Never commit the token. Competitor KR stays scheduled and fails soft."
)

EMPTY_SNAPSHOT_NOTE = (
    "No competitor KR snapshots yet. Reuse saved searchType0 searches, "
    "or run `soldscope-competitor-kr --create-missing` (max 1 POST per "
    "ASIN, cap 5/run). Weekly jobs read cached snapshots unless missing "
    "or stale. This desk never creates Rank Tracker groups or Product "
    "Research."
)

HERO_ASINS = {
    "lip": "B0CLHTF8YN",
    "balm": "B0DQFKMJFY",
    "deo": "B0HBSZ71XQ",
}


def load_config() -> dict:
    path = PROJECT_ROOT / "config" / "soldscope_competitors.json"
    with open(path) as f:
        raw = json.load(f)
    excluded = {
        str(a).strip().upper()
        for a in (raw.get("excluded_asins") or [])
        if str(a).strip()
    } | EXCLUDED_OURS
    families_raw = raw.get("families") or {}
    families: dict[str, dict] = {}
    for name, spec in families_raw.items():
        key = str(name).strip().lower()
        if key not in FAMILIES or not isinstance(spec, dict):
            continue
        families[key] = {
            "hero_asin": str(spec.get("hero_asin") or HERO_ASINS[key]).strip().upper(),
            "rt_group_id": spec.get("rt_group_id"),
            "kr_search_id": spec.get("kr_search_id"),
            "also_ours": [
                str(a).strip().upper()
                for a in (spec.get("also_ours") or [])
                if str(a).strip()
            ],
            "exact_watch_asin": (
                str(spec.get("exact_watch_asin") or "").strip().upper() or None
            ),
        }
        excluded.update(families[key]["also_ours"])
    competitors: list[dict] = []
    seen: set[str] = set()
    dropped: list[str] = []
    for item in raw.get("competitors") or []:
        if not isinstance(item, dict):
            continue
        asin = str(item.get("asin") or "").strip().upper()
        family = str(item.get("family") or "").strip().lower()
        if not asin or family not in FAMILIES:
            continue
        if asin in excluded or asin in seen or asin in HERO_ASINS.values():
            dropped.append(asin)
            continue
        seen.add(asin)
        competitors.append({"asin": asin, "family": family})
    schedule = raw.get("schedule") or {}
    return {
        "marketplace": str(raw.get("marketplace") or "US"),
        "create_missing_max": int(raw.get("create_missing_max") or DEFAULT_CREATE_CAP),
        "stale_after_days": int(
            raw.get("stale_after_days") or DEFAULT_STALE_AFTER_DAYS
        ),
        "blake_family_cap": int(
            raw.get("blake_family_cap") or DEFAULT_BLAKE_FAMILY_CAP
        ),
        "blake_total_cap": int(
            raw.get("blake_total_cap") or DEFAULT_BLAKE_TOTAL_CAP
        ),
        "max_keywords": max(
            1,
            min(
                int(raw.get("max_keywords") or DEFAULT_KR_MAX_KEYWORDS),
                DEFAULT_KR_MAX_KEYWORDS,
            ),
        ),
        "min_search_volume": max(
            1,
            int(raw.get("min_search_volume") or DEFAULT_MIN_SEARCH_VOLUME),
        ),
        "max_aba_sfr": (
            int(raw["max_aba_sfr"])
            if raw.get("max_aba_sfr") not in (None, "", 0)
            else None
        ),
        "opportunity_floor": int(
            raw.get("opportunity_floor") or DEFAULT_OPPORTUNITY_FLOOR
        ),
        "excluded_asins": sorted(excluded),
        "families": families,
        "competitors": competitors,
        "dropped_asins": dropped,
        "schedule": {
            "day_of_week": schedule.get("day_of_week", "sun"),
            "hour": int(schedule.get("hour", 10)),
            "minute": int(schedule.get("minute", 45)),
            "timezone": schedule.get("timezone", "America/New_York"),
        },
    }


def competitor_present(row: dict, competitor_asin: str) -> bool:
    """True when the competitor ranks organic or sponsored on the keyword."""
    want = str(competitor_asin or "").strip().upper()
    org_asin = str(row.get("organic_asin") or "").strip().upper()
    sp_asin = str(row.get("sponsored_asin") or "").strip().upper()
    org_rank = _int(row.get("organic_rank"))
    sp_rank = _int(row.get("sponsored_rank"))
    if want and org_asin == want:
        return True
    if want and sp_asin == want:
        return True
    if org_rank is not None and org_rank > 0:
        return True
    if sp_rank is not None and sp_rank > 0:
        return True
    return False


def exact_keywords_from_targets(targets: Iterable[dict]) -> set[str]:
    """Enabled Exact keyword_targets only. Phrase/Broad/Auto do not count."""
    from src.amazon_ads.organic_rank import normalize_keyword

    out: set[str] = set()
    for t in targets:
        mt = str((t or {}).get("match_type") or "").strip().lower()
        if mt and mt != "exact":
            continue
        state = str((t or {}).get("state") or "").strip().lower()
        if state and state not in {"enabled", "enable"}:
            continue
        key = normalize_keyword((t or {}).get("keyword_text"))
        if key:
            out.add(key)
    return out


def classify_exact_bidding(
    keyword: str,
    targets: Iterable[dict],
    extra_exact: Iterable[str] = (),
) -> dict:
    """already_bidding is Y only for enabled Exact / has_enabled_exact_elsewhere."""
    from src.amazon_ads.organic_rank import normalize_keyword

    key = normalize_keyword(keyword)
    if not key:
        return {"already": False, "already_bidding": "N", "note": "—"}
    enabled = exact_keywords_from_targets(targets)
    extras = {normalize_keyword(x) for x in extra_exact}
    extras.discard("")
    if key in enabled or key in extras:
        return {
            "already": True,
            "already_bidding": "Y",
            "note": "Exact",
        }
    return {"already": False, "already_bidding": "N", "note": "—"}


def suggest_lever(
    *,
    already_exact: bool,
    present: bool,
    family_fit: bool,
    opportunity: int | None,
    opportunity_floor: int = DEFAULT_OPPORTUNITY_FLOOR,
) -> str:
    if already_exact or not present or not family_fit:
        return "skip"
    if opportunity is not None and opportunity >= opportunity_floor:
        return "harvest_exact"
    return "watch"


def our_organic_rank(
    keyword: str,
    family: str,
    rank_rows: Iterable[dict],
) -> int | None:
    """Reuse existing RT snapshots for the hero family. Never invent rank."""
    from src.amazon_ads.organic_rank import normalize_keyword

    key = normalize_keyword(keyword)
    hero = HERO_ASINS.get(str(family or "").strip().lower())
    if not key or not hero:
        return None
    newest: tuple[str, int] | None = None
    for row in rank_rows:
        if str(row.get("asin") or "").strip().upper() != hero:
            continue
        phrase = normalize_keyword(row.get("phrase") or row.get("keyword"))
        if phrase != key:
            continue
        pos = _int(row.get("organic_position") or row.get("organic_rank"))
        if pos is None or pos <= 0:
            continue
        as_of = str(row.get("as_of") or "")
        if newest is None or as_of > newest[0]:
            newest = (as_of, pos)
    return newest[1] if newest else None


def _volume(row: dict):
    return _int(
        row.get("search_volume")
        if row.get("search_volume") is not None
        else row.get("volume") if row.get("volume") is not None
        else row.get("searchVolume")
    )


def _sfr(row: dict):
    return _int(
        row.get("aba_search_frequency_rank")
        if row.get("aba_search_frequency_rank") is not None
        else row.get("sfr") if row.get("sfr") is not None
        else row.get("abaSearchFrequencyRank")
    )


def has_real_traffic(
    row: dict,
    *,
    min_search_volume: int = DEFAULT_MIN_SEARCH_VOLUME,
    max_aba_sfr: int | None = None,
) -> bool:
    """True when the keyword has real search volume. Missing/zero → skip."""
    vol = _volume(row)
    if vol is None or vol < int(min_search_volume):
        return False
    if max_aba_sfr is not None:
        sfr = _sfr(row)
        if sfr is not None and sfr > int(max_aba_sfr):
            return False
    return True


def competitor_kr_rows_from_payload(
    items: list[dict],
    *,
    competitor_asin: str,
    family: str,
    marketplace: str,
    search_id: int,
    pulled_at: str,
    as_of: str | None = None,
    min_search_volume: int = DEFAULT_MIN_SEARCH_VOLUME,
    max_aba_sfr: int | None = None,
) -> list[dict]:
    from src.amazon_ads.organic_rank import normalize_keyword

    rows: list[dict] = []
    seen: set[str] = set()
    day = as_of or date.today().isoformat()
    floor = max(1, int(min_search_volume))
    for p in items:
        keyword = str(p.get("keyword") or "").strip()
        key = normalize_keyword(keyword)
        if not keyword or key in seen:
            continue
        if not has_real_traffic(
            p, min_search_volume=floor, max_aba_sfr=max_aba_sfr,
        ):
            continue
        seen.add(key)
        match_types = p.get("matchTypes")
        if isinstance(match_types, list):
            match_txt = ",".join(str(x) for x in match_types if x)
        else:
            match_txt = str(match_types or "").strip() or None
        rows.append({
            "competitor_asin": competitor_asin,
            "marketplace": marketplace,
            "family": family,
            "search_id": int(search_id),
            "keyword_normalized": key,
            "keyword": keyword,
            "search_volume": _int(p.get("searchVolume")),
            "aba_search_frequency_rank": _int(p.get("abaSearchFrequencyRank")),
            "organic_asin": (
                str(p.get("organicAsin") or "").strip().upper() or None
            ),
            "organic_rank": _int(p.get("organicRank")),
            "sponsored_asin": (
                str(p.get("sponsoredAsin") or "").strip().upper() or None
            ),
            "sponsored_rank": _int(p.get("sponsoredRank")),
            "sponsored_products": _int(p.get("sponsoredProducts")),
            "opportunity_score": _int(p.get("opportunityScore")),
            "cpc": _num(p.get("cpc")),
            "match_types": match_txt,
            "as_of": day,
            "pulled_at": pulled_at,
        })
    return rows


def build_competitor_outliers(args: dict) -> list[dict]:
    """Join competitor KR to Exact keyword_targets + hero RT organic rank."""
    from src.amazon_ads.organic_rank import normalize_keyword

    rows = list(args.get("kr_rows") or [])
    targets = list(args.get("targets") or [])
    extra_exact = list(args.get("extra_exact") or [])
    rank_rows = list(args.get("rank_rows") or [])
    floor = int(args.get("opportunity_floor") or DEFAULT_OPPORTUNITY_FLOOR)
    min_vol = int(args.get("min_search_volume") or DEFAULT_MIN_SEARCH_VOLUME)
    max_sfr = args.get("max_aba_sfr")
    cap = int(args.get("cap") or OUTLIER_CAP)
    families = FAMILIES

    latest: dict[tuple[str, str], dict] = {}
    for row in rows:
        asin = str(row.get("competitor_asin") or "").strip().upper()
        key = normalize_keyword(row.get("keyword") or row.get("keyword_normalized"))
        family = str(row.get("family") or "").strip().lower()
        if not asin or not key or family not in families:
            continue
        if asin in EXCLUDED_OURS or is_sentinel_row(row):
            continue
        if not has_real_traffic(
            row, min_search_volume=min_vol, max_aba_sfr=max_sfr,
        ):
            continue
        cur = latest.get((asin, key))
        if cur is None or str(row.get("as_of") or "") >= str(cur.get("as_of") or ""):
            latest[(asin, key)] = row

    out: list[dict] = []
    for row in latest.values():
        asin = str(row.get("competitor_asin") or "").strip().upper()
        family = str(row.get("family") or "").strip().lower()
        keyword = str(row.get("keyword") or "").strip()
        present = competitor_present(row, asin)
        bid = classify_exact_bidding(keyword, targets, extra_exact)
        opp = _int(row.get("opportunity_score"))
        lever = suggest_lever(
            already_exact=bid["already"],
            present=present,
            family_fit=family in families,
            opportunity=opp,
            opportunity_floor=floor,
        )
        if not present:
            continue
        out.append({
            "keyword": keyword,
            "keyword_normalized": normalize_keyword(keyword),
            "competitor_asin": asin,
            "our_hero_family": family,
            "volume": _int(row.get("search_volume")),
            "sfr": _int(row.get("aba_search_frequency_rank")),
            "opportunity": opp,
            "competitor_organic_rank": _int(row.get("organic_rank")),
            "competitor_sponsored_rank": _int(row.get("sponsored_rank")),
            "our_organic_rank": our_organic_rank(keyword, family, rank_rows),
            "already_bidding": bid["already_bidding"],
            "suggested_lever": lever,
            "as_of": row.get("as_of"),
        })

    rank_lever = {"harvest_exact": 0, "watch": 1, "skip": 2}
    out.sort(key=lambda r: (
        rank_lever.get(r["suggested_lever"], 9),
        -(r["opportunity"] if r["opportunity"] is not None else -1),
        -(r["volume"] if r["volume"] is not None else -1),
        r["keyword_normalized"],
    ))
    return out[:cap]


def outlier_key(row: dict) -> tuple[str, str]:
    from src.amazon_ads.organic_rank import normalize_keyword

    return (
        str(row.get("competitor_asin") or "").strip().upper(),
        normalize_keyword(row.get("keyword") or row.get("keyword_normalized")),
    )


def net_new_actionable(
    current: Iterable[dict],
    previous: Iterable[dict],
    *,
    levers: Iterable[str] = ("harvest_exact",),
) -> list[dict]:
    """Rows whose (competitor, keyword) was not actionable last snapshot."""
    wanted = {str(x) for x in levers}
    prev_keys = {
        outlier_key(r)
        for r in previous
        if str(r.get("suggested_lever") or "") in wanted
        and outlier_key(r)[0]
        and outlier_key(r)[1]
    }
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for r in current:
        if str(r.get("suggested_lever") or "") not in wanted:
            continue
        key = outlier_key(r)
        if not key[0] or not key[1] or key in seen or key in prev_keys:
            continue
        seen.add(key)
        out.append(r)
    return out


def digest_should_ping(net_new: Iterable[dict]) -> bool:
    """Blake digest hook — True only when net-new harvest_exact rows exist."""
    return any(
        str(r.get("suggested_lever") or "") == "harvest_exact" for r in net_new
    )


def is_sentinel_row(row: dict) -> bool:
    kn = str(row.get("keyword_normalized") or "").strip().lower()
    kw = str(row.get("keyword") or "").strip().lower()
    return kn == SENTINEL_KEYWORD or kw == SENTINEL_KEYWORD


def _asin(row: dict) -> str:
    return str(row.get("competitor_asin") or "").strip().upper()


def _valid_search_id(value) -> int | None:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def load_cached_kr() -> list[dict]:
    """Warehouse reverse snapshots. Fail-soft — weekly jobs stay up."""
    try:
        from src.db import get_client

        client = get_client()
        resp = (
            client.table(TABLE)
            .select("*")
            .order("as_of", desc=True)
            .limit(8000)
            .execute()
        )
    except Exception as e:
        log.info("Competitor KR cache load skipped: %s", e)
        return []
    return [r for r in (resp.data or []) if isinstance(r, dict)]


def search_ids_from_cache(rows: Iterable[dict]) -> dict[str, int]:
    """Newest valid search_id per competitor ASIN (includes sentinel rows)."""
    out: dict[str, int] = {}
    newest: dict[str, str] = {}
    for row in rows:
        asin = _asin(row)
        sid = _valid_search_id(row.get("search_id"))
        if not asin or sid is None:
            continue
        as_of = str(row.get("as_of") or "")
        if asin not in out or as_of >= newest.get(asin, ""):
            out[asin] = sid
            newest[asin] = as_of
    return out


def posted_asins_from_cache(rows: Iterable[dict]) -> set[str]:
    """ASINs that already had a KR POST (search_id or durable sentinel)."""
    out: set[str] = set()
    for row in rows:
        asin = _asin(row)
        if not asin:
            continue
        if _valid_search_id(row.get("search_id")) or is_sentinel_row(row):
            out.add(asin)
    return out


def asin_cache_status(
    rows: Iterable[dict],
    asins: Iterable[str],
    stale_after_days: int,
    as_of_today: str,
) -> dict[str, str]:
    """fresh = real keywords within stale_after_days; sentinel-only is missing."""
    try:
        today = date.fromisoformat(str(as_of_today)[:10])
    except ValueError:
        today = date.today()
    cutoff = today - timedelta(days=int(stale_after_days))
    latest_real: dict[str, str] = {}
    for row in rows:
        if is_sentinel_row(row) or not has_real_traffic(row):
            continue
        asin = _asin(row)
        as_of = str(row.get("as_of") or "")
        if not asin or not as_of:
            continue
        if asin not in latest_real or as_of > latest_real[asin]:
            latest_real[asin] = as_of
    out: dict[str, str] = {}
    for raw in asins:
        asin = str(raw or "").strip().upper()
        as_of = latest_real.get(asin)
        if not as_of:
            out[asin] = "missing"
            continue
        try:
            pulled = date.fromisoformat(as_of[:10])
        except ValueError:
            out[asin] = "stale"
            continue
        out[asin] = "fresh" if pulled >= cutoff else "stale"
    return out


def latest_real_rows_for_asins(
    rows: Iterable[dict],
    asins: Iterable[str],
) -> list[dict]:
    wanted = {str(a).strip().upper() for a in asins if str(a).strip()}
    latest_as_of: dict[str, str] = {}
    for row in rows:
        if is_sentinel_row(row) or not has_real_traffic(row):
            continue
        asin = _asin(row)
        as_of = str(row.get("as_of") or "")
        if asin not in wanted or not as_of:
            continue
        if as_of > latest_as_of.get(asin, ""):
            latest_as_of[asin] = as_of
    out: list[dict] = []
    for row in rows:
        if is_sentinel_row(row) or not has_real_traffic(row):
            continue
        asin = _asin(row)
        if asin in latest_as_of and str(row.get("as_of") or "") == latest_as_of[asin]:
            out.append(row)
    return out


def previous_kr_rows(
    cache: Iterable[dict],
    current_rows: Iterable[dict],
) -> list[dict]:
    """Older as_of rows per ASIN — used to drop last week's keywords."""
    latest: dict[str, str] = {}
    for row in current_rows:
        if is_sentinel_row(row):
            continue
        asin = _asin(row)
        as_of = str(row.get("as_of") or "")
        if asin and as_of > latest.get(asin, ""):
            latest[asin] = as_of
    prev: list[dict] = []
    for row in cache:
        if is_sentinel_row(row):
            continue
        asin = _asin(row)
        as_of = str(row.get("as_of") or "")
        if asin in latest and as_of and as_of < latest[asin]:
            prev.append(row)
    return prev


def make_sentinel_row(
    *,
    competitor_asin: str,
    family: str,
    marketplace: str,
    search_id: int | None,
    pulled_at: str,
    as_of: str,
) -> dict:
    return {
        "competitor_asin": competitor_asin,
        "marketplace": marketplace,
        "family": family,
        "search_id": _valid_search_id(search_id) or 0,
        "keyword_normalized": SENTINEL_KEYWORD,
        "keyword": SENTINEL_KEYWORD,
        "search_volume": None,
        "aba_search_frequency_rank": None,
        "organic_asin": None,
        "organic_rank": None,
        "sponsored_asin": None,
        "sponsored_rank": None,
        "sponsored_products": None,
        "opportunity_score": None,
        "cpc": None,
        "match_types": None,
        "as_of": as_of,
        "pulled_at": pulled_at,
    }


def build_blake_competitor_surface(args: dict) -> list[dict]:
    """Net-new unused Exact only. Cap ~5 per family / ~15 total."""
    family_cap = int(args.get("family_cap") or DEFAULT_BLAKE_FAMILY_CAP)
    total_cap = int(args.get("total_cap") or DEFAULT_BLAKE_TOTAL_CAP)
    kr_rows = [r for r in (args.get("kr_rows") or []) if not is_sentinel_row(r)]
    outliers = build_competitor_outliers({
        **args,
        "kr_rows": kr_rows,
        "cap": 10_000,
    })
    unused = [
        r for r in outliers
        if r.get("already_bidding") == "N"
        and r.get("suggested_lever") in {"harvest_exact", "watch"}
    ]
    previous = [
        r for r in (args.get("previous_kr_rows") or []) if not is_sentinel_row(r)
    ]
    if previous:
        from src.amazon_ads.organic_rank import normalize_keyword

        prev_keys = {
            (
                _asin(r),
                normalize_keyword(r.get("keyword") or r.get("keyword_normalized")),
            )
            for r in previous
        }
        unused = [
            r for r in unused
            if (
                str(r.get("competitor_asin") or "").strip().upper(),
                str(r.get("keyword_normalized") or ""),
            ) not in prev_keys
        ]
    by_family = {"lip": 0, "balm": 0, "deo": 0}
    out: list[dict] = []
    for row in unused:
        fam = str(row.get("our_hero_family") or "")
        if by_family.get(fam, family_cap) >= family_cap:
            continue
        by_family[fam] = by_family.get(fam, 0) + 1
        out.append(row)
        if len(out) >= total_cap:
            break
    return out


def _create_cap(requested: int | None, cfg_max: int) -> int:
    cap = cfg_max if requested is None else int(requested)
    if cap < 0:
        return 0
    return min(cap, cfg_max)


def _result(
    *,
    status: str,
    message: str,
    notes: list[str],
    errors: list[str],
    written: dict,
    created: list[str],
    reused: list[str],
    cached: list[str],
    missing: list[str],
    pulled_at: str,
    asins: list[str],
    create_missing: bool,
    create_cap: int,
    kr_rows: list[dict],
    persist_rows: list[dict],
    dry_run: bool,
    quota: QuotaExceeded | None,
    digest: dict,
    outliers: list[dict],
) -> dict:
    if dry_run:
        message = "DRY RUN — " + message
    if notes:
        message = (message + " | " + "; ".join(notes))[:1000]
    return {
        "status": status,
        "message": message,
        "notes": notes,
        "errors": errors,
        "written": written,
        "counts": {"competitor_kr": len(kr_rows)},
        "created": created,
        "reused": reused,
        "cached": cached,
        "missing": missing,
        "create_missing": create_missing,
        "create_cap": create_cap,
        "pulled_at": pulled_at,
        "asins": asins,
        "persist_rows": len(persist_rows),
        "quota_remaining": quota.remaining if quota else None,
        "quota_reset": quota.reset if quota else None,
        "digest": digest,
        "outliers": outliers,
    }


def _blake_from_rows(
    cfg: dict,
    kr_rows: list[dict],
    cache: list[dict],
) -> tuple[list[dict], dict]:
    previous = previous_kr_rows(cache, kr_rows)
    surface = build_blake_competitor_surface({
        "kr_rows": kr_rows,
        "previous_kr_rows": previous,
        "opportunity_floor": cfg["opportunity_floor"],
        "min_search_volume": cfg["min_search_volume"],
        "max_aba_sfr": cfg.get("max_aba_sfr"),
        "family_cap": cfg["blake_family_cap"],
        "total_cap": cfg["blake_total_cap"],
    })
    harvest = [r for r in surface if r.get("suggested_lever") == "harvest_exact"]
    digest = {
        "should_ping": digest_should_ping(harvest),
        "net_new": len(surface),
        "harvest_exact": len(harvest),
    }
    return surface, digest


def sync_competitor_kr(
    *,
    dry_run: bool = False,
    create_missing: bool = False,
    max_create: int | None = None,
) -> dict:
    """Pull competitor KR. Cache-first. Reuse saved searchType0. Create gated."""
    notes: list[str] = []
    errors: list[str] = []
    created: list[str] = []
    reused: list[str] = []
    cached: list[str] = []
    missing: list[str] = []
    written = {"competitor_kr": 0}
    pulled_at = datetime.now(timezone.utc).isoformat()
    cfg = load_config()
    create_cap = _create_cap(max_create, int(cfg["create_missing_max"]))
    asins = [c["asin"] for c in cfg["competitors"]]
    family_by_asin = {c["asin"]: c["family"] for c in cfg["competitors"]}

    if cfg["dropped_asins"]:
        notes.append(
            "Dropped excluded/hero ASINs from competitor list: "
            + ", ".join(cfg["dropped_asins"])
        )
    if not cfg["competitors"]:
        return _result(
            status="fail",
            message="No competitor ASINs left after family/exclude filter.",
            notes=notes, errors=errors, written=written,
            created=created, reused=reused, cached=cached, missing=missing,
            pulled_at=pulled_at, asins=asins, create_missing=create_missing,
            create_cap=create_cap, kr_rows=[], persist_rows=[],
            dry_run=dry_run, quota=None,
            digest={"should_ping": False, "net_new": 0}, outliers=[],
        )

    today = date.today().isoformat()
    cache = load_cached_kr()
    stale_after = int(cfg["stale_after_days"])
    status_by = asin_cache_status(cache, asins, stale_after, today)
    fresh_asins = [a for a in asins if status_by.get(a) == "fresh"]
    refresh_asins = [a for a in asins if status_by.get(a) != "fresh"]
    cached_sids = search_ids_from_cache(cache)
    already_posted = posted_asins_from_cache(cache)

    def _finish(
        *,
        status: str,
        kr_rows: list[dict],
        persist_rows: list[dict],
        quota: QuotaExceeded | None = None,
        extra_status_from_cache: bool = False,
    ) -> dict:
        real_rows = [r for r in kr_rows if not is_sentinel_row(r)]
        if not real_rows and quota is None and not created:
            notes.append(EMPTY_SNAPSHOT_NOTE)
        if not dry_run and persist_rows:
            from src.db import upsert_rows

            written["competitor_kr"] = upsert_rows(
                TABLE, persist_rows, on_conflict=CONFLICT,
            )
        surface, digest = _blake_from_rows(cfg, real_rows, cache)
        if digest["should_ping"]:
            notes.append(
                f"Blake digest hook: {digest['harvest_exact']} net-new "
                "harvest_exact row(s) on the capped surface. "
                "Email is not sent from this job."
            )
        total_in = len(real_rows)
        if extra_status_from_cache:
            pass
        elif quota and total_in == 0 and not created and not any(written.values()):
            status = "fail"
        elif quota or errors:
            status = (
                "partial"
                if total_in or created or cached or any(written.values())
                else "fail"
            )
        message = (
            f"{len(cfg['competitors'])} competitor ASIN(s), "
            f"{len(cached)} cached / {len(reused)} reused / "
            f"{len(created)} created / {len(missing)} missing, "
            f"{len(real_rows)} KR row(s), {len(surface)} Blake net-new"
        )
        return _result(
            status=status, message=message, notes=notes, errors=errors,
            written=written, created=created, reused=reused, cached=cached,
            missing=missing, pulled_at=pulled_at, asins=asins,
            create_missing=create_missing, create_cap=create_cap,
            kr_rows=real_rows, persist_rows=persist_rows, dry_run=dry_run,
            quota=quota, digest=digest, outliers=surface,
        )

    if not refresh_asins:
        notes.append(
            f"cache_fresh — skipped SoldScope (all {len(fresh_asins)} ASIN(s) "
            f"have real KR rows within {stale_after} days)."
        )
        cached.extend(fresh_asins)
        return _finish(
            status="success",
            kr_rows=latest_real_rows_for_asins(cache, fresh_asins),
            persist_rows=[],
            extra_status_from_cache=True,
        )

    if not token_present():
        notes.append("missing_token")
        cached_rows = latest_real_rows_for_asins(cache, asins)
        if cached_rows:
            notes.append(
                "cache_fallback — weekly job serving warehouse snapshots "
                "(no SoldScope re-hit)."
            )
            cached.extend(fresh_asins)
            missing.extend(refresh_asins)
            return _finish(
                status="partial",
                kr_rows=cached_rows,
                persist_rows=[],
                extra_status_from_cache=True,
            )
        return _result(
            status="fail",
            message=MISSING_TOKEN_MESSAGE,
            notes=notes, errors=errors, written=written,
            created=created, reused=reused, cached=cached,
            missing=asins, pulled_at=pulled_at, asins=asins,
            create_missing=create_missing, create_cap=create_cap,
            kr_rows=[], persist_rows=[], dry_run=dry_run, quota=None,
            digest={"should_ping": False, "net_new": 0}, outliers=[],
        )

    try:
        auth = check_auth()
        acct = ((auth.get("account") or {}) if isinstance(auth, dict) else {}) or {}
        notes.append(f"auth_ok account={acct.get('name') or acct.get('id') or '?'}")
    except AuthError as e:
        cached_rows = latest_real_rows_for_asins(cache, asins)
        if cached_rows:
            notes.append("auth_fail_cache_fallback")
            errors.append(str(e)[:300])
            cached.extend(fresh_asins)
            missing.extend(refresh_asins)
            return _finish(
                status="partial",
                kr_rows=cached_rows,
                persist_rows=[],
                extra_status_from_cache=True,
            )
        return _result(
            status="fail",
            message=str(e)[:500],
            notes=notes, errors=[str(e)[:300]], written=written,
            created=created, reused=reused, cached=cached,
            missing=asins, pulled_at=pulled_at, asins=asins,
            create_missing=create_missing, create_cap=create_cap,
            kr_rows=[], persist_rows=[], dry_run=dry_run, quota=None,
            digest={"should_ping": False, "net_new": 0}, outliers=[],
        )

    marketplace = cfg["marketplace"]
    kr_cap = int(cfg["max_keywords"])
    new_rows: list[dict] = []
    sentinels: list[dict] = []
    quota: QuotaExceeded | None = None
    created_count = 0
    cached.extend(fresh_asins)

    need_list = [a for a in refresh_asins if a not in cached_sids]
    saved: dict[str, int] = {}
    if need_list:
        try:
            saved = collect_saved_kr_search_ids(asins=need_list)
        except QuotaExceeded as e:
            quota = e
            notes.append(
                f"402 listing KR searches; stopping (Remaining={e.remaining})."
            )
        except (SoldScopeError, AuthError) as e:
            errors.append(f"list KR searches: {e}")
        except Exception as e:
            errors.append(f"list KR searches: {e}")

    for asin in refresh_asins:
        if quota is not None:
            break
        family = family_by_asin[asin]
        sid = cached_sids.get(asin) or saved.get(asin)
        if sid is None and create_missing:
            if asin in already_posted:
                notes.append(
                    f"Skip POST for {asin} — warehouse already has a KR "
                    "search_id/sentinel (max 1 POST per ASIN)."
                )
                missing.append(asin)
                continue
            if created_count >= create_cap:
                missing.append(asin)
                notes.append(
                    f"Create-missing cap {create_cap} reached; skipped {asin}."
                )
                continue
            try:
                created_body = create_single_asin_search(
                    marketplace=marketplace, asin=asin,
                )
                data = created_body.get("data") if isinstance(created_body, dict) else None
                new_id = (data or {}).get("id") if isinstance(data, dict) else None
                created_count += 1
                created.append(asin)
                already_posted.add(asin)
                sid = _valid_search_id(new_id)
                sentinels.append(make_sentinel_row(
                    competitor_asin=asin,
                    family=family,
                    marketplace=marketplace,
                    search_id=sid,
                    pulled_at=pulled_at,
                    as_of=today,
                ))
                if sid is None:
                    notes.append(
                        f"KR create for competitor {asin} returned no search id "
                        "(sentinel stored — never POST this ASIN again)."
                    )
                    missing.append(asin)
                    continue
                notes.append(
                    f"Created single-ASIN KR search {sid} for competitor {asin} "
                    "(no wait-loop; one POST per ASIN)."
                )
            except QuotaExceeded as e:
                quota = e
                notes.append(
                    f"402 creating KR for {asin}; stopping (Remaining={e.remaining})."
                )
                missing.append(asin)
                break
            except (SoldScopeError, AuthError) as e:
                errors.append(f"{asin} KR create: {e}")
                missing.append(asin)
                continue
            except Exception as e:
                errors.append(f"{asin} KR create: {e}")
                missing.append(asin)
                continue
        if sid is None:
            missing.append(asin)
            if not create_missing:
                notes.append(
                    f"No saved searchType0 KR for {asin} — reuse-only "
                    "(pass --create-missing to POST, max 1 per ASIN, cap "
                    f"{create_cap}/run)."
                )
            continue
        try:
            items = collect_kr_results(sid, cap=kr_cap)
            batch = competitor_kr_rows_from_payload(
                items,
                competitor_asin=asin,
                family=family,
                marketplace=marketplace,
                search_id=sid,
                pulled_at=pulled_at,
                min_search_volume=int(cfg["min_search_volume"]),
                max_aba_sfr=cfg.get("max_aba_sfr"),
            )
            new_rows.extend(batch)
            reused.append(asin)
        except QuotaExceeded as e:
            quota = e
            notes.append(
                f"402 reading KR {sid} for {asin}; stopping "
                f"(Remaining={e.remaining})."
            )
            break
        except (SoldScopeError, AuthError) as e:
            errors.append(f"{asin} KR read: {e}")
        except Exception as e:
            errors.append(f"{asin} KR read: {e}")

    kr_rows = latest_real_rows_for_asins(cache, fresh_asins) + new_rows
    persist_rows = new_rows + sentinels
    return _finish(
        status="success",
        kr_rows=kr_rows,
        persist_rows=persist_rows,
        quota=quota,
    )


# Re-export helpers the tests / client already use so callers stay local.
__all__ = [
    "TABLE",
    "CONFLICT",
    "DEFAULT_BLAKE_FAMILY_CAP",
    "DEFAULT_BLAKE_TOTAL_CAP",
    "DEFAULT_CREATE_CAP",
    "DEFAULT_KR_MAX_KEYWORDS",
    "DEFAULT_MIN_SEARCH_VOLUME",
    "DEFAULT_STALE_AFTER_DAYS",
    "EMPTY_SNAPSHOT_NOTE",
    "EXCLUDED_OURS",
    "SENTINEL_KEYWORD",
    "asin_cache_status",
    "build_blake_competitor_surface",
    "build_competitor_outliers",
    "classify_exact_bidding",
    "competitor_kr_rows_from_payload",
    "competitor_present",
    "digest_should_ping",
    "exact_keywords_from_targets",
    "has_real_traffic",
    "is_sentinel_row",
    "load_cached_kr",
    "load_config",
    "make_sentinel_row",
    "net_new_actionable",
    "posted_asins_from_cache",
    "search_ids_from_cache",
    "suggest_lever",
    "sync_competitor_kr",
]
