"""Phase 2 official-API connectors — fail closed, no invented metrics, no wait-loops."""
from __future__ import annotations

import os
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import click
from click.testing import CliRunner

from src.config import load_project_dotenv
from src.phase2_connectors import (
    CONNECTORS,
    GSC_APPEARANCE_DIMENSION,
    GSC_APPEARANCE_KIND,
    GSC_PDP_INSPECT_ALLOWLIST,
    GSC_SITE_DIMS,
    NEEDS_OAUTH,
    ga4_sync,
    google_ads_campaign_query,
    google_ads_sync,
    gsc_sync,
    meta_ads_sync,
    missing_oauth_env,
    prior_ny_day,
    sync_stub,
    sync_window,
)

NY = ZoneInfo("America/New_York")


def _clear(monkeypatch):
    for spec in CONNECTORS.values():
        for key in spec["env"]:
            monkeypatch.delenv(key, raising=False)
        for key in spec.get("optional_env") or ():
            monkeypatch.delenv(key, raising=False)


def _google_env(**extra):
    env = {
        "GOOGLE_OAUTH_CLIENT_ID": "id",
        "GOOGLE_OAUTH_CLIENT_SECRET": "secret",
        "GOOGLE_OAUTH_REFRESH_TOKEN": "refresh",
        "GA4_PROPERTY_ID": "411710093",
        "GSC_SITE_URL": "sc-domain:tallowbourn.com",
        "GOOGLE_ADS_DEVELOPER_TOKEN": "devtok",
        "GOOGLE_ADS_CUSTOMER_ID": "5332206723",
        "GOOGLE_ADS_LOGIN_CUSTOMER_ID": "7137868835",
    }
    env.update(extra)
    return env


def _ads_stream(results):
    return [{"results": results}]


class _Resp:
    def __init__(self, payload, status=200, text=""):
        self._payload = payload
        self.status_code = status
        self.text = text or ""

    def json(self):
        return self._payload


def _ga4_report(dims, rows):
    dim_headers = [{"name": d} for d in dims]
    # Infer metric headers from the first row's leftover keys, or standard set.
    met_names = []
    if rows:
        skip = set(dims)
        met_names = [k for k in rows[0] if k not in skip]
    elif "eventName" in dims:
        met_names = ["eventCount"]
    else:
        met_names = ["sessions", "engagedSessions"]
    body_rows = []
    for raw in rows:
        body_rows.append({
            "dimensionValues": [{"value": str(raw.get(d, ""))} for d in dims],
            "metricValues": [{"value": str(raw[m])} for m in met_names],
        })
    return {
        "dimensionHeaders": dim_headers,
        "metricHeaders": [{"name": m} for m in met_names],
        "rowCount": len(body_rows),
        "rows": body_rows,
    }


