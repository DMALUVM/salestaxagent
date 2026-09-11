"""GNO PPC Watch — observe-only rails and scheduler pin."""
from __future__ import annotations

import inspect
import json
from pathlib import Path

from src.rules import (
    GNO_AUTO_LOOSE_BUDGET,
    GNO_DAY5_PAUSE,
    GNO_DEO_BE_ACOS,
    GNO_FLAVOR_SHELL,
    GNO_FORBIDDEN_AUTO_ACTIONS,
    GNO_KEEP_ALIVE,
    GNO_LAUNCHED_AT,
    GNO_BALM_BE_ACOS,
    GNO_LIP_BE_ACOS,
    GNO_NEW_EXACT,
    GNO_NEXT_REVIEW_AT,
    GNO_OBSERVE_ONLY,
)


ROOT = Path(__file__).resolve().parent.parent


def test_gno_spec_pins_dave_watchlists():
    assert GNO_OBSERVE_ONLY is True
    assert len(GNO_KEEP_ALIVE) == 11
    assert len(GNO_NEW_EXACT) == 10
    assert len(GNO_DAY5_PAUSE) == 13
    assert len(GNO_FLAVOR_SHELL) == 24
    assert any("Orange Lip Balm - SP -" in n for n in GNO_FLAVOR_SHELL)
    assert GNO_LIP_BE_ACOS == 42
    assert GNO_DEO_BE_ACOS == 36
    assert GNO_BALM_BE_ACOS == 36
    assert GNO_AUTO_LOOSE_BUDGET == 303
    assert "SP | TBL | B0CLHVCPL5 | EX | tallow lip balm | TOS" in GNO_NEW_EXACT
    assert "SP | DEO | B0CLHYY3BB | EX | tallow deodorant for men | TOS" in GNO_NEW_EXACT
    assert "SP | TBM | B0CLF5B27Y | EX | tallow balm | TOS" in GNO_NEW_EXACT
    assert "SP | TBM | B0CLF5B27Y | EX | beef tallow balm | TOS" in GNO_NEW_EXACT
    assert not any("TBM" in n and "deodorant" in n.lower() for n in GNO_NEW_EXACT)
    assert any("Loose Match-TOS" in n for n in GNO_KEEP_ALIVE)
    assert GNO_FORBIDDEN_AUTO_ACTIONS == frozenset(
        {"pause", "negate", "raise_budget", "raise_bid"})
    assert GNO_LAUNCHED_AT == "2026-09-07T12:00:00-04:00"
    assert GNO_NEXT_REVIEW_AT == "2026-09-09T18:00:00-07:00"


def test_dashboard_json_matches_repo_config():
    repo = (ROOT / "config" / "gno_ppc_watch.json").read_text()
    dash = (ROOT / "dashboard" / "config" / "gno_ppc_watch.json").read_text()
    assert repo == dash
    spec = json.loads(repo)
    assert spec["observe_only"] is True
    assert spec["aliases"]["broad_m"] == "GG - Lip Balm - Broad M"
    assert len(spec["flavor_shell"]) == 24
    assert spec["new_exact"][-3] == "SP | DEO | B0CLHYY3BB | EX | tallow deodorant for men | TOS"
    assert not any("TBM" in n and "deodorant" in n.lower() for n in spec["new_exact"])


def test_gno_campaign_job_is_observe_only_campaigns_api():
    from src.main import _run_ads_gno_campaigns_sync
    src = inspect.getsource(_run_ads_gno_campaigns_sync)
    assert "snapshot_gno_meta" in src
    assert "campaigns_api" in src
    assert "days=3" not in src
    assert "campaigns_only=True" not in src
    assert "_run_ads_sync_job" not in src
    assert "_run_ads_search_terms_sync" not in src
    assert "_run_ads_placements_sync" not in src
    assert "poll_report" not in src
    assert "fetch_report" not in src
    assert "Observe only" in src
    assert "425" in src


def test_gno_job_is_scheduled_every_4h_not_at_0500():
    from src import main as main_mod
    src = inspect.getsource(main_mod)
    assert 'id="ads_gno_campaigns_sync"' in src
    assert 'hour="1,9,13,17,21"' in src
    assert "_run_ads_gno_campaigns_sync" in src
    block = src[src.index("ads_gno_campaigns_sync") : src.index("ads_gno_campaigns_sync") + 800]
    assert "hour=5" not in block


