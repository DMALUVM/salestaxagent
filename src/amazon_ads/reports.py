"""Amazon Ads report definitions, fetchers, and Supabase upsert.

Uses Reporting v3 API with GZIP_JSON format.
All requests chunked to ≤30 days (API max is 31).
"""
from __future__ import annotations

import logging
import threading
from datetime import date, timedelta

import httpx

from src.amazon_ads.client import (
    AdsReportSlotBusy,
    fetch_report,
    SEARCH_TERM_TIMEOUT,
)
from src.db import upsert_rows
from src.rules import (
    ADS_CAMPAIGN_CHUNK_DAYS,
    ADS_CAMPAIGN_TIMEOUT_SB_SECONDS,
    ADS_CAMPAIGN_TIMEOUT_SD_SECONDS,
    ADS_MAX_CHUNK_DAYS,
    ADS_SB_SD_CHUNK_DAYS,
    ADS_SEARCH_TERM_CHUNK_DAYS,
    amazon_as_of,
)

log = logging.getLogger(__name__)

MAX_CHUNK_DAYS = ADS_MAX_CHUNK_DAYS
SEARCH_TERM_CHUNK_DAYS = ADS_SEARCH_TERM_CHUNK_DAYS
CAMPAIGN_CHUNK_DAYS = ADS_CAMPAIGN_CHUNK_DAYS

# One Ads Reporting v3 pull at a time so we do not stack reports on a
# slow Amazon queue. Waiters must NOT sit for hours: on 2026-08-24
# campaigns held this lock for 231 minutes, and placements/search terms
# waited 180 minutes then Telegram'd a failure. A short wait + skip lets
# the scheduler retry after campaigns release the lock.
_SYNC_LOCK = threading.Lock()
_SYNC_LOCK_TIMEOUT = 45  # seconds — then skip, do not page


class AdsSyncBusy(RuntimeError):
    """Another ads pull holds the process lock. Retry; do not alert."""


def _safe(v, default=0):
    try:
        return float(v) if v is not None else default
    except (ValueError, TypeError):
        return default


def _metrics(r: dict) -> dict:
    """Extract common metrics from a report row (v3 column names)."""
    spend = _safe(r.get("spend"))
    sales = _safe(r.get("sales14d") or r.get("sales"))
    orders = _safe(r.get("purchases14d") or r.get("unitsSoldClicks14d") or r.get("orders"))
    clicks = _safe(r.get("clicks"))
    impressions = _safe(r.get("impressions"))
    return {
        "spend": round(spend, 2),
        "sales_14d": round(sales, 2),
        "orders_14d": int(orders),
        "clicks": int(clicks),
        "impressions": int(impressions),
        "cpc": round(spend / clicks, 2) if clicks > 0 else 0,
        "acos": round(spend / sales * 100, 1) if sales > 0 else 0,
        "roas": round(sales / spend, 2) if spend > 0 else 0,
        "ctr": round(clicks / impressions * 100, 2) if impressions > 0 else 0,
        "cvr": round(orders / clicks * 100, 2) if clicks > 0 else 0,
    }


def _date_chunks(start: date, end: date,
                 chunk_days: int | None = None) -> list[tuple[date, date]]:
    """Split a date range into chunks of at most `chunk_days` days.

    Defaults to MAX_CHUNK_DAYS (30). Search-term reports pass a smaller size —
    they are an order of magnitude heavier and a wide window times out.
    Anything above MAX_CHUNK_DAYS is clamped: the API limit is not negotiable.
    """
    size = MAX_CHUNK_DAYS if chunk_days is None else max(1, min(chunk_days, MAX_CHUNK_DAYS))
    chunks = []
    cursor = start
    while cursor <= end:
        chunk_end = min(cursor + timedelta(days=size - 1), end)
        chunks.append((cursor, chunk_end))
        cursor = chunk_end + timedelta(days=1)
    return chunks


