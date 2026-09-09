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
    "/common/search-volume",
    "/common/ratings-history",
    "/rank-tracker/groups",
    "/keyword-research/searches",
})
_ALLOWED_GET_PATTERNS = (
    re.compile(r"^/rank-tracker/groups/\d+$"),
    re.compile(r"^/rank-tracker/groups/\d+/products$"),
    re.compile(r"^/rank-tracker/groups/\d+/products/\d+/phrases/v2$"),
    re.compile(r"^/keyword-research/searches/asin/single/\d+$"),
)
_KR_CREATE_PATH = "/keyword-research/searches/asin/single"

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
            "(history + search-volume + ratings + Rank Tracker + KR reads)."
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


def build_search_volume_params(
    *, marketplace: str, keyword: str,
) -> dict[str, str]:
    """OAS: marketplace + keyword. Metered. No days param."""
    kw = (keyword or "").strip()
    if not kw:
        raise SoldScopeError("search-volume requires a non-empty keyword")
    return {
        "marketplace": marketplace,
        "keyword": kw,
    }


def build_ratings_history_params(
    *, marketplace: str, asin: str, days: int,
) -> dict[str, str | int]:
    """OAS: marketplace + asin + days (required; 30 or 365 typical)."""
    if days is None or int(days) < 1:
        raise SoldScopeError("ratings-history requires days >= 1")
    return {
        "marketplace": marketplace,
        "asin": asin,
        "days": int(days),
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

    return _parse_response(resp, path, q)


def _parse_response(
    resp: httpx.Response,
    path: str,
    q: dict[str, str | None],
    *,
    method: str = "GET",
) -> tuple[Any, dict[str, str | None]]:
    if resp.status_code == 402:
        raise QuotaExceeded(
            f"SoldScope quota exceeded (402) on {method} {path}"
            + (f" Remaining={q['remaining']}" if q["remaining"] is not None else "")
            + (f" Reset={q['reset']}" if q["reset"] else ""),
            remaining=q["remaining"],
            limit=q["limit"],
            reset=q["reset"],
        )
    if resp.status_code == 401:
        raise AuthError(f"SoldScope auth failed (401) on {method} {path}")
    if resp.status_code == 403:
        raise AuthError(f"SoldScope forbidden (403) on {method} {path}")
    if resp.status_code == 404:
        if path == "/auth/check":
            raise AuthError(f"SoldScope auth failed (404) on {method} {path}")
        log.info("SoldScope %s %s returned 404 — treating as empty (not ready)", method, path)
        return {}, q
    if resp.status_code == 429:
        raise SoldScopeError(
            f"SoldScope {method} {path} rate-limited (429) — not retrying"
        )
    if resp.status_code >= 400:
        raise SoldScopeError(
            f"SoldScope {method} {path} failed ({resp.status_code}): {resp.text[:300]}"
        )

    if not resp.content:
        return {}, q
    try:
        return resp.json(), q
    except ValueError as e:
        raise SoldScopeError(f"SoldScope {method} {path} returned non-JSON") from e


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


def get_search_volume(*, marketplace: str, keyword: str) -> dict:
    body, _ = request(
        "GET", "/common/search-volume",
        params=build_search_volume_params(marketplace=marketplace, keyword=keyword),
    )
    return body if isinstance(body, dict) else {}


def get_ratings_history(*, marketplace: str, asin: str, days: int) -> dict:
    body, _ = request(
        "GET", "/common/ratings-history",
        params=build_ratings_history_params(
            marketplace=marketplace, asin=asin, days=days,
        ),
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


def list_kr_searches(
    *,
    page: int = 1,
    per_page: int = 50,
    asin: str | None = None,
) -> dict:
    """GET completed Keyword Research searches. Reuse saved searches only."""
    params: dict[str, Any] = {"page": page, "perPage": per_page, "sortDesc": True}
    if asin:
        params["filters[titleAsinKeyword]"] = asin
    body, _ = request("GET", "/keyword-research/searches", params=params)
    return body if isinstance(body, dict) else {}


def get_kr_asin_results(
    search_id: int,
    *,
    page: int = 1,
    per_page: int = 100,
) -> dict:
    body, _ = request(
        "GET",
        f"/keyword-research/searches/asin/single/{int(search_id)}",
        params={
            "page": page,
            "perPage": per_page,
            "sort": "searchVolume",
            "sortDesc": True,
        },
    )
    return body if isinstance(body, dict) else {}


def create_single_asin_search(*, marketplace: str, asin: str) -> dict:
    """POST one single-ASIN KR search. Never Product Research. Never RT create.

    Caller must gate this: download ready, no saved search, no RT phrases,
    one POST per hero max. 402 stops with no retry.
    """
    path = _KR_CREATE_PATH
    url = f"{BASE_URL}{path}"
    resp = httpx.post(
        url,
        headers=_headers(),
        json={"marketplace": marketplace, "asin": asin},
        timeout=60,
    )
    q = quota_headers(resp)
    log_quota(resp, path)
    body, _ = _parse_response(resp, path, q, method="POST")
    return body if isinstance(body, dict) else {}
