"""Phase 2 official-API sync — GA4 + Search Console + Google Ads live; Meta stub.

GA4 Data API, Search Console API, and Google Ads API are one-shot REST pulls
(refresh token, then runReport / searchAnalytics.query / googleAds:searchStream).
No report wait-loop, no Ads poll, no sleep. Missing credentials → a clear
"needs OAuth" result and zero rows. A metric the API omitted stays NULL.
Zero is a real measurement. Never invent a session, click, or conversion.

Google Ads is read-only usage despite the adwords scope — never mutate.
Meta stays a scaffold stub.

Secrets live in Vercel env (same pattern as AI_GATEWAY_API_KEY) and, when
Dana wires Mini, the same names in Mini `.env` from 1Password. Do not
chat-paste keys.

Nothing here writes nexus, Pulse sales, or contribution P&L.
"""
from __future__ import annotations

import logging
import os
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Iterable
from urllib.parse import quote

import httpx

import src.config  # noqa: F401 — absolute Mini `.env` load before missing_oauth_env

log = logging.getLogger(__name__)

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
        "tables": (
            "gsc_query_daily",
            "gsc_page_daily",
            "gsc_query_device_daily",
            "gsc_page_device_daily",
            "gsc_dim_daily",
            "gsc_url_inspection",
        ),
        "env": GOOGLE_OAUTH_ENV + ("GSC_SITE_URL",),
        "scopes": ("https://www.googleapis.com/auth/webmasters.readonly",),
    },
}

NEEDS_OAUTH = "needs OAuth"
SCAFFOLD_NO_WRITE = (
    "Official API pull is not wired yet (Phase 2 scaffold). "
    "Wrote 0 rows. Never invent metrics."
)

TOKEN_URL = "https://oauth2.googleapis.com/token"
GA4_REPORT_URL = (
    "https://analyticsdata.googleapis.com/v1beta/properties/{property_id}:runReport"
)
GSC_QUERY_URL = (
    "https://searchconsole.googleapis.com/webmasters/v3/sites/{site}/searchAnalytics/query"
)
# URL Inspection is a separate read-only POST. 2k/day/site — allowlist only.
GSC_URL_INSPECTION_URL = (
    "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
)
# Tiny hardcoded top PDPs. Not a crawl. Add a handle only when it stays a
# first-class tallowbourn.com SKU. Never invent a product URL.
GSC_PDP_INSPECT_ALLOWLIST = (
    "https://tallowbourn.com/products/tallow-balm",
    "https://tallowbourn.com/products/natural-tallow-deodorant-extra-strength",
    "https://tallowbourn.com/products/grass-fed-tallow-lip-balm",
)
# Site-wide Search Analytics dims that may share the date dimension.
# searchAppearance cannot be grouped with ANY other dimension — including
# date. Google returns HTTP 400:
# "Cannot group by search appearance dimension together with another dimension."
# Harvest it day-bounded with dimensions=['searchAppearance'] only.
GSC_SITE_DIMS = (
    ("device", "device"),
    ("country", "country"),
)
GSC_APPEARANCE_DIMENSION = "searchAppearance"
GSC_APPEARANCE_KIND = "search_appearance"
# Latest stable REST version as of 2026-09 (sunset Aug 2027). SELECT only.
GOOGLE_ADS_API_VERSION = "v25"
GOOGLE_ADS_SEARCH_STREAM_URL = (
    "https://googleads.googleapis.com/{version}/customers/{customer_id}/googleAds:searchStream"
)

DEFAULT_LOOKBACK_DAYS = 7
MAX_LOOKBACK_DAYS = 90
MAX_PAGES = 4
GA4_PAGE_LIMIT = 100_000
GSC_PAGE_LIMIT = 25_000
HTTP_TIMEOUT = 30.0

GA4_EVENT_NAMES = (
    "session_start",
    "view_item",
    "add_to_cart",
    "begin_checkout",
    "purchase",
)
GA4_EVENT_TO_COL = {
    "session_start": "landings",
    "view_item": "view_item",
    "add_to_cart": "add_to_cart",
    "begin_checkout": "begin_checkout",
    "purchase": "purchase",
}
GA4_SESSION_EVENT_COLS = tuple(GA4_EVENT_TO_COL.values())


def missing_oauth_env(connector: str, environ: dict | None = None) -> list[str]:
    """Required env names that are blank. Optional MCC login is not required."""
    spec = CONNECTORS[connector]
    env = environ if environ is not None else os.environ
    missing = []
    for key in spec["env"]:
        if not str(env.get(key) or "").strip():
            missing.append(key)
    return missing


def connector_env_ready(connector: str, environ: dict | None = None) -> bool:
    """True when Mini/Vercel has every required name for this connector."""
    return not missing_oauth_env(connector, environ)


def needs_oauth_message(connector: str, missing: Iterable[str]) -> str:
    spec = CONNECTORS[connector]
    keys = ", ".join(missing)
    return (
        f"{spec['label']} {NEEDS_OAUTH}. Missing: {keys}. "
        f"Set them on Vercel → project dashboard → Settings → "
        f"Environment Variables (same page as AI_GATEWAY_API_KEY). "
        f"Mini `.env` needs the same GOOGLE_* names for ga4-sync / "
        f"gsc-sync / google-ads-sync to pull. Never chat-paste. "
        f"See docs/oauth-phase2.md. "
        f"Wrote 0 rows. Never invent metrics."
    )