# ── Ad products ────────────────────────────────────────────────
#
# The Amazon Ads console's daily "Total cost" spans all three ad products, but
# this sync used to request Sponsored Products only — which is why the agent
# read ~6% under the console on 2026-08-19 ($393.64 vs $417.09) while CPC, CTR
# and ROAS matched almost exactly: the rates were right, the volume was short.
#
# Metric column names differ per product (SP reports `spend`/`sales14d`, SB and
# SD report `cost`/`sales`), and not every account exposes every column, so
# each product carries a list of candidate column sets tried in order.
# campaign_type on the row records which product a campaign belongs to; the
# table's PRIMARY KEY (date, campaign_id) already separates them.

AD_PRODUCTS: dict[str, dict] = {
    "SP": {
        "ad_product": "SPONSORED_PRODUCTS",
        "report_type": "spCampaigns",
        "column_sets": [
            ["date", "campaignName", "campaignId", "campaignStatus",
             "campaignBudgetAmount", "campaignBudgetType",
             "impressions", "clicks", "spend", "sales14d", "purchases14d"],
            ["date", "campaignName", "campaignId",
             "impressions", "clicks", "spend", "sales14d", "purchases14d"],
        ],
    },
    "SB": {
        "ad_product": "SPONSORED_BRANDS",
        "report_type": "sbCampaigns",
        "column_sets": [
            ["date", "campaignName", "campaignId", "campaignStatus",
             "impressions", "clicks", "cost", "sales", "purchases"],
            ["date", "campaignName", "campaignId",
             "impressions", "clicks", "cost", "sales"],
            ["date", "campaignName", "campaignId", "impressions", "clicks", "cost"],
        ],
    },
    "SD": {
        "ad_product": "SPONSORED_DISPLAY",
        "report_type": "sdCampaigns",
        "column_sets": [
            ["date", "campaignName", "campaignId", "campaignStatus",
             "impressions", "clicks", "cost", "sales", "purchases"],
            ["date", "campaignName", "campaignId",
             "impressions", "clicks", "cost", "sales"],
            ["date", "campaignName", "campaignId", "impressions", "clicks", "cost"],
        ],
    },
}

DEFAULT_AD_PRODUCTS = ("SP", "SB", "SD")

# Poll timeouts differ by product on purpose.
#
# Sponsored Products keeps the client default (1800s). It is the report the KPI
# cards, PPC actions and P&L all depend on, and Amazon's report queue does go
# through slow spells where a normally-instant report sits PENDING for many
# minutes — observed on this account. Trimming SP's headroom would turn those
# spells into nightly failures.
#
# SB and SD are fetched after SP is committed, so a hang cannot discard SP.
# They still need a durable poll: a 300s cap produced nightly
# `SB+SD FAILED, SP kept` partials when Brands/Display sat PENDING longer than
# five minutes. Knobs live in config/business_rules.json
# (`ads.campaign_report_timeout_{sb,sd}_seconds`); both default to 900s, still
# below SP's 1800s client default.
CAMPAIGN_REPORT_TIMEOUT = {
    "SB": ADS_CAMPAIGN_TIMEOUT_SB_SECONDS,
    "SD": ADS_CAMPAIGN_TIMEOUT_SD_SECONDS,
}


def _normalise_metric_keys(r: dict) -> dict:
    """Map SB/SD metric names onto the SP names `_metrics()` expects."""
    out = dict(r)
    if out.get("spend") is None and out.get("cost") is not None:
        out["spend"] = out["cost"]
    if out.get("sales14d") is None:
        for k in ("sales", "attributedSales14d", "attributedSales"):
            if out.get(k) is not None:
                out["sales14d"] = out[k]
                break
    if out.get("purchases14d") is None:
        for k in ("purchases", "attributedConversions14d", "attributedConversions"):
            if out.get(k) is not None:
                out["purchases14d"] = out[k]
                break
    return out


