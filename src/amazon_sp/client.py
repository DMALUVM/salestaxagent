"""Low-level SP-API HTTP client.

Handles report lifecycle: create → poll → download.
All methods are synchronous (suitable for CLI and scheduler).
"""
from __future__ import annotations

import gzip
import io
import time
from datetime import date, datetime

import httpx

from src.amazon_sp.auth import get_access_token
from src.config import settings

# North America endpoint (covers US, CA, MX, BR)
BASE_URL = "https://sellingpartnerapi-na.amazon.com"
REPORTS_PATH = "/reports/2021-06-30"

# US marketplace
DEFAULT_MARKETPLACE = "ATVPDKIKX0DER"

USER_AGENT = "SalesTaxAgent/1.0 (Language=Python)"

# Polling
POLL_INTERVAL_SECS = 20
DEFAULT_TIMEOUT_SECS = 30 * 60  # 30 minutes


class SPAPIError(Exception):
    """SP-API returned an error."""


class ReportTimeoutError(SPAPIError):
    """Report did not finish within the timeout."""


def _headers() -> dict[str, str]:
    return {
        "x-amz-access-token": get_access_token(),
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    }


def _marketplace_id() -> str:
    return settings.amazon_sp_marketplace_id or DEFAULT_MARKETPLACE


# ── Report lifecycle ─────────────────────────────────────────


def create_report(
    report_type: str,
    start: date,
    end: date,
    report_options: dict | None = None,
) -> str:
    """Create a report request.  Returns the reportId.

    `report_options` maps to SP-API's `reportOptions`. Brand Analytics reports
    need it (reportPeriod, asin); the order and inventory reports do not pass
    it and are unaffected.
    """
    body = {
        "reportType": report_type,
        "dataStartTime": datetime.combine(start, datetime.min.time()).isoformat() + "Z",
        "dataEndTime": datetime.combine(end, datetime.max.time().replace(microsecond=0)).isoformat() + "Z",
        "marketplaceIds": [_marketplace_id()],
    }
    if report_options:
        body["reportOptions"] = report_options

    resp = httpx.post(
        f"{BASE_URL}{REPORTS_PATH}/reports",
        json=body,
        headers=_headers(),
        timeout=30,
    )

    if resp.status_code not in (200, 202):
        raise SPAPIError(
            f"createReport failed ({resp.status_code}): {resp.text[:500]}"
        )

    return resp.json()["reportId"]


def get_report(report_id: str) -> dict:
    """Get current report status."""
    resp = httpx.get(
        f"{BASE_URL}{REPORTS_PATH}/reports/{report_id}",
        headers=_headers(),
        timeout=30,
    )

    if resp.status_code != 200:
        raise SPAPIError(
            f"getReport failed ({resp.status_code}): {resp.text[:500]}"
        )

    return resp.json()


def wait_for_report(
    report_id: str,
    timeout: int = DEFAULT_TIMEOUT_SECS,
    on_poll: callable | None = None,
) -> str:
    """Poll until report is DONE.  Returns the reportDocumentId.

    Args:
        report_id: The SP-API reportId.
        timeout:   Max seconds to wait.
        on_poll:   Optional callback(status, elapsed_secs) for progress.

    Raises:
        ReportTimeoutError if timeout exceeded.
        SPAPIError if the report is CANCELLED or FATAL.
    """
    deadline = time.time() + timeout
    interval = POLL_INTERVAL_SECS
    start_time = time.time()

    while True:
        report = get_report(report_id)
        status = report.get("processingStatus", "UNKNOWN")
        elapsed = int(time.time() - start_time)

        if on_poll:
            on_poll(status, elapsed)

        if status == "DONE":
            doc_id = report.get("reportDocumentId")
            if not doc_id:
                raise SPAPIError("Report DONE but no reportDocumentId returned")
            return doc_id

        if status in ("CANCELLED", "FATAL"):
            raise SPAPIError(f"Report {report_id} ended with status: {status}")

        if time.time() > deadline:
            raise ReportTimeoutError(
                f"Report {report_id} did not finish within {timeout}s "
                f"(last status: {status})"
            )

        time.sleep(interval)
        # Gentle backoff: 20s → 30s → 30s ...
        interval = min(interval + 5, 30)


def get_report_document(document_id: str) -> dict:
    """Get the download URL for a report document."""
    resp = httpx.get(
        f"{BASE_URL}{REPORTS_PATH}/documents/{document_id}",
        headers=_headers(),
        timeout=30,
    )

    if resp.status_code != 200:
        raise SPAPIError(
            f"getReportDocument failed ({resp.status_code}): {resp.text[:500]}"
        )

    return resp.json()


def download_report(document_id: str) -> str:
    """Download report content as a decoded string.

    Handles GZIP decompression if the document is compressed.
    """
    doc = get_report_document(document_id)
    url = doc["url"]
    compression = doc.get("compressionAlgorithm")

    resp = httpx.get(url, timeout=120, follow_redirects=True)
    resp.raise_for_status()

    if compression and compression.upper() == "GZIP":
        raw = gzip.decompress(resp.content)
        return raw.decode("utf-8-sig")

    return resp.text


# ── Convenience: full lifecycle ──────────────────────────────


def request_and_download(
    report_type: str,
    start: date,
    end: date,
    timeout: int = DEFAULT_TIMEOUT_SECS,
    on_poll: callable | None = None,
    report_options: dict | None = None,
) -> str:
    """Create a report, wait for it, and download.

    Returns the report content as a string (TSV for the flat-file reports,
    JSON for Brand Analytics).
    """
    report_id = create_report(report_type, start, end, report_options=report_options)

    doc_id = wait_for_report(report_id, timeout=timeout, on_poll=on_poll)

    return download_report(doc_id)