def _route_google(url, json=None, **_kwargs):
    if "oauth2.googleapis.com/token" in url:
        return _Resp({"access_token": "ya29.test-token", "expires_in": 3600})
    if "runReport" in url:
        dims = [d["name"] for d in (json or {}).get("dimensions") or []]
        if dims == ["date"]:
            return _Resp(_ga4_report(["date"], [
                {"date": "20260919", "sessions": "100", "engagedSessions": "70"},
            ]))
        if dims == ["date", "eventName"]:
            return _Resp(_ga4_report(["date", "eventName"], [
                {"date": "20260919", "eventName": "session_start",
                 "eventCount": "95"},
                {"date": "20260919", "eventName": "purchase", "eventCount": "4"},
            ]))
        if dims == ["date", "deviceCategory"]:
            return _Resp(_ga4_report(["date", "deviceCategory"], [
                {"date": "20260919", "deviceCategory": "mobile",
                 "sessions": "60", "engagedSessions": "40"},
            ]))
        if dims == ["date", "deviceCategory", "eventName"]:
            return _Resp(_ga4_report(["date", "deviceCategory", "eventName"], [
                {"date": "20260919", "deviceCategory": "mobile",
                 "eventName": "purchase", "eventCount": "3"},
            ]))
        if dims == ["date", "landingPage", "deviceCategory"]:
            return _Resp(_ga4_report(
                ["date", "landingPage", "deviceCategory"],
                [{
                    "date": "20260919", "landingPage": "/shop",
                    "deviceCategory": "mobile",
                    "sessions": "40", "engagedSessions": "22",
                }],
            ))
        if dims == ["date", "landingPage", "deviceCategory", "eventName"]:
            return _Resp(_ga4_report(
                ["date", "landingPage", "deviceCategory", "eventName"],
                [{
                    "date": "20260919", "landingPage": "/shop",
                    "deviceCategory": "mobile",
                    "eventName": "purchase", "eventCount": "2",
                }],
            ))
        return _Resp(_ga4_report(dims, []))
    if "searchAnalytics/query" in url:
        dims = (json or {}).get("dimensions") or []
        if dims == ["date", "query"]:
            return _Resp({"rows": [{
                "keys": ["2026-09-19", "tallow balm"],
                "clicks": 5, "impressions": 80, "ctr": 0.0625, "position": 4.2,
            }]})
        if dims == ["date", "page"]:
            return _Resp({"rows": [{
                "keys": ["2026-09-19", "https://tallowbourn.com/shop"],
                "clicks": 3, "impressions": 40, "ctr": 0.075, "position": 6.1,
            }]})
        if dims == ["date", "query", "device"]:
            return _Resp({"rows": [{
                "keys": ["2026-09-19", "tallow balm", "MOBILE"],
                "clicks": 4, "impressions": 60, "ctr": 0.0667, "position": 3.8,
            }]})
        if dims == ["date", "page", "device"]:
            return _Resp({"rows": [{
                "keys": ["2026-09-19", "https://tallowbourn.com/shop", "MOBILE"],
                "clicks": 2, "impressions": 30, "ctr": 0.0667, "position": 5.4,
            }]})
        if dims == ["date", "device"]:
            return _Resp({"rows": [{
                "keys": ["2026-09-19", "MOBILE"],
                "clicks": 8, "impressions": 100, "ctr": 0.08, "position": 5.0,
            }]})
        if dims == ["date", "country"]:
            return _Resp({"rows": [{
                "keys": ["2026-09-19", "usa"],
                "clicks": 7, "impressions": 90, "ctr": 0.0778, "position": 4.8,
            }]})
        # Google forbids searchAppearance with any other dimension, including date.
        if "searchAppearance" in dims and dims != ["searchAppearance"]:
            return _Resp(
                {"error": {
                    "code": 400,
                    "message": (
                        "Cannot group by search appearance dimension "
                        "together with another dimension."
                    ),
                    "status": "INVALID_ARGUMENT",
                }},
                status=400,
                text="Cannot group by search appearance dimension together with another dimension.",
            )
        if dims == ["searchAppearance"]:
            return _Resp({"rows": [{
                "keys": ["PRODUCT_SNIPPETS"],
                "clicks": 1, "impressions": 50, "ctr": 0.02, "position": 8.1,
            }]})
        return _Resp({})
    if "urlInspection/index:inspect" in url:
        inspected = str((json or {}).get("inspectionUrl") or "")
        return _Resp({
            "inspectionResult": {
                "inspectionResultLink": "https://search.google.com/search-console/inspect",
                "indexStatusResult": {
                    "verdict": "PASS",
                    "coverageState": "Submitted and indexed",
                    "robotsTxtState": "ALLOWED",
                    "indexingState": "INDEXING_ALLOWED",
                    "lastCrawlTime": "2026-09-18T12:00:00Z",
                    "pageFetchState": "SUCCESSFUL",
                    "googleCanonical": inspected,
                    "userCanonical": inspected,
                    "crawledAs": "MOBILE",
                    "referringUrls": ["https://tallowbourn.com/"],
                },
                # Issue lists must never be persisted — Ellis owns those.
                "mobileUsabilityResult": {
                    "verdict": "PASS",
                    "issues": [{"issueType": "SKIP_ME"}],
                },
                "richResultsResult": {
                    "verdict": "PASS",
                    "detectedItems": [{"richResultType": "Product", "items": []}],
                },
            },
        })
    if "googleAds:searchStream" in url:
        return _Resp(_ads_stream([{
            "campaign": {"id": "111", "name": "Tallow Search"},
            "segments": {"date": "2026-09-19"},
            "metrics": {
                "costMicros": "2500000",
                "clicks": "12",
                "impressions": "400",
                "conversions": "1.5",
                "conversionsValue": "42.0",
            },
        }]))
    raise AssertionError(f"unexpected URL {url}")


def test_missing_oauth_lists_required_vercel_names(monkeypatch):
    _clear(monkeypatch)
    missing = missing_oauth_env("ga4")
    assert "GOOGLE_OAUTH_CLIENT_ID" in missing
    assert "GA4_PROPERTY_ID" in missing
    assert "GOOGLE_ADS_DEVELOPER_TOKEN" not in missing


def test_project_dotenv_loads_google_ads_keys_when_cwd_is_elsewhere(
    tmp_path, monkeypatch,
):
    """Mini `.env` is path-absolute — CLI cwd must not hide GOOGLE_* keys."""
    project = tmp_path / "sales-tax-agent"
    elsewhere = tmp_path / "elsewhere"
    project.mkdir()
    elsewhere.mkdir()
    keys = (
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GOOGLE_OAUTH_REFRESH_TOKEN",
        "GOOGLE_ADS_DEVELOPER_TOKEN",
        "GOOGLE_ADS_CUSTOMER_ID",
    )
    (project / ".env").write_text(
        "\n".join(f"{key}=present-{i}" for i, key in enumerate(keys)) + "\n",
        encoding="utf-8",
    )
    for key in keys:
        monkeypatch.delenv(key, raising=False)

    monkeypatch.chdir(elsewhere)
    assert Path.cwd() == elsewhere
    assert os.environ.get("GOOGLE_OAUTH_CLIENT_ID") in (None, "")
    assert missing_oauth_env("google_ads") == list(keys)

    loaded = load_project_dotenv(project)
    assert loaded is True
    assert missing_oauth_env("google_ads") == []
    for key in keys:
        assert str(os.environ.get(key) or "").strip()


def test_project_dotenv_absent_stays_fail_closed(tmp_path, monkeypatch):
    """No invented credentials when the absolute `.env` is missing."""
    project = tmp_path / "empty-project"
    elsewhere = tmp_path / "elsewhere"
    project.mkdir()
    elsewhere.mkdir()
    keys = CONNECTORS["google_ads"]["env"]
    for key in keys:
        monkeypatch.delenv(key, raising=False)

    monkeypatch.chdir(elsewhere)
    loaded = load_project_dotenv(project)
    assert loaded is False
    missing = missing_oauth_env("google_ads")
    assert missing == list(keys)