def _blank_result(connector: str, *, dry_run: bool, missing: list[str]) -> dict:
    spec = CONNECTORS[connector]
    return {
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


def sync_stub(connector: str, *, dry_run: bool = False,
              environ: dict | None = None) -> dict:
    """Meta (and leftover) scaffold. One shot. No wait-loop. Zero rows even with OAuth."""
    if connector not in CONNECTORS:
        raise KeyError(f"unknown Phase 2 connector: {connector}")
    spec = CONNECTORS[connector]
    missing = missing_oauth_env(connector, environ)
    out = _blank_result(connector, dry_run=dry_run, missing=missing)
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


def prior_ny_day(now: datetime | None = None) -> date:
    """Yesterday in America/New_York (agent / Shopify / digest lock)."""
    from src.rules import agent_today

    return agent_today(now) - timedelta(days=1)


def sync_window(days: int = DEFAULT_LOOKBACK_DAYS, as_of: str | date | None = None,
                now: datetime | None = None) -> tuple[date, date]:
    """Inclusive [start, end] ending at as_of (default: prior NY day)."""
    if days < 1 or days > MAX_LOOKBACK_DAYS:
        raise ValueError(f"days must be 1–{MAX_LOOKBACK_DAYS}")
    if as_of is None:
        end = prior_ny_day(now)
    elif isinstance(as_of, datetime):
        end = as_of.date()
    elif isinstance(as_of, date):
        end = as_of
    else:
        end = date.fromisoformat(str(as_of).strip()[:10])
    start = end - timedelta(days=days - 1)
    return start, end


def _env_get(environ: dict | None, key: str) -> str:
    env = environ if environ is not None else os.environ
    return str(env.get(key) or "").strip()


def _ga4_property_id(raw: str) -> str:
    s = raw.strip()
    if s.startswith("properties/"):
        return s.split("/", 1)[1].strip()
    return s


def _http_post(url: str, *, headers: dict | None = None, data: Any = None,
               json: Any = None, timeout: float = HTTP_TIMEOUT) -> httpx.Response:
    """Single official-API POST. No retry sleep, no wait-loop."""
    return httpx.post(url, headers=headers, data=data, json=json, timeout=timeout)


def _google_error(resp: httpx.Response) -> str:
    try:
        body = resp.json()
    except Exception:
        return f"HTTP {resp.status_code}: {(resp.text or '')[:240]}"
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        msg = err.get("message") or err.get("status") or err
        return f"HTTP {resp.status_code}: {msg}"[:400]
    if isinstance(err, str) and err:
        return f"HTTP {resp.status_code}: {err}"[:400]
    return f"HTTP {resp.status_code}: {str(body)[:240]}"


def refresh_access_token(environ: dict | None = None) -> dict:
    """Refresh-token grant. One shot. Never logs the token."""
    try:
        resp = _http_post(
            TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "client_id": _env_get(environ, "GOOGLE_OAUTH_CLIENT_ID"),
                "client_secret": _env_get(environ, "GOOGLE_OAUTH_CLIENT_SECRET"),
                "refresh_token": _env_get(environ, "GOOGLE_OAUTH_REFRESH_TOKEN"),
                "grant_type": "refresh_token",
            },
        )
    except httpx.HTTPError as e:
        return {"error": f"OAuth token request failed: {e}"[:400]}
    if resp.status_code >= 400:
        return {"error": f"OAuth token { _google_error(resp) }"}
    try:
        payload = resp.json()
    except Exception:
        return {"error": "OAuth token response was not JSON"}
    token = str(payload.get("access_token") or "").strip()
    if not token:
        return {"error": "OAuth token response missing access_token"}
    return {"access_token": token}


def _api_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _api_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _ga4_date(raw: Any) -> str | None:
    s = str(raw or "").strip()
    if len(s) == 8 and s.isdigit():
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    return None


def _in_window(day: str, start: date, end: date) -> bool:
    try:
        parsed = date.fromisoformat(day)
    except ValueError:
        return False
    return start <= parsed <= end


def _report_maps(body: dict) -> list[dict]:
    dim_headers = [h.get("name") for h in (body.get("dimensionHeaders") or [])]
    met_headers = [h.get("name") for h in (body.get("metricHeaders") or [])]
    out: list[dict] = []
    for row in body.get("rows") or []:
        item: dict[str, Any] = {}
        dims = row.get("dimensionValues") or []
        mets = row.get("metricValues") or []
        for i, name in enumerate(dim_headers):
            if name and i < len(dims):
                item[str(name)] = dims[i].get("value")
        for i, name in enumerate(met_headers):
            if name and i < len(mets):
                item[str(name)] = mets[i].get("value")
        out.append(item)
    return out


def ga4_run_report(token: str, property_id: str, payload: dict) -> dict:
    """GA4 Data API runReport. Offset pages only — no PENDING poll."""
    url = GA4_REPORT_URL.format(property_id=property_id)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    rows: list[dict] = []
    offset = 0
    for _page in range(MAX_PAGES):
        body = {**payload, "limit": GA4_PAGE_LIMIT, "offset": offset}
        try:
            resp = _http_post(url, headers=headers, json=body)
        except httpx.HTTPError as e:
            return {"error": f"GA4 runReport failed: {e}"[:400], "rows": []}
        if resp.status_code >= 400:
            return {"error": _google_error(resp), "rows": []}
        try:
            data = resp.json()
        except Exception:
            return {"error": "GA4 runReport response was not JSON", "rows": []}
        if not isinstance(data, dict):
            return {"error": "GA4 runReport response was not an object", "rows": []}
        batch = _report_maps(data)
        rows.extend(batch)
        total = _api_int(data.get("rowCount"))
        offset += len(batch)
        if not batch:
            break
        if total is None or offset >= total:
            break
    return {"rows": rows}


