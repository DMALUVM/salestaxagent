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

BASE_URL = "https://advertising-api.amazon.com"
POLL_INTERVAL = 30  # seconds (Ads reports take 5-20 minutes)
DEFAULT_TIMEOUT = 1800    # 30 minutes — sufficient for campaigns
SEARCH_TERM_TIMEOUT = 5400  # 90 minutes — search term reports are much larger


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
    resp.raise_for_status()
    data = resp.json()
    report_id = data.get("reportId", "")
    log.info("Ads report created: %s (type=%s)", report_id, report_type)
    return report_id


def poll_report(report_id: str, timeout: int = DEFAULT_TIMEOUT) -> dict:
    """Poll until report is COMPLETED or fails."""
    headers = ads_headers()
    start = time.time()
    last_status = ""
    while time.time() - start < timeout:
        resp = httpx.get(f"{BASE_URL}/reporting/reports/{report_id}",
                         headers=headers, timeout=15)
        resp.raise_for_status()
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


def fetch_report(config: dict, timeout: int | None = None) -> list[dict]:
    """Create → poll → download a report. Returns list of row dicts.

    Args:
        config: Ads Reporting v3 request body.
        timeout: Poll timeout in seconds. Defaults to DEFAULT_TIMEOUT.
    """
    report_id = create_report(config)
    poll_timeout = timeout if timeout is not None else DEFAULT_TIMEOUT
    completed = poll_report(report_id, timeout=poll_timeout)
    download_url = completed.get("url", "")
    if not download_url:
        raise RuntimeError(f"No download URL for report {report_id}")
    rows = download_report(download_url)
    log.info("Ads report %s: %d rows downloaded", report_id, len(rows))
    return rows


def get_profiles() -> list[dict]:
    """List advertising profiles for the account."""
    headers = ads_headers()
    # Profile listing needs different Accept + no scope
    headers.pop("Amazon-Advertising-API-Scope", None)
    headers["Accept"] = "application/json"
    resp = httpx.get(f"{BASE_URL}/v2/profiles", headers=headers, timeout=15)
    resp.raise_for_status()
    return resp.json()