def test_each_connector_needs_oauth_and_writes_zero(monkeypatch):
    _clear(monkeypatch)
    fns = (ga4_sync, google_ads_sync, meta_ads_sync, gsc_sync)
    for fn in fns:
        r = fn()
        assert r["needs_oauth"] is True
        assert r["rows"] == 0
        assert r["ok"] is False
        assert NEEDS_OAUTH in r["error"]
        assert "Never invent metrics" in r["error"]
        assert "docs/oauth-phase2.md" in r["error"]


def test_meta_credentials_present_still_write_zero_rows():
    env = {
        "META_APP_ID": "app",
        "META_APP_SECRET": "secret",
        "META_ADS_ACCESS_TOKEN": "token",
        "META_ADS_ACCOUNT_ID": "act_1",
    }
    r = meta_ads_sync(environ=env)
    assert r["needs_oauth"] is False
    assert r["rows"] == 0
    assert r["ok"] is False
    assert r["scaffold"] is True
    assert "Never invent metrics" in r["message"]
    stub = sync_stub("meta_ads", environ=env)
    assert stub["scaffold"] is True
    assert stub["rows"] == 0


def test_prior_ny_day_is_america_new_york():
    now = datetime(2026, 9, 20, 1, 30, tzinfo=NY)
    assert prior_ny_day(now) == date(2026, 9, 19)
    # 01:30 ET is still the 19th UTC+4 — window must not use UTC today.
    start, end = sync_window(days=1, now=now)
    assert start == end == date(2026, 9, 19)


def test_ga4_success_mocked_http_upserts_locked_day(monkeypatch):
    upserts: list[tuple] = []

    def fake_upsert(table, rows, on_conflict=None):
        upserts.append((table, list(rows), on_conflict))
        return len(rows)

    monkeypatch.setattr("src.phase2_connectors._http_post", _route_google)
    monkeypatch.setattr("src.db.upsert_rows", fake_upsert)

    r = ga4_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    assert r["needs_oauth"] is False
    assert r["ok"] is True
    assert r["rows"] > 0
    assert r["start_date"] == r["end_date"] == "2026-09-19"
    assert r.get("scaffold") is not True
    tables = {t for t, _, _ in upserts}
    assert tables == {"ga4_sessions_daily", "ga4_landing_daily"}

    sessions = next(rows for t, rows, _ in upserts if t == "ga4_sessions_daily")
    by = {(row["split_kind"], row["split_value"]): row for row in sessions}
    all_row = by[("all", "")]
    assert all_row["metric_date"] == "2026-09-19"
    assert all_row["sessions"] == 100
    assert all_row["engaged_sessions"] == 70
    assert all_row["landings"] == 95
    assert all_row["purchase"] == 4
    # Event report succeeded; omitted events are 0 (asked-for, not invented).
    assert all_row["view_item"] == 0
    assert all_row["add_to_cart"] == 0
    assert "bounce_sessions" not in all_row  # API did not return a count

    landing = next(rows for t, rows, _ in upserts if t == "ga4_landing_daily")
    assert landing[0]["metric_date"] == "2026-09-19"
    assert landing[0]["landing_page"] == "/shop"
    assert landing[0]["device"] == "mobile"
    assert landing[0]["sessions"] == 40
    assert landing[0]["purchase"] == 2


def test_ga4_rejects_measurement_id(monkeypatch):
    monkeypatch.setattr(
        "src.phase2_connectors._http_post",
        lambda *a, **k: _Resp({"access_token": "tok"}),
    )
    r = ga4_sync(environ=_google_env(GA4_PROPERTY_ID="G-XXXX"), as_of="2026-09-19",
                 days=1)
    assert r["ok"] is False
    assert r["rows"] == 0
    assert "Measurement ID" in r["error"]


def test_ga4_dry_run_documents_path_without_upsert(monkeypatch):
    monkeypatch.setattr("src.phase2_connectors._http_post", _route_google)

    def boom(*_a, **_k):
        raise AssertionError("dry-run must not upsert")

    monkeypatch.setattr("src.db.upsert_rows", boom)
    r = ga4_sync(environ=_google_env(), as_of="2026-09-19", days=1, dry_run=True)
    assert r["ok"] is True
    assert r["dry_run"] is True
    assert r["rows"] > 0
    assert "No upsert" in r["message"]
    assert "runReport" in r["message"]


def test_ga4_skips_dates_outside_requested_window(monkeypatch):
    def weird(url, json=None, **kwargs):
        if "runReport" in url:
            dims = [d["name"] for d in (json or {}).get("dimensions") or []]
            if dims == ["date"]:
                return _Resp(_ga4_report(["date"], [
                    {"date": "20260910", "sessions": "9", "engagedSessions": "8"},
                    {"date": "20260919", "sessions": "2", "engagedSessions": "1"},
                ]))
            return _Resp(_ga4_report(dims, []))
        return _route_google(url, json=json, **kwargs)

    upserts = []
    monkeypatch.setattr("src.phase2_connectors._http_post", weird)
    monkeypatch.setattr(
        "src.db.upsert_rows",
        lambda t, rows, on_conflict=None: upserts.append(rows) or len(rows),
    )
    ga4_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    sessions = next(rows for rows in upserts if rows and "split_kind" in rows[0])
    assert all(row["metric_date"] == "2026-09-19" for row in sessions)
    assert not any(row["metric_date"] == "2026-09-10" for row in sessions)