def test_gno_job_on_pull_lease_and_last_sync_list():
    from src.amazon_ads.sync_lock import ADS_PULL_JOBS
    from src.amazon_ads.export_brief import ADS_JOBS
    assert "ads_gno_campaigns_sync" in ADS_PULL_JOBS
    assert "ads_gno_campaigns_sync" in ADS_JOBS


def test_gno_dashboard_never_auto_writes_amazon():
    files = [
        ROOT / "dashboard" / "src" / "components" / "ppc-gno-watch.tsx",
        ROOT / "dashboard" / "src" / "lib" / "gno-ppc-watch.ts",
        ROOT / "dashboard" / "src" / "lib" / "gno-export-state.ts",
        ROOT / "dashboard" / "src" / "lib" / "gno-learning.ts",
        ROOT / "dashboard" / "src" / "app" / "api" / "ppc" / "gno" / "route.ts",
        ROOT / "dashboard" / "src" / "app" / "api" / "ppc" / "gno-export" / "route.ts",
        ROOT / "dashboard" / "src" / "app" / "api" / "ppc" / "gno-outcome" / "route.ts",
        ROOT / "dashboard" / "src" / "app" / "api" / "ppc" / "gno-ack" / "route.ts",
    ]
    for path in files:
        src = path.read_text()
        assert "observe" in src.lower()
        assert "amazonads" not in src.lower()
        assert "autoPause(" not in src
        assert "auto_pause = true" not in src.lower()
    ui = files[0].read_text()
    lib = files[1].read_text()
    assert "Mark Done" in ui
    assert 'alert("P0", "KEEPER_MISSING"' not in lib
    assert "not a P0" in lib
    assert "metrics_complete" in lib
    assert "break_even_acos" in lib
    assert "acos_vs_be" in lib
    assert "breakEvenAcosOf(term.campaign_name" in lib
    assert "acos <= LIP_BE_ACOS" not in lib
    assert "packClosedEnd" in lib
    assert "Never `today`" in lib
    assert "hoursSinceCampaignLaunch" in lib
    assert "When to Export GNO pack" in ui
    assert "EXPORT NEEDED" in ui
    assert "Log Grok outcome" in ui
    assert "Family BE ACOS" in ui
    assert "acosWithBe" in ui
    assert "FLAVOR_SHELL" in lib
    assert "broad_m_search_terms.csv" in lib
    assert "advertised_product_l7.csv" in lib
    assert "placement report lag" in lib
    assert "isBroadM" in lib
    assert 'n.includes("lip")' in lib
    assert "keywordWindowMetrics" in lib
    assert "search_term === kw" not in lib.replace("normalizeTerm(t.search_term) === kw", "")
    assert "normalizeTerm(t.search_term) === kw" not in lib
    assert "TBM_FORBIDDEN_DEO_RE" in lib
    assert "stale_pre_raise" in lib
    assert "auto_st_l2" not in lib.lower()
    assert "SP | TBM | B0CLF5B27Y | EX | tallow deodorant for men" not in lib


def test_keeper_missing_from_short_spend_lookback_is_not_p0():
    lib = (ROOT / "dashboard" / "src" / "lib" / "gno-ppc-watch.ts").read_text()
    assert "SHORT_SPEND_LOOKBACK_DAYS" in lib
    assert "keeperMissingPriority" in lib
    assert "snapshot_gno_meta" in (ROOT / "src" / "main.py").read_text()


def test_gno_json_pins_export_and_learning_knobs():
    spec = json.loads((ROOT / "config" / "gno_ppc_watch.json").read_text())
    assert spec["export_review_lead_hours"] == 6
    assert spec["digest_window_et"] == {"start": "06:30", "end": "08:00"}
    assert spec["learning_harvest_skip_threshold"] == 2
    assert spec["observe_only"] is True
    assert spec["launched_at"] == "2026-09-07T12:00:00-04:00"
    assert spec["next_human_review_at"] == "2026-09-09T18:00:00-07:00"