def _is_transient_report_error(e: Exception) -> bool:
    """True when creating a *new* report is likely to succeed.

    HTTP 425 on create means the reporting slot is occupied
    (AdsReportSlotBusy). That is not transient: a wait-loop plus another
    create is how overlapping 90d CLIs filled the slot. Poll 425 on the
    *same* report is handled inside poll_report and never reaches here.

    429 / 5xx / transport errors can still back off. Timeouts cancel the
    hung report in fetch_report, then one fresh create is allowed.
    """
    if isinstance(e, AdsReportSlotBusy):
        return False
    if isinstance(e, (TimeoutError, httpx.TimeoutException, httpx.NetworkError)):
        return True
    if isinstance(e, httpx.HTTPStatusError):
        return e.response.status_code in {429, 500, 502, 503, 504}
    msg = str(e)
    if "429" in msg:
        return True
    if "timed out" in msg.lower():
        return True
    return False


def _transient_label(e: Exception) -> str:
    msg = str(e)
    if isinstance(e, AdsReportSlotBusy) or "425" in msg:
        return "slot busy"
    if "429" in msg:
        return "rate limited"
    if isinstance(e, TimeoutError) or "timed out" in msg.lower():
        return "timed out"
    return "transient error"


def _fetch_report_with_backoff(config: dict, attempts: int = 3,
                               base_sleep: float = 45.0,
                               timeout: int | None = None) -> list[dict]:
    """fetch_report with backoff on rate limits, 5xx, and one poll timeout.

    HTTP 425 on create (AdsReportSlotBusy) is not retried: creating another
    report while the slot is occupied is the wait-loop that filled the
    queue. Poll 425 on the same report stays inside poll_report.
    """
    import time

    last: Exception | None = None
    for attempt in range(attempts):
        try:
            return fetch_report(config, timeout=timeout)
        except AdsReportSlotBusy:
            raise
        except Exception as e:
            last = e
            timed_out = (isinstance(e, TimeoutError)
                         or "timed out" in str(e).lower())
            # A 90-minute search-term timeout retried three times would pin
            # the scheduler all morning. One fresh report is enough.
            max_attempts = 2 if timed_out else attempts
            if not _is_transient_report_error(e) or attempt >= max_attempts - 1:
                raise
            wait = base_sleep * (2 ** attempt)
            log.warning("Ads report %s (attempt %d/%d) — backing off %.0fs",
                        _transient_label(e), attempt + 1, max_attempts, wait)
            time.sleep(wait)
    raise last  # unreachable, keeps type checkers happy


# ── Campaign daily (single chunk) ──

def _fetch_campaigns_chunk(start: date, end: date,
                           product: str = "SP") -> list[dict]:
    """Fetch campaign daily metrics for one ad product over a ≤30-day range.

    Tries each configured column set in order: accounts differ in which columns
    they expose, and a rejected column set is a 400, not a data problem.
    """
    spec = AD_PRODUCTS[product]
    last: Exception | None = None
    for columns in spec["column_sets"]:
        config = {
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "configuration": {
                "adProduct": spec["ad_product"],
                "groupBy": ["campaign"],
                "columns": columns,
                "reportTypeId": spec["report_type"],
                "timeUnit": "DAILY",
                "format": "GZIP_JSON",
            },
        }
        try:
            rows = _fetch_report_with_backoff(
                config, timeout=CAMPAIGN_REPORT_TIMEOUT.get(product))
            log.info("%s campaigns: %d row(s) using columns %s",
                     product, len(rows), columns[-3:])
            return rows
        except Exception as e:
            last = e
            if "400" in str(e) or "422" in str(e):
                log.info("%s column set rejected, trying a narrower one: %s",
                         product, str(e)[:120])
                continue
            raise
    raise last if last else RuntimeError(f"no column set worked for {product}")


def _fetch_placements_chunk(start: date, end: date) -> list[dict]:
    """Fetch SP placement performance for a ≤30-day range.

    Same spCampaigns report grouped by campaignPlacement. Verified against the
    live API: returns Top of Search on-Amazon / Detail Page on-Amazon / Other
    on-Amazon / Off Amazon.
    """
    config = {
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "configuration": {
            "adProduct": "SPONSORED_PRODUCTS",
            "groupBy": ["campaignPlacement"],
            "columns": [
                "date", "campaignName", "campaignId", "placementClassification",
                "impressions", "clicks", "spend", "sales14d", "purchases14d",
            ],
            "reportTypeId": "spCampaigns",
            "timeUnit": "DAILY",
            "format": "GZIP_JSON",
        },
    }
    return _fetch_report_with_backoff(config)


