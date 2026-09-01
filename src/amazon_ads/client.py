"""Amazon Ads Reporting API v3 client.

Creates reports, polls until complete, downloads GZIP JSON.
"""
from __future__ import annotations

import gzip
import json
import logging
import time
from datetime import date, timedelta

import httpx

from src.amazon_ads.auth import ads_headers
from src.config import settings

log = logging.getLogger(__name__)

from src.rules import ADS_SEARCH_TERM_TIMEOUT_SECONDS

BASE_URL = "https://advertising-api.amazon.com"
POLL_INTERVAL = 30  # seconds (Ads reports take 5-20 minutes)
DEFAULT_TIMEOUT = 1800    # 30 minutes — SP campaigns use this (no override)
# Mid-poll 429/5xx used to abort a report Amazon was still producing, then
# the caller created a second report on the same queue. Stay on this report.
TRANSIENT_POLL_STATUS = frozenset({429, 425, 500, 502, 503, 504})


class AdsReportSlotBusy(RuntimeError):
    """HTTP 425 on create — the Ads reporting slot is occupied.

    Do not wait-loop or create another report. Cancel a known hung report
    if the API allows, then STOP. Reporting-queue cleanup only — this is
    not an ads write (no bids, negatives, status, or budgets).
    """
# SB/SD campaign poll caps live in config/business_rules.json
# (ads.campaign_report_timeout_{sb,sd}_seconds) and are applied in
# reports.CAMPAIGN_REPORT_TIMEOUT — not here — so SP stays on this default.
# 90 minutes — search term reports are much larger. Canonical value lives in
# config/business_rules.json (ads.search_term_timeout_seconds).
SEARCH_TERM_TIMEOUT = ADS_SEARCH_TERM_TIMEOUT_SECONDS


def create_report(config: dict) -> str:
    """Create an async report. Returns reportId."""
    headers = ads_headers()
    report_type = config.get("configuration", {}).get("reportTypeId", "unknown")
    resp = httpx.post(f"{BASE_URL}/reporting/reports",
                      headers=headers, json=config, timeout=20)
    if resp.status_code == 401:
        raise PermissionError("Ads API auth failed (401)")
    if resp.status_code == 403:
        raise PermissionError("Ads API forbidden (403) — check profile scope")
    if resp.status_code == 425:
        raise AdsReportSlotBusy(
            "Amazon Ads reporting slot busy (HTTP 425). "
            "Do not retry in a loop. Cancel a hung report if an id is known, then stop.")
    resp.raise_for_status()
    data = resp.json()
    report_id = data.get("reportId", "")
    log.info("Ads report created: %s (type=%s)", report_id, report_type)
    return report_id


def poll_report(report_id: str, timeout: int = DEFAULT_TIMEOUT) -> dict:
    """Poll until report is COMPLETED or fails.

    The access token is re-fetched on a 401. A poll can outlive the token —
    a slow report followed a long one and the poll came back 401 Unauthorized
    partway through, throwing away a report that was still being produced.
    Headers are cheap to rebuild; a finished report is not.
    """
    headers = ads_headers()
    start = time.time()
    last_status = ""
    refreshed = False
    while time.time() - start < timeout:
        try:
            resp = httpx.get(f"{BASE_URL}/reporting/reports/{report_id}",
                             headers=headers, timeout=15)
        except (httpx.TimeoutException, httpx.NetworkError) as e:
            log.warning("Report %s: poll transport error (%s) — retrying",
                        report_id, e)
            time.sleep(POLL_INTERVAL)
            continue
        if resp.status_code == 401 and not refreshed:
            log.info("Report %s: token expired mid-poll — refreshing", report_id)
            headers = ads_headers(force_refresh=True)
            refreshed = True
            continue
        if resp.status_code in TRANSIENT_POLL_STATUS:
            log.warning("Report %s: poll HTTP %s — staying on this report",
                        report_id, resp.status_code)
            time.sleep(POLL_INTERVAL)
            continue
        resp.raise_for_status()
        refreshed = False  # a good response re-arms the one-shot refresh
        data = resp.json()
        status = data.get("status", "")
        if status != last_status:
            elapsed = int(time.time() - start)
            log.info("Report %s: status=%s (elapsed %ds)", report_id, status, elapsed)
            last_status = status
        if status == "COMPLETED":
            return data
        if status in ("FAILED", "CANCELLED"):
            raise RuntimeError(f"Report {report_id} final status: {status}")
        time.sleep(POLL_INTERVAL)
    log.warning("Report %s timed out after %ds (last status: %s)",
                report_id, timeout, last_status)
    raise TimeoutError(f"Report {report_id} timed out after {timeout}s")


def download_report(url: str) -> list[dict]:
    """Download and decompress a GZIP JSON report."""
    resp = httpx.get(url, timeout=60, follow_redirects=True)
    resp.raise_for_status()
    try:
        raw = gzip.decompress(resp.content)
        return json.loads(raw)
    except (gzip.BadGzipFile, json.JSONDecodeError):
        # Try plain JSON
        return resp.json()


def cancel_report(report_id: str) -> bool:
    """Best-effort DELETE of a PENDING report so the next create is not 425.

    Reporting-queue cleanup only. Does not change bids, negatives, status,
    or budgets. There is no list-all-reports API — only a known id can
    be cancelled. 404 means it is already gone.
    """
    if not report_id:
        return False
    try:
        headers = ads_headers()
        resp = httpx.delete(
            f"{BASE_URL}/reporting/reports/{report_id}",
            headers=headers, timeout=15)
        if resp.status_code in (200, 204, 404):
            log.info("Ads report %s cancel → HTTP %s", report_id, resp.status_code)
            return True
        log.warning("Ads report %s cancel → HTTP %s %s",
                    report_id, resp.status_code, (resp.text or "")[:160])
        return False
    except Exception as e:
        log.warning("Ads report %s cancel failed: %s", report_id, e)
        return False


def fetch_report(config: dict, timeout: int | None = None) -> list[dict]:
    """Create → poll → download a report. Returns list of row dicts.

    Args:
        config: Ads Reporting v3 request body.
        timeout: Poll timeout in seconds. Defaults to DEFAULT_TIMEOUT.

    On poll timeout the report we created is cancelled so it does not
    keep the slot occupied (HTTP 425) for the next one-shot.
    """
    report_id = None
    try:
        report_id = create_report(config)
        poll_timeout = timeout if timeout is not None else DEFAULT_TIMEOUT
        completed = poll_report(report_id, timeout=poll_timeout)
        download_url = completed.get("url", "")
        if not download_url:
            raise RuntimeError(f"No download URL for report {report_id}")
        rows = download_report(download_url)
        log.info("Ads report %s: %d rows downloaded", report_id, len(rows))
        return rows
    except TimeoutError:
        if report_id:
            log.warning("Report %s timed out — cancelling so the slot can free",
                        report_id)
            cancel_report(report_id)
        raise


def get_profiles() -> list[dict]:
    """List advertising profiles for the account."""
    headers = ads_headers()
    # Profile listing needs different Accept + no scope
    headers.pop("Amazon-Advertising-API-Scope", None)
    headers["Accept"] = "application/json"
    resp = httpx.get(f"{BASE_URL}/v2/profiles", headers=headers, timeout=15)
    resp.raise_for_status()
    return resp.json()
