"""Shopify access-token management — client_credentials grant.

Shopify Dev Dashboard apps (2025+) issue short-lived tokens (~24 h)
via grant_type=client_credentials.  There is no separate refresh_token;
re-POST the same request to get a new token.

Durable secrets: SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (from .env).
SHOPIFY_ACCESS_TOKEN is accepted as a bootstrap fallback but ignored
once a fresh client_credentials token is obtained.

Token is cached in memory and on disk (.cache/shopify_token.json) so it
survives process restarts without a fresh POST on every boot.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import httpx

from src.config import settings, PROJECT_ROOT

log = logging.getLogger(__name__)

_CACHE_DIR = PROJECT_ROOT / ".cache"
_CACHE_FILE = _CACHE_DIR / "shopify_token.json"

# In-memory cache
_cached_token: str | None = None
_token_expiry: float = 0  # unix timestamp


# ---------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------

def get_access_token() -> str:
    """Return a valid Shopify access token.

    Priority:
      1. In-memory cache (if not expired)
      2. Disk cache (.cache/shopify_token.json, if not expired)
      3. client_credentials POST (stores to memory + disk)
      4. Static SHOPIFY_ACCESS_TOKEN from .env (legacy fallback)
    """
    global _cached_token, _token_expiry

    # 1. Memory cache — valid if >5 min until expiry
    if _cached_token and time.time() < _token_expiry - 300:
        return _cached_token

    # 2. Disk cache
    disk = _load_disk_cache()
    if disk:
        _cached_token = disk["access_token"]
        _token_expiry = disk["expires_at"]
        if time.time() < _token_expiry - 300:
            return _cached_token

    # 3. Client-credentials exchange
    if settings.shopify_client_id and settings.shopify_client_secret:
        return _exchange_client_credentials()

    # 4. Legacy static token (may be expired — caller will get a 401)
    if settings.shopify_access_token:
        return settings.shopify_access_token

    raise RuntimeError(
        "No Shopify credentials configured. "
        "Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET in .env"
    )


def clear_cache() -> None:
    """Invalidate both memory and disk caches.  Next call to
    get_access_token() will do a fresh client_credentials exchange."""
    global _cached_token, _token_expiry
    _cached_token = None
    _token_expiry = 0
    try:
        _CACHE_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def auth_headers() -> dict[str, str]:
    """Return HTTP headers for Shopify Admin API calls."""
    return {
        "X-Shopify-Access-Token": get_access_token(),
        "Content-Type": "application/json",
    }


def auth_headers_with_retry(resp_status: int, *, _retried: bool = False) -> dict[str, str] | None:
    """If *resp_status* is 401, clear cache, refresh, and return new
    headers.  Returns None if already retried (to prevent loops)."""
    if resp_status != 401 or _retried:
        return None
    log.info("Shopify 401 — refreshing access token")
    clear_cache()
    return auth_headers()


# ---------------------------------------------------------------------------
# Client-credentials exchange
# ---------------------------------------------------------------------------

def _exchange_client_credentials() -> str:
    """POST grant_type=client_credentials to Shopify and cache the result."""
    global _cached_token, _token_expiry

    shop = settings.shopify_shop_domain
    if not shop:
        raise RuntimeError("SHOPIFY_SHOP_DOMAIN not set")

    url = f"https://{shop}/admin/oauth/access_token"
    body = {
        "client_id": settings.shopify_client_id,
        "client_secret": settings.shopify_client_secret,
        "grant_type": "client_credentials",
    }

    resp = httpx.post(url, json=body, timeout=15)

    if resp.status_code != 200:
        raise RuntimeError(
            f"Shopify client_credentials exchange failed "
            f"({resp.status_code}): {resp.text[:400]}"
        )

    data = resp.json()
    access_token = data["access_token"]
    expires_in = int(data.get("expires_in", 82800))
    expires_at = time.time() + expires_in

    _cached_token = access_token
    _token_expiry = expires_at
    _save_disk_cache(access_token, expires_at)

    log.info(
        "Shopify token refreshed (expires in %d h)",
        expires_in // 3600,
    )
    return access_token


# ---------------------------------------------------------------------------
# Disk cache
# ---------------------------------------------------------------------------

def _load_disk_cache() -> dict | None:
    """Load cached token from disk.  Returns None if missing/expired/corrupt."""
    try:
        if not _CACHE_FILE.exists():
            return None
        data = json.loads(_CACHE_FILE.read_text())
        if not data.get("access_token") or not data.get("expires_at"):
            return None
        return data
    except (json.JSONDecodeError, OSError, KeyError):
        return None


def _save_disk_cache(access_token: str, expires_at: float) -> None:
    """Persist token to disk so it survives process restarts."""
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _CACHE_FILE.write_text(json.dumps({
            "access_token": access_token,
            "expires_at": expires_at,
        }))
    except OSError as e:
        log.warning("Could not save Shopify token cache: %s", e)