def gsc_search_analytics(token: str, site_url: str, payload: dict) -> dict:
    """Search Console searchAnalytics.query. startRow pages only."""
    url = GSC_QUERY_URL.format(site=quote(site_url, safe=""))
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    rows: list[dict] = []
    for page in range(MAX_PAGES):
        body = {**payload, "rowLimit": GSC_PAGE_LIMIT, "startRow": page * GSC_PAGE_LIMIT}
        try:
            resp = _http_post(url, headers=headers, json=body)
        except httpx.HTTPError as e:
            return {"error": f"GSC query failed: {e}"[:400], "rows": []}
        if resp.status_code >= 400:
            return {"error": _google_error(resp), "rows": []}
        try:
            data = resp.json()
        except Exception:
            return {"error": "GSC query response was not JSON", "rows": []}
        if not isinstance(data, dict):
            return {"error": "GSC query response was not an object", "rows": []}
        batch = data.get("rows") or []
        if not isinstance(batch, list):
            return {"error": "GSC query rows were not a list", "rows": []}
        rows.extend(batch)
        if len(batch) < GSC_PAGE_LIMIT:
            break
    return {"rows": rows}


def _zero_fill_events(row: dict) -> None:
    for col in GA4_SESSION_EVENT_COLS:
        if row.get(col) is None:
            row[col] = 0


def _apply_session_metrics(row: dict, raw: dict) -> None:
    if "sessions" in raw:
        row["sessions"] = _api_int(raw.get("sessions"))
    if "engagedSessions" in raw:
        row["engaged_sessions"] = _api_int(raw.get("engagedSessions"))


def _apply_event_counts(row: dict, raw: dict) -> None:
    event = str(raw.get("eventName") or "").strip()
    col = GA4_EVENT_TO_COL.get(event)
    if not col:
        return
    row[col] = _api_int(raw.get("eventCount"))


def _ga4_event_filter() -> dict:
    return {
        "filter": {
            "fieldName": "eventName",
            "inListFilter": {"values": list(GA4_EVENT_NAMES)},
        }
    }


def pull_ga4_rows(token: str, property_id: str, start: date, end: date,
                  fetched_at: str) -> dict:
    """Four one-shot runReports (sessions/events × all/device + landing)."""
    date_range = {
        "dateRanges": [{
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
        }],
    }
    errors: list[str] = []
    sessions: dict[tuple[str, str, str], dict] = {}
    landings: dict[tuple[str, str, str], dict] = {}

    def session_row(day: str, kind: str, value: str) -> dict:
        key = (day, kind, value)
        if key not in sessions:
            sessions[key] = {
                "metric_date": day,
                "split_kind": kind,
                "split_value": value,
                "source": "ga4_data_api",
                "fetched_at": fetched_at,
            }
        return sessions[key]

    def landing_row(day: str, path: str, device: str) -> dict:
        key = (day, path, device)
        if key not in landings:
            landings[key] = {
                "metric_date": day,
                "landing_page": path,
                "device": device,
                "source": "ga4_data_api",
                "fetched_at": fetched_at,
            }
        return landings[key]

    reports = (
        ("sessions_all", {
            **date_range,
            "dimensions": [{"name": "date"}],
            "metrics": [{"name": "sessions"}, {"name": "engagedSessions"}],
        }),
        ("events_all", {
            **date_range,
            "dimensions": [{"name": "date"}, {"name": "eventName"}],
            "metrics": [{"name": "eventCount"}],
            "dimensionFilter": _ga4_event_filter(),
        }),
        ("sessions_device", {
            **date_range,
            "dimensions": [{"name": "date"}, {"name": "deviceCategory"}],
            "metrics": [{"name": "sessions"}, {"name": "engagedSessions"}],
        }),
        ("events_device", {
            **date_range,
            "dimensions": [
                {"name": "date"}, {"name": "deviceCategory"}, {"name": "eventName"},
            ],
            "metrics": [{"name": "eventCount"}],
            "dimensionFilter": _ga4_event_filter(),
        }),
        ("sessions_landing", {
            **date_range,
            "dimensions": [
                {"name": "date"}, {"name": "landingPage"},
                {"name": "deviceCategory"},
            ],
            "metrics": [{"name": "sessions"}, {"name": "engagedSessions"}],
        }),
        ("events_landing", {
            **date_range,
            "dimensions": [
                {"name": "date"}, {"name": "landingPage"},
                {"name": "deviceCategory"}, {"name": "eventName"},
            ],
            "metrics": [{"name": "eventCount"}],
            "dimensionFilter": _ga4_event_filter(),
        }),
    )

    events_ok = {"all": False, "device": False, "landing": False}

    for name, payload in reports:
        result = ga4_run_report(token, property_id, payload)
        if result.get("error"):
            errors.append(f"{name}: {result['error']}")
            continue
        for raw in result.get("rows") or []:
            day = _ga4_date(raw.get("date"))
            if not day or not _in_window(day, start, end):
                continue
            if name == "sessions_all":
                _apply_session_metrics(session_row(day, "all", ""), raw)
            elif name == "events_all":
                _apply_event_counts(session_row(day, "all", ""), raw)
            elif name == "sessions_device":
                device = str(raw.get("deviceCategory") or "").strip()
                _apply_session_metrics(session_row(day, "device", device), raw)
            elif name == "events_device":
                device = str(raw.get("deviceCategory") or "").strip()
                _apply_event_counts(session_row(day, "device", device), raw)
            elif name == "sessions_landing":
                path = str(raw.get("landingPage") or "").strip()
                if not path:
                    continue
                device = str(raw.get("deviceCategory") or "").strip()
                _apply_session_metrics(landing_row(day, path, device), raw)
            elif name == "events_landing":
                path = str(raw.get("landingPage") or "").strip()
                if not path:
                    continue
                device = str(raw.get("deviceCategory") or "").strip()
                _apply_event_counts(landing_row(day, path, device), raw)
        if name == "events_all":
            events_ok["all"] = True
        elif name == "events_device":
            events_ok["device"] = True
        elif name == "events_landing":
            events_ok["landing"] = True

    if events_ok["all"]:
        for row in sessions.values():
            if row["split_kind"] == "all":
                _zero_fill_events(row)
    if events_ok["device"]:
        for row in sessions.values():
            if row["split_kind"] == "device":
                _zero_fill_events(row)
    if events_ok["landing"]:
        for row in landings.values():
            _zero_fill_events(row)

    return {
        "sessions": list(sessions.values()),
        "landings": list(landings.values()),
        "errors": errors,
    }