def fetch_placements(start: date, end: date) -> dict:
    """Fetch placement performance, auto-chunked to ≤30 days.

    Requires supabase/migration_ads_placement.sql. If the table is absent the
    upsert fails loudly rather than silently discarding a completed report.
    """
    chunks = _date_chunks(start, end)
    all_parsed: list[dict] = []
    errors: list[str] = []

    for i, (cs, ce) in enumerate(chunks, 1):
        log.info("Placements chunk %d/%d: %s → %s", i, len(chunks), cs, ce)
        try:
            rows = _fetch_placements_chunk(cs, ce)
        except Exception as e:
            msg = f"Chunk {i} ({cs}→{ce}): {str(e)[:120]}"
            log.warning("Placement %s", msg)
            errors.append(msg)
            continue

        for r in rows:
            placement = r.get("placementClassification") or "Unknown"
            all_parsed.append({
                "date": r.get("date", cs.isoformat()),
                "campaign_id": str(r.get("campaignId", "")),
                "campaign_name": r.get("campaignName", ""),
                "placement": placement,
                **_metrics(r),
            })

    inserted = 0
    if all_parsed:
        # Deduplicate on the primary key before upserting.
        seen: dict[tuple, dict] = {}
        for p in all_parsed:
            seen[(p["date"], p["campaign_id"], p["placement"])] = p
        try:
            inserted = upsert_rows("ads_placement_daily", list(seen.values()),
                                   on_conflict="date,campaign_id,placement")
        except Exception as e:
            # A missing table is a setup step, not a failure to alert on every
            # night. Anything else is a real error and propagates.
            if "ads_placement_daily" in str(e) and "schema cache" in str(e):
                log.warning("ads_placement_daily missing — run "
                            "supabase/migration_ads_placement.sql to enable placement data")
                return {"rows": len(all_parsed), "inserted": 0, "chunks": len(chunks),
                        "errors": [], "skipped": "table missing: run migration_ads_placement.sql"}
            raise

    dates = [r["date"] for r in all_parsed if r.get("date")]
    return {
        "rows": len(all_parsed), "inserted": inserted, "chunks": len(chunks),
        "errors": errors,
        "date_min": min(dates) if dates else None,
        "date_max": max(dates) if dates else None,
    }


def _fetch_search_terms_chunk(start: date, end: date) -> list[dict]:
    """Fetch SP search term report for a ≤30-day range.

    Uses SEARCH_TERM_TIMEOUT (90 min) — these reports are much larger
    than campaign reports and routinely exceed 30 minutes.
    """
    config = {
        "startDate": start.isoformat(),
        "endDate": end.isoformat(),
        "configuration": {
            "adProduct": "SPONSORED_PRODUCTS",
            "groupBy": ["searchTerm"],
            "columns": [
                "searchTerm",
                "campaignName", "campaignId",
                "adGroupName", "adGroupId",
                "keyword", "keywordId", "matchType",
                "impressions", "clicks", "spend",
                "sales14d", "purchases14d",
            ],
            "reportTypeId": "spSearchTerm",
            "timeUnit": "SUMMARY",
            "format": "GZIP_JSON",
        },
    }
    return _fetch_report_with_backoff(config, timeout=SEARCH_TERM_TIMEOUT)


# ── Chunked fetchers ──

