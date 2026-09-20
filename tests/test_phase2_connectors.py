"""Phase 2 official-API connectors — fail closed, no invented metrics, no wait-loops."""
from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import click
from click.testing import CliRunner

from src.phase2_connectors import (
    CONNECTORS,
    NEEDS_OAUTH,
    ga4_sync,
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
    }
    env.update(extra)
    return env


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
        return _Resp({})
    raise AssertionError(f"unexpected URL {url}")


def test_missing_oauth_lists_required_vercel_names(monkeypatch):
    _clear(monkeypatch)
    missing = missing_oauth_env("ga4")
    assert "GOOGLE_OAUTH_CLIENT_ID" in missing
    assert "GA4_PROPERTY_ID" in missing
    assert "GOOGLE_ADS_DEVELOPER_TOKEN" not in missing


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


def test_ads_meta_credentials_present_still_write_zero_rows():
    env = {
        "GOOGLE_OAUTH_CLIENT_ID": "id",
        "GOOGLE_OAUTH_CLIENT_SECRET": "secret",
        "GOOGLE_OAUTH_REFRESH_TOKEN": "refresh",
        "GOOGLE_ADS_DEVELOPER_TOKEN": "dev",
        "GOOGLE_ADS_CUSTOMER_ID": "123",
        "META_APP_ID": "app",
        "META_APP_SECRET": "secret",
        "META_ADS_ACCESS_TOKEN": "token",
        "META_ADS_ACCOUNT_ID": "act_1",
    }
    for name in ("google_ads", "meta_ads"):
        r = sync_stub(name, environ=env)
        assert r["needs_oauth"] is False
        assert r["rows"] == 0
        assert r["scaffold"] is True
        assert "Never invent metrics" in r["message"]


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
    assert r["rows"] == 2
    assert r["start_date"] == "2026-09-19"
    tables = {t for t, _, _ in upserts}
    assert tables == {"gsc_query_daily", "gsc_page_daily"}

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


def test_gsc_empty_final_day_is_success_zero_rows(monkeypatch):
    def empty(url, json=None, **kwargs):
        if "searchAnalytics/query" in url:
            return _Resp({})
        return _route_google(url, json=json, **kwargs)

    called = []
    monkeypatch.setattr("src.phase2_connectors._http_post", empty)
    monkeypatch.setattr(
        "src.db.upsert_rows",
        lambda *a, **k: called.append(1) or 0,
    )
    r = gsc_sync(environ=_google_env(), as_of="2026-09-19", days=1)
    assert r["ok"] is True
    assert r["rows"] == 0
    assert called == []  # nothing to upsert; do not invent a query


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


def test_cli_commands_fail_closed_without_oauth(monkeypatch):
    _clear(monkeypatch)
    from src.main import cli

    runner = CliRunner()
    for cmd in ("ga4-sync", "google-ads-sync", "meta-ads-sync", "gsc-sync"):
        result = runner.invoke(cli, [cmd])
        assert result.exit_code != 0, cmd
        assert "needs OAuth" in result.output, result.output
        assert "0 rows" in result.output or "Wrote 0" in result.output


def test_cli_ga4_and_gsc_success_mocked(monkeypatch):
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
    # Live GA4/GSC only when Mini env is present. Ads/Meta stay unscheduled.
    assert "connector_env_ready" in sched
    assert "_run_ga4_sync" in sched
    assert "_run_gsc_sync" in sched
    assert "ga4_sync" in sched
    assert "gsc_sync" in sched
    assert "google-ads-sync" not in sched
    assert "meta-ads-sync" not in sched
    assert "_run_google_ads" not in sched
    assert "_run_meta_ads" not in sched


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
    assert "google-ads" not in src or "GOOGLE_ADS" in src


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


def test_side_tables_never_feed_nexus_or_pnl():
    for rel in ("src/pnl.py", "src/sales_daily.py", "src/channels.py"):
        text = Path(rel).read_text()
        for table in (
            "ga4_sessions_daily", "ga4_landing_daily", "google_ads_daily",
            "meta_ads_daily", "gsc_query_daily", "gsc_page_daily",
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
