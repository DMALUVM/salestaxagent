"""Login with Amazon (LWA) token management for SP-API.

Self-authorized apps use a long-lived refresh_token to obtain
short-lived access_tokens (~1 hour).  This module caches the
access_token in memory and refreshes automatically.

Required env vars (in .env):
    AMAZON_SP_CLIENT_ID      – LWA client ID from your app
    AMAZON_SP_CLIENT_SECRET  – LWA client secret
    AMAZON_SP_REFRESH_TOKEN  – obtained during self-authorization

──────────────────────────────────────────────────────────────
HOW TO GET THESE CREDENTIALS — Seller Central setup steps
──────────────────────────────────────────────────────────────

1.  Developer registration
    • Go to Seller Central → Apps & Services → Develop Apps
    • If you haven't registered as a developer, click
      "Register as a Developer" and follow the prompts.
    • Choose "Private developer" (self-use only).

2.  Create an SP-API application
    • On the Developer Central page, click "Add new app client".
    • App name: e.g. "Sales Tax Agent"
    • API type: SP API
    • IAM ARN: For self-authorized apps since 2023 you can
      use the simplified auth flow — leave the IAM ARN field
      as directed by the registration wizard.
    • Save.  Note your **LWA Client ID** and **Client Secret**.

3.  Authorize the app (self-authorization)
    • On the same page, click "Authorize" next to your app.
    • Confirm the permissions.
    • Amazon will display a **Refresh Token** — copy it immediately
      (it is shown only once).

4.  Configure the agent
    Add these to your .env file:
        AMAZON_SP_CLIENT_ID=amzn1.application-oa2-client.xxxxxxxxx
        AMAZON_SP_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
        AMAZON_SP_REFRESH_TOKEN=Atzr|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
        AMAZON_SP_MARKETPLACE_ID=ATVPDKIKX0DER   # US marketplace

5.  Required SP-API roles
    Your app must have the following roles enabled in Developer Central:
    • Finance and Accounting  (for tax / order reports)
    • Inventory and Order Management (for inventory ledger)
    You can request these on the app details page.

6.  Test the connection
        python -m src.main spapi-test
"""
from __future__ import annotations

import time

import httpx

from src.config import settings

LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token"

# In-memory token cache
_cached_token: str | None = None
_token_expiry: float = 0


class SPAuthError(Exception):
    """Raised when LWA token exchange fails."""


def get_access_token() -> str:
    """Return a valid SP-API access token, refreshing if needed."""
    global _cached_token, _token_expiry

    if _cached_token and time.time() < _token_expiry - 120:
        return _cached_token

    if not settings.amazon_sp_client_id or not settings.amazon_sp_refresh_token:
        raise SPAuthError(
            "SP-API credentials not configured. "
            "Set AMAZON_SP_CLIENT_ID, AMAZON_SP_CLIENT_SECRET, "
            "and AMAZON_SP_REFRESH_TOKEN in .env"
        )

    resp = httpx.post(
        LWA_TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "refresh_token": settings.amazon_sp_refresh_token,
            "client_id": settings.amazon_sp_client_id,
            "client_secret": settings.amazon_sp_client_secret,
        },
        timeout=30,
    )

    if resp.status_code != 200:
        raise SPAuthError(
            f"LWA token refresh failed ({resp.status_code}): {resp.text[:500]}"
        )

    body = resp.json()
    _cached_token = body["access_token"]
    _token_expiry = time.time() + body.get("expires_in", 3600)
    return _cached_token


def clear_token_cache() -> None:
    """Force re-authentication on next call."""
    global _cached_token, _token_expiry
    _cached_token = None
    _token_expiry = 0
