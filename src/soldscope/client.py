"""SoldScope HTTP client — GET only, no Rank Tracker writes, no wait-loops.

Auth: Authorization: Bearer $SOLDSCOPE_API_TOKEN
Base: https://www.soldscope.com/api

Metered history endpoints count against X-API-RateLimit-*. HTTP 402 means
quota is exhausted — stop cleanly, do not retry. Remaining is logged when
the header is present.

Rank Tracker: list existing groups / phrases only. Creating groups or
phrases is refused here so a caller cannot accidentally POST.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any
from urllib.parse import urlparse

import httpx

log = logging.getLogger(__name__)

BASE_URL = "https://www.soldscope.com/api"
OBSERVE_ONLY = True

# GET paths this client is allowed to call. Writes are never allowed.
_ALLOWED_GET_EXACT = frozenset({
    "/auth/check",
    "/common/sales-history",
    "/common/bsr-history",
    "/common/price-history",
    "/rank-tracker/groups",
})
_ALLOWED_GET_PATTERNS = (
    re.compile(r"^/rank-tracker/groups/\d+$"),
    re.compile(r"^/rank-tracker/groups/\d+/products$"),
    re.compile(r"^/rank-tracker/groups/\d+/products/\d+/phrases/v2$"),
)

_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


class SoldScopeError(RuntimeError):
    """SoldScope request failed or was refused."""


class QuotaExceeded(SoldScopeError):
    """HTTP 402 — monthly quota exhausted. Do not retry."""

    def __init__(
        self,
        message: str,
        *,
        remaining: str | None = None,
        limit: str | None = None,
        reset: str | None = None,
    ):
        super().__init__(message)
        self.remaining = remaining
        self.limit = limit
        self.reset = reset


class AuthError(SoldScopeError):
    """HTTP 401 / missing token."""


def api_token() -> str:
    """Read the token from the environment only. Never from config files."""
    from src.config import settings

    env = (os.environ.get("SOLDSCOPE_API_TOKEN") or "").strip()
    if env:
        return env
    return (getattr(settings, "soldscope_api_token", "") or "").strip()


def token_present() -> bool:
    return bool(api_token())


def _headers() -> dict[str, str]:
    token = api_token()
    if not token:
        raise AuthError(
            "SOLDSCOPE_API_TOKEN is not set. Add it to the Mini .env "
            "(launchd) and document it for Vercel — never commit the token."
        )
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }


def _normalize_path(path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        path = urlparse(path).path or "/"
        prefix = "/api"
        if path.startswith(prefix + "/") or path == prefix:
            path = path[len(prefix):] or "/"
    if not path.startswith("/"):
        path = "/" + path
    return path.split("?", 1)[0]


def _is_allowed_get(path: str) -> bool:
    path = _normalize_path(path)
    if path in _ALLOWED_GET_EXACT:
        return True
    return any(p.match(path) for p in _ALLOWED_GET_PATTERNS)


def assert_read_only(method: str, path: str) -> None:
    """Refuse writes and out-of-scope reads (Product Research, KR, LA, RT create)."""
    method = (method or "").upper()
    path = _normalize_path(path)
    if method in _WRITE_METHODS:
        raise SoldScopeError(
            f"Refusing {method} {path} — SoldScope sync is observe-only "
            "(never create Rank Tracker groups or phrases)."
        )
    if method != "GET":
        raise SoldScopeError(f"Refusing {method} {path} — GET only.")
    if not _is_allowed_get(path):
        raise SoldScopeError(
            f"Refusing GET {path} — not in the SoldScope v1 allowlist "
            "(history + Rank Tracker read)."
        )


def build_sales_history_params(
    *, marketplace: str, asin: str, days: int,
) -> dict[str, str | int]:
    """OAS: marketplace + asin + days (required; 0 = full history)."""
    if days is None or int(days) < 0:
        raise SoldScopeError("sales-history requires days >= 0")
    return {
        "marketplace": marketplace,
        "asin": asin,
        "days": int(days),
    }


def build_bsr_history_params(
    *, marketplace: str, asin: str, days: int,
) -> dict[str, str | int]:
    """OAS: marketplace + asin + days (required; 0 = full history)."""
    if days is None or int(days) < 0:
        raise SoldScopeError("bsr-history requires days >= 0")
    return {
        "marketplace": marketplace,
        "asin": asin,
        "days": int(days),
    }


def build_price_history_params(
    *, marketplace: str, asin: str,
) -> dict[str, str | int]:
    """OAS: marketplace + asin only. days is omitted — full Buy Box history."""
    return {
        "marketplace": marketplace,
        "asin": asin,
    }


def quota_headers(resp: httpx.Response) -> dict[str, str | None]:
    return {
        "limit": resp.headers.get("X-API-RateLimit-Limit"),
        "remaining": resp.headers.get("X-API-RateLimit-Remaining"),
        "reset": resp.headers.get("X-API-RateLimit-Reset"),
    }


def log_quota(resp: httpx.Response, path: str) -> None:
    q = quota_headers(resp)
    if q["remaining"] is not None:
        log.info(
            "SoldScope quota Remaining=%s Limit=%s Reset=%s after GET %s",
            q["remaining"], q["limit"], q["reset"], path,
        )


def request(
    method: str,
    path: str,
    *,
    params: dict[str, Any] | None = None,
    timeout: float = 45,
) -> tuple[Any, dict[str, str | None]]:
    """One GET. No retries on 402. No wait-loops."""
    assert_read_only(method, path)
    path = _normalize_path(path)
    url = f"{BASE_URL}{path}"
    resp = httpx.get(url, headers=_headers(), params=params, timeout=timeout)
    q = quota_headers(resp)
    log_quota(resp, path)

    if resp.status_code == 402:
        raise QuotaExceeded(
            f"SoldScope quota exceeded (402) on GET {path}"
            + (f" Remaining={q['remaining']}" if q["remaining"] is not None else "")
            + (f" Reset={q['reset']}" if q["reset"] else ""),
            remaining=q["remaining"],
            limit=q["limit"],
            reset=q["reset"],
        )
    if resp.status_code == 401:
        raise AuthError(f"SoldScope auth failed (401) on GET {path}")
    if resp.status_code == 403:
        raise AuthError(f"SoldScope forbidden (403) on GET {path}")
    if resp.status_code == 404:
        # Catalog still syncing / ASIN not in SoldScope yet. Empty, not a retry.
        if path == "/auth/check":
            raise AuthError(f"SoldScope auth failed (404) on GET {path}")
        log.info("SoldScope GET %s returned 404 — treating as empty (not ready)", path)
        return {}, q
    if resp.status_code == 429:
        raise SoldScopeError(
            f"SoldScope GET {path} rate-limited (429) — not retrying"
        )
    if resp.status_code >= 400:
        raise SoldScopeError(
            f"SoldScope GET {path} failed ({resp.status_code}): {resp.text[:300]}"
        )

    if not resp.content:
        return {}, q
    try:
        return resp.json(), q
    except ValueError as e:
        raise SoldScopeError(f"SoldScope GET {path} returned non-JSON") from e


def check_auth() -> dict:
    body, _ = request("GET", "/auth/check")
    return body if isinstance(body, dict) else {}


def get_sales_history(*, marketplace: str, asin: str, days: int) -> dict:
    body, _ = request(
        "GET", "/common/sales-history",
        params=build_sales_history_params(
            marketplace=marketplace, asin=asin, days=days,
        ),
    )
    return body if isinstance(body, dict) else {}


def get_bsr_history(*, marketplace: str, asin: str, days: int) -> dict:
    body, _ = request(
        "GET", "/common/bsr-history",
        params=build_bsr_history_params(
            marketplace=marketplace, asin=asin, days=days,
        ),
    )
    return body if isinstance(body, dict) else {}


def get_price_history(*, marketplace: str, asin: str) -> dict:
    body, _ = request(
        "GET", "/common/price-history",
        params=build_price_history_params(marketplace=marketplace, asin=asin),
    )
    return body if isinstance(body, dict) else {}


def list_rank_groups(*, page: int = 1, per_page: int = 100,
                     marketplace: str | None = None) -> dict:
    params: dict[str, Any] = {"page": page, "perPage": per_page}
    if marketplace:
        params["marketplace"] = marketplace
    body, _ = request("GET", "/rank-tracker/groups", params=params)
    return body if isinstance(body, dict) else {}


def list_group_products(group_id: int) -> dict:
    body, _ = request("GET", f"/rank-tracker/groups/{int(group_id)}/products")
    return body if isinstance(body, dict) else {}


def list_product_phrases(
    group_id: int,
    product_id: int,
    *,
    page: int = 1,
    per_page: int = 1000,
) -> dict:
    body, _ = request(
        "GET",
        f"/rank-tracker/groups/{int(group_id)}/products/{int(product_id)}/phrases/v2",
        params={"page": page, "perPage": per_page},
    )
    return body if isinstance(body, dict) else {}
