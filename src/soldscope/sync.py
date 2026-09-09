"""Weekly SoldScope pull for the three parent hero ASINs.

Writes soldscope_* warehouse tables and a job_runs row (via the CLI /
scheduler wrapper). Rank Tracker is observe-only: list existing groups,
match heroes, pull phrases if present. Zero groups → empty + a job note.
Never POSTs create-group / create-phrase.

Not a source for sales_daily, nexus, liability, or Ads actions.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

from src.config import PROJECT_ROOT
from src.rules import AMAZON_TZ
from src.soldscope.client import (
    AuthError,
    QuotaExceeded,
    SoldScopeError,
    check_auth,
    get_bsr_history,
    get_price_history,
    get_ratings_history,
    get_sales_history,
    get_search_volume,
    get_kr_asin_results,
    list_group_products,
    list_kr_searches,
    list_product_phrases,
    list_rank_groups,
    create_single_asin_search,
    token_present,
)

log = logging.getLogger(__name__)

# Locked parent heroes from config/asin_titles.json. Config may only list
# a subset; extras are dropped. Never invent ASINs.
LOCKED_HERO_ASINS = frozenset({
    "B0CLHTF8YN",
    "B0DQFKMJFY",
    "B0HBSZ71XQ",
})

SALES_TABLE = "soldscope_sales_history"
BSR_TABLE = "soldscope_bsr_history"
PRICE_TABLE = "soldscope_price_history"
RANK_TABLE = "soldscope_rank_snapshots"
RATINGS_TABLE = "soldscope_ratings_history"
VOLUME_TABLE = "soldscope_search_volume"
KR_TABLE = "soldscope_keyword_research"

SALES_CONFLICT = "asin,marketplace,date"
BSR_CONFLICT = "asin,marketplace,date,category_id"
PRICE_CONFLICT = "asin,marketplace,date"
RANK_CONFLICT = "asin,marketplace,group_id,phrase,as_of"
RATINGS_CONFLICT = "asin,marketplace,date"
VOLUME_CONFLICT = "keyword_normalized,marketplace"
KR_CONFLICT = "asin,marketplace,keyword_normalized,search_id"

DEFAULT_KR_MAX_KEYWORDS = 80

DEFAULT_SV_MAX_KEYWORDS = 20
DEFAULT_RATINGS_DAYS = 365

MISSING_TOKEN_MESSAGE = (
    "SOLDSCOPE_API_TOKEN is not set. Add it to the Mini .env (launchd) "
    "and keep it on Vercel only if a live pull is added later. "
    "Never commit the token. Weekly job stays scheduled and fails soft."
)

EMPTY_HISTORY_NOTE = (
    "History empty — SoldScope may still be downloading Amazon data. "
    "No rows invented. Weekly job is ready; it will store points when they appear."
)

RT_EMPTY_NOTE = (
    "Rank Tracker returned 0 groups — observe-only, "
    "not creating groups or phrases."
)


def load_asin_titles() -> dict[str, str]:
    path = PROJECT_ROOT / "config" / "asin_titles.json"
    with open(path) as f:
        raw = json.load(f)
    return {
        k: v.strip()
        for k, v in raw.items()
        if not str(k).startswith("_") and isinstance(v, str) and v.strip()
    }


def load_config() -> dict:
    path = PROJECT_ROOT / "config" / "soldscope.json"
    with open(path) as f:
        raw = json.load(f)
    titles = load_asin_titles()
    requested = [str(a).strip().upper() for a in (raw.get("asins") or []) if str(a).strip()]
    asins = [a for a in requested if a in LOCKED_HERO_ASINS and a in titles]
    dropped = [a for a in requested if a not in asins]
    schedule = raw.get("schedule") or {}
    rt = raw.get("rank_tracker") or {}
    return {
        "marketplace": str(raw.get("marketplace") or "US"),
        "days": int(raw.get("days") or 90),
        "asins": asins,
        "dropped_asins": dropped,
        "titles": {a: titles[a] for a in asins},
        "schedule": {
            "day_of_week": schedule.get("day_of_week", "sun"),
            "hour": int(schedule.get("hour", 10)),
            "minute": int(schedule.get("minute", 30)),
            "timezone": schedule.get("timezone", "America/New_York"),
        },
        "rank_tracker": {
            "enabled": bool(rt.get("enabled", True)),
            "create_groups": False,
        },
        "search_volume": {
            "enabled": bool((raw.get("search_volume") or {}).get("enabled", True)),
            "max_keywords": int(
                (raw.get("search_volume") or {}).get("max_keywords")
                or DEFAULT_SV_MAX_KEYWORDS
            ),
        },
        "ratings": {
            "enabled": bool((raw.get("ratings") or {}).get("enabled", True)),
            "days": int((raw.get("ratings") or {}).get("days") or DEFAULT_RATINGS_DAYS),
        },
        "keyword_research": {
            "enabled": bool((raw.get("keyword_research") or {}).get("enabled", True)),
            "create_if_needed": bool(
                (raw.get("keyword_research") or {}).get("create_if_needed", True)
            ),
            "max_keywords": int(
                (raw.get("keyword_research") or {}).get("max_keywords")
                or DEFAULT_KR_MAX_KEYWORDS
            ),
        },
    }


def unix_to_amazon_date(ts: int | float | str | None) -> date | None:
    """SoldScope history points are unix seconds. Day boundary = Amazon TZ."""
    if ts is None or ts == "":
        return None
    try:
        epoch = int(float(ts))
    except (TypeError, ValueError):
        return None
    if epoch > 10_000_000_000:  # ms
        epoch //= 1000
    return datetime.fromtimestamp(epoch, tz=AMAZON_TZ).date()


def _num(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _int(value: Any) -> int | None:
    n = _num(value)
    if n is None:
        return None
    return int(n)


def collapse_points(
    points: Iterable[tuple[date, Any]],
) -> dict[date, Any]:
    """Last point on a calendar date wins — upserts stay idempotent."""
    out: dict[date, Any] = {}
    for d, value in points:
        out[d] = value
    return out


def sales_rows_from_payload(
    body: dict,
    *,
    asin: str,
    marketplace: str,
    pulled_at: str,
) -> list[dict]:
    data = (body or {}).get("data") or {}
    series = data.get("sales") if isinstance(data, dict) else None
    if not isinstance(series, list):
        return []
    pairs: list[tuple[date, int | None]] = []
    for pt in series:
        if not isinstance(pt, dict):
            continue
        d = unix_to_amazon_date(pt.get("time"))
        if d is None:
            continue
        pairs.append((d, _int(pt.get("value"))))
    collapsed = collapse_points(pairs)
    return [
        {
            "asin": asin,
            "marketplace": marketplace,
            "date": d.isoformat(),
            "units": units,
            "pulled_at": pulled_at,
        }
        for d, units in sorted(collapsed.items())
    ]


def bsr_rows_from_payload(
    body: dict,
    *,
    asin: str,
    marketplace: str,
    pulled_at: str,
) -> list[dict]:
    data = (body or {}).get("data") or {}
    series = data.get("bsr") if isinstance(data, dict) else None
    categories = {
        int(c["id"]): (c.get("title") or None)
        for c in (data.get("categories") or [])
        if isinstance(c, dict) and c.get("id") is not None
    } if isinstance(data, dict) else {}
    if not isinstance(series, list):
        return []
    pairs: list[tuple[tuple[date, int], tuple[int | None, str | None]]] = []
    for pt in series:
        if not isinstance(pt, dict):
            continue
        d = unix_to_amazon_date(pt.get("time"))
        if d is None:
            continue
        cat_id = _int(pt.get("category")) or 0
        pairs.append(((d, cat_id), (_int(pt.get("value")), categories.get(cat_id))))
    collapsed: dict[tuple[date, int], tuple[int | None, str | None]] = {}
    for key, value in pairs:
        collapsed[key] = value
    return [
        {
            "asin": asin,
            "marketplace": marketplace,
            "date": d.isoformat(),
            "category_id": cat_id,
            "bsr": bsr,
            "category_title": title,
            "pulled_at": pulled_at,
        }
        for (d, cat_id), (bsr, title) in sorted(collapsed.items())
    ]


def price_rows_from_payload(
    body: dict,
    *,
    asin: str,
    marketplace: str,
    pulled_at: str,
    min_date: date | None = None,
) -> list[dict]:
    data = (body or {}).get("data") or {}
    series = data.get("price") if isinstance(data, dict) else None
    if not isinstance(series, list):
        return []
    pairs: list[tuple[date, float | None]] = []
    for pt in series:
        if not isinstance(pt, dict):
            continue
        d = unix_to_amazon_date(pt.get("time"))
        if d is None:
            continue
        if min_date is not None and d < min_date:
            continue
        pairs.append((d, _num(pt.get("value"))))
    collapsed = collapse_points(pairs)
    return [
        {
            "asin": asin,
            "marketplace": marketplace,
            "date": d.isoformat(),
            "price": price,
            "pulled_at": pulled_at,
        }
        for d, price in sorted(collapsed.items())
    ]


def ratings_rows_from_payload(
    body: dict,
    *,
    asin: str,
    marketplace: str,
    pulled_at: str,
) -> list[dict]:
    data = (body or {}).get("data") or {}
    series = data.get("ratings") if isinstance(data, dict) else None
    if not isinstance(series, list):
        return []
    pairs: list[tuple[date, tuple[float | None, int | None]]] = []
    for pt in series:
        if not isinstance(pt, dict):
            continue
        d = unix_to_amazon_date(pt.get("time"))
        if d is None:
            continue
        pairs.append((d, (_num(pt.get("rating")), _int(pt.get("count")))))
    collapsed: dict[date, tuple[float | None, int | None]] = {}
    for d, value in pairs:
        collapsed[d] = value
    return [
        {
            "asin": asin,
            "marketplace": marketplace,
            "date": d.isoformat(),
            "rating": rating,
            "ratings_count": count,
            "pulled_at": pulled_at,
        }
        for d, (rating, count) in sorted(collapsed.items())
    ]


def search_volume_row_from_payload(
    body: dict,
    *,
    keyword_normalized: str,
    marketplace: str,
    pulled_at: str,
) -> dict | None:
    """Latest weekly point + sv30. Empty history → None (no invented volume)."""
    key = (keyword_normalized or "").strip()
    if not key:
        return None
    data = (body or {}).get("data") or {}
    if not isinstance(data, dict):
        return None
    weekly = data.get("svHistory")
    as_of: str | None = None
    sv: int | None = None
    if isinstance(weekly, list):
        best: tuple[str, int | None] | None = None
        for pt in weekly:
            if not isinstance(pt, dict):
                continue
            event = str(pt.get("event_date") or "").strip()
            if not event:
                continue
            if best is None or event > best[0]:
                best = (event, _int(pt.get("search_volume")))
        if best:
            as_of, sv = best
    sv30 = _int(data.get("sv30Days"))
    if as_of is None and sv30 is None and sv is None:
        return None
    return {
        "keyword_normalized": key,
        "marketplace": marketplace,
        "as_of": as_of or date.today().isoformat(),
        "search_volume": sv,
        "sv30": sv30,
        "pulled_at": pulled_at,
    }


def kr_search_asin(item: dict) -> str | None:
    for key in ("mainAsin", "seedAsin"):
        a = str(item.get(key) or "").strip().upper()
        if a:
            return a
    asins = item.get("asins")
    if isinstance(asins, list) and asins:
        a = str(asins[0] or "").strip().upper()
        if a:
            return a
    return None


def is_single_asin_kr(item: dict) -> bool:
    return item.get("searchType") in (0, "0")


def collect_saved_kr_search_ids(*, asins: Iterable[str]) -> dict[str, int]:
    """Newest completed single-ASIN search id per hero. Never creates."""
    found: dict[str, int] = {}
    heroes = {str(a).strip().upper() for a in asins}
    for asin in heroes:
        body = list_kr_searches(page=1, per_page=20, asin=asin)
        for item in _page_items(body):
            if not isinstance(item, dict) or not is_single_asin_kr(item):
                continue
            sid = item.get("id")
            matched = kr_search_asin(item)
            if sid is None or matched not in heroes:
                continue
            if matched not in found:
                found[matched] = int(sid)
    return found


def collect_kr_results(search_id: int, *, cap: int) -> list[dict]:
    items: list[dict] = []
    page = 1
    while len(items) < cap:
        body = get_kr_asin_results(search_id, page=page, per_page=min(100, cap))
        batch = [p for p in _page_items(body) if isinstance(p, dict)]
        items.extend(batch)
        if len(batch) < 100:
            break
        page += 1
        if page > 5:
            break
    return items[:cap]


def kr_rows_from_payload(
    items: list[dict],
    *,
    asin: str,
    marketplace: str,
    search_id: int,
    pulled_at: str,
) -> list[dict]:
    from src.amazon_ads.organic_rank import normalize_keyword

    rows: list[dict] = []
    seen: set[str] = set()
    for p in items:
        keyword = str(p.get("keyword") or "").strip()
        key = normalize_keyword(keyword)
        if not keyword or key in seen:
            continue
        seen.add(key)
        rows.append({
            "asin": asin,
            "marketplace": marketplace,
            "search_id": int(search_id),
            "keyword_normalized": key,
            "keyword": keyword,
            "search_volume": _int(p.get("searchVolume")),
            "opportunity_score": _int(p.get("opportunityScore")),
            "organic_rank": _int(p.get("organicRank")),
            "sponsored_rank": _int(p.get("sponsoredRank")),
            "cpc": _num(p.get("cpc")),
            "as_of": date.today().isoformat(),
            "pulled_at": pulled_at,
        })
    return rows


def collect_existing_keywords(*, limit: int = DEFAULT_SV_MAX_KEYWORDS) -> list[str]:
    """Keywords we already show (targets + search terms). Never invent queries."""
    from src.amazon_ads.organic_rank import normalize_keyword

    scored: dict[str, float] = {}
    try:
        from src.db import get_client

        client = get_client()
        try:
            kw = (
                client.table("ads_keyword_targets")
                .select("keyword_text")
                .limit(2000)
                .execute()
            )
            for row in kw.data or []:
                n = normalize_keyword((row or {}).get("keyword_text"))
                if n:
                    scored[n] = scored.get(n, 0) + 1.0
        except Exception as e:
            log.info("SoldScope keyword-target collect skipped: %s", e)
        try:
            terms = (
                client.table("ads_search_terms_daily")
                .select("search_term,spend")
                .order("date", desc=True)
                .limit(2000)
                .execute()
            )
            for row in terms.data or []:
                n = normalize_keyword((row or {}).get("search_term"))
                if n:
                    scored[n] = scored.get(n, 0) + float((row or {}).get("spend") or 0)
        except Exception as e:
            log.info("SoldScope search-term collect skipped: %s", e)
    except Exception as e:
        log.info("SoldScope keyword collect skipped (no warehouse): %s", e)
        return []
    ranked = sorted(scored.items(), key=lambda kv: (-kv[1], kv[0]))
    return [k for k, _ in ranked[: max(0, int(limit))]]


def upsert_key(table: str, row: dict) -> tuple:
    """Stable unique key matching the warehouse primary key."""
    if table == SALES_TABLE:
        return (row["asin"], row["marketplace"], row["date"])
    if table == BSR_TABLE:
        return (row["asin"], row["marketplace"], row["date"], int(row.get("category_id") or 0))
    if table == PRICE_TABLE:
        return (row["asin"], row["marketplace"], row["date"])
    if table == RANK_TABLE:
        return (
            row["asin"], row["marketplace"], int(row["group_id"]),
            row["phrase"], row["as_of"],
        )
    if table == RATINGS_TABLE:
        return (row["asin"], row["marketplace"], row["date"])
    if table == VOLUME_TABLE:
        return (row["keyword_normalized"], row["marketplace"])
    if table == KR_TABLE:
        return (
            row["asin"], row["marketplace"],
            row["keyword_normalized"], int(row["search_id"]),
        )
    raise KeyError(table)


def merge_upsert_rows(existing: list[dict], incoming: list[dict], table: str) -> list[dict]:
    """Last incoming row wins per unique key — same as PostgREST upsert."""
    merged = {upsert_key(table, r): r for r in existing}
    for r in incoming:
        merged[upsert_key(table, r)] = r
    return list(merged.values())


def match_hero_groups(groups: list[dict], hero_asins: Iterable[str]) -> list[dict]:
    """Keep groups whose primary ASIN is a configured hero. Never create."""
    heroes = {str(a).strip().upper() for a in hero_asins}
    matched = []
    for g in groups:
        if not isinstance(g, dict):
            continue
        asin = str(g.get("asin") or "").strip().upper()
        if asin in heroes:
            matched.append(g)
    return matched


def _page_items(body: dict) -> list:
    data = body.get("data")
    if isinstance(data, list):
        return data
    return []


def collect_rank_groups(*, marketplace: str) -> list[dict]:
    groups: list[dict] = []
    page = 1
    while True:
        body = list_rank_groups(page=page, per_page=100, marketplace=marketplace)
        items = [g for g in _page_items(body) if isinstance(g, dict)]
        groups.extend(items)
        meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
        last = meta.get("last_page") or meta.get("lastPage")
        if last is not None:
            try:
                if page >= int(last):
                    break
            except (TypeError, ValueError):
                pass
        if len(items) < 100:
            break
        page += 1
        if page > 50:
            break
    return groups


def collect_phrases(group_id: int, product_id: int) -> list[dict]:
    phrases: list[dict] = []
    page = 1
    while True:
        body = list_product_phrases(group_id, product_id, page=page, per_page=1000)
        items = [p for p in _page_items(body) if isinstance(p, dict)]
        phrases.extend(items)
        if len(items) < 1000:
            break
        page += 1
        if page > 20:
            break
    return phrases


def rank_rows_from_phrases(
    phrases: list[dict],
    *,
    asin: str,
    marketplace: str,
    group_id: int,
    product_id: int | None,
    as_of: date,
    pulled_at: str,
) -> list[dict]:
    rows: list[dict] = []
    seen: set[str] = set()
    for p in phrases:
        phrase = str(p.get("phrase") or "").strip()
        if not phrase or phrase in seen:
            continue
        seen.add(phrase)
        rows.append({
            "asin": asin,
            "marketplace": marketplace,
            "group_id": int(group_id),
            "product_id": product_id,
            "phrase_id": _int(p.get("id")),
            "phrase": phrase,
            "organic_position": _int(p.get("organicPosition")),
            "sponsored_position": _int(p.get("sponsoredPosition")),
            "search_volume": _int(p.get("searchVolume")),
            "as_of": as_of.isoformat(),
            "pulled_at": pulled_at,
            "raw": {
                "organicPage": p.get("organicPage"),
                "sponsoredPage": p.get("sponsoredPage"),
                "cpc": p.get("cpc"),
            },
        })
    return rows


def _pick_product_id(products: list[dict], asin: str) -> int | None:
    want = asin.upper()
    for p in products:
        if str(p.get("asin") or "").strip().upper() == want and p.get("id") is not None:
            return int(p["id"])
    for p in products:
        if p.get("id") is not None:
            return int(p["id"])
    return None


def sync_weekly(*, dry_run: bool = False) -> dict:
    """Pull hero history + optional RT snapshots. Fail soft on missing token / 402."""
    notes: list[str] = []
    errors: list[str] = []
    written = {
        "sales": 0, "bsr": 0, "price": 0, "rank": 0,
        "ratings": 0, "search_volume": 0, "keyword_research": 0,
    }
    pulled_at = datetime.now(timezone.utc).isoformat()
    cfg = load_config()

    if cfg["dropped_asins"]:
        notes.append(
            "Dropped non-hero ASINs from config: " + ", ".join(cfg["dropped_asins"])
        )
    if not cfg["asins"]:
        return {
            "status": "fail",
            "message": "No locked hero ASINs left after config filter.",
            "notes": notes,
            "errors": errors,
            "written": written,
            "pulled_at": pulled_at,
            "quota": None,
        }

    if not token_present():
        notes.append("missing_token")
        return {
            "status": "fail",
            "message": MISSING_TOKEN_MESSAGE,
            "notes": notes,
            "errors": errors,
            "written": written,
            "pulled_at": pulled_at,
            "quota": None,
            "asins": cfg["asins"],
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
            "pulled_at": pulled_at,
            "quota": None,
            "asins": cfg["asins"],
        }

    marketplace = cfg["marketplace"]
    days = cfg["days"]
    min_price_date = date.today() - timedelta(days=days)
    sales_rows: list[dict] = []
    bsr_rows: list[dict] = []
    price_rows: list[dict] = []
    rank_rows: list[dict] = []
    ratings_rows: list[dict] = []
    volume_rows: list[dict] = []
    kr_rows: list[dict] = []
    quota: QuotaExceeded | None = None
    ratings_days = int(cfg["ratings"]["days"])

    for asin in cfg["asins"]:
        try:
            sales_rows.extend(sales_rows_from_payload(
                get_sales_history(marketplace=marketplace, asin=asin, days=days),
                asin=asin, marketplace=marketplace, pulled_at=pulled_at,
            ))
            bsr_rows.extend(bsr_rows_from_payload(
                get_bsr_history(marketplace=marketplace, asin=asin, days=days),
                asin=asin, marketplace=marketplace, pulled_at=pulled_at,
            ))
            price_rows.extend(price_rows_from_payload(
                get_price_history(marketplace=marketplace, asin=asin),
                asin=asin, marketplace=marketplace, pulled_at=pulled_at,
                min_date=min_price_date,
            ))
        except QuotaExceeded as e:
            quota = e
            notes.append(
                f"402 on history for {asin}; stopping remaining ASINs "
                f"(Remaining={e.remaining})."
            )
            break
        except (SoldScopeError, AuthError) as e:
            errors.append(f"{asin} history: {e}")
        except Exception as e:
            errors.append(f"{asin} history: {e}")

    if quota is None and cfg["ratings"]["enabled"]:
        for asin in cfg["asins"]:
            try:
                ratings_rows.extend(ratings_rows_from_payload(
                    get_ratings_history(
                        marketplace=marketplace, asin=asin, days=ratings_days,
                    ),
                    asin=asin, marketplace=marketplace, pulled_at=pulled_at,
                ))
            except QuotaExceeded as e:
                quota = e
                notes.append(
                    f"402 on ratings-history for {asin}; stopping "
                    f"(Remaining={e.remaining})."
                )
                break
            except (SoldScopeError, AuthError) as e:
                errors.append(f"{asin} ratings: {e}")
            except Exception as e:
                errors.append(f"{asin} ratings: {e}")

    if quota is None and cfg["rank_tracker"]["enabled"]:
        try:
            groups = collect_rank_groups(marketplace=marketplace)
            if not groups:
                notes.append(RT_EMPTY_NOTE)
            else:
                matched = match_hero_groups(groups, cfg["asins"])
                if not matched:
                    notes.append(
                        f"Rank Tracker has {len(groups)} group(s) but none "
                        "match hero ASINs — observe-only, not creating groups."
                    )
                else:
                    as_of = date.today()
                    for g in matched:
                        asin = str(g.get("asin") or "").strip().upper()
                        gid = int(g["id"])
                        products_body = list_group_products(gid)
                        products = [p for p in _page_items(products_body) if isinstance(p, dict)]
                        pid = _pick_product_id(products, asin)
                        if pid is None:
                            notes.append(f"RT group {gid} ({asin}) has no product id — skipped phrases.")
                            continue
                        phrases = collect_phrases(gid, pid)
                        rank_rows.extend(rank_rows_from_phrases(
                            phrases,
                            asin=asin,
                            marketplace=marketplace,
                            group_id=gid,
                            product_id=pid,
                            as_of=as_of,
                            pulled_at=pulled_at,
                        ))
                    notes.append(
                        f"Rank Tracker matched {len(matched)} hero group(s), "
                        f"{len(rank_rows)} phrase snapshot(s)."
                    )
        except QuotaExceeded as e:
            quota = e
            notes.append(
                f"402 on Rank Tracker read; stopping (Remaining={e.remaining})."
            )
        except (SoldScopeError, AuthError) as e:
            errors.append(f"rank tracker: {e}")
        except Exception as e:
            errors.append(f"rank tracker: {e}")

    if quota is None and cfg["search_volume"]["enabled"]:
        from src.amazon_ads.organic_rank import normalize_keyword

        already = {
            normalize_keyword(str(r.get("phrase") or ""))
            for r in rank_rows
            if r.get("search_volume") is not None
        }
        already.discard("")
        keywords = [
            k for k in collect_existing_keywords(
                limit=int(cfg["search_volume"]["max_keywords"]),
            )
            if k not in already
        ]
        pulled_sv = 0
        for keyword in keywords:
            try:
                row = search_volume_row_from_payload(
                    get_search_volume(marketplace=marketplace, keyword=keyword),
                    keyword_normalized=keyword,
                    marketplace=marketplace,
                    pulled_at=pulled_at,
                )
                if row:
                    volume_rows.append(row)
                    pulled_sv += 1
            except QuotaExceeded as e:
                quota = e
                notes.append(
                    f"402 on search-volume for '{keyword}'; stopping "
                    f"(Remaining={e.remaining})."
                )
                break
            except (SoldScopeError, AuthError) as e:
                errors.append(f"search-volume '{keyword}': {e}")
            except Exception as e:
                errors.append(f"search-volume '{keyword}': {e}")
        notes.append(
            f"Search volume: {pulled_sv} keyword(s) stored"
            + (f", skipped {len(already)} already on RT phrases" if already else "")
            + "."
        )

    history_ready = bool(sales_rows or bsr_rows or price_rows)
    if quota is None and cfg["keyword_research"]["enabled"]:
        kr_cap = int(cfg["keyword_research"]["max_keywords"])
        try:
            saved = collect_saved_kr_search_ids(asins=cfg["asins"])
            for asin in cfg["asins"]:
                sid = saved.get(asin)
                if sid is None and cfg["keyword_research"]["create_if_needed"]:
                    has_rt = any(r.get("asin") == asin for r in rank_rows)
                    if not history_ready:
                        notes.append(
                            f"Skip KR create for {asin} — SoldScope still downloading "
                            "(history empty)."
                        )
                    elif has_rt:
                        notes.append(
                            f"Skip KR create for {asin} — Rank Tracker phrases already stored."
                        )
                    else:
                        created = create_single_asin_search(
                            marketplace=marketplace, asin=asin,
                        )
                        data = created.get("data") if isinstance(created, dict) else None
                        new_id = (data or {}).get("id") if isinstance(data, dict) else None
                        if new_id is None:
                            notes.append(f"KR create for {asin} returned no search id.")
                        else:
                            sid = int(new_id)
                            notes.append(f"Created single-ASIN KR search {sid} for {asin}.")
                if sid is None:
                    continue
                items = collect_kr_results(sid, cap=kr_cap)
                kr_rows.extend(kr_rows_from_payload(
                    items,
                    asin=asin,
                    marketplace=marketplace,
                    search_id=sid,
                    pulled_at=pulled_at,
                ))
            notes.append(
                f"Keyword research: {len(kr_rows)} keyword(s) from "
                f"{len({r['search_id'] for r in kr_rows})} saved/created search(es)."
            )
        except QuotaExceeded as e:
            quota = e
            notes.append(
                f"402 on keyword-research; stopping (Remaining={e.remaining})."
            )
        except (SoldScopeError, AuthError) as e:
            errors.append(f"keyword-research: {e}")
        except Exception as e:
            errors.append(f"keyword-research: {e}")

    if not dry_run:
        from src.db import upsert_rows

        written["sales"] = upsert_rows(SALES_TABLE, sales_rows, on_conflict=SALES_CONFLICT)
        written["bsr"] = upsert_rows(BSR_TABLE, bsr_rows, on_conflict=BSR_CONFLICT)
        written["price"] = upsert_rows(PRICE_TABLE, price_rows, on_conflict=PRICE_CONFLICT)
        written["rank"] = upsert_rows(RANK_TABLE, rank_rows, on_conflict=RANK_CONFLICT)
        written["ratings"] = upsert_rows(
            RATINGS_TABLE, ratings_rows, on_conflict=RATINGS_CONFLICT,
        )
        written["search_volume"] = upsert_rows(
            VOLUME_TABLE, volume_rows, on_conflict=VOLUME_CONFLICT,
        )
        written["keyword_research"] = upsert_rows(
            KR_TABLE, kr_rows, on_conflict=KR_CONFLICT,
        )

    total_in = (
        len(sales_rows) + len(bsr_rows) + len(price_rows) + len(rank_rows)
        + len(ratings_rows) + len(volume_rows) + len(kr_rows)
    )
    history_empty = not (sales_rows or bsr_rows or price_rows)
    if history_empty and quota is None:
        notes.append(EMPTY_HISTORY_NOTE)

    if quota and total_in == 0 and not any(written.values()):
        status = "fail"
    elif quota or errors:
        status = "partial" if total_in or any(written.values()) else "fail"
    else:
        # Empty catalog is a clean success: connection works, data not ready yet.
        status = "success"

    message = (
        f"{len(cfg['asins'])} hero ASIN(s), {len(sales_rows)} sales / "
        f"{len(bsr_rows)} bsr / {len(price_rows)} price / "
        f"{len(rank_rows)} rank / {len(ratings_rows)} ratings / "
        f"{len(volume_rows)} search-volume / {len(kr_rows)} KR row(s)"
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
        "counts": {
            "sales": len(sales_rows),
            "bsr": len(bsr_rows),
            "price": len(price_rows),
            "rank": len(rank_rows),
            "ratings": len(ratings_rows),
            "search_volume": len(volume_rows),
            "keyword_research": len(kr_rows),
        },
        "pulled_at": pulled_at,
        "asins": cfg["asins"],
        "history_empty": history_empty,
        "quota_remaining": quota.remaining if quota else None,
        "quota_reset": quota.reset if quota else None,
    }
