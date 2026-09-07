"""Brand Analytics Search Query Performance import.

SQP is the official Amazon signal closest to organic rank. It does not publish
a SERP position directly — it reports, per query, how many impressions/clicks/
purchases the whole market saw and what share was ours. So this parser:

  - takes an explicit rank column when the export (or a derived sheet) has one
  - otherwise derives a rank BAND from our organic click share, and records
    only that band with the share alongside it

Deriving a band is a deliberate compromise and is marked as such: a 60% click
share on a query is strong evidence we sit at or near the top, but it is not a
measured position. The band is coarse on purpose (1 / 5 / 99) so it can drive
the three policy tiers without pretending to a precision it does not have. Any
row where share is missing yields NO rank rather than a guess.

Official Seller Central Brand Analytics exports often start with a metadata
preamble (Brand=/Reporting Range=/Select week=) before the real header row.
Brand View CSVs use "Clicks: Brand Share %" / "Impressions: Brand Share %" /
"Purchases: Brand Share %" and funnel Total/Brand counts — those land in
sqp_weekly (source=sqp_brand_csv). Shares are never invented.

Column names vary between the Amazon UI export, the API export and whatever a
spreadsheet has been through, so headers are matched loosely.
"""
from __future__ import annotations

import csv
import io
import logging
import re
from datetime import date, timedelta

from src.amazon_ads.organic_rank import normalize_keyword

log = logging.getLogger(__name__)

# Header synonyms, matched after lowercasing and stripping punctuation.
QUERY_HEADERS = ("search query", "query", "customer search term", "search term")
RANK_HEADERS = ("organic rank", "rank", "organic position", "position",
                "search query rank")
# Click share drives the rank band. Brand Analytics: "Clicks: Brand Share %".
CLICK_SHARE_HEADERS = (
    "clicks brand share",
    "click share", "organic click share", "search query click share",
    "clicks click share", "asin click share",
)
# Kept for callers / tests that still import SHARE_HEADERS.
SHARE_HEADERS = CLICK_SHARE_HEADERS
IMP_SHARE_HEADERS = (
    "impressions brand share", "impression share", "asin impression share",
)
PURCH_SHARE_HEADERS = (
    "purchases brand share", "purchase share", "asin purchase share",
)
ASIN_HEADERS = ("asin", "child asin", "parent asin")
DATE_HEADERS = ("reporting date", "date", "week", "start date", "reporting period")
VOLUME_HEADERS = ("search query volume", "query volume", "search volume")
IMP_TOTAL_HEADERS = ("impressions total count", "total impressions", "impression count")
IMP_BRAND_HEADERS = ("impressions brand count", "asin impressions", "brand impressions")
CLICK_TOTAL_HEADERS = ("clicks total count", "total clicks", "click count")
CLICK_BRAND_HEADERS = ("clicks brand count", "asin clicks", "brand clicks")
PURCH_TOTAL_HEADERS = ("purchases total count", "total purchases", "purchase count")
PURCH_BRAND_HEADERS = ("purchases brand count", "asin purchases", "brand purchases")

WEEKLY_SOURCE = "sqp_brand_csv"

# Click-share thresholds → coarse rank band. Bands, not positions.
SHARE_TO_RANK = ((0.40, 1), (0.15, 5), (0.0, 99))


def _canon(h: str) -> str:
    # Collapse whitespace so "Clicks: Brand Share %" → "clicks brand share"
    # (colon becomes a space; without collapse exact/substring matches miss).
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", str(h or "").lower())).strip()


def _find(fieldnames: list[str], candidates: tuple[str, ...]) -> str | None:
    canon = {_canon(f): f for f in fieldnames}
    for cand in candidates:
        if cand in canon:
            return canon[cand]
    # Substring fallback — exports append units, e.g. "Click Share (%)".
    for c, original in canon.items():
        if any(cand in c for cand in candidates):
            return original
    return None


def _parse_share(value) -> float | None:
    """Accept 0.42, '42%', '42.0'. Returns a fraction, or None."""
    if value is None or value == "":
        return None
    s = str(value).strip().replace(",", "")
    pct = s.endswith("%")
    s = s.rstrip("%").strip()
    try:
        v = float(s)
    except ValueError:
        return None
    if pct or v > 1.0:
        v = v / 100.0
    return max(0.0, min(1.0, v))


def _parse_count(value) -> int | None:
    if value is None or value == "":
        return None
    s = str(value).strip().replace(",", "")
    if not s:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def _rank_from_share(share: float) -> int:
    for floor, rank in SHARE_TO_RANK:
        if share >= floor:
            return rank
    return 99


