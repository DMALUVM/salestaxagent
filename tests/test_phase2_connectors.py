"""Phase 2 official-API stubs — fail closed, no invented metrics, no wait-loops."""
from __future__ import annotations

from pathlib import Path

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
    sync_stub,
)


def _clear(monkeypatch):
    for spec in CONNECTORS.values():
        for key in spec["env"]:
            monkeypatch.delenv(key, raising=False)
        for key in spec.get("optional_env") or ():
            monkeypatch.delenv(key, raising=False)


def test_missing_oauth_lists_required_vercel_names(monkeypatch):
    _clear(monkeypatch)
    missing = missing_oauth_env("ga4")
    assert "GOOGLE_OAUTH_CLIENT_ID" in missing
    assert "GA4_PROPERTY_ID" in missing
    assert "GOOGLE_ADS_DEVELOPER_TOKEN" not in missing


def test_each_stub_needs_oauth_and_writes_zero(monkeypatch):
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


def test_credentials_present_still_write_zero_rows():
    env = {
        "GOOGLE_OAUTH_CLIENT_ID": "id",
        "GOOGLE_OAUTH_CLIENT_SECRET": "secret",
        "GOOGLE_OAUTH_REFRESH_TOKEN": "refresh",
        "GA4_PROPERTY_ID": "properties/1",
        "GOOGLE_ADS_DEVELOPER_TOKEN": "dev",
        "GOOGLE_ADS_CUSTOMER_ID": "123",
        "GSC_SITE_URL": "sc-domain:tallowbourn.com",
        "META_APP_ID": "app",
        "META_APP_SECRET": "secret",
        "META_ADS_ACCESS_TOKEN": "token",
        "META_ADS_ACCOUNT_ID": "act_1",
    }
    for name in CONNECTORS:
        r = sync_stub(name, environ=env)
        assert r["needs_oauth"] is False
        assert r["rows"] == 0
        assert r["scaffold"] is True
        assert "Never invent metrics" in r["message"]


def test_cli_commands_fail_closed_without_oauth(monkeypatch):
    _clear(monkeypatch)
    from src.main import cli

    runner = CliRunner()
    for cmd in ("ga4-sync", "google-ads-sync", "meta-ads-sync", "gsc-sync"):
        result = runner.invoke(cli, [cmd])
        assert result.exit_code != 0, cmd
        assert "needs OAuth" in result.output, result.output
        assert "0 rows" in result.output or "Wrote 0" in result.output


def test_cli_registered_and_read_only():
    src = Path("src/main.py").read_text()
    for cmd in ("ga4-sync", "google-ads-sync", "meta-ads-sync", "gsc-sync"):
        assert f'@cli.command("{cmd}")' in src
    assert "needs OAuth" in src
    assert "no wait-loop" in src
    assert "Never invent metrics" in src
    # Do not schedule Phase 2 until OAuth exists — would fail Mini every morning.
    sched = src[src.find("def run():"):]
    assert "BlockingScheduler" in sched
    assert "shopify_funnel_sync" in sched  # Phase 1 stays scheduled
    assert "ga4-sync" not in sched
    assert "google-ads-sync" not in sched
    assert "meta-ads-sync" not in sched
    assert "gsc-sync" not in sched
    assert "phase2_connectors" not in sched
    assert "_run_ga4" not in sched


def test_stubs_have_no_wait_loop_or_mutate():
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
    for rel in (
        "config/warehouse_snapshot_tables.json",
        "dashboard/config/warehouse_snapshot_tables.json",
    ):
        text = Path(rel).read_text()
        assert "ga4_sessions_daily" in text
        assert "conversion_digest_status" in text
