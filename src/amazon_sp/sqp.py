"""Brand Analytics Search Query Performance via SP-API.

Automates the input the PPC organic-rank gate reads, so nobody has to download
a CSV from Seller Central every week.

What this is and is not:

  SQP is available through the SP-API **Reports** API as
  `GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT`. It is NOT part of the
  Advertising API, which publishes no organic signal at all.

  SQP does **not** report a SERP position. It reports market-level funnel
  counts per query and our share of them. So a rank BAND is derived from click
  share — a coarse three-way split that is enough to drive the gate's three
  policy tiers and nothing more. It is recorded as a band, with the underlying
  share kept alongside, and is never presented as "we are position N".

Requires Brand Registry and the **Brand Analytics** role on the existing SP-API
app. A missing role surfaces as an explicit, actionable error rather than an
empty result — silently returning no rows would look identical to "no data this
week" and would quietly disable the gate.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from datetime import date, timedelta

from src.amazon_ads.organic_rank import normalize_keyword

log = logging.getLogger(__name__)

REPORT_TYPE = "GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT"
SOURCE = "sqp_spapi"

# SP-API caps the `asin` reportOption string at 200 characters. ASINs are 10
# chars, space-separated, so 18 fit; batching is computed rather than assumed.
ASIN_OPTION_MAX_CHARS = 200

VALID_PERIODS = ("WEEK", "MONTH", "QUARTER")


# ── Period boundaries ───────────────────────────────────────────
#
# dataStartTime/dataEndTime must align to the reporting period or the report is
# rejected. Amazon's SQP week is Sunday→Saturday.

def week_bounds(ref: date) -> tuple[date, date]:
    """The most recent COMPLETE Sunday→Saturday week before `ref`.

    "Complete" matters: requesting the in-progress week returns nothing useful
    and burns a report slot. Python's weekday() is Mon=0..Sun=6.
    """
    days_since_sunday = (ref.weekday() + 1) % 7
    this_sunday = ref - timedelta(days=days_since_sunday)
    last_saturday = this_sunday - timedelta(days=1)
    last_sunday = last_saturday - timedelta(days=6)
    return last_sunday, last_saturday


def month_bounds(ref: date) -> tuple[date, date]:
    """The most recent complete calendar month before `ref`."""
    first_this = ref.replace(day=1)
    last_prev = first_this - timedelta(days=1)
    return last_prev.replace(day=1), last_prev


def quarter_bounds(ref: date) -> tuple[date, date]:
    """The most recent complete calendar quarter before `ref`."""
    q = (ref.month - 1) // 3
    first_this_q = date(ref.year, q * 3 + 1, 1)
    last_prev_q = first_this_q - timedelta(days=1)
    start_month = ((last_prev_q.month - 1) // 3) * 3 + 1
    return date(last_prev_q.year, start_month, 1), last_prev_q


def period_bounds(period: str, ref: date | None = None) -> tuple[date, date]:
    ref = ref or date.today()
    p = (period or "WEEK").upper()
    if p == "MONTH":
        return month_bounds(ref)
    if p == "QUARTER":
        return quarter_bounds(ref)
    return week_bounds(ref)


def batch_asins(asins: list[str],
                max_chars: int = ASIN_OPTION_MAX_CHARS) -> list[list[str]]:
    """Split ASINs into batches whose space-joined form fits the option limit."""
    batches: list[list[str]] = []
    current: list[str] = []
    for a in [str(x).strip() for x in asins if str(x).strip()]:
        candidate = current + [a]
        if len(" ".join(candidate)) > max_chars and current:
            batches.append(current)
            current = [a]
        else:
            current = candidate
    if current:
        batches.append(current)
    return batches


# ── ASIN resolution ─────────────────────────────────────────────

def catalog_asins(limit: int = 18, days: int = 120) -> list[dict]:
    """Real ASINs we actually stock, most-active first.

    inventory_events is the catalog of record here: sku_costs.asin is
    unpopulated and there is no products table. Ordering by event volume keeps
    the SQP request pointed at ASINs that plausibly have search data, rather
    than spending the 200-character option budget on long-tail items.
    """
    from collections import Counter
    from datetime import date as _date

    from src.db import get_client

    since = (_date.today() - timedelta(days=days)).isoformat()
    client = get_client()
    counts: Counter = Counter()
    offset = 0
    while True:
        page = (client.table("inventory_events").select("asin,event_date")
                .gte("event_date", since)
                .range(offset, offset + 999).execute().data) or []
        for r in page:
            if r.get("asin"):
                counts[str(r["asin"])] += 1
        if len(page) < 1000:
            break
        offset += 1000
    return [{"asin": a, "events": n} for a, n in counts.most_common(limit)]


def resolve_asins(configured: list[str] | None, limit: int = 18) -> dict:
    """Decide which ASINs to request, and say why.

    Configured ASINs are validated against the live catalog before use. This
    exists because the shipped defaults were parent-ASIN title overrides that
    appear in no table — SP-API accepted them and returned an empty report,
    which is indistinguishable from "quiet week" unless someone checks.
    """
    configured = [str(a).strip() for a in (configured or []) if str(a).strip()]
    try:
        catalog = catalog_asins(limit=limit)
    except Exception as e:
        log.warning("Could not read catalog ASINs: %s", str(e)[:160])
        catalog = []

    known = {c["asin"] for c in catalog}
    if not configured:
        return {"asins": [c["asin"] for c in catalog], "basis": "catalog",
                "unknown": [], "note": "no ASINs configured — using the most "
                                       "active ASINs from inventory_events"}

    unknown = [a for a in configured if known and a not in known]
    if unknown and len(unknown) == len(configured):
        # Every configured ASIN is absent from the catalog. Requesting them
        # yields an empty report that looks like a data gap, so fall back and
        # say so loudly rather than silently returning nothing.
        return {"asins": [c["asin"] for c in catalog], "basis": "catalog_fallback",
                "unknown": unknown,
                "note": (f"configured ASINs {', '.join(unknown)} appear in no "
                         f"inventory/sales data — falling back to the live "
                         f"catalog. Fix organic_rank_gating.sqp_auto.asins.")}

    return {"asins": configured, "basis": "config", "unknown": unknown,
            "note": (f"configured ASINs used; {', '.join(unknown)} not seen in "
                     f"recent inventory" if unknown else "configured ASINs used")}


# ── Share → rank band ───────────────────────────────────────────
#
# Deliberately shared with the CSV importer so the manual and automated paths
# can never disagree about what a share means.

def share_to_rank(share: float | None) -> int | None:
    """Coarse rank band from click share, or None when there is no evidence."""
    from src.amazon_ads.sqp_import import SHARE_TO_RANK

    if share is None:
        return None
    for floor, rank in SHARE_TO_RANK:
        if share >= floor:
            return rank
    return 99


# ── Parsing ─────────────────────────────────────────────────────

def _num(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _count(node: dict, *paths: str) -> int | None:
    """Pull a funnel count, tolerating the field names SQP has shipped."""
    for p in paths:
        if p in node:
            v = _num(node[p])
            if v is not None:
                return int(v)
    return None


def _share(node: dict, *paths: str) -> float | None:
    """Pull a share value, tolerating the several shapes SQP has shipped."""
    for p in paths:
        if p in node:
            v = _num(node[p])
            if v is not None:
                return v / 100.0 if v > 1.0 else v
    return None


@dataclass
class SQPParse:
    rows: list[dict] = field(default_factory=list)
    parsed: int = 0
    skipped: int = 0
    derived_from_share: int = 0
    warnings: list[str] = field(default_factory=list)
    # Diagnostics. `had_records_key` separates "empty week" from "wrong shape".
    top_level_keys: list[str] = field(default_factory=list)
    had_records_key: bool = False
    doc_bytes: int = 0
    # Non-empty when the document was an SP-API error payload rather than data.
    api_error_codes: list[str] = field(default_factory=list)
    # Full per-query funnel rows for sqp_weekly (branded share tracker).
    weekly: list[dict] = field(default_factory=list)


def parse_sqp_json(content: str, as_of: date, default_asin: str = "",
                   week_start: date | None = None,
                   period: str = "WEEK") -> SQPParse:
    """Parse the SQP JSON document into keyword_organic_rank rows.

    The report nests query records under `dataByAsin` (or `dataByDepartment`
    for the non-ASIN variant). Field names have moved between versions, so
    each value is looked up across the shapes that have been observed rather
    than assuming one.
    """
    out = SQPParse()
    try:
        doc = json.loads(content)
    except ValueError as e:
        out.warnings.append(f"response was not JSON: {str(e)[:120]}")
        return out

    out.top_level_keys = sorted(doc.keys()) if isinstance(doc, dict) else ["<list>"]

    # An SP-API error document parses as valid JSON with an `errors` array and
    # no data. Treating that as "empty week" is actively harmful: it looks like
    # a quiet period, and it triggers the previous-period retry, which spends
    # another unit of the very quota that just ran out.
    if isinstance(doc, dict) and doc.get("errors"):
        errs = doc["errors"] if isinstance(doc["errors"], list) else [doc["errors"]]
        codes = [str(e.get("code") or "") for e in errs if isinstance(e, dict)]
        msgs = [str(e.get("message") or "") for e in errs if isinstance(e, dict)]
        out.api_error_codes = codes
        out.warnings.append(
            f"SP-API returned an error document ({', '.join(codes) or 'unknown'}): "
            f"{'; '.join(msgs)[:200]}")
        return out
    has_key = isinstance(doc, dict) and ("dataByAsin" in doc or "dataByDepartment" in doc)
    records = (doc.get("dataByAsin") if isinstance(doc, dict) else None) \
        or (doc.get("dataByDepartment") if isinstance(doc, dict) else None) or []
    if not records and isinstance(doc, list):
        records = doc
        has_key = True
    out.had_records_key = has_key

    if not records:
        # Present-but-empty and absent mean different things: the first is a
        # real report for ASINs with no search data that period, the second
        # suggests the document is not the shape we expect at all.
        out.warnings.append(
            ("dataByAsin present but EMPTY — the report ran for these ASINs and "
             "that period, and Amazon returned no query rows."
             if has_key else
             f"no dataByAsin/dataByDepartment key in the document. Top-level "
             f"keys: {out.top_level_keys}. Either the role is not granted or "
             f"the payload shape changed."))
        return out

    for rec in records:
        query = (rec.get("searchQueryData") or {}).get("searchQuery") \
            or rec.get("searchQuery") or ""
        kw = normalize_keyword(query)
        if not kw:
            out.skipped += 1
            continue

        asin = str(rec.get("asin") or default_asin or "").strip()

        click_node = rec.get("clickData") or rec.get("asinClickData") or {}
        imp_node = rec.get("impressionData") or rec.get("asinImpressionData") or {}

        click_share = _share(click_node, "clickShare", "asinClickShare",
                             "searchQueryClickShare")
        imp_share = _share(imp_node, "impressionShare", "asinImpressionShare",
                           "searchQueryImpressionShare")

        # Click share is the gating signal: it reflects where shoppers actually
        # went, which is closer to "would we have won this click anyway" than
        # impression share, which only says we were shown.
        rank = share_to_rank(click_share)
        if rank is None:
            out.skipped += 1
            continue
        out.derived_from_share += 1

        # Full funnel for the branded market-share rollups. Kept separately
        # from the rank row: the gate needs one band, the tracker needs counts
        # and market denominators.
        from src.amazon_ads.brand_terms import classify

        cls = classify(query)
        sq_node = rec.get("searchQueryData") or {}
        purch_node = rec.get("purchaseData") or rec.get("asinPurchaseData") or {}
        out.weekly.append({
            "asin": asin,
            "search_query": str(query).strip(),
            "query_normalized": kw,
            "week_start": week_start.isoformat() if week_start else as_of.isoformat(),
            "week_end": as_of.isoformat(),
            "report_period": period,
            "is_branded": cls["branded"],
            "brand_rule": cls["matched_rule"],
            "total_impressions": _count(imp_node, "totalQueryImpressionCount",
                                        "totalImpressionCount"),
            "total_clicks": _count(click_node, "totalClickCount"),
            "total_purchases": _count(purch_node, "totalPurchaseCount"),
            "search_query_volume": _count(sq_node, "searchQueryVolume"),
            "asin_impressions": _count(imp_node, "asinImpressionCount"),
            "asin_clicks": _count(click_node, "asinClickCount"),
            "asin_purchases": _count(purch_node, "asinPurchaseCount"),
            "impression_share": imp_share,
            "click_share": click_share,
            "purchase_share": _share(purch_node, "purchaseShare", "asinPurchaseShare"),
            "source": SOURCE,
        })

        out.rows.append({
            "asin": asin,
            "keyword_normalized": kw,
            "keyword_raw": str(query).strip(),
            "organic_rank": rank,
            "page": 1 if rank <= 48 else 2,
            "source": SOURCE,
            "as_of": as_of.isoformat(),
            "impression_share_organic": imp_share,
            "raw": {"click_share": click_share, "impression_share": imp_share},
        })
        out.parsed += 1

    if out.derived_from_share:
        out.warnings.append(
            f"{out.derived_from_share} row(s): SQP publishes SHARE, not SERP "
            f"position — rank is a derived BAND (click share >=40% -> 1, "
            f">=15% -> 5, else 99), not a measured rank.")
    return out


# ── Fetch ───────────────────────────────────────────────────────

class BrandAnalyticsRoleError(RuntimeError):
    """The SP-API app lacks the Brand Analytics role, or Brand Registry."""


def _role_error(detail: str) -> BrandAnalyticsRoleError:
    return BrandAnalyticsRoleError(
        "Brand Analytics is not available to this SP-API app.\n"
        "  1. Seller Central > Apps & Services > Develop Apps > your app\n"
        "  2. Edit app > add the 'Brand Analytics' role\n"
        "  3. Brand Registry must be active for the brand\n"
        "  4. RE-AUTHORIZE the app after adding the role — an existing refresh "
        "token does not gain new roles\n"
        f"  SP-API said: {detail[:300]}")


def fetch_sqp(asins: list[str], period: str = "WEEK",
              ref: date | None = None, timeout: int = 1800) -> dict:
    """Pull SQP for the most recent complete period. Returns parsed rows.

    Batches ASINs to respect the 200-character reportOptions limit. A batch
    that fails is recorded and the others still run — partial data beats none,
    and the failure is reported rather than swallowed.
    """
    from src.amazon_sp.client import create_report, download_report, wait_for_report

    p = (period or "WEEK").upper()
    if p not in VALID_PERIODS:
        raise ValueError(f"reportPeriod must be one of {VALID_PERIODS}, got {period!r}")

    start, end = period_bounds(p, ref)
    batches = batch_asins(asins)
    if not batches:
        return {"rows": [], "period": p, "start": start.isoformat(),
                "end": end.isoformat(), "batches": 0, "errors": [],
                "warnings": ["no ASINs configured — set organic_rank_gating."
                             "sqp_auto.asins"]}

    all_rows: list[dict] = []
    errors: list[str] = []
    warnings: list[str] = []
    diagnostics: list[dict] = []
    all_weekly: list[dict] = []
    parsed = skipped = 0

    for i, batch in enumerate(batches, 1):
        opts = {"reportPeriod": p, "asin": " ".join(batch)}
        log.info("SQP batch %d/%d: %s..%s asins=%s",
                 i, len(batches), start, end, len(batch))
        try:
            report_id = create_report(REPORT_TYPE, start, end, report_options=opts)
            doc_id = wait_for_report(report_id, timeout=timeout)
            content = download_report(doc_id)
            diagnostics.append({"batch": i, "report_id": report_id,
                                "asins": list(batch), "doc_bytes": len(content or "")})
        except Exception as e:
            msg = str(e)
            low = msg.lower()
            if any(t in low for t in ("unauthorized", "access to requested resource",
                                      "403", "forbidden", "invalid report type")):
                raise _role_error(msg) from e
            errors.append(f"batch {i} ({len(batch)} asins): {msg[:160]}")
            log.warning("SQP batch %d failed: %s", i, msg[:200])
            continue

        res = parse_sqp_json(content, as_of=end, week_start=start, period=p,
                             default_asin=batch[0] if len(batch) == 1 else "")
        all_weekly.extend(res.weekly)
        if diagnostics:
            diagnostics[-1].update({"top_level_keys": res.top_level_keys,
                                    "had_records_key": res.had_records_key,
                                    "records_parsed": res.parsed,
                                    "api_error_codes": res.api_error_codes})
        if res.api_error_codes:
            errors.append(f"batch {i}: SP-API error "
                          f"{', '.join(res.api_error_codes)}")
        all_rows.extend(res.rows)
        parsed += res.parsed
        skipped += res.skipped
        for w in res.warnings:
            if w not in warnings:
                warnings.append(w)

    # Keep the strongest evidence per (asin, keyword).
    best: dict[tuple, dict] = {}
    for r in all_rows:
        k = (r["asin"], r["keyword_normalized"])
        prev = best.get(k)
        if prev is None or (r["organic_rank"] or 99) < (prev["organic_rank"] or 99):
            best[k] = r

    return {"rows": list(best.values()), "period": p,
            "start": start.isoformat(), "end": end.isoformat(),
            "batches": len(batches), "parsed": parsed, "skipped": skipped,
            "errors": errors, "warnings": warnings, "diagnostics": diagnostics,
            "weekly": all_weekly,
            "asins_requested": [a for b in batches for a in b]}


def sync_sqp(asins: list[str] | None = None, period: str | None = None,
             ref: date | None = None, dry_run: bool = False,
             retry_previous: bool = True) -> dict:
    """Fetch SQP and upsert into keyword_organic_rank — the scheduled path.

    ASINs are resolved against the live catalog before the request: the shipped
    defaults were parent-ASIN title overrides present in no table, and SP-API
    happily returns an empty report for ASINs it does not recognise.

    Amazon publishes SQP roughly 24-48h after a week closes, so the most recent
    complete week can legitimately be empty. When it is, the previous complete
    period is tried once and the result says which period actually had data.
    """
    from src.amazon_ads.organic_rank import load_config, upsert_ranks

    cfg = load_config()
    auto = cfg.get("sqp_auto") or {}
    use_period = period or auto.get("report_period") or "WEEK"

    resolution = resolve_asins(
        asins if asins is not None else (auto.get("asins") or []))
    use_asins = resolution["asins"]
    if resolution["basis"] != "config":
        log.warning("SQP ASIN resolution: %s", resolution["note"])

    result = fetch_sqp(use_asins, period=use_period, ref=ref)
    result["asins"] = list(use_asins)
    result["asin_resolution"] = resolution
    result["dry_run"] = dry_run
    result["period_used"] = result["end"]

    # Publish lag: an empty latest week is expected within ~48h of it closing.
    quota_hit = any("QuotaExceeded" in str(e) for e in (result.get("errors") or []))
    if quota_hit:
        result["quota_exceeded"] = True
        result["warnings"] = list(result.get("warnings") or []) + [
            "SP-API report QUOTA exceeded — this is a rate limit, not an empty "
            "period. SQP allows only a small number of report requests per "
            "interval; wait before retrying. The weekly schedule stays well "
            "inside the quota; ad-hoc re-runs are what exhaust it."]

    if retry_previous and not quota_hit and not result["rows"] and not result["errors"]:
        start = date.fromisoformat(result["start"])
        earlier_ref = start - timedelta(days=1)
        log.info("SQP: latest period empty, retrying the previous %s", use_period)
        prev = fetch_sqp(use_asins, period=use_period, ref=earlier_ref)
        prev["asins"] = list(use_asins)
        prev["asin_resolution"] = resolution
        prev["dry_run"] = dry_run
        prev["retried_previous_period"] = True
        prev["first_attempt"] = {"start": result["start"], "end": result["end"],
                                 "rows": 0}
        prev["warnings"] = list(prev.get("warnings") or []) + [
            f"latest {use_period} ({result['start']}→{result['end']}) returned no "
            f"rows; used the previous {use_period} instead. Amazon publishes SQP "
            f"roughly 24-48h after a period closes."]
        result = prev
        result["period_used"] = result["end"]

    if dry_run or not result["rows"]:
        result["written"] = 0
        return result

    result["weekly_written"] = _upsert_weekly(result.get("weekly") or [])

    try:
        result["written"] = upsert_ranks(result["rows"])
    except Exception as e:
        # upsert_ranks already separates "missing table" from "rejected write",
        # so the message here is the real one rather than a guess.
        result["written"] = 0
        result["errors"].append(str(e)[:400])
        return result
    return result


def _upsert_weekly(rows: list[dict]) -> int:
    """Persist the per-query funnel. A missing table is a setup step, not a failure.

    The rank gate does not depend on this table, so the sync must still write
    ranks when only the tracker migration is outstanding.
    """
    from src.db import upsert_rows

    if not rows:
        return 0
    # Dedupe on the natural key: two ASINs can surface the same query, and one
    # request cannot send two rows with the same conflict target.
    seen: dict[tuple, dict] = {}
    for r in rows:
        seen[(r["asin"], r["query_normalized"], r["week_start"], r["source"])] = r
    try:
        return upsert_rows("sqp_weekly", list(seen.values()),
                           on_conflict="asin,query_normalized,week_start,source")
    except Exception as e:
        if "sqp_weekly" in str(e):
            log.info("sqp_weekly missing — run supabase/migration_sqp_weekly.sql "
                     "to enable the branded market-share tracker")
            return 0
        raise
