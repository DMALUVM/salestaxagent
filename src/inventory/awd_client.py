"""Shared AWD (Amazon Warehousing & Distribution) API helpers."""
from __future__ import annotations

import logging
import time

import httpx

from src.amazon_sp.client import BASE_URL, SPAPIError, _headers

log = logging.getLogger(__name__)

AWD_BASE = "/awd/2024-05-09"
AWD_ROLE_HINT = (
    "Ensure SP-API app has the 'Amazon Warehousing and Distribution' role "
    "(Developer Central → App → Roles). Re-authorize the seller after adding it."
)
AWD_MIN_INTERVAL_SEC = 0.35
AWD_MAX_RETRIES = 5

_last_awd_request_at = 0.0


def _throttle() -> None:
    global _last_awd_request_at
    elapsed = time.monotonic() - _last_awd_request_at
    if elapsed < AWD_MIN_INTERVAL_SEC:
        time.sleep(AWD_MIN_INTERVAL_SEC - elapsed)
    _last_awd_request_at = time.monotonic()


def awd_get(path: str, *, params: dict | None = None, timeout: int = 60) -> dict:
    """GET an AWD v2024-05-09 resource with throttle + 429 retry."""
    url = f"{BASE_URL}{AWD_BASE}{path}"
    last_error: SPAPIError | None = None

    for attempt in range(AWD_MAX_RETRIES):
        _throttle()
        resp = httpx.get(url, headers=_headers(), params=params or {}, timeout=timeout)
        if resp.status_code == 403:
            raise SPAPIError(
                f"AWD API forbidden (403) on {path}. {AWD_ROLE_HINT} "
                f"Body: {resp.text[:300]}"
            )
        if resp.status_code == 429:
            retry_after = resp.headers.get("Retry-After")
            try:
                wait = float(retry_after) if retry_after else min(2 ** attempt, 30)
            except (TypeError, ValueError):
                wait = min(2 ** attempt, 30)
            last_error = SPAPIError(
                f"AWD API quota exceeded (429) on {path}: {resp.text[:300]}"
            )
            if attempt + 1 >= AWD_MAX_RETRIES:
                raise last_error
            log.info("AWD 429 on %s — retry in %.1fs (attempt %d/%d)",
                     path, wait, attempt + 1, AWD_MAX_RETRIES)
            time.sleep(wait)
            continue
        if resp.status_code != 200:
            raise SPAPIError(
                f"AWD API failed ({resp.status_code}) on {path}: {resp.text[:400]}"
            )
        return resp.json()

    if last_error:
        raise last_error
    raise SPAPIError(f"AWD API failed on {path}")


def awd_probe() -> dict:
    """Lightweight connectivity check for all AWD endpoints we use."""
    out: dict = {}
    for key, path, params in (
        ("inventory", "/inventory", {"maxResults": 1, "details": "SHOW"}),
        ("replenishment_orders", "/replenishmentOrders", {"maxResults": 1}),
        ("inbound_shipments", "/inboundShipments", {"maxResults": 1}),
    ):
        try:
            body = awd_get(path, params=params, timeout=30)
            if key == "inventory":
                n = len(body.get("inventory") or [])
            elif key == "replenishment_orders":
                n = len(body.get("orders") or [])
            else:
                n = len(body.get("shipments") or [])
            out[key] = {"ok": True, "sample_count": n}
        except SPAPIError as e:
            out[key] = {"ok": False, "error": str(e)[:400]}
        except Exception as e:
            out[key] = {"ok": False, "error": str(e)[:200]}
    out["all_ok"] = all(v.get("ok") for v in out.values() if isinstance(v, dict))
    return out
