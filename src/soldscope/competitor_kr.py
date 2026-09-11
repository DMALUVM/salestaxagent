"""Competitor reverse-ASIN Keyword Research — reuse saved searchType0, capped create.

Observe / recommend only. Never writes Amazon Ads. Never Rank Tracker
create. Never Product Research. HTTP 402 stops clean with no retry.

Weekly job: reuse saved single-ASIN KR only.
First fill: CLI `--create-missing` with a hard cap (default 5 / run).
Created searches are not polled — the next weekly reuse reads them.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timezone
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
DEFAULT_OPPORTUNITY_FLOOR = 100
OUTLIER_CAP = 30
LEVERS = frozenset({"harvest_exact", "watch", "skip"})

MISSING_TOKEN_MESSAGE = (
    "SOLDSCOPE_API_TOKEN is not set. Add it to the Mini .env (launchd). "
    "Never commit the token. Competitor KR stays scheduled and fails soft."
)

EMPTY_SNAPSHOT_NOTE = (
    "No competitor KR snapshots yet. Reuse saved searchType0 searches, "
    "or run `soldscope-competitor-kr --create-missing` (cap 5/run). "
    "This desk never creates Rank Tracker groups or Product Research."
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
        "max_keywords": int(raw.get("max_keywords") or DEFAULT_KR_MAX_KEYWORDS),
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


def competitor_kr_rows_from_payload(
    items: list[dict],
    *,
    competitor_asin: str,
    family: str,
    marketplace: str,
    search_id: int,
    pulled_at: str,
    as_of: str | None = None,
) -> list[dict]:
    from src.amazon_ads.organic_rank import normalize_keyword

    rows: list[dict] = []
    seen: set[str] = set()
    day = as_of or date.today().isoformat()
    for p in items:
        keyword = str(p.get("keyword") or "").strip()
        key = normalize_keyword(keyword)
        if not keyword or key in seen:
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
    cap = int(args.get("cap") or OUTLIER_CAP)
    families = FAMILIES

    latest: dict[tuple[str, str], dict] = {}
    for row in rows:
        asin = str(row.get("competitor_asin") or "").strip().upper()
        key = normalize_keyword(row.get("keyword") or row.get("keyword_normalized"))
        family = str(row.get("family") or "").strip().lower()
        if not asin or not key or family not in families:
            continue
        if asin in EXCLUDED_OURS:
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


def _create_cap(requested: int | None, cfg_max: int) -> int:
    cap = cfg_max if requested is None else int(requested)
    if cap < 0:
        return 0
    return min(cap, cfg_max)


def sync_competitor_kr(
    *,
    dry_run: bool = False,
    create_missing: bool = False,
    max_create: int | None = None,
) -> dict:
    """Pull competitor KR. Reuse saved searchType0. Create only when flagged."""
    notes: list[str] = []
    errors: list[str] = []
    created: list[str] = []
    reused: list[str] = []
    missing: list[str] = []
    written = {"competitor_kr": 0}
    pulled_at = datetime.now(timezone.utc).isoformat()
    cfg = load_config()
    create_cap = _create_cap(max_create, int(cfg["create_missing_max"]))

    if cfg["dropped_asins"]:
        notes.append(
            "Dropped excluded/hero ASINs from competitor list: "
            + ", ".join(cfg["dropped_asins"])
        )
    if not cfg["competitors"]:
        return {
            "status": "fail",
            "message": "No competitor ASINs left after family/exclude filter.",
            "notes": notes,
            "errors": errors,
            "written": written,
            "created": created,
            "reused": reused,
            "missing": missing,
            "pulled_at": pulled_at,
            "quota": None,
            "digest": {"should_ping": False, "net_new": 0},
        }

    if not token_present():
        notes.append("missing_token")
        return {
            "status": "fail",
            "message": MISSING_TOKEN_MESSAGE,
            "notes": notes,
            "errors": errors,
            "written": written,
            "created": created,
            "reused": reused,
            "missing": [c["asin"] for c in cfg["competitors"]],
            "pulled_at": pulled_at,
            "quota": None,
            "asins": [c["asin"] for c in cfg["competitors"]],
            "digest": {"should_ping": False, "net_new": 0},
        }

    try:
        auth = check_auth()
        acct = ((auth.get("account") or {}) if isinstance(auth, dict) else {}) or {}
        notes.append(f"auth_ok account={acct.get('name') or acct.get('id') or '?'}")
    except AuthError as e:
        return {
            "status": "fail",
            "message": str(e)[:500],
            "notes": notes,
            "errors": [str(e)[:300]],
            "written": written,
            "created": created,
            "reused": reused,
            "missing": [c["asin"] for c in cfg["competitors"]],
            "pulled_at": pulled_at,
            "quota": None,
            "asins": [c["asin"] for c in cfg["competitors"]],
            "digest": {"should_ping": False, "net_new": 0},
        }

    marketplace = cfg["marketplace"]
    kr_cap = int(cfg["max_keywords"])
    kr_rows: list[dict] = []
    quota: QuotaExceeded | None = None
    created_count = 0

    asins = [c["asin"] for c in cfg["competitors"]]
    saved: dict[str, int] = {}
    try:
        saved = collect_saved_kr_search_ids(asins=asins)
    except QuotaExceeded as e:
        quota = e
        notes.append(
            f"402 listing KR searches; stopping (Remaining={e.remaining})."
        )
    except (SoldScopeError, AuthError) as e:
        errors.append(f"list KR searches: {e}")
    except Exception as e:
        errors.append(f"list KR searches: {e}")

    for item in cfg["competitors"]:
        if quota is not None:
            break
        asin = item["asin"]
        family = item["family"]
        sid = saved.get(asin)
        if sid is None and create_missing:
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
                if new_id is None:
                    notes.append(
                        f"KR create for competitor {asin} returned no search id "
                        "(not polling — next weekly reuse will pick it up)."
                    )
                    missing.append(asin)
                    continue
                sid = int(new_id)
                notes.append(
                    f"Created single-ASIN KR search {sid} for competitor {asin} "
                    "(no wait-loop; results on a later reuse)."
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
                    "(pass --create-missing to POST, cap "
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
            )
            kr_rows.extend(batch)
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

    if not kr_rows and quota is None and not created:
        notes.append(EMPTY_SNAPSHOT_NOTE)

    previous: list[dict] = []
    if not dry_run:
        from src.db import upsert_rows

        written["competitor_kr"] = upsert_rows(
            TABLE, kr_rows, on_conflict=CONFLICT,
        )
        previous = _load_previous_outliers(kr_rows)

    current_outliers = build_competitor_outliers({
        "kr_rows": kr_rows,
        "opportunity_floor": cfg["opportunity_floor"],
    })
    # When we just wrote this week's rows, previous is last week's warehouse
    # snapshot. Dry-run has no warehouse — net-new is the current harvest set.
    prev_outliers = (
        previous
        if previous
        else []
    )
    net_new = net_new_actionable(current_outliers, prev_outliers)
    digest = {
        "should_ping": digest_should_ping(net_new),
        "net_new": len(net_new),
    }
    if digest["should_ping"]:
        notes.append(
            f"Blake digest hook: {digest['net_new']} net-new harvest_exact "
            "row(s). Email is not sent from this job."
        )

    total_in = len(kr_rows)
    if quota and total_in == 0 and not created and not any(written.values()):
        status = "fail"
    elif quota or errors:
        status = "partial" if total_in or created or any(written.values()) else "fail"
    else:
        status = "success"

    message = (
        f"{len(cfg['competitors'])} competitor ASIN(s), "
        f"{len(reused)} reused / {len(created)} created / "
        f"{len(missing)} missing, {len(kr_rows)} KR row(s)"
    )
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
        "missing": missing,
        "create_missing": create_missing,
        "create_cap": create_cap,
        "pulled_at": pulled_at,
        "asins": asins,
        "quota_remaining": quota.remaining if quota else None,
        "quota_reset": quota.reset if quota else None,
        "digest": digest,
        "outliers": current_outliers,
    }


def _load_previous_outliers(current_rows: list[dict]) -> list[dict]:
    """Prior as_of warehouse rows for the same competitor ASINs (net-new)."""
    asins = sorted({
        str(r.get("competitor_asin") or "").strip().upper()
        for r in current_rows
        if r.get("competitor_asin")
    })
    current_as_of = {
        str(r.get("as_of") or "")
        for r in current_rows
        if r.get("as_of")
    }
    if not asins:
        return []
    try:
        from src.db import get_client

        client = get_client()
        resp = (
            client.table(TABLE)
            .select("*")
            .in_("competitor_asin", asins)
            .order("as_of", desc=True)
            .limit(5000)
            .execute()
        )
    except Exception as e:
        log.info("Competitor KR previous snapshot skipped: %s", e)
        return []
    prior = [
        r for r in (resp.data or [])
        if isinstance(r, dict) and str(r.get("as_of") or "") not in current_as_of
    ]
    if not prior:
        return []
    newest = max(str(r.get("as_of") or "") for r in prior)
    return build_competitor_outliers({
        "kr_rows": [r for r in prior if str(r.get("as_of") or "") == newest],
    })


# Re-export helpers the tests / client already use so callers stay local.
__all__ = [
    "TABLE",
    "CONFLICT",
    "DEFAULT_CREATE_CAP",
    "EMPTY_SNAPSHOT_NOTE",
    "EXCLUDED_OURS",
    "build_competitor_outliers",
    "classify_exact_bidding",
    "competitor_kr_rows_from_payload",
    "competitor_present",
    "digest_should_ping",
    "exact_keywords_from_targets",
    "load_config",
    "net_new_actionable",
    "suggest_lever",
    "sync_competitor_kr",
]
