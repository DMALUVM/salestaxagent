"""Shopify access-token management.

Supports two modes (checked in this order):

1. **Static custom-app token** (most common):
   Set SHOPIFY_ACCESS_TOKEN.  Custom-app tokens do not expire.
   Returned as-is on every call.

2. **Client-credentials exchange** (public/OAuth apps):
   Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (no access token).
   Exchanges for a token via the shop's OAuth endpoint and caches
   until near expiry.
"""
from __future__ import annotations

import logging
import time

import httpx

from src.config import settings

log = logging.getLogger(__name__)

_cached_token: str | None = None
_token_expiry: float = 0


def get_access_token(force_refresh: bool = False) -> str:
    """Return a valid Shopify access token.

    Prefers client-credentials exchange when client_id + client_secret
    are configured.  Falls back to the static access_token.

    `force_refresh` discards a cached exchanged token. Shopify can reject a
    token the cache still believes is valid, so a 401 needs a way to ask for a
    new one instead of replaying the dead one.
    """
    global _cached_token, _token_expiry

    # ── Mode 1: static custom-app token (most common, never expires) ──
    if settings.shopify_access_token:
        return settings.shopify_access_token

    # ── Mode 2: client-credentials exchange (public/OAuth apps) ──
    if settings.shopify_client_id and settings.shopify_client_secret:
        if not force_refresh and _cached_token and time.time() < _token_expiry - 120:
            return _cached_token

        shop = settings.shopify_shop_domain
        url = f"https://{shop}/admin/oauth/access_token"
        resp = httpx.post(
            url,
            json={
                "client_id": settings.shopify_client_id,
                "client_secret": settings.shopify_client_secret,
                "grant_type": "client_credentials",
            },
            timeout=15,
        )

        if resp.status_code != 200:
            raise RuntimeError(
                f"Shopify token exchange failed ({resp.status_code}): "
                f"{resp.text[:300]}"
            )

        body = resp.json()
        _cached_token = body["access_token"]
        _token_expiry = time.time() + body.get("expires_in", 82800)
        return _cached_token

    raise RuntimeError(
        "No Shopify credentials configured. Set SHOPIFY_ACCESS_TOKEN "
        "or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET in .env"
    )


def auth_headers() -> dict[str, str]:
    """Return HTTP headers for Shopify Admin API calls."""
    return {
        "X-Shopify-Access-Token": get_access_token(),
        "Content-Type": "application/json",
    }


def auth_headers_with_retry(status_code: int) -> dict[str, str] | None:
    """Fresh headers after an auth failure, or None if a retry cannot help.

    Callers hit this on a 401: the cached token was rejected before the cache
    expected it to expire. Only the client-credentials mode can recover, by
    exchanging for a new token. With a static custom-app token there is nothing
    to refresh — a 401 there means the token was revoked or scoped wrong, and
    returning None stops the caller retrying a request that cannot succeed.
    """
    if status_code != 401:
        return None
    if settings.shopify_access_token:
        log.warning("Shopify 401 with a static access token — it was revoked or "
                    "lacks scope; refreshing cannot help. Check SHOPIFY_ACCESS_TOKEN.")
        return None
    if not (settings.shopify_client_id and settings.shopify_client_secret):
        return None
    try:
        token = get_access_token(force_refresh=True)
    except Exception as e:
        log.warning("Shopify token refresh after 401 failed: %s", str(e)[:200])
        return None
    log.info("Shopify token refreshed after 401")
    return {
        "X-Shopify-Access-Token": token,
        "Content-Type": "application/json",
    }