def _gsc_metric_fields(raw: dict, fetched_at: str) -> dict:
    """Present-or-null Search Analytics metrics. Never invent a click."""
    return {
        "clicks": _api_int(raw.get("clicks")),
        "impressions": _api_int(raw.get("impressions")),
        "ctr": _api_float(raw.get("ctr")),
        "position": _api_float(raw.get("position")),
        "source": "gsc_api",
        "fetched_at": fetched_at,
    }


def pull_gsc_rows(token: str, site_url: str, start: date, end: date,
                  fetched_at: str) -> dict:
    """Query + page totals plus cheap device / country / appearance dims.

    gsc_query_daily / gsc_page_daily stay the totals SoT. Extra harvests
    are additive. searchAppearance is site-wide and date-less: Google
    forbids grouping it with any other dimension, including date. Use
    startDate/endDate as a one-day window and stamp metric_date from
    that request day. Query/page/device/country still use the date dim.
    """
    errors: list[str] = []
    queries: list[dict] = []
    pages: list[dict] = []
    query_device: list[dict] = []
    page_device: list[dict] = []
    dims: list[dict] = []

    def harvest(dimensions: list[str], dest: list[dict],
                build: Callable[[str, list], dict | None]) -> None:
        result = gsc_search_analytics(token, site_url, {
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "dimensions": ["date", *dimensions],
            "dataState": "final",
        })
        label = "+".join(dimensions)
        if result.get("error"):
            errors.append(f"{label}: {result['error']}")
            return
        for raw in result.get("rows") or []:
            if not isinstance(raw, dict):
                continue
            keys = raw.get("keys") or []
            if not isinstance(keys, list) or len(keys) < 1 + len(dimensions):
                continue
            day = _ga4_date(keys[0])
            if not day or not _in_window(day, start, end):
                continue
            row = build(day, [str(k or "").strip() for k in keys[1:]])
            if not row:
                continue
            dest.append({**row, **_gsc_metric_fields(raw, fetched_at)})

    def one_key(field: str):
        def build(day: str, keys: list[str]) -> dict | None:
            if not keys or not keys[0]:
                return None
            return {"metric_date": day, field: keys[0]}
        return build

    def key_device(field: str):
        def build(day: str, keys: list[str]) -> dict | None:
            if len(keys) < 2 or not keys[0] or not keys[1]:
                return None
            return {"metric_date": day, field: keys[0], "device": keys[1]}
        return build

    def site_dim(kind: str):
        def build(day: str, keys: list[str]) -> dict | None:
            if not keys or not keys[0]:
                return None
            return {"metric_date": day, "dim_kind": kind, "dim_value": keys[0]}
        return build

    def harvest_appearance() -> None:
        """Day-bounded searchAppearance — never put date (or any other dim) in dimensions[]."""
        day = start
        while day <= end:
            stamp = day.isoformat()
            result = gsc_search_analytics(token, site_url, {
                "startDate": stamp,
                "endDate": stamp,
                "dimensions": [GSC_APPEARANCE_DIMENSION],
                "dataState": "final",
            })
            if result.get("error"):
                errors.append(f"{GSC_APPEARANCE_DIMENSION}: {result['error']}")
                day += timedelta(days=1)
                continue
            for raw in result.get("rows") or []:
                if not isinstance(raw, dict):
                    continue
                keys = raw.get("keys") or []
                if not isinstance(keys, list) or not keys:
                    continue
                value = str(keys[0] or "").strip()
                if not value:
                    continue
                dims.append({
                    "metric_date": stamp,
                    "dim_kind": GSC_APPEARANCE_KIND,
                    "dim_value": value,
                    **_gsc_metric_fields(raw, fetched_at),
                })
            day += timedelta(days=1)

    harvest(["query"], queries, one_key("query"))
    harvest(["page"], pages, one_key("page"))
    harvest(["query", "device"], query_device, key_device("query"))
    harvest(["page", "device"], page_device, key_device("page"))
    for api_name, kind in GSC_SITE_DIMS:
        harvest([api_name], dims, site_dim(kind))
    harvest_appearance()
    return {
        "queries": queries,
        "pages": pages,
        "query_device": query_device,
        "page_device": page_device,
        "dims": dims,
        "errors": errors,
    }


def gsc_inspect_url(token: str, site_url: str, inspection_url: str) -> dict:
    """One-shot URL Inspection. Read-only. Never crawls. Fail closed."""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    try:
        resp = _http_post(
            GSC_URL_INSPECTION_URL,
            headers=headers,
            json={
                "inspectionUrl": inspection_url,
                "siteUrl": site_url,
                "languageCode": "en-US",
            },
        )
    except httpx.HTTPError as e:
        return {"error": f"URL Inspection failed: {e}"[:400]}
    if resp.status_code >= 400:
        return {"error": _google_error(resp)}
    try:
        data = resp.json()
    except Exception:
        return {"error": "URL Inspection response was not JSON"}
    if not isinstance(data, dict):
        return {"error": "URL Inspection response was not an object"}
    return {"payload": data}


