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
    get_sales_history,
    list_group_products,
    list_product_phrases,
    list_rank_groups,
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

SALES_CONFLICT = "asin,marketplace,date"
BSR_CONFLICT = "asin,marketplace,date,category_id"
PRICE_CONFLICT = "asin,marketplace,date"
RANK_CONFLICT = "asin,marketplace,group_id,phrase,as_of"

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
    written = {"sales": 0, "bsr": 0, "price": 0, "rank": 0}
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
    quota: QuotaExceeded | None = None

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

    if not dry_run:
        from src.db import upsert_rows

        written["sales"] = upsert_rows(SALES_TABLE, sales_rows, on_conflict=SALES_CONFLICT)
        written["bsr"] = upsert_rows(BSR_TABLE, bsr_rows, on_conflict=BSR_CONFLICT)
        written["price"] = upsert_rows(PRICE_TABLE, price_rows, on_conflict=PRICE_CONFLICT)
        written["rank"] = upsert_rows(RANK_TABLE, rank_rows, on_conflict=RANK_CONFLICT)

    total_in = len(sales_rows) + len(bsr_rows) + len(price_rows) + len(rank_rows)
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
        f"{len(rank_rows)} rank row(s)"
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
        },
        "pulled_at": pulled_at,
        "asins": cfg["asins"],
        "history_empty": history_empty,
        "quota_remaining": quota.remaining if quota else None,
        "quota_reset": quota.reset if quota else None,
    }