def test_gsc_success_mocked_http_upserts_locked_day(monkeypatch):
    upserts: list[tuple] = []

    def fake_upsert(table, rows, on_conflict=None):
        upserts.append((table, list(rows), on_conflict))
        return len(rows)

    monkeypatch.setattr("src.phase2_connectors._http_post", _route_google)
    monkeypatch.setattr("src.db.upsert_rows", fake_upsert)

    r = gsc_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    assert r["ok"] is True
    assert r["needs_oauth"] is False
    assert r["rows"] == 7
    assert r["start_date"] == "2026-09-19"
    assert r["fetched"]["inspections"] == 3
    tables = {t for t, _, _ in upserts}
    assert tables == {
        "gsc_query_daily", "gsc_page_daily",
        "gsc_query_device_daily", "gsc_page_device_daily",
        "gsc_dim_daily", "gsc_url_inspection",
    }

    queries = next(rows for t, rows, _ in upserts if t == "gsc_query_daily")
    assert queries[0]["metric_date"] == "2026-09-19"
    assert queries[0]["query"] == "tallow balm"
    assert queries[0]["clicks"] == 5
    assert queries[0]["impressions"] == 80
    assert queries[0]["ctr"] == 0.0625
    assert queries[0]["position"] == 4.2

    pages = next(rows for t, rows, _ in upserts if t == "gsc_page_daily")
    assert pages[0]["page"] == "https://tallowbourn.com/shop"
    assert pages[0]["metric_date"] == "2026-09-19"

    qdev = next(rows for t, rows, _ in upserts if t == "gsc_query_device_daily")
    assert qdev[0]["query"] == "tallow balm"
    assert qdev[0]["device"] == "MOBILE"
    assert qdev[0]["clicks"] == 4

    dims = next(rows for t, rows, _ in upserts if t == "gsc_dim_daily")
    by_kind = {row["dim_kind"]: row for row in dims}
    assert by_kind["device"]["dim_value"] == "MOBILE"
    assert by_kind["country"]["dim_value"] == "usa"
    assert by_kind["search_appearance"]["dim_value"] == "PRODUCT_SNIPPETS"
    assert by_kind["search_appearance"]["metric_date"] == "2026-09-19"

    inspects = next(rows for t, rows, _ in upserts if t == "gsc_url_inspection")
    assert len(inspects) == 3
    assert all(row["verdict"] == "PASS" for row in inspects)
    raw = inspects[0]["raw"]
    assert "issues" not in raw
    assert "detectedItems" not in raw
    assert raw["mobileUsabilityVerdict"] == "PASS"


def test_gsc_empty_final_day_is_success_zero_rows(monkeypatch):
    def empty(url, json=None, **kwargs):
        if "searchAnalytics/query" in url:
            return _Resp({})
        return _route_google(url, json=json, **kwargs)

    upserts: list[str] = []
    monkeypatch.setattr("src.phase2_connectors._http_post", empty)
    monkeypatch.setattr(
        "src.db.upsert_rows",
        lambda t, rows, on_conflict=None: upserts.append(t) or len(rows),
    )
    r = gsc_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    assert r["ok"] is True
    assert r["rows"] == 0
    # Analytics stay empty — do not invent a query. Inspection is latest-state.
    assert "gsc_query_daily" not in upserts
    assert "gsc_page_daily" not in upserts
    assert "gsc_url_inspection" in upserts


def test_gsc_omitted_metric_stays_null(monkeypatch):
    def partial(url, json=None, **kwargs):
        if "searchAnalytics/query" in url:
            dims = (json or {}).get("dimensions") or []
            if dims == ["date", "query"]:
                return _Resp({"rows": [{
                    "keys": ["2026-09-19", "tallow"],
                    "clicks": 2, "impressions": 10,
                    # ctr / position omitted — stay null
                }]})
            return _Resp({})
        return _route_google(url, json=json, **kwargs)

    upserts = []
    monkeypatch.setattr("src.phase2_connectors._http_post", partial)
    monkeypatch.setattr(
        "src.db.upsert_rows",
        lambda t, rows, on_conflict=None: upserts.append((t, rows)) or len(rows),
    )
    gsc_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    queries = next(rows for t, rows in upserts if t == "gsc_query_daily")
    assert queries[0]["clicks"] == 2
    assert queries[0]["ctr"] is None
    assert queries[0]["position"] is None


def test_gsc_dry_run_documents_path_without_upsert(monkeypatch):
    monkeypatch.setattr("src.phase2_connectors._http_post", _route_google)

    def boom(*_a, **_k):
        raise AssertionError("dry-run must not upsert")

    monkeypatch.setattr("src.db.upsert_rows", boom)
    r = gsc_sync(environ=_google_env(), as_of="2026-09-19", days=1, dry_run=True)
    assert r["ok"] is True
    assert r["dry_run"] is True
    assert r["rows"] == 7
    assert r["fetched"]["inspections"] == 3
    assert "No upsert" in r["message"]
    assert "gsc_dim_daily" in r["message"]