def fetch_campaigns_daily(start: date, end: date,
                          ad_products: tuple[str, ...] | None = None,
                          chunk_days: int | None = None,
                          sb_sd_days: int | None = None,
                          on_progress=None) -> dict:
    """Fetch campaign daily metrics for each ad product, chunked to ≤30 days.

    Sponsored Products, Brands and Display are fetched independently and every
    row is stamped with its `campaign_type` (SP | SB | SD) so downstream math
    can either total them or split them, never guess.

    Each product soft-fails on its own: if SB or SD errors out — and they are
    the ones that rate-limit — SP rows are still written and the nightly job
    still reports success for the data it did get. `by_type` carries the
    per-product outcome so callers can alert on a partial sync.
    """
    products = tuple(ad_products or DEFAULT_AD_PRODUCTS)
    # Default is ADS_CAMPAIGN_CHUNK_DAYS (7), not 30. A single 30-day SB/SD
    # report on this account sits PENDING past the 900s cap; the same 30-day
    # window in 7-day chunks completed (2026-08-22 ops retry). Each chunk
    # commits on its own, so a stall keeps the days already written.
    size = CAMPAIGN_CHUNK_DAYS if chunk_days is None else chunk_days
    chunks = _date_chunks(start, end, size)
    say = on_progress or (lambda _msg: None)
    all_parsed: list[dict] = []
    errors: list[str] = []
    by_type: dict[str, dict] = {}
    inserted = 0

    for product in products:
        if product not in AD_PRODUCTS:
            log.warning("Unknown ad product %r — skipping", product)
            continue

        parsed: list[dict] = []
        product_errors: list[str] = []
        product_inserted = 0

        product_chunks = chunks
        if product in ("SB", "SD"):
            product_start = start
            if sb_sd_days:
                product_start = max(start, end - timedelta(days=sb_sd_days - 1))
            # SB/SD always use the tighter chunk size. One 7-day Brands
            # report that times out used to leave the whole window SP-only.
            sb_sd_size = min(size, ADS_SB_SD_CHUNK_DAYS)
            product_chunks = _date_chunks(product_start, end, sb_sd_size)
        # Newest first: if a later chunk times out we still have yesterday.
        product_chunks = list(reversed(product_chunks))

        for i, (cs, ce) in enumerate(product_chunks, 1):
            log.info("%s campaigns chunk %d/%d: %s → %s",
                     product, i, len(product_chunks), cs, ce)
            try:
                rows = _fetch_campaigns_chunk(cs, ce, product)
            except Exception as e:
                msg = f"{product} chunk {i} ({cs}→{ce}): {str(e)[:120]}"
                log.warning("Campaign %s", msg)
                product_errors.append(msg)
                say(f"    {product} chunk {i}/{len(product_chunks)} {cs}→{ce}: FAILED — {str(e)[:80]}")
                continue

            chunk_rows = []
            for r in rows:
                m = _metrics(_normalise_metric_keys(r))
                chunk_rows.append({
                    "date": r.get("date", cs.isoformat()),
                    "campaign_id": str(r.get("campaignId", "")),
                    "campaign_name": r.get("campaignName", ""),
                    "campaign_type": product,
                    "campaign_status": r.get("campaignStatus", ""),
                    "budget": _safe(r.get("campaignBudgetAmount")),
                    **m,
                })

            # Commit each chunk as it lands. Sponsored Products is fetched
            # first, so its rows are in the table before SB/SD are even
            # attempted — a hung Brands report, which is a real failure mode on
            # this account, cannot take down the rows the KPI cards and P&L
            # read. Within a product it also means a backfill that stalls
            # halfway keeps the days it already got.
            #
            # A campaign id is unique across ad products, so (date, campaign_id)
            # separates SP/SB/SD rows. Dedupe anyway — a repeated chunk boundary
            # would otherwise send two rows with the same key in one request,
            # which PostgREST rejects outright.
            chunk_spend = sum(r["spend"] for r in chunk_rows)
            if chunk_rows:
                seen: dict[tuple, dict] = {}
                for r in chunk_rows:
                    seen[(r["date"], r["campaign_id"])] = r
                try:
                    product_inserted += upsert_rows("ads_campaigns_daily",
                                                    list(seen.values()),
                                                    on_conflict="date,campaign_id")
                except Exception as e:
                    msg = f"{product} chunk {i} upsert: {str(e)[:120]}"
                    log.warning("Campaign %s", msg)
                    product_errors.append(msg)
                    say(f"    {product} chunk {i}/{len(product_chunks)} upsert FAILED — {str(e)[:80]}")

            parsed.extend(chunk_rows)
            say(f"    {product} chunk {i}/{len(product_chunks)} {cs}→{ce}: "
                f"{len(chunk_rows)} row(s), ${chunk_spend:,.2f} — committed")

        spend = round(sum(r["spend"] for r in parsed), 2)
        by_type[product] = {
            "rows": len(parsed),
            "inserted": product_inserted,
            "spend": spend,
            "clicks": sum(r["clicks"] for r in parsed),
            "errors": product_errors,
            # Rows landed = the product is present. A timed-out older chunk
            # is a gap, not "SB missing" — 2026-08-24 Telegram'd SB+SD
            # missing while SB had already written $993.71.
            "ok": bool(parsed),
        }
        log.info("%s campaigns: %d row(s), $%.2f spend, %d error(s)",
                 product, len(parsed), spend, len(product_errors))

        inserted += product_inserted
        all_parsed.extend(parsed)
        errors.extend(product_errors)

    total_spend = sum(r["spend"] for r in all_parsed)
    # min/max, not first/last — rows come back in API order, not date order.
    dates = [r["date"] for r in all_parsed if r.get("date")]
    ok_products = [p for p, v in by_type.items() if v["ok"]]
    failed_products = [p for p, v in by_type.items() if not v["ok"]]
    return {
        "rows": len(all_parsed), "inserted": inserted, "chunks": len(chunks),
        "errors": errors, "total_spend": round(total_spend, 2),
        "date_min": min(dates) if dates else None,
        "date_max": max(dates) if dates else None,
        "by_type": by_type,
        "products_ok": ok_products,
        "products_failed": failed_products,
        # Partial = some products landed, others did not. The nightly job uses
        # this to alert without treating a lost SB report as a lost sync.
        "partial": bool(ok_products and failed_products),
    }