def _slim_inspection(payload: dict, *, inspection_url: str, site_url: str,
                     fetched_at: str) -> dict:
    """Store verdicts + index status. Never persist issue / detectedItems lists."""
    result = payload.get("inspectionResult") if isinstance(payload, dict) else None
    if not isinstance(result, dict):
        result = {}
    index = result.get("indexStatusResult")
    if not isinstance(index, dict):
        index = {}
    mobile = result.get("mobileUsabilityResult")
    if not isinstance(mobile, dict):
        mobile = {}
    rich = result.get("richResultsResult")
    if not isinstance(rich, dict):
        rich = {}
    refs = index.get("referringUrls")
    referring: list[str] = []
    if isinstance(refs, list):
        for item in refs[:20]:
            s = str(item or "").strip()
            if s:
                referring.append(s)
    last_crawl = index.get("lastCrawlTime")
    last_crawl_s = str(last_crawl).strip() if last_crawl else None
    return {
        "inspection_url": inspection_url,
        "site_url": site_url,
        "inspected_at": fetched_at,
        "verdict": (str(index["verdict"]).strip() if "verdict" in index else None),
        "coverage_state": (
            str(index["coverageState"]).strip() if "coverageState" in index else None
        ),
        "robots_txt_state": (
            str(index["robotsTxtState"]).strip() if "robotsTxtState" in index else None
        ),
        "indexing_state": (
            str(index["indexingState"]).strip() if "indexingState" in index else None
        ),
        "last_crawl_time": last_crawl_s or None,
        "page_fetch_state": (
            str(index["pageFetchState"]).strip() if "pageFetchState" in index else None
        ),
        "google_canonical": (
            str(index["googleCanonical"]).strip() if "googleCanonical" in index else None
        ),
        "user_canonical": (
            str(index["userCanonical"]).strip() if "userCanonical" in index else None
        ),
        "crawled_as": (str(index["crawledAs"]).strip() if "crawledAs" in index else None),
        "referring_urls": referring or None,
        "mobile_usability_verdict": (
            str(mobile["verdict"]).strip() if "verdict" in mobile else None
        ),
        "rich_results_verdict": (
            str(rich["verdict"]).strip() if "verdict" in rich else None
        ),
        "inspection_result_link": (
            str(result["inspectionResultLink"]).strip()
            if "inspectionResultLink" in result else None
        ),
        "raw": {
            "indexStatusResult": {
                k: index[k] for k in (
                    "verdict", "coverageState", "robotsTxtState", "indexingState",
                    "lastCrawlTime", "pageFetchState", "googleCanonical",
                    "userCanonical", "crawledAs",
                ) if k in index
            },
            "mobileUsabilityVerdict": mobile.get("verdict"),
            "richResultsVerdict": rich.get("verdict"),
            "inspectionResultLink": result.get("inspectionResultLink"),
        },
        "error": None,
        "source": "gsc_url_inspection_api",
    }


def pull_gsc_inspections(token: str, site_url: str, fetched_at: str) -> dict:
    """Inspect the hardcoded PDP allowlist. Fail closed — log + continue."""
    rows: list[dict] = []
    errors: list[str] = []
    for url in GSC_PDP_INSPECT_ALLOWLIST:
        result = gsc_inspect_url(token, site_url, url)
        if result.get("error"):
            msg = f"{url}: {result['error']}"[:240]
            errors.append(msg)
            log.warning("GSC URL Inspection skipped: %s", msg)
            continue
        payload = result.get("payload")
        if not isinstance(payload, dict):
            msg = f"{url}: empty inspection payload"
            errors.append(msg)
            log.warning("GSC URL Inspection skipped: %s", msg)
            continue
        rows.append(_slim_inspection(
            payload, inspection_url=url, site_url=site_url, fetched_at=fetched_at,
        ))
    return {"rows": rows, "errors": errors}


def _ads_customer_id(raw: str) -> str:
    """Digits only. Ads UI dashes (123-456-7890) are stripped. Invalid → blank."""
    s = str(raw or "").strip().replace("-", "").replace(" ", "")
    return s if s.isdigit() else ""


def _ads_field(obj: Any, *names: str) -> Any:
    if not isinstance(obj, dict):
        return None
    for name in names:
        if name in obj:
            return obj[name]
    return None


def _micros_to_dollars(value: Any) -> float | None:
    """cost_micros → currency. Unit conversion only — never invent a spend."""
    if value is None or value == "":
        return None
    micros = _api_int(value)
    if micros is None:
        return None
    return round(micros / 1_000_000.0, 2)


def _ads_stream_rows(data: Any) -> dict:
    """searchStream wraps results in a JSON array of batch objects."""
    if isinstance(data, dict):
        if data.get("error"):
            return {"error": "Google Ads searchStream returned an error object", "rows": []}
        batches = [data]
    elif isinstance(data, list):
        batches = data
    else:
        return {"error": "Google Ads searchStream response was not JSON array", "rows": []}
    rows: list[dict] = []
    for batch in batches:
        if not isinstance(batch, dict):
            continue
        if batch.get("error"):
            return {"error": "Google Ads searchStream batch contained an error", "rows": []}
        results = batch.get("results") or []
        if not isinstance(results, list):
            return {"error": "Google Ads searchStream results were not a list", "rows": []}
        rows.extend(r for r in results if isinstance(r, dict))
    return {"rows": rows}


def google_ads_campaign_query(start: date, end: date) -> str:
    """Read-only GAQL. SELECT only — never mutate."""
    return (
        "SELECT segments.date, campaign.id, campaign.name, "
        "metrics.cost_micros, metrics.clicks, metrics.impressions, "
        "metrics.conversions, metrics.conversions_value "
        "FROM campaign "
        f"WHERE segments.date BETWEEN '{start.isoformat()}' AND '{end.isoformat()}'"
    )