def test_gsc_inspection_error_is_fail_closed(monkeypatch):
    """Inspect HTTP errors log + continue. Query/page SoT still writes."""
    def boom_inspect(url, json=None, **kwargs):
        if "urlInspection/index:inspect" in url:
            return _Resp(
                {"error": {"code": 429, "message": "quota", "status": "RESOURCE_EXHAUSTED"}},
                status=429,
                text="quota",
            )
        return _route_google(url, json=json, **kwargs)

    upserts: list[str] = []
    monkeypatch.setattr("src.phase2_connectors._http_post", boom_inspect)
    monkeypatch.setattr(
        "src.db.upsert_rows",
        lambda t, rows, on_conflict=None: upserts.append(t) or len(rows),
    )
    r = gsc_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    assert r["ok"] is True
    assert r["rows"] == 7
    assert r.get("partial") is not True
    assert r.get("inspection_errors")
    assert "gsc_query_daily" in upserts
    assert "gsc_url_inspection" not in upserts


def test_gsc_never_groups_search_appearance_with_query(monkeypatch):
    seen: list[list] = []

    def capture(url, json=None, **kwargs):
        if "searchAnalytics/query" in url:
            seen.append(list((json or {}).get("dimensions") or []))
        return _route_google(url, json=json, **kwargs)

    monkeypatch.setattr("src.phase2_connectors._http_post", capture)
    monkeypatch.setattr("src.db.upsert_rows", lambda *a, **k: 1)
    gsc_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    analytics = [d for d in seen if d]
    assert ["searchAppearance"] in analytics
    for dims in analytics:
        if "searchAppearance" in dims:
            assert dims == ["searchAppearance"]
            assert "date" not in dims
            assert "query" not in dims
            assert "page" not in dims
    assert all("/products/" in u for u in GSC_PDP_INSPECT_ALLOWLIST)
    assert len(GSC_PDP_INSPECT_ALLOWLIST) <= 8


def test_gsc_search_appearance_request_excludes_date(monkeypatch):
    """Mocked Search Analytics body for appearance is dimensions=['searchAppearance'] only."""
    seen: list[dict] = []

    def capture(url, json=None, **kwargs):
        if "searchAnalytics/query" in url:
            seen.append(dict(json or {}))
        return _route_google(url, json=json, **kwargs)

    monkeypatch.setattr("src.phase2_connectors._http_post", capture)
    monkeypatch.setattr("src.db.upsert_rows", lambda *a, **k: 1)
    gsc_sync(environ=_google_env(), as_of="2026-09-19", days=2)

    appearance = [
        p for p in seen
        if GSC_APPEARANCE_DIMENSION in (p.get("dimensions") or [])
    ]
    assert appearance, "gsc-sync must request searchAppearance"
    windows = []
    for payload in appearance:
        dims = payload.get("dimensions") or []
        assert dims == [GSC_APPEARANCE_DIMENSION]
        assert "date" not in dims
        assert len(dims) == 1
        assert payload.get("dataState") == "final"
        # Day-bounded: stamp metric_date from this window, not from keys.
        assert payload["startDate"] == payload["endDate"]
        windows.append(payload["startDate"])
    assert windows == ["2026-09-18", "2026-09-19"]

    # Other harvests still include the date dimension — do not regress them.
    assert ["date", "query"] in [p.get("dimensions") for p in seen]
    assert ["date", "page"] in [p.get("dimensions") for p in seen]
    assert ["date", "device"] in [p.get("dimensions") for p in seen]
    assert ["date", "country"] in [p.get("dimensions") for p in seen]
    assert ["date", "query", "device"] in [p.get("dimensions") for p in seen]
    assert ["date", "page", "device"] in [p.get("dimensions") for p in seen]
    assert GSC_APPEARANCE_DIMENSION not in {name for name, _ in GSC_SITE_DIMS}


def test_gsc_search_appearance_stamps_metric_date_from_request_window(monkeypatch):
    upserts: list[tuple] = []

    def fake_upsert(table, rows, on_conflict=None):
        upserts.append((table, list(rows), on_conflict))
        return len(rows)

    monkeypatch.setattr("src.phase2_connectors._http_post", _route_google)
    monkeypatch.setattr("src.db.upsert_rows", fake_upsert)
    r = gsc_sync(environ=_google_env(), as_of="2026-09-19", days=2)
    assert r["ok"] is True
    dims = next(rows for t, rows, _ in upserts if t == "gsc_dim_daily")
    appearance = [row for row in dims if row["dim_kind"] == GSC_APPEARANCE_KIND]
    assert {row["metric_date"] for row in appearance} == {"2026-09-18", "2026-09-19"}
    assert all(row["dim_value"] == "PRODUCT_SNIPPETS" for row in appearance)
    # Device/country still come from the dated harvest (mock only returns 2026-09-19).
    by_kind = {row["dim_kind"]: row for row in dims if row["dim_kind"] != GSC_APPEARANCE_KIND}
    assert by_kind["device"]["metric_date"] == "2026-09-19"
    assert by_kind["country"]["metric_date"] == "2026-09-19"


def test_cli_commands_fail_closed_without_oauth(monkeypatch):
    _clear(monkeypatch)
    from src.main import cli

    runner = CliRunner()
    for cmd in ("ga4-sync", "google-ads-sync", "meta-ads-sync", "gsc-sync"):
        result = runner.invoke(cli, [cmd])
        assert result.exit_code != 0, cmd
        assert "needs OAuth" in result.output, result.output
        assert "0 rows" in result.output or "Wrote 0" in result.output