def _search_term_chunk_present(end: date) -> bool:
    """True when ads_search_terms_daily already has a SUMMARY row stamped `end`.

    Used to resume a 90d one-shot without re-requesting weeks that landed.
    A lookup miss must return False (fetch, do not skip) so a DB hiccup
    cannot invent "already covered" and drop a week.
    """
    try:
        from src.db import fetch_one
        return fetch_one("ads_search_terms_daily", {"date": end.isoformat()}) is not None
    except Exception as e:
        log.warning("Could not check existing search-term date %s: %s — will fetch",
                    end, e)
        return False


def fetch_search_terms(start: date, end: date,
                       chunk_days: int | None = None,
                       skip_existing: bool = False,
                       newest_first: bool = False) -> dict:
    """Fetch SP search term report, chunked to `chunk_days` (default 7).

    Search-term reports are SP-only (spSearchTerm / SPONSORED_PRODUCTS).
    SB/SD have no search-term grain in this pipeline — do not silently
    drop or invent them. Campaigns (SP+SB+SD) are a separate job.

    Each chunk is upserted as soon as it returns. A 90d Sunday backfill is
    ~13 chunks; a kill/timeout/ghost lock on a later chunk must leave the
    weeks already written in ads_search_terms_daily. Buffering the full
    window and writing once is how a hung 90d CLI wrote zero rows.

    HTTP 425 (AdsReportSlotBusy) and poll TimeoutError STOP remaining
    chunks. Do not continue to the next week — that create would 425
    immediately. 429 / other chunk errors still skip that week only.

    skip_existing: skip a chunk whose END date is already stored (resume
    a 90d one-shot). Weekday 7d must leave this False so the last week
    still refreshes.
    newest_first: request recent weeks first so a stop still lands
    freshness. Sunday 90d / one-shot use this; nightly 7d does not care.

    Note: the report is requested with timeUnit=SUMMARY, so each chunk returns
    one aggregate row per term. `date` is a window label (chunk END), not a
    daily grain — consumers filter on it then sum metrics. Smaller chunks
    still mean shorter reports; they are not required for freshness.
    """
    chunks = _date_chunks(start, end, chunk_days or SEARCH_TERM_CHUNK_DAYS)
    if newest_first:
        chunks = list(reversed(chunks))
    all_parsed: list[dict] = []
    errors: list[str] = []
    skipped_existing: list[str] = []
    inserted = 0
    stopped: str | None = None

    for i, (cs, ce) in enumerate(chunks, 1):
        if skip_existing and _search_term_chunk_present(ce):
            log.info("Search terms chunk %d/%d: %s → %s — skip, already stored",
                     i, len(chunks), cs, ce)
            skipped_existing.append(ce.isoformat())
            continue
        log.info("Search terms chunk %d/%d: %s → %s", i, len(chunks), cs, ce)
        try:
            rows = _fetch_search_terms_chunk(cs, ce)
        except AdsReportSlotBusy as e:
            msg = f"Chunk {i} ({cs}→{ce}): {str(e)[:160]}"
            log.error("STOP search-term fetch: reporting slot busy (HTTP 425). "
                      "Remaining chunks not requested. Do not retry in a loop.")
            errors.append(msg)
            stopped = "slot_busy"
            break
        except TimeoutError as e:
            msg = f"Chunk {i} ({cs}→{ce}): {str(e)[:160]}"
            log.error("STOP search-term fetch: report timed out (cancelled). "
                      "Remaining chunks not requested.")
            errors.append(msg)
            stopped = "timeout"
            break
        except Exception as e:
            msg = f"Chunk {i} ({cs}→{ce}): {str(e)[:120]}"
            log.warning("Search terms %s", msg)
            errors.append(msg)
            continue

        chunk_rows = []
        for r in rows:
            m = _metrics(r)
            chunk_rows.append({
                # timeUnit=SUMMARY collapses the chunk to one aggregate row.
                # Stamp chunk END so max(date) is a freshness proxy for the
                # window (a 7-day chunk ending yesterday would otherwise look
                # ~6 days stale if we stamped the start). Metrics are unchanged.
                "date": ce.isoformat(),
                "search_term": r.get("searchTerm", ""),
                "campaign_id": str(r.get("campaignId", "")),
                "campaign_name": r.get("campaignName", ""),
                "ad_group_id": str(r.get("adGroupId", "")),
                "ad_group_name": r.get("adGroupName", ""),
                "keyword": r.get("keyword", ""),
                "keyword_id": str(r.get("keywordId", "")),
                "match_type": r.get("matchType", ""),
                **m,
            })

        # Commit this week now. Do not wait for the remaining 90d chunks.
        if chunk_rows:
            seen: dict[tuple, dict] = {}
            for p in chunk_rows:
                key = (p["date"], p["search_term"], p["campaign_id"], p["ad_group_id"])
                seen[key] = p
            try:
                inserted += upsert_rows(
                    "ads_search_terms_daily", list(seen.values()),
                    on_conflict="date,search_term,campaign_id,ad_group_id")
            except Exception as e:
                msg = f"Chunk {i} ({cs}→{ce}) upsert: {str(e)[:120]}"
                log.warning("Search terms %s", msg)
                errors.append(msg)

        all_parsed.extend(chunk_rows)

    return {
        "rows": len(all_parsed), "inserted": inserted, "chunks": len(chunks),
        "chunk_days": chunk_days or SEARCH_TERM_CHUNK_DAYS,
        "chunks_ok": len(chunks) - len(errors) - len(skipped_existing),
        "chunks_skipped_existing": len(skipped_existing),
        "stopped": stopped,
        "errors": errors,
        "coverage": "SP-only",
    }