def google_ads_search_stream(
    token: str,
    customer_id: str,
    developer_token: str,
    query: str,
    *,
    login_customer_id: str = "",
) -> dict:
    """Google Ads searchStream. One POST — no report poll, no page wait."""
    url = GOOGLE_ADS_SEARCH_STREAM_URL.format(
        version=GOOGLE_ADS_API_VERSION,
        customer_id=customer_id,
    )
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "developer-token": developer_token,
    }
    if login_customer_id:
        headers["login-customer-id"] = login_customer_id
    try:
        resp = _http_post(url, headers=headers, json={"query": query})
    except httpx.HTTPError as e:
        return {"error": f"Google Ads searchStream failed: {e}"[:400], "rows": []}
    if resp.status_code >= 400:
        return {"error": _google_error(resp), "rows": []}
    try:
        data = resp.json()
    except Exception:
        return {"error": "Google Ads searchStream response was not JSON", "rows": []}
    return _ads_stream_rows(data)


def pull_google_ads_rows(
    token: str,
    customer_id: str,
    developer_token: str,
    start: date,
    end: date,
    fetched_at: str,
    *,
    login_customer_id: str = "",
) -> dict:
    """Campaign × day grain. metric_date is the API day — never substituted."""
    query = google_ads_campaign_query(start, end)
    result = google_ads_search_stream(
        token, customer_id, developer_token, query,
        login_customer_id=login_customer_id,
    )
    if result.get("error"):
        return {"rows": [], "errors": [result["error"]]}
    out: dict[tuple[str, str], dict] = {}
    for raw in result.get("rows") or []:
        campaign = raw.get("campaign") or {}
        metrics = raw.get("metrics") or {}
        segments = raw.get("segments") or {}
        if not isinstance(campaign, dict):
            campaign = {}
        if not isinstance(metrics, dict):
            metrics = {}
        if not isinstance(segments, dict):
            segments = {}
        day = _ga4_date(_ads_field(segments, "date"))
        if not day or not _in_window(day, start, end):
            continue
        cid = _ads_field(campaign, "id")
        if cid is None or cid == "":
            continue
        cid = str(cid).strip()
        if not cid:
            continue
        name = _ads_field(campaign, "name")
        row: dict[str, Any] = {
            "metric_date": day,
            "campaign_id": cid,
            "source": "google_ads_api",
            "fetched_at": fetched_at,
        }
        if name is not None:
            row["campaign_name"] = str(name)
        # Present-or-null: omit key only when the API did not return the field.
        if "costMicros" in metrics or "cost_micros" in metrics:
            row["spend"] = _micros_to_dollars(
                _ads_field(metrics, "costMicros", "cost_micros"),
            )
        if "clicks" in metrics:
            row["clicks"] = _api_int(metrics.get("clicks"))
        if "impressions" in metrics:
            row["impressions"] = _api_int(metrics.get("impressions"))
        if "conversions" in metrics:
            row["conversions"] = _api_float(metrics.get("conversions"))
        if "conversionsValue" in metrics or "conversions_value" in metrics:
            val = _api_float(_ads_field(metrics, "conversionsValue", "conversions_value"))
            row["conversion_value"] = None if val is None else round(val, 2)
        out[(day, cid)] = row
    return {"rows": list(out.values()), "errors": []}


def _upsert(table: str, rows: list[dict], on_conflict: str,
            upsert_rows: Callable) -> int:
    if not rows:
        return 0
    return int(upsert_rows(table, rows, on_conflict=on_conflict) or 0)


def _resolve_window(days: int, as_of: str | date | None,
                    now: datetime | None) -> tuple[date, date] | dict:
    try:
        return sync_window(days=days, as_of=as_of, now=now)
    except ValueError as e:
        return {"error": str(e)}