def test_google_ads_success_mocked_http_upserts_locked_day(monkeypatch):
    upserts: list[tuple] = []
    seen_headers: list[dict] = []

    def capture(url, headers=None, json=None, **kwargs):
        if headers:
            seen_headers.append(dict(headers))
        return _route_google(url, json=json, headers=headers, **kwargs)

    def fake_upsert(table, rows, on_conflict=None):
        upserts.append((table, list(rows), on_conflict))
        return len(rows)

    monkeypatch.setattr("src.phase2_connectors._http_post", capture)
    monkeypatch.setattr("src.db.upsert_rows", fake_upsert)

    r = google_ads_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    assert r["needs_oauth"] is False
    assert r["ok"] is True
    assert r["rows"] == 1
    assert r["start_date"] == r["end_date"] == "2026-09-19"
    assert r.get("scaffold") is not True
    assert r["customer_id"] == "5332206723"
    assert r["login_customer_id"] == "7137868835"
    assert upserts[0][0] == "google_ads_daily"
    assert upserts[0][2] == "metric_date,campaign_id"
    row = upserts[0][1][0]
    assert row["metric_date"] == "2026-09-19"
    assert row["campaign_id"] == "111"
    assert row["campaign_name"] == "Tallow Search"
    assert row["spend"] == 2.50
    assert row["clicks"] == 12
    assert row["impressions"] == 400
    assert row["conversions"] == 1.5
    assert row["conversion_value"] == 42.0
    assert row["source"] == "google_ads_api"

    ads_headers = [h for h in seen_headers if h.get("developer-token")]
    assert ads_headers
    assert ads_headers[0]["developer-token"] == "devtok"
    assert ads_headers[0]["login-customer-id"] == "7137868835"
    assert ads_headers[0]["Authorization"] == "Bearer ya29.test-token"


def test_google_ads_omitted_metric_stays_null(monkeypatch):
    def partial(url, json=None, **kwargs):
        if "googleAds:searchStream" in url:
            return _Resp(_ads_stream([{
                "campaign": {"id": "222", "name": "PMax"},
                "segments": {"date": "2026-09-19"},
                "metrics": {"clicks": "3"},
            }]))
        return _route_google(url, json=json, **kwargs)

    upserts = []
    monkeypatch.setattr("src.phase2_connectors._http_post", partial)
    monkeypatch.setattr(
        "src.db.upsert_rows",
        lambda t, rows, on_conflict=None: upserts.append((t, rows)) or len(rows),
    )
    google_ads_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    rows = next(r for t, r in upserts if t == "google_ads_daily")
    assert rows[0]["clicks"] == 3
    assert "spend" not in rows[0]
    assert "impressions" not in rows[0]
    assert "conversions" not in rows[0]
    assert "conversion_value" not in rows[0]


def test_google_ads_empty_day_is_success_zero_rows(monkeypatch):
    def empty(url, json=None, **kwargs):
        if "googleAds:searchStream" in url:
            return _Resp([])
        return _route_google(url, json=json, **kwargs)

    called = []
    monkeypatch.setattr("src.phase2_connectors._http_post", empty)
    monkeypatch.setattr(
        "src.db.upsert_rows",
        lambda *a, **k: called.append(1) or 0,
    )
    r = google_ads_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    assert r["ok"] is True
    assert r["rows"] == 0
    assert called == []


def test_google_ads_dry_run_documents_path_without_upsert(monkeypatch):
    monkeypatch.setattr("src.phase2_connectors._http_post", _route_google)

    def boom(*_a, **_k):
        raise AssertionError("dry-run must not upsert")

    monkeypatch.setattr("src.db.upsert_rows", boom)
    r = google_ads_sync(environ=_google_env(), as_of="2026-09-19", days=1,
                        dry_run=True)
    assert r["ok"] is True
    assert r["dry_run"] is True
    assert r["rows"] == 1
    assert "No upsert" in r["message"]
    assert "searchStream" in r["message"]
    assert "Never mutate" in r["message"]


def test_google_ads_skips_dates_outside_requested_window(monkeypatch):
    def weird(url, json=None, **kwargs):
        if "googleAds:searchStream" in url:
            return _Resp(_ads_stream([
                {
                    "campaign": {"id": "1", "name": "old"},
                    "segments": {"date": "2026-09-10"},
                    "metrics": {"costMicros": "9000000", "clicks": "9"},
                },
                {
                    "campaign": {"id": "2", "name": "locked"},
                    "segments": {"date": "2026-09-19"},
                    "metrics": {"costMicros": "1000000", "clicks": "1"},
                },
            ]))
        return _route_google(url, json=json, **kwargs)

    upserts = []
    monkeypatch.setattr("src.phase2_connectors._http_post", weird)
    monkeypatch.setattr(
        "src.db.upsert_rows",
        lambda t, rows, on_conflict=None: upserts.append(rows) or len(rows),
    )
    google_ads_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    rows = upserts[0]
    assert all(row["metric_date"] == "2026-09-19" for row in rows)
    assert not any(row["metric_date"] == "2026-09-10" for row in rows)
    assert rows[0]["campaign_name"] == "locked"


def test_google_ads_rejects_non_digit_customer_id(monkeypatch):
    monkeypatch.setattr(
        "src.phase2_connectors._http_post",
        lambda *a, **k: _Resp({"access_token": "tok"}),
    )
    r = google_ads_sync(
        environ=_google_env(GOOGLE_ADS_CUSTOMER_ID="not-an-id"),
        as_of="2026-09-19", days=1,
    )
    assert r["ok"] is False
    assert r["rows"] == 0
    assert "10-digit" in r["error"]


