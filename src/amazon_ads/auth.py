"""Amazon Ads API authentication (LWA OAuth2, separate from SP-API)."""
from __future__ import annotations

import time
import httpx
from src.config import settings

TOKEN_URL = "https://api.amazon.com/auth/o2/token"
_cached_token: str | None = None
_token_expiry: float = 0


def get_access_token(force_refresh: bool = False) -> str:
    """Get or refresh an Amazon Ads access token.

    `force_refresh` discards the cached token. Amazon can invalidate a token
    before its stated expiry, so a 401 on a call the cache thought was still
    good needs a way to ask for a new one rather than replaying the dead one.
    """
    global _cached_token, _token_expiry

    if not force_refresh and _cached_token and time.time() < _token_expiry - 120:
        return _cached_token

    resp = httpx.post(TOKEN_URL, data={
        "grant_type": "refresh_token",
        "client_id": settings.amazon_ads_client_id,
        "client_secret": settings.amazon_ads_client_secret,
        "refresh_token": settings.amazon_ads_refresh_token,
    }, timeout=15)
    resp.raise_for_status()
    data = resp.json()

    _cached_token = data["access_token"]
    _token_expiry = time.time() + data.get("expires_in", 3600)
    return _cached_token


def ads_headers(force_refresh: bool = False) -> dict[str, str]:
    """Standard headers for Amazon Ads API calls."""
    return {
        "Amazon-Advertising-API-ClientId": settings.amazon_ads_client_id,
        "Amazon-Advertising-API-Scope": settings.amazon_ads_profile_id,
        "Authorization": f"Bearer {get_access_token(force_refresh)}",
        "Content-Type": "application/json",
        "Accept": "application/vnd.spCampaign.v3+json",
    }