def ga4_sync(*, dry_run: bool = False, environ: dict | None = None,
             as_of: str | date | None = None, days: int = DEFAULT_LOOKBACK_DAYS,
             now: datetime | None = None) -> dict:
    """Pull GA4 Data API → upsert ga4_*_daily. Official API only."""
    missing = missing_oauth_env("ga4", environ)
    out = _blank_result("ga4", dry_run=dry_run, missing=missing)
    if missing:
        out["error"] = needs_oauth_message("ga4", missing)
        out["message"] = out["error"]
        return out

    window = _resolve_window(days, as_of, now)
    if isinstance(window, dict):
        out["error"] = window["error"]
        out["message"] = window["error"]
        return out
    start, end = window
    out["start_date"] = start.isoformat()
    out["end_date"] = end.isoformat()
    out["metric_date"] = end.isoformat()

    token_r = refresh_access_token(environ)
    if token_r.get("error"):
        out["error"] = token_r["error"]
        out["message"] = token_r["error"]
        return out

    property_id = _ga4_property_id(_env_get(environ, "GA4_PROPERTY_ID"))
    if not property_id or property_id.upper().startswith("G-"):
        out["error"] = (
            "GA4_PROPERTY_ID must be the numeric property id "
            "(not a Measurement ID G-XXXX). Wrote 0 rows. Never invent metrics."
        )
        out["message"] = out["error"]
        return out

    fetched_at = datetime.now(timezone.utc).isoformat()
    pulled = pull_ga4_rows(token_r["access_token"], property_id, start, end,
                           fetched_at)
    session_rows = pulled.get("sessions") or []
    landing_rows = pulled.get("landings") or []
    errors = list(pulled.get("errors") or [])
    out["errors"] = errors
    out["fetched"] = {"sessions": len(session_rows), "landings": len(landing_rows)}

    if dry_run:
        n = len(session_rows) + len(landing_rows)
        out["rows"] = n
        out["ok"] = not errors or n > 0
        out["message"] = (
            f"GA4 Data API dry-run {start.isoformat()}…{end.isoformat()} "
            f"properties/{property_id} runReport → "
            f"{len(session_rows)} ga4_sessions_daily + "
            f"{len(landing_rows)} ga4_landing_daily. No upsert. "
            f"Never invent metrics."
        )
        if errors and n == 0:
            out["error"] = errors[0]
            out["ok"] = False
        return out

    written = 0
    try:
        from src.db import upsert_rows
    except Exception as e:
        out["error"] = f"Supabase client unavailable: {e}"[:400]
        out["message"] = out["error"]
        return out

    try:
        written += _upsert(
            "ga4_sessions_daily", session_rows,
            "metric_date,split_kind,split_value", upsert_rows,
        )
    except Exception as e:
        errors.append(f"ga4_sessions_daily: {e}"[:240])
    try:
        written += _upsert(
            "ga4_landing_daily", landing_rows,
            "metric_date,landing_page,device", upsert_rows,
        )
    except Exception as e:
        errors.append(f"ga4_landing_daily: {e}"[:240])

    n = len(session_rows) + len(landing_rows)
    out["rows"] = n
    out["upserted"] = written
    out["errors"] = errors
    out["ok"] = n > 0 or not errors
    if errors and n == 0:
        out["error"] = errors[0]
        out["message"] = out["error"]
        return out
    out["message"] = (
        f"GA4 Data API {start.isoformat()}…{end.isoformat()} "
        f"upserted {len(session_rows)} ga4_sessions_daily + "
        f"{len(landing_rows)} ga4_landing_daily. Never invent metrics."
    )
    if errors:
        out["error"] = errors[0]
        out["ok"] = True
        out["partial"] = True
    return out


def gsc_sync(*, dry_run: bool = False, environ: dict | None = None,
             as_of: str | date | None = None, days: int = DEFAULT_LOOKBACK_DAYS,
             now: datetime | None = None) -> dict:
    """Pull Search Console API → upsert gsc_*_daily. Official API only.

    Performance (`searchAnalytics.query`) for query/page totals plus
    device / country / searchAppearance. Merchant / structured-data /
    rich-result issue lists are not in this API — Ellis mail owns those.
    URL Inspection is a tiny hardcoded PDP allowlist (read-only, latest
    row). Fail closed on inspect errors (log + continue; no Telegram).
    Do not invent an issues poll.
    """
    missing = missing_oauth_env("gsc", environ)
    out = _blank_result("gsc", dry_run=dry_run, missing=missing)
    if missing:
        out["error"] = needs_oauth_message("gsc", missing)
        out["message"] = out["error"]
        return out

    window = _resolve_window(days, as_of, now)
    if isinstance(window, dict):
        out["error"] = window["error"]
        out["message"] = window["error"]
        return out
    start, end = window
    out["start_date"] = start.isoformat()
    out["end_date"] = end.isoformat()
    out["metric_date"] = end.isoformat()

    token_r = refresh_access_token(environ)
    if token_r.get("error"):
        out["error"] = token_r["error"]
        out["message"] = token_r["error"]
        return out

    site_url = _env_get(environ, "GSC_SITE_URL")
    fetched_at = datetime.now(timezone.utc).isoformat()
    pulled = pull_gsc_rows(token_r["access_token"], site_url, start, end,
                           fetched_at)
    query_rows = pulled.get("queries") or []
    page_rows = pulled.get("pages") or []
    query_device_rows = pulled.get("query_device") or []
    page_device_rows = pulled.get("page_device") or []
    dim_rows = pulled.get("dims") or []
    errors = list(pulled.get("errors") or [])
    inspected = pull_gsc_inspections(
        token_r["access_token"], site_url, fetched_at,
    )
    inspect_rows = inspected.get("rows") or []
    inspect_errors = list(inspected.get("errors") or [])
    out["errors"] = errors
    out["inspection_errors"] = inspect_errors
    out["fetched"] = {
        "queries": len(query_rows),
        "pages": len(page_rows),
        "query_device": len(query_device_rows),
        "page_device": len(page_device_rows),
        "dims": len(dim_rows),
        "inspections": len(inspect_rows),
    }

    n = (
        len(query_rows) + len(page_rows)
        + len(query_device_rows) + len(page_device_rows) + len(dim_rows)
    )
    out["rows"] = n

    def _gsc_message(*, upserted: bool) -> str:
        verb = "upserted" if upserted else "searchAnalytics.query →"
        extra = "No upsert. " if not upserted else ""
        return (
            f"Search Console API{' dry-run' if dry_run else ''} "
            f"{start.isoformat()}…{end.isoformat()} {site_url} {verb} "
            f"{len(query_rows)} gsc_query_daily + "
            f"{len(page_rows)} gsc_page_daily + "
            f"{len(query_device_rows)} gsc_query_device_daily + "
            f"{len(page_device_rows)} gsc_page_device_daily + "
            f"{len(dim_rows)} gsc_dim_daily + "
            f"{len(inspect_rows)} gsc_url_inspection. {extra}"
            f"GSC final data lags ~2 days (null until the locked day exists). "
            f"Never invent metrics."
        )

    if dry_run:
        out["ok"] = not errors or n > 0
        out["message"] = _gsc_message(upserted=False)
        if errors and n == 0:
            out["error"] = errors[0]
            out["ok"] = False
        return out

    written = 0
    try:
        from src.db import upsert_rows
    except Exception as e:
        out["error"] = f"Supabase client unavailable: {e}"[:400]
        out["message"] = out["error"]
        return out

    writes = (
        ("gsc_query_daily", query_rows, "metric_date,query"),
        ("gsc_page_daily", page_rows, "metric_date,page"),
        ("gsc_query_device_daily", query_device_rows, "metric_date,query,device"),
        ("gsc_page_device_daily", page_device_rows, "metric_date,page,device"),
        ("gsc_dim_daily", dim_rows, "metric_date,dim_kind,dim_value"),
    )
    for table, rows, conflict in writes:
        try:
            written += _upsert(table, rows, conflict, upsert_rows)
        except Exception as e:
            errors.append(f"{table}: {e}"[:240])
    try:
        written += _upsert(
            "gsc_url_inspection", inspect_rows, "inspection_url", upsert_rows,
        )
    except Exception as e:
        # Inspection is optional. Missing table / write error must not
        # fail the query/page SoT or page Mini Telegram.
        msg = f"gsc_url_inspection: {e}"[:240]
        inspect_errors.append(msg)
        log.warning("GSC URL Inspection upsert skipped: %s", msg)

    out["rows"] = n
    out["upserted"] = written
    out["errors"] = errors
    out["inspection_errors"] = inspect_errors
    out["ok"] = n > 0 or not errors
    if errors and n == 0:
        out["error"] = errors[0]
        out["message"] = out["error"]
        return out
    out["message"] = _gsc_message(upserted=True)
    if errors:
        out["error"] = errors[0]
        out["ok"] = True
        out["partial"] = True
    return out