def is_amazon_sqp_preamble(line: str) -> bool:
    s = str(line or "")
    return bool(re.search(r"Brand\s*=", s) and re.search(r"Reporting\s*Range\s*=", s, re.I))


def parse_select_week_preamble(text: str) -> tuple[date | None, date | None]:
    """Parse week bounds from Seller Central Select week=[...]."""
    m = re.search(
        r"Select\s*week\s*=\s*\[[^\]]*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})",
        str(text or ""),
        re.I,
    )
    if not m:
        return None, None
    try:
        return date.fromisoformat(m.group(1)), date.fromisoformat(m.group(2))
    except ValueError:
        return None, None


def _split_preamble(content: str) -> tuple[str, str, list[str]]:
    """Return (preamble_text, csv_body_starting_at_header, raw_lines)."""
    raw = content.replace("\ufeff", "")
    lines = raw.splitlines()
    header_idx = 0
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        # DictReader-style: first cell that looks like Search Query.
        try:
            row = next(csv.reader([line]))
        except Exception:
            row = [line]
        if _find(row, QUERY_HEADERS):
            header_idx = i
            break
    preamble = "\n".join(lines[:header_idx])
    body = "\n".join(lines[header_idx:])
    return preamble, body, lines


def parse_sqp(content: str, default_asin: str = "",
              as_of: date | None = None) -> dict:
    """Parse an SQP export into keyword_organic_rank + sqp_weekly rows."""
    ref = as_of or date.today()
    preamble, body, _lines = _split_preamble(content)
    week_start, week_end = parse_select_week_preamble(preamble)

    reader = csv.DictReader(io.StringIO(body))
    if not reader.fieldnames:
        return {"rows": [], "weekly": [], "parsed": 0, "skipped": 0,
                "warnings": ["empty file / no header row"],
                "week_start": None, "week_end": None}

    fields = list(reader.fieldnames)
    q_col = _find(fields, QUERY_HEADERS)
    r_col = _find(fields, RANK_HEADERS)
    s_col = _find(fields, CLICK_SHARE_HEADERS)
    imp_share_col = _find(fields, IMP_SHARE_HEADERS)
    purch_share_col = _find(fields, PURCH_SHARE_HEADERS)
    a_col = _find(fields, ASIN_HEADERS)
    d_col = _find(fields, DATE_HEADERS)
    vol_col = _find(fields, VOLUME_HEADERS)
    imp_total_col = _find(fields, IMP_TOTAL_HEADERS)
    imp_brand_col = _find(fields, IMP_BRAND_HEADERS)
    click_total_col = _find(fields, CLICK_TOTAL_HEADERS)
    click_brand_col = _find(fields, CLICK_BRAND_HEADERS)
    purch_total_col = _find(fields, PURCH_TOTAL_HEADERS)
    purch_brand_col = _find(fields, PURCH_BRAND_HEADERS)

    warnings: list[str] = []
    if preamble.strip():
        warnings.append("skipped Amazon metadata line(s) before header row")
    if not q_col:
        return {"rows": [], "weekly": [], "parsed": 0, "skipped": 0,
                "warnings": [f"no search-query column found in: {fields}"],
                "week_start": week_start.isoformat() if week_start else None,
                "week_end": week_end.isoformat() if week_end else None}
    if not r_col and not s_col:
        warnings.append(
            "export has neither a rank column nor a click-share column — no rank "
            "can be established from it")

    from src.amazon_ads.brand_terms import classify

    rows: list[dict] = []
    weekly: list[dict] = []
    parsed = skipped = derived = 0
    reporting_date_seen: date | None = None

    for rec in reader:
        raw_q = rec.get(q_col) or ""
        kw = normalize_keyword(raw_q)
        if not kw:
            skipped += 1
            continue

        asin = (rec.get(a_col) or default_asin or "").strip() if a_col else (default_asin or "")
        click_share = _parse_share(rec.get(s_col)) if s_col else None
        imp_share = _parse_share(rec.get(imp_share_col)) if imp_share_col else None
        purch_share = _parse_share(rec.get(purch_share_col)) if purch_share_col else None

        rank: int | None = None
        if r_col:
            try:
                v = int(float(str(rec.get(r_col) or "").strip()))
                rank = v if v > 0 else None
            except (ValueError, TypeError):
                rank = None

        if rank is None and click_share is not None:
            rank = _rank_from_share(click_share)
            derived += 1

        row_date = ref
        if d_col and rec.get(d_col):
            candidate = str(rec[d_col]).strip()[:10]
            try:
                row_date = date.fromisoformat(candidate)
                if reporting_date_seen is None:
                    reporting_date_seen = row_date
            except ValueError:
                pass

        if rank is not None:
            rows.append({
                "asin": asin,
                "keyword_normalized": kw,
                "keyword_raw": raw_q.strip(),
                "organic_rank": rank,
                "page": 1 if rank <= 48 else 2,
                "source": "sqp",
                "as_of": row_date.isoformat(),
                "impression_share_organic": click_share,
            })
            parsed += 1
        else:
            skipped += 1

        cls = classify(raw_q)
        weekly.append({
            "asin": asin,
            "search_query": raw_q.strip(),
            "query_normalized": kw,
            "week_start": (week_start or ref).isoformat(),
            "week_end": (week_end or row_date).isoformat(),
            "report_period": "WEEK",
            "is_branded": cls["branded"],
            "brand_rule": cls["matched_rule"],
            "total_impressions": _parse_count(rec.get(imp_total_col)) if imp_total_col else None,
            "total_clicks": _parse_count(rec.get(click_total_col)) if click_total_col else None,
            "total_purchases": _parse_count(rec.get(purch_total_col)) if purch_total_col else None,
            "search_query_volume": _parse_count(rec.get(vol_col)) if vol_col else None,
            "asin_impressions": _parse_count(rec.get(imp_brand_col)) if imp_brand_col else None,
            "asin_clicks": _parse_count(rec.get(click_brand_col)) if click_brand_col else None,
            "asin_purchases": _parse_count(rec.get(purch_brand_col)) if purch_brand_col else None,
            "impression_share": imp_share,
            "click_share": click_share,
            "purchase_share": purch_share,
            "source": WEEKLY_SOURCE,
        })

    if (week_start is None or week_end is None) and reporting_date_seen is not None:
        week_end = week_end or reporting_date_seen
        week_start = week_start or (week_end - timedelta(days=6))
        for w in weekly:
            w["week_start"] = week_start.isoformat()
            w["week_end"] = week_end.isoformat()
        warnings.append(
            f"week bounds derived from Reporting Date {reporting_date_seen.isoformat()} "
            f"(week_start = week_end − 6 days)")
    elif week_start is not None and week_end is not None:
        for w in weekly:
            w["week_start"] = week_start.isoformat()
            w["week_end"] = week_end.isoformat()

    if derived:
        warnings.append(
            f"{derived} row(s) had no rank column — rank BAND derived from click "
            f"share (>=40% -> 1, >=15% -> 5, else 99). These are bands, not "
            f"measured SERP positions.")

    # One rank row per (asin, keyword): keep the best-evidenced.
    best: dict[tuple, dict] = {}
    for r in rows:
        k = (r["asin"], r["keyword_normalized"])
        prev = best.get(k)
        if prev is None or (r["organic_rank"] or 99) < (prev["organic_rank"] or 99):
            best[k] = r

    # One weekly row per natural key.
    best_w: dict[tuple, dict] = {}
    for w in weekly:
        k = (w["asin"], w["query_normalized"], w["week_start"], w["source"])
        best_w[k] = w

    return {
        "rows": list(best.values()),
        "weekly": list(best_w.values()),
        "parsed": parsed,
        "skipped": skipped,
        "derived_from_share": derived,
        "warnings": warnings,
        "week_start": week_start.isoformat() if week_start else None,
        "week_end": week_end.isoformat() if week_end else None,
        "columns": {"query": q_col, "rank": r_col, "share": s_col,
                    "asin": a_col, "date": d_col},
    }


def import_sqp(path: str, default_asin: str = "", as_of: date | None = None,
               dry_run: bool = False) -> dict:
    from src.amazon_ads.organic_rank import upsert_ranks

    with open(path, encoding="utf-8-sig") as f:
        result = parse_sqp(f.read(), default_asin=default_asin, as_of=as_of)

    if dry_run:
        result["written"] = 0
        result["sqp_weekly_written"] = 0
        return result

    result["written"] = upsert_ranks(result["rows"]) if result["rows"] else 0
    result["sqp_weekly_written"] = 0
    if result.get("weekly"):
        try:
            from src.amazon_sp.sqp import _upsert_weekly
            result["sqp_weekly_written"] = _upsert_weekly(result["weekly"])
        except Exception as e:
            log.warning("sqp_weekly upsert failed: %s", e)
            result.setdefault("warnings", []).append(
                f"sqp_weekly upsert failed: {str(e)[:200]}")
    return result