def test_google_ads_strips_dashes_and_omits_login_when_unset(monkeypatch):
    seen = []

    def capture(url, headers=None, json=None, **kwargs):
        seen.append((url, dict(headers or {})))
        return _route_google(url, json=json, headers=headers, **kwargs)

    monkeypatch.setattr("src.phase2_connectors._http_post", capture)
    monkeypatch.setattr("src.db.upsert_rows", lambda *a, **k: 1)
    env = _google_env(
        GOOGLE_ADS_CUSTOMER_ID="533-220-6723",
        GOOGLE_ADS_LOGIN_CUSTOMER_ID="",
    )
    r = google_ads_sync(environ=env, as_of="2026-09-19", days=1)
    assert r["ok"] is True
    assert r["customer_id"] == "5332206723"
    assert "login_customer_id" not in r
    ads = [u for u, _h in seen if "googleAds:searchStream" in u]
    assert ads and "/customers/5332206723/" in ads[0]
    ads_headers = [h for u, h in seen if "googleAds:searchStream" in u]
    assert "login-customer-id" not in ads_headers[0]


def test_google_ads_api_error_fails_closed_zero_rows(monkeypatch):
    def boom(url, json=None, **kwargs):
        if "googleAds:searchStream" in url:
            return _Resp(
                {"error": {"code": 403, "message": "developer token not approved",
                           "status": "PERMISSION_DENIED"}},
                status=403,
                text="denied",
            )
        return _route_google(url, json=json, **kwargs)

    called = []
    monkeypatch.setattr("src.phase2_connectors._http_post", boom)
    monkeypatch.setattr(
        "src.db.upsert_rows",
        lambda *a, **k: called.append(1) or 0,
    )
    r = google_ads_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    assert r["ok"] is False
    assert r["rows"] == 0
    assert "403" in r["error"]
    assert called == []


def test_google_ads_query_is_select_only():
    q = google_ads_campaign_query(date(2026, 9, 13), date(2026, 9, 19))
    assert q.startswith("SELECT ")
    assert "FROM campaign" in q
    assert "BETWEEN '2026-09-13' AND '2026-09-19'" in q
    assert "mutate" not in q.lower()
    assert "REMOVE" not in q
    assert "SET " not in q


def test_cli_ga4_gsc_and_ads_success_mocked(monkeypatch):
    monkeypatch.setattr("src.phase2_connectors._http_post", _route_google)
    monkeypatch.setattr("src.db.upsert_rows", lambda *a, **k: 1)
    for key, val in _google_env().items():
        monkeypatch.setenv(key, val)
    from src.main import cli

    runner = CliRunner()
    ga4 = runner.invoke(cli, ["ga4-sync", "--date", "2026-09-19", "--days", "1"])
    assert ga4.exit_code == 0, ga4.output
    assert "ga4_sessions_daily" in ga4.output
    gsc = runner.invoke(cli, ["gsc-sync", "--date", "2026-09-19", "--days", "1"])
    assert gsc.exit_code == 0, gsc.output
    assert "gsc_query_daily" in gsc.output
    ads = runner.invoke(cli, ["google-ads-sync", "--date", "2026-09-19", "--days", "1"])
    assert ads.exit_code == 0, ads.output
    assert "google_ads_daily" in ads.output
    assert "Never mutate" in ads.output


def test_cli_registered_and_read_only():
    src = Path("src/main.py").read_text()
    for cmd in ("ga4-sync", "google-ads-sync", "meta-ads-sync", "gsc-sync"):
        assert f'@cli.command("{cmd}")' in src
    assert "needs OAuth" in src
    assert "no wait-loop" in src
    assert "Never invent metrics" in src
    sched = src[src.find("def run():"):]
    assert "BlockingScheduler" in sched
    assert "shopify_funnel_sync" in sched  # Phase 1 stays scheduled
    # Live GA4/GSC/Ads only when Mini env is present. Meta stays unscheduled.
    assert "connector_env_ready" in sched
    assert "_run_ga4_sync" in sched
    assert "_run_gsc_sync" in sched
    assert "_run_google_ads_sync" in sched
    assert "ga4_sync" in sched
    assert "gsc_sync" in sched
    assert "google_ads_sync" in sched
    assert "meta-ads-sync" not in sched
    assert "_run_meta_ads" not in sched


def test_gsc_sync_hard_fail_uses_job_fail_not_all_good():
    src = Path("src/main.py").read_text()
    start = src.find("def _gsc_job_fail")
    end = src.find("def _run_google_ads_sync")
    block = src[start:end]
    assert 'topic="job_fail"' in block
    assert "_gsc_job_fail" in src[src.find("def _run_gsc_sync"):end]
    assert "all-good" in block
    docs = Path("docs/oauth-phase2.md").read_text()
    env = Path("dashboard/ENV.md").read_text()
    for text in (docs, env):
        assert "issue lists" in text
        assert "Ellis" in text
        assert "URL Inspection" in text