def google_ads_sync(*, dry_run: bool = False, environ: dict | None = None,
                    as_of: str | date | None = None,
                    days: int = DEFAULT_LOOKBACK_DAYS,
                    now: datetime | None = None) -> dict:
    """Pull Google Ads API → upsert google_ads_daily. Official API only.

    Read-only searchStream despite adwords scope. Never mutate campaigns.
    """
    missing = missing_oauth_env("google_ads", environ)
    out = _blank_result("google_ads", dry_run=dry_run, missing=missing)
    if missing:
        out["error"] = needs_oauth_message("google_ads", missing)
        out["message"] = out["error"]
        return out

    window = _resolve_window(days, as_of, now)
    if isinstance(window, dict):
        out["error"] = window["error"]
        out["message"] = window["error"]
        return out
    start, end = window
    out["start_date"] = start.isoformat()
    out["end_date"] = end.isoformat()
    out["metric_date"] = end.isoformat()

    customer_id = _ads_customer_id(_env_get(environ, "GOOGLE_ADS_CUSTOMER_ID"))
    if not customer_id:
        out["error"] = (
            "GOOGLE_ADS_CUSTOMER_ID must be the 10-digit client id "
            "(no dashes). Wrote 0 rows. Never invent metrics."
        )
        out["message"] = out["error"]
        return out
    login_raw = _env_get(environ, "GOOGLE_ADS_LOGIN_CUSTOMER_ID")
    login_customer_id = _ads_customer_id(login_raw) if login_raw else ""
    if login_raw and not login_customer_id:
        out["error"] = (
            "GOOGLE_ADS_LOGIN_CUSTOMER_ID must be the 10-digit MCC id "
            "(no dashes) when set. Wrote 0 rows. Never invent metrics."
        )
        out["message"] = out["error"]
        return out
    developer_token = _env_get(environ, "GOOGLE_ADS_DEVELOPER_TOKEN")

    token_r = refresh_access_token(environ)
    if token_r.get("error"):
        out["error"] = token_r["error"]
        out["message"] = token_r["error"]
        return out

    fetched_at = datetime.now(timezone.utc).isoformat()
    pulled = pull_google_ads_rows(
        token_r["access_token"], customer_id, developer_token, start, end,
        fetched_at, login_customer_id=login_customer_id,
    )
    rows = pulled.get("rows") or []
    errors = list(pulled.get("errors") or [])
    out["errors"] = errors
    out["fetched"] = {"campaigns": len(rows)}
    out["customer_id"] = customer_id
    if login_customer_id:
        out["login_customer_id"] = login_customer_id

    if dry_run:
        n = len(rows)
        out["rows"] = n
        out["ok"] = not errors or n > 0
        out["message"] = (
            f"Google Ads API dry-run {start.isoformat()}…{end.isoformat()} "
            f"customers/{customer_id} searchStream → "
            f"{n} google_ads_daily. No upsert. Never mutate. "
            f"Never invent metrics."
        )
        if errors and n == 0:
            out["error"] = errors[0]
            out["ok"] = False
        return out

    written = 0
    try:
        from src.db import upsert_rows
    except Exception as e:
        out["error"] = f"Supabase client unavailable: {e}"[:400]
        out["message"] = out["error"]
        return out

    try:
        written += _upsert(
            "google_ads_daily", rows, "metric_date,campaign_id", upsert_rows,
        )
    except Exception as e:
        errors.append(f"google_ads_daily: {e}"[:240])

    n = len(rows)
    out["rows"] = n
    out["upserted"] = written
    out["errors"] = errors
    out["ok"] = n > 0 or not errors
    if errors and n == 0:
        out["error"] = errors[0]
        out["message"] = out["error"]
        return out
    out["message"] = (
        f"Google Ads API {start.isoformat()}…{end.isoformat()} "
        f"upserted {n} google_ads_daily. Never mutate. Never invent metrics."
    )
    if errors:
        out["error"] = errors[0]
        out["ok"] = True
        out["partial"] = True
    return out


def meta_ads_sync(*, dry_run: bool = False, environ: dict | None = None) -> dict:
    return sync_stub("meta_ads", dry_run=dry_run, environ=environ)
