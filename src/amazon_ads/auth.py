"""Amazon Ads API authentication (LWA OAuth2, separate from SP-API)."""
from __future__ import annotations

import time
import httpx
from src.config import settings

TOKEN_URL = "https://api.amazon.com/auth/o2/token"
_cached_token: str | None = None
_token_expiry: float = 0


def get_access_token() -> str:
    """Get or refresh an Amazon Ads access token."""
    global _cached_token, _token_expiry

    if _cached_token and time.time() < _token_expiry - 120:
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


def ads_headers() -> dict[str, str]:
    """Standard headers for Amazon Ads API calls."""
    return {
        "Amazon-Advertising-API-ClientId": settings.amazon_ads_client_id,
        "Amazon-Advertising-API-Scope": settings.amazon_ads_profile_id,
        "Authorization": f"Bearer {get_access_token()}",
        "Content-Type": "application/json",
        "Accept": "application/vnd.spCampaign.v3+json",
    }