def test_live_connectors_have_no_wait_loop_or_mutate():
    src = Path("src/phase2_connectors.py").read_text()
    assert "time.sleep" not in src
    assert "while True" not in src
    assert "wait-loop" in src
    assert "Never invent" in src
    assert "mutate" not in src.lower() or "never mutate" in src.lower()
    # Official APIs only — no Ryze / CSV intel tables.
    assert "ryze" not in src.lower()
    assert "paid_ga_daily" not in src
    assert "sales_by_state" not in src
    assert "pnl_daily" not in src
    assert "analyticsdata.googleapis.com" in src
    assert "searchconsole.googleapis.com" in src
    assert "googleads.googleapis.com" in src
    assert "googleAds:searchStream" in src
    assert "never mutate" in src.lower()
    assert "googleAds:mutate" not in src
    assert "GOOGLE_ADS" in src


def test_scopes_are_read_minima():
    assert CONNECTORS["ga4"]["scopes"] == (
        "https://www.googleapis.com/auth/analytics.readonly",
    )
    assert CONNECTORS["gsc"]["scopes"] == (
        "https://www.googleapis.com/auth/webmasters.readonly",
    )
    assert CONNECTORS["meta_ads"]["scopes"] == ("ads_read",)
    assert "ads_management" not in CONNECTORS["meta_ads"]["scopes"]
    assert "read_insights" not in CONNECTORS["meta_ads"]["scopes"]


def test_click_exception_type():
    assert issubclass(click.ClickException, Exception)


def test_shopify_funnel_untouched_by_phase2():
    """#149 must keep working — Phase 2 is additive."""
    funnel = Path("src/shopify_funnel_sync.py").read_text()
    assert "ga4-sync" not in funnel
    assert "phase2_connectors" not in funnel
    assert "abandonedCheckouts" in funnel
    sql = Path("supabase/migration_conversion_phase2.sql").read_text()
    assert "create table if not exists shopify_funnel" not in sql.lower()
    assert "drop table" not in sql.lower()
    assert "alter table shopify_funnel" not in sql.lower()
    dims_sql = Path("supabase/migration_gsc_analysis_dims.sql").read_text()
    assert "create table if not exists gsc_dim_daily" in dims_sql
    assert "create table if not exists gsc_query_device_daily" in dims_sql
    assert "create table if not exists gsc_url_inspection" in dims_sql
    assert "drop table" not in dims_sql.lower()
    assert "gsc_query_daily" not in dims_sql or "alter table gsc_query_daily" not in dims_sql.lower()
    assert "search_appearance" in dims_sql
    assert "Ellis" in dims_sql


def test_side_tables_never_feed_nexus_or_pnl():
    for rel in ("src/pnl.py", "src/sales_daily.py", "src/channels.py"):
        text = Path(rel).read_text()
        for table in (
            "ga4_sessions_daily", "ga4_landing_daily", "google_ads_daily",
            "meta_ads_daily", "gsc_query_daily", "gsc_page_daily",
            "gsc_query_device_daily", "gsc_page_device_daily",
            "gsc_dim_daily", "gsc_url_inspection",
            "conversion_digest_status",
        ):
            assert table not in text, f"{rel} must not read {table}"


def test_docs_and_snapshot_list_the_tables():
    docs = Path("docs/oauth-phase2.md").read_text()
    assert "GA4 Data API" in docs
    assert "analytics.readonly" in docs
    assert "webmasters.readonly" in docs
    assert "ads_read" in docs
    assert "AI_GATEWAY_API_KEY" in docs
    assert "Never chat-paste" in docs or "never chat-paste" in docs
    assert "oauthplayground" in docs
    assert "bc-74a886b6" in docs
    assert "googleAds:searchStream" in docs
    assert "Never mutate" in docs or "never mutate" in docs
    assert "Do not add a second Jev job on Mini" in docs
    assert "ecommdashboard.com" in docs
    assert "Mini `.env`" in docs
    for rel in (
        "config/warehouse_snapshot_tables.json",
        "dashboard/config/warehouse_snapshot_tables.json",
    ):
        text = Path(rel).read_text()
        assert "ga4_sessions_daily" in text
        assert "conversion_digest_status" in text
        assert "gsc_dim_daily" in text
        assert "gsc_url_inspection" in text
        assert "gsc_query_device_daily" in text


def test_settings_loads_when_phase2_google_env_is_set(monkeypatch):
    """Mini .env GOOGLE_* must not forbid Settings() / get_client()."""
    from src.config import Settings

    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "id")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "secret")
    monkeypatch.setenv("GOOGLE_OAUTH_REFRESH_TOKEN", "refresh")
    monkeypatch.setenv("GA4_PROPERTY_ID", "411710093")
    monkeypatch.setenv("GSC_SITE_URL", "sc-domain:tallowbourn.com")
    monkeypatch.setenv("GOOGLE_ADS_DEVELOPER_TOKEN", "dev")
    monkeypatch.setenv("META_ADS_ACCESS_TOKEN", "token")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "service-role")
    # Undeclared Mini keys must not break required Supabase fields.
    monkeypatch.setenv("SOME_FUTURE_MINI_KEY", "ignore-me")

    loaded = Settings()
    assert loaded.google_oauth_client_id == "id"
    assert loaded.google_oauth_client_secret == "secret"
    assert loaded.google_oauth_refresh_token == "refresh"
    assert loaded.ga4_property_id == "411710093"
    assert loaded.gsc_site_url == "sc-domain:tallowbourn.com"
    assert loaded.supabase_url == "https://example.supabase.co"
    assert loaded.supabase_service_key == "service-role"
