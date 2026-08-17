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

import time

import httpx

from src.config import settings

_cached_token: str | None = None
_token_expiry: float = 0


def get_access_token() -> str:
    """Return a valid Shopify access token.

    Prefers client-credentials exchange when client_id + client_secret
    are configured.  Falls back to the static access_token.
    """
    global _cached_token, _token_expiry

    # ── Mode 1: static custom-app token (most common, never expires) ──
    if settings.shopify_access_token:
        return settings.shopify_access_token

    # ── Mode 2: client-credentials exchange (public/OAuth apps) ──
    if settings.shopify_client_id and settings.shopify_client_secret:
        if _cached_token and time.time() < _token_expiry - 120:
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
