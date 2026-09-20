"""Phase 2 official-API sync stubs — GA4, Google Ads, Meta, Search Console.

SCAFFOLD. OAuth lands later (docs/oauth-phase2.md). These jobs are one-shot:
no report wait-loop, no Ads poll, no sleep. Missing credentials → a clear
"needs OAuth" result and zero rows. Credentials present but the Data API
pull is not wired → still zero rows. Never invent a session, click, spend,
or conversion.

Secrets live in Vercel env (same pattern as AI_GATEWAY_API_KEY) and, when
Dana wires Mini, the same names in Mini `.env` from 1Password. Do not
chat-paste keys.

Nothing here writes nexus, Pulse sales, or contribution P&L.
"""
from __future__ import annotations

import os
from typing import Iterable

# Vercel (dashboard) + Mini `.env` — same names. Read-only official APIs.
GOOGLE_OAUTH_ENV = (
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN",
)

CONNECTORS: dict[str, dict] = {
    "ga4": {
        "command": "ga4-sync",
        "label": "GA4 Data API",
        "tables": ("ga4_sessions_daily", "ga4_landing_daily"),
        "env": GOOGLE_OAUTH_ENV + ("GA4_PROPERTY_ID",),
        "scopes": ("https://www.googleapis.com/auth/analytics.readonly",),
    },
    "google_ads": {
        "command": "google-ads-sync",
        "label": "Google Ads API",
        "tables": ("google_ads_daily",),
        "env": GOOGLE_OAUTH_ENV + (
            "GOOGLE_ADS_DEVELOPER_TOKEN",
            "GOOGLE_ADS_CUSTOMER_ID",
        ),
        "optional_env": ("GOOGLE_ADS_LOGIN_CUSTOMER_ID",),
        # Google Ads has no read-only OAuth scope. We still never mutate.
        "scopes": ("https://www.googleapis.com/auth/adwords",),
    },
    "meta_ads": {
        "command": "meta-ads-sync",
        "label": "Meta Marketing API",
        "tables": ("meta_ads_daily",),
        "env": (
            "META_APP_ID",
            "META_APP_SECRET",
            "META_ADS_ACCESS_TOKEN",
            "META_ADS_ACCOUNT_ID",
        ),
        "scopes": ("ads_read",),
    },
    "gsc": {
        "command": "gsc-sync",
        "label": "Search Console API",
        "tables": ("gsc_query_daily", "gsc_page_daily"),
        "env": GOOGLE_OAUTH_ENV + ("GSC_SITE_URL",),
        "scopes": ("https://www.googleapis.com/auth/webmasters.readonly",),
    },
}

NEEDS_OAUTH = "needs OAuth"
SCAFFOLD_NO_WRITE = (
    "Official API pull is not wired yet (Phase 2 scaffold). "
    "Wrote 0 rows. Never invent metrics."
)


def missing_oauth_env(connector: str, environ: dict | None = None) -> list[str]:
    """Required env names that are blank. Optional MCC login is not required."""
    spec = CONNECTORS[connector]
    env = environ if environ is not None else os.environ
    missing = []
    for key in spec["env"]:
        if not str(env.get(key) or "").strip():
            missing.append(key)
    return missing


def needs_oauth_message(connector: str, missing: Iterable[str]) -> str:
    spec = CONNECTORS[connector]
    keys = ", ".join(missing)
    return (
        f"{spec['label']} {NEEDS_OAUTH}. Missing: {keys}. "
        f"Set them on Vercel → project dashboard → Settings → "
        f"Environment Variables (same page as AI_GATEWAY_API_KEY). "
        f"Mini does not need these keys for the scaffold. "
        f"Never chat-paste. See docs/oauth-phase2.md. "
        f"Wrote 0 rows. Never invent metrics."
    )


def sync_stub(connector: str, *, dry_run: bool = False,
              environ: dict | None = None) -> dict:
    """One shot. No wait-loop. Zero rows whether or not OAuth is present."""
    if connector not in CONNECTORS:
        raise KeyError(f"unknown Phase 2 connector: {connector}")
    spec = CONNECTORS[connector]
    missing = missing_oauth_env(connector, environ)
    out = {
        "connector": connector,
        "command": spec["command"],
        "label": spec["label"],
        "tables": list(spec["tables"]),
        "rows": 0,
        "dry_run": bool(dry_run),
        "scopes": list(spec["scopes"]),
        "missing_env": missing,
        "needs_oauth": bool(missing),
        "ok": False,
    }
    if missing:
        out["error"] = needs_oauth_message(connector, missing)
        out["message"] = out["error"]
        return out
    out["scaffold"] = True
    out["message"] = (
        f"{spec['label']} credentials present. {SCAFFOLD_NO_WRITE}"
    )
    # Still fail-closed: scaffold must not look like a successful pull.
    out["error"] = out["message"]
    return out


def ga4_sync(*, dry_run: bool = False, environ: dict | None = None) -> dict:
    return sync_stub("ga4", dry_run=dry_run, environ=environ)


def google_ads_sync(*, dry_run: bool = False, environ: dict | None = None) -> dict:
    return sync_stub("google_ads", dry_run=dry_run, environ=environ)


def meta_ads_sync(*, dry_run: bool = False, environ: dict | None = None) -> dict:
    return sync_stub("meta_ads", dry_run=dry_run, environ=environ)


def gsc_sync(*, dry_run: bool = False, environ: dict | None = None) -> dict:
    return sync_stub("gsc", dry_run=dry_run, environ=environ)