# ── Full sync ──

def sync_ads(days: int = 14, campaigns_only: bool = False,
             search_terms_only: bool = False,
             placements_only: bool = False,
             with_placements: bool = False,
             search_term_chunk_days: int | None = None,
             ad_products: tuple[str, ...] | None = None,
             campaign_chunk_days: int | None = None,
             sb_sd_days: int | None = None,
             skip_existing_search_term_weeks: bool = False,
             newest_first_search_terms: bool = False,
             on_progress=None) -> dict:
    """Ads sync: campaigns and/or search terms, auto-chunked.

    Campaign ranges are chunked to `campaign_chunk_days` (default 7, max 30);
    search-term ranges to `search_term_chunk_days` (default 7). A single
    30-day SB/SD report times out on this account. Safe to call with days=90
    or higher.

    The two halves are independent on purpose: `campaigns_only` returns without
    ever touching the search-term endpoint, so the fast daily refresh that
    feeds the /ppc KPIs and trends never waits on a 90-minute report. A failure
    in one half is recorded but never aborts the other.

    Campaigns cover Sponsored Products, Brands and Display by default; pass
    `ad_products` to narrow it (e.g. a backfill of just the two new products).
    Search terms and placements stay SP-only — the SB/SD reports have no
    search-term grain to feed the negate/harvest loop.
    """
    only_flags = [campaigns_only, search_terms_only, placements_only]
    if sum(bool(f) for f in only_flags) > 1:
        raise ValueError("campaigns_only, search_terms_only and placements_only "
                         "are mutually exclusive")

    acquired = _SYNC_LOCK.acquire(timeout=_SYNC_LOCK_TIMEOUT)
    if not acquired:
        raise AdsSyncBusy(
            "another ads pull is running — skipped so this job does not "
            "wait hours and page Telegram")
    try:
        return _sync_ads_body(
            days=days,
            search_term_chunk_days=search_term_chunk_days,
            ad_products=ad_products,
            campaign_chunk_days=campaign_chunk_days,
            sb_sd_days=sb_sd_days,
            skip_existing_search_term_weeks=skip_existing_search_term_weeks,
            newest_first_search_terms=newest_first_search_terms,
            on_progress=on_progress,
            do_campaigns=campaigns_only or not any(only_flags),
            do_search_terms=search_terms_only or not any(only_flags),
            do_placements=placements_only or (with_placements and not any(only_flags)),
        )
    finally:
        _SYNC_LOCK.release()


