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

Column names vary between the Amazon UI export, the API export and whatever a
spreadsheet has been through, so headers are matched loosely.
"""
from __future__ import annotations

import csv
import io
import logging
import re
from datetime import date

from src.amazon_ads.organic_rank import normalize_keyword

log = logging.getLogger(__name__)

# Header synonyms, matched after lowercasing and stripping punctuation.
QUERY_HEADERS = ("search query", "query", "customer search term", "search term")
RANK_HEADERS = ("organic rank", "rank", "organic position", "position",
                "search query rank")
SHARE_HEADERS = ("click share", "organic click share", "search query click share",
                 "clicks click share", "asin click share")
ASIN_HEADERS = ("asin", "child asin", "parent asin")
DATE_HEADERS = ("reporting date", "date", "week", "start date", "reporting period")

# Click-share thresholds → coarse rank band. Bands, not positions.
SHARE_TO_RANK = ((0.40, 1), (0.15, 5), (0.0, 99))


def _canon(h: str) -> str:
    return re.sub(r"[^a-z0-9 ]", " ", str(h or "").lower()).strip()


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


def _rank_from_share(share: float) -> int:
    for floor, rank in SHARE_TO_RANK:
        if share >= floor:
            return rank
    return 99


def parse_sqp(content: str, default_asin: str = "",
              as_of: date | None = None) -> dict:
    """Parse an SQP export into keyword_organic_rank rows."""
    ref = as_of or date.today()
    reader = csv.DictReader(io.StringIO(content))
    if not reader.fieldnames:
        return {"rows": [], "parsed": 0, "skipped": 0,
                "warnings": ["empty file / no header row"]}

    fields = list(reader.fieldnames)
    q_col = _find(fields, QUERY_HEADERS)
    r_col = _find(fields, RANK_HEADERS)
    s_col = _find(fields, SHARE_HEADERS)
    a_col = _find(fields, ASIN_HEADERS)
    d_col = _find(fields, DATE_HEADERS)

    warnings: list[str] = []
    if not q_col:
        return {"rows": [], "parsed": 0, "skipped": 0,
                "warnings": [f"no search-query column found in: {fields}"]}
    if not r_col and not s_col:
        warnings.append(
            "export has neither a rank column nor a click-share column — no rank "
            "can be established from it")

    rows: list[dict] = []
    parsed = skipped = derived = 0
    for rec in reader:
        raw_q = rec.get(q_col) or ""
        kw = normalize_keyword(raw_q)
        if not kw:
            skipped += 1
            continue

        rank: int | None = None
        share: float | None = None

        if r_col:
            try:
                v = int(float(str(rec.get(r_col) or "").strip()))
                rank = v if v > 0 else None
            except (ValueError, TypeError):
                rank = None

        if s_col:
            share = _parse_share(rec.get(s_col))

        if rank is None and share is not None:
            rank = _rank_from_share(share)
            derived += 1
        if rank is None:
            skipped += 1
            continue

        row_date = ref.isoformat()
        if d_col and rec.get(d_col):
            candidate = str(rec[d_col]).strip()[:10]
            try:
                date.fromisoformat(candidate)
                row_date = candidate
            except ValueError:
                pass

        rows.append({
            "asin": (rec.get(a_col) or default_asin or "").strip() if a_col else default_asin,
            "keyword_normalized": kw,
            "keyword_raw": raw_q.strip(),
            "organic_rank": rank,
            "page": 1 if rank <= 48 else 2,
            "source": "sqp",
            "as_of": row_date,
            "impression_share_organic": share,
        })
        parsed += 1

    if derived:
        warnings.append(
            f"{derived} row(s) had no rank column — rank BAND derived from click "
            f"share (>=40% -> 1, >=15% -> 5, else 99). These are bands, not "
            f"measured SERP positions.")

    # One row per (asin, keyword): keep the best-evidenced.
    best: dict[tuple, dict] = {}
    for r in rows:
        k = (r["asin"], r["keyword_normalized"])
        prev = best.get(k)
        if prev is None or (r["organic_rank"] or 99) < (prev["organic_rank"] or 99):
            best[k] = r

    return {"rows": list(best.values()), "parsed": parsed, "skipped": skipped,
            "derived_from_share": derived, "warnings": warnings,
            "columns": {"query": q_col, "rank": r_col, "share": s_col,
                        "asin": a_col, "date": d_col}}


def import_sqp(path: str, default_asin: str = "", as_of: date | None = None,
               dry_run: bool = False) -> dict:
    from src.amazon_ads.organic_rank import upsert_ranks

    with open(path, encoding="utf-8-sig") as f:
        result = parse_sqp(f.read(), default_asin=default_asin, as_of=as_of)

    if dry_run or not result["rows"]:
        result["written"] = 0
        return result
    result["written"] = upsert_ranks(result["rows"])
    return result
