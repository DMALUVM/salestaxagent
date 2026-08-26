"""Shared AWD (Amazon Warehousing & Distribution) API helpers."""
from __future__ import annotations

import logging

import httpx

from src.amazon_sp.client import BASE_URL, SPAPIError, _headers

log = logging.getLogger(__name__)

AWD_BASE = "/awd/2024-05-09"
AWD_ROLE_HINT = (
    "Ensure SP-API app has the 'Amazon Warehousing and Distribution' role "
    "(Developer Central → App → Roles). Re-authorize the seller after adding it."
)


def awd_get(path: str, *, params: dict | None = None, timeout: int = 60) -> dict:
    """GET an AWD v2024-05-09 resource; raise SPAPIError with role hint on 403."""
    url = f"{BASE_URL}{AWD_BASE}{path}"
    resp = httpx.get(url, headers=_headers(), params=params or {}, timeout=timeout)
    if resp.status_code == 403:
        raise SPAPIError(
            f"AWD API forbidden (403) on {path}. {AWD_ROLE_HINT} "
            f"Body: {resp.text[:300]}"
        )
    if resp.status_code != 200:
        raise SPAPIError(
            f"AWD API failed ({resp.status_code}) on {path}: {resp.text[:400]}"
        )
    return resp.json()


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