def _sync_ads_body(*, days: int,
                   search_term_chunk_days: int | None,
                   ad_products: tuple[str, ...] | None,
                   campaign_chunk_days: int | None,
                   sb_sd_days: int | None,
                   skip_existing_search_term_weeks: bool,
                   newest_first_search_terms: bool,
                   on_progress, do_campaigns: bool, do_search_terms: bool,
                   do_placements: bool) -> dict:
    end = amazon_as_of()
    start = end - timedelta(days=days - 1)

    results: dict = {
        "start": start.isoformat(), "end": end.isoformat(), "days": days,
        "ran": [k for k, on in (("campaigns", do_campaigns),
                                ("search_terms", do_search_terms),
                                ("placements", do_placements)) if on],
    }

    log.info("Ads sync: %s → %s (%d days) — %s", start, end, days,
             ", ".join(results["ran"]))

    if do_campaigns:
        try:
            results["campaigns"] = fetch_campaigns_daily(
                start, end, ad_products=ad_products,
                chunk_days=campaign_chunk_days, sb_sd_days=sb_sd_days,
                on_progress=on_progress)
        except Exception as e:
            log.exception("Campaign sync failed")
            results["campaigns"] = {"error": str(e)[:200]}

    if do_search_terms:
        try:
            results["search_terms"] = fetch_search_terms(
                start, end, chunk_days=search_term_chunk_days,
                skip_existing=skip_existing_search_term_weeks,
                newest_first=newest_first_search_terms)
        except Exception as e:
            log.exception("Search term sync failed")
            results["search_terms"] = {"error": str(e)[:200]}

    if do_placements:
        try:
            results["placements"] = fetch_placements(start, end)
        except Exception as e:
            log.exception("Placement sync failed")
            results["placements"] = {"error": str(e)[:200]}

    return results
