"""Shared AWD (Amazon Warehousing & Distribution) API helpers.

Pacing is per operation, from the published AWD v2024-05-09 usage plans
(not a shared interval). A shared 0.35s (~2.8 rps) budget is faster than
listInboundShipments (1 rps, burst 1) and is why overnight pagination 429s.

Docs:
  https://developer-docs.amazon.com/sp-api/reference/listinventory
  https://developer-docs.amazon.com/sp-api/reference/listinboundshipments
  https://developer-docs.amazon.com/sp-api/reference/getinboundshipment
  https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits-in-the-sp-api
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass

import httpx

from src.amazon_sp.client import BASE_URL, SPAPIError, _headers

log = logging.getLogger(__name__)

AWD_BASE = "/awd/2024-05-09"
AWD_ROLE_HINT = (
    "Ensure SP-API app has the 'Amazon Warehousing and Distribution' role "
    "(Developer Central → App → Roles). Re-authorize the seller after adding it."
)
AWD_MAX_RETRIES = 5
# Honor Retry-After / token wait, but never invent a multi-minute sleep.
AWD_MAX_WAIT_SEC = 30.0

# Published default rate (rps) and burst. Replenishment list/get are not in
# the official AWD reference tables — default to the slower list plan (1/1)
# until x-amzn-RateLimit-Limit says otherwise.
AWD_USAGE_PLANS: dict[str, tuple[float, float]] = {
    "listInventory": (2.0, 2.0),
    "listInboundShipments": (1.0, 1.0),
    "getInboundShipment": (2.0, 2.0),
    "listReplenishmentOrders": (1.0, 1.0),
    "getReplenishmentOrder": (1.0, 1.0),
}

_RATE_LIMIT_HEADER = "x-amzn-RateLimit-Limit"
_RATE_REMAINING_HEADER = "x-amzn-RateLimit-Remaining"


@dataclass
class _OpLimiter:
    rate: float
    burst: float
    tokens: float
    updated_at: float


_limiters: dict[str, _OpLimiter] = {}


def reset_awd_limiters() -> None:
    """Test helper — drop learned rates and token buckets."""
    _limiters.clear()


def operation_for_path(path: str) -> str:
    """Map an AWD path to the usage-plan operation name."""
    p = (path or "").split("?", 1)[0]
    if not p.startswith("/"):
        p = "/" + p
    if p == "/inventory" or p.startswith("/inventory/"):
        return "listInventory"
    if p == "/inboundShipments":
        return "listInboundShipments"
    if p.startswith("/inboundShipments/"):
        return "getInboundShipment"
    if p == "/replenishmentOrders":
        return "listReplenishmentOrders"
    if p.startswith("/replenishmentOrders/"):
        return "getReplenishmentOrder"
    return "listInboundShipments"


def _limiter(op: str) -> _OpLimiter:
    lim = _limiters.get(op)
    if lim is None:
        rate, burst = AWD_USAGE_PLANS.get(op, (1.0, 1.0))
        lim = _OpLimiter(
            rate=rate, burst=burst, tokens=burst, updated_at=time.monotonic(),
        )
        _limiters[op] = lim
    return lim


def _refill(lim: _OpLimiter, now: float) -> None:
    elapsed = max(0.0, now - lim.updated_at)
    lim.tokens = min(lim.burst, lim.tokens + elapsed * lim.rate)
    lim.updated_at = now


def _wait_for_token(op: str) -> float:
    """Sleep just long enough for one token. Returns seconds slept."""
    lim = _limiter(op)
    now = time.monotonic()
    _refill(lim, now)
    if lim.tokens >= 1.0:
        lim.tokens -= 1.0
        return 0.0
    wait = (1.0 - lim.tokens) / lim.rate if lim.rate > 0 else AWD_MAX_WAIT_SEC
    wait = min(max(wait, 0.0), AWD_MAX_WAIT_SEC)
    if wait > 0:
        time.sleep(wait)
    now = time.monotonic()
    _refill(lim, now)
    lim.tokens = max(0.0, lim.tokens - 1.0)
    return wait


def _parse_rate_header(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return float(str(value).strip().split()[0])
    except (TypeError, ValueError):
        m = re.search(r"(\d+(?:\.\d+)?)", str(value))
        if m:
            return float(m.group(1))
    return None


def _apply_rate_headers(op: str, headers) -> None:
    """Adopt Amazon's assigned rate / remaining when the headers are present."""
    lim = _limiter(op)
    rate = _parse_rate_header(
        headers.get(_RATE_LIMIT_HEADER) or headers.get("X-Amzn-RateLimit-Limit")
    )
    if rate and rate > 0:
        # Header is requests-per-second only; keep the published burst.
        lim.rate = rate

    remaining = _parse_rate_header(
        headers.get(_RATE_REMAINING_HEADER)
        or headers.get("X-Amzn-RateLimit-Remaining")
    )
    if remaining is not None:
        lim.tokens = max(0.0, min(lim.burst, remaining))
        lim.updated_at = time.monotonic()


def _retry_after_seconds(headers, attempt: int) -> float:
    raw = headers.get("Retry-After") or headers.get("retry-after")
    try:
        wait = float(raw) if raw else min(2 ** attempt, AWD_MAX_WAIT_SEC)
    except (TypeError, ValueError):
        wait = min(2 ** attempt, AWD_MAX_WAIT_SEC)
    return min(max(wait, 0.0), AWD_MAX_WAIT_SEC)


def _throttle(path: str) -> None:
    _wait_for_token(operation_for_path(path))


def awd_get(path: str, *, params: dict | None = None, timeout: int = 60) -> dict:
    """GET an AWD v2024-05-09 resource with per-operation pacing + 429 retry."""
    url = f"{BASE_URL}{AWD_BASE}{path}"
    op = operation_for_path(path)
    last_error: SPAPIError | None = None

    for attempt in range(AWD_MAX_RETRIES):
        _throttle(path)
        resp = httpx.get(url, headers=_headers(), params=params or {}, timeout=timeout)
        _apply_rate_headers(op, resp.headers)
        if resp.status_code == 403:
            raise SPAPIError(
                f"AWD API forbidden (403) on {path}. {AWD_ROLE_HINT} "
                f"Body: {resp.text[:300]}"
            )
        if resp.status_code == 429:
            wait = _retry_after_seconds(resp.headers, attempt)
            last_error = SPAPIError(
                f"AWD API quota exceeded (429) on {path}: {resp.text[:300]}"
            )
            if attempt + 1 >= AWD_MAX_RETRIES:
                raise last_error
            log.info(
                "AWD 429 on %s (%s) — retry in %.1fs (attempt %d/%d)",
                path, op, wait, attempt + 1, AWD_MAX_RETRIES,
            )
            if wait > 0:
                time.sleep(wait)
            # Bucket is empty after a 429; do not immediately burst again.
            lim = _limiter(op)
            lim.tokens = 0.0
            lim.updated_at = time.monotonic()
            continue
        if resp.status_code != 200:
            raise SPAPIError(
                f"AWD API failed ({resp.status_code}) on {path}: {resp.text[:400]}"
            )
        return resp.json()

    if last_error:
        raise last_error
    raise SPAPIError(f"AWD API failed on {path}")


def is_awd_quota_error(err: object) -> bool:
    """True when the failure is an AWD 429 / quota exceeded."""
    text = str(err or "").lower()
    return "429" in text or "quota exceeded" in text


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
