"""Phase 2 official-API sync — GA4 + Search Console live; Ads/Meta stubs.

GA4 Data API and Search Console API are one-shot REST pulls (refresh token,
then runReport / searchAnalytics.query). No report wait-loop, no Ads poll,
no sleep. Missing credentials → a clear "needs OAuth" result and zero rows.
A metric the API omitted stays NULL. Zero is a real measurement. Never invent
a session, click, or conversion.

Google Ads and Meta stay scaffold stubs (developer token / Meta still blocked).

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

TOKEN_URL = "https://oauth2.googleapis.com/token"
GA4_REPORT_URL = (
    "https://analyticsdata.googleapis.com/v1beta/properties/{property_id}:runReport"
)
GSC_QUERY_URL = (
    "https://searchconsole.googleapis.com/webmasters/v3/sites/{site}/searchAnalytics/query"
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
        f"Mini `.env` needs the same GOOGLE_* names for ga4-sync / gsc-sync "
        f"to pull. Never chat-paste. See docs/oauth-phase2.md. "
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
    """Ads/Meta scaffold. One shot. No wait-loop. Zero rows even with OAuth."""
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


def pull_gsc_rows(token: str, site_url: str, start: date, end: date,
                  fetched_at: str) -> dict:
    """Query + page grains. Date dimension is the API day — never substituted."""
    errors: list[str] = []
    queries: list[dict] = []
    pages: list[dict] = []

    def harvest(dimension: str, key_field: str, dest: list[dict]) -> None:
        result = gsc_search_analytics(token, site_url, {
            "startDate": start.isoformat(),
            "endDate": end.isoformat(),
            "dimensions": ["date", dimension],
            "dataState": "final",
        })
        if result.get("error"):
            errors.append(f"{dimension}: {result['error']}")
            return
        for raw in result.get("rows") or []:
            keys = raw.get("keys") or []
            if not isinstance(keys, list) or len(keys) < 2:
                continue
            day = _ga4_date(keys[0])
            if not day or not _in_window(day, start, end):
                continue
            key = str(keys[1] or "").strip()
            if not key:
                continue
            dest.append({
                "metric_date": day,
                key_field: key,
                "clicks": _api_int(raw.get("clicks")),
                "impressions": _api_int(raw.get("impressions")),
                "ctr": _api_float(raw.get("ctr")),
                "position": _api_float(raw.get("position")),
                "source": "gsc_api",
                "fetched_at": fetched_at,
            })

    harvest("query", "query", queries)
    harvest("page", "page", pages)
    return {"queries": queries, "pages": pages, "errors": errors}


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
    """Pull Search Console API → upsert gsc_*_daily. Official API only."""
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
    errors = list(pulled.get("errors") or [])
    out["errors"] = errors
    out["fetched"] = {"queries": len(query_rows), "pages": len(page_rows)}

    if dry_run:
        n = len(query_rows) + len(page_rows)
        out["rows"] = n
        out["ok"] = not errors or n > 0
        out["message"] = (
            f"Search Console API dry-run {start.isoformat()}…{end.isoformat()} "
            f"{site_url} searchAnalytics.query → "
            f"{len(query_rows)} gsc_query_daily + "
            f"{len(page_rows)} gsc_page_daily. No upsert. "
            f"GSC final data lags ~2 days (null until the locked day exists). "
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
            "gsc_query_daily", query_rows, "metric_date,query", upsert_rows,
        )
    except Exception as e:
        errors.append(f"gsc_query_daily: {e}"[:240])
    try:
        written += _upsert(
            "gsc_page_daily", page_rows, "metric_date,page", upsert_rows,
        )
    except Exception as e:
        errors.append(f"gsc_page_daily: {e}"[:240])

    n = len(query_rows) + len(page_rows)
    out["rows"] = n
    out["upserted"] = written
    out["errors"] = errors
    out["ok"] = n > 0 or not errors
    if errors and n == 0:
        out["error"] = errors[0]
        out["message"] = out["error"]
        return out
    out["message"] = (
        f"Search Console API {start.isoformat()}…{end.isoformat()} "
        f"upserted {len(query_rows)} gsc_query_daily + "
        f"{len(page_rows)} gsc_page_daily. Never invent metrics."
    )
    if errors:
        out["error"] = errors[0]
        out["ok"] = True
        out["partial"] = True
    return out


def google_ads_sync(*, dry_run: bool = False, environ: dict | None = None) -> dict:
    return sync_stub("google_ads", dry_run=dry_run, environ=environ)


def meta_ads_sync(*, dry_run: bool = False, environ: dict | None = None) -> dict:
    return sync_stub("meta_ads", dry_run=dry_run, environ=environ)
