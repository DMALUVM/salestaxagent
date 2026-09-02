"""FBA inventory ledger health.

This feed decides physical nexus, and therefore which states get registered.
Both of its failure modes are silent — a sync that stopped, and an FC code with
no state mapping — so these tests lock the detection, not just the happy path.
"""
from datetime import datetime, timedelta, timezone

import pytest

from src.inventory.ledger_health import (
    CRITICAL_AFTER_HOURS, STALE_AFTER_HOURS, build_health, hours_since,
    last_successful_sync, staleness_line,
)

NOW = datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc)


def job(name="spapi_refresh", status="success", hours_ago=2.0):
    ts = (NOW - timedelta(hours=hours_ago)).isoformat()
    return {"job_name": name, "status": status, "started_at": ts}


def ev(date_str, fc="ABE2", state="PA", source="spapi_inventory_ledger"):
    return {"event_date": date_str, "fc_code": fc, "state_code": state,
            "source_file": source}


class TestFreshness:
    def test_recent_success_is_ok(self):
        h = build_health([], [job(hours_ago=10)], NOW)
        assert h.status == "ok"
        assert not h.is_stale
        assert staleness_line(h) is None

    def test_beyond_the_stale_threshold(self):
        h = build_health([], [job(hours_ago=STALE_AFTER_HOURS + 1)], NOW)
        assert h.status == "stale"
        assert "stale" in staleness_line(h)

    def test_beyond_the_critical_threshold(self):
        h = build_health([], [job(hours_ago=CRITICAL_AFTER_HOURS + 1)], NOW)
        assert h.status == "critical"
        assert "🚨" in staleness_line(h)

    def test_no_run_on_record_is_treated_as_stale(self):
        """Never syncing is not 'fine' — it is the worst case, not the best."""
        h = build_health([], [], NOW)
        assert h.is_stale and h.is_critical
        assert "no successful sync" in staleness_line(h)

    def test_a_failed_run_does_not_count_as_fresh(self):
        h = build_health([], [job(status="fail", hours_ago=1)], NOW)
        assert h.is_stale

    def test_partial_counts_as_fresh(self):
        """Orders and inventory share one job; a partial still wrote inventory."""
        h = build_health([], [job(status="partial", hours_ago=1)], NOW)
        assert h.status == "ok"

    def test_other_jobs_are_ignored(self):
        h = build_health([], [job(name="ads_sync", hours_ago=1)], NOW)
        assert h.is_stale

    def test_latest_success_wins(self):
        rows = [job(hours_ago=100), job(hours_ago=3), job(hours_ago=50)]
        assert last_successful_sync(rows)["started_at"].startswith("2026-08-20T09")

    def test_naive_timestamps_are_treated_as_utc(self):
        assert hours_since("2026-08-20T10:00:00", NOW) == pytest.approx(2.0)

    def test_malformed_timestamp_does_not_raise(self):
        assert hours_since("not-a-date", NOW) is None


class TestCoverage:
    def test_counts_states_and_dates(self):
        events = [ev("2024-01-01", "ABE2", "PA"), ev("2026-08-19", "ONT8", "CA")]
        h = build_health(events, [job()], NOW)
        assert h.date_min == "2024-01-01"
        assert h.date_max == "2026-08-19"
        assert h.distinct_states == 2
        assert h.events_by_year == {"2024": 1, "2026": 1}

    def test_unmapped_fc_codes_are_surfaced_with_ranges(self):
        """These carry no state and are invisible to the nexus engine."""
        events = [
            ev("2025-08-10", "STW1", None),
            ev("2026-08-18", "STW1", None),
            ev("2026-01-01", "SNL1", None),
            ev("2026-01-02", "ABE2", "PA"),
        ]
        h = build_health(events, [job()], NOW)
        assert h.unknown_event_count == 3
        top = h.unknown_fcs[0]
        assert top.fc_code == "STW1" and top.events == 2
        assert top.first_seen == "2025-08-10" and top.last_seen == "2026-08-18"

    def test_unknown_codes_are_ordered_by_volume(self):
        events = [ev("2026-01-01", "AAA1", None)] + [
            ev("2026-01-01", "BBB2", None) for _ in range(5)]
        h = build_health(events, [job()], NOW)
        assert [u.fc_code for u in h.unknown_fcs] == ["BBB2", "AAA1"]

    def test_an_unmapped_code_does_not_inflate_the_state_count(self):
        h = build_health([ev("2026-01-01", "STW1", None)], [job()], NOW)
        assert h.distinct_states == 0
        assert h.states == []

    def test_sources_are_tallied(self):
        events = [ev("2026-01-01", source="spapi_inventory_ledger"),
                  ev("2026-01-02", source="legacy.csv")]
        h = build_health(events, [job()], NOW)
        assert h.sources["spapi_inventory_ledger"] == 1

    def test_empty_ledger_does_not_raise(self):
        h = build_health([], [job()], NOW)
        assert h.total_events == 0 and h.date_max is None


class TestHistoryIsNeverTruncated:
    """The sync window must never remove events older than the window.

    Physical nexus reads inventory back to 2024. The ledger fetch writes with
    an UPSERT on a natural key and issues no DELETE — this pins that, because a
    switch to delete-then-insert would silently erase the evidence the
    registration decisions are built on.
    """

    def test_fetch_inventory_upserts_and_never_deletes(self, monkeypatch):
        from datetime import date

        import src.amazon_sp.reports as reports

        calls = {"upsert": 0, "delete": 0, "on_conflict": None}

        class FakeTable:
            def delete(self, *a, **k):
                calls["delete"] += 1
                return self

            def execute(self, *a, **k):
                return type("R", (), {"data": []})()

        def fake_upsert(table, rows, on_conflict=None):
            calls["upsert"] += 1
            calls["on_conflict"] = on_conflict
            return len(rows)

        monkeypatch.setattr(reports, "request_and_download", lambda *a, **k: "")
        monkeypatch.setattr(reports, "parse_inventory_ledger", lambda c: {
            "rows_total": 1, "rows_parsed": 1, "rows_skipped": 0,
            "states_found": {"PA"}, "unknown_fcs": set(), "warnings": [],
            "events": [type("E", (), {"model_dump": lambda self: {
                "source_file": "spapi_inventory_ledger", "event_date": "2026-08-19",
                "fc_code": "ABE2", "asin": "B0", "event_type": "Receipts",
                "quantity": 1, "state_code": "PA"}})()],
        })
        monkeypatch.setattr(reports, "upsert_rows", fake_upsert)
        monkeypatch.setattr(reports, "log_ingestion", lambda **k: None)
        monkeypatch.setattr(reports, "log_audit", lambda **k: None)

        reports.fetch_inventory(date(2026, 8, 5), date(2026, 8, 19))

        assert calls["upsert"] == 1
        assert calls["delete"] == 0, "the ledger sync must never delete events"
        # The natural key: re-pulling a window corrects rows in place.
        assert calls["on_conflict"] == (
            "source_file,event_date,fc_code,asin,event_type,quantity")

    def test_configured_windows_are_sane(self):
        from src.rules import (
            SPAPI_INVENTORY_BACKFILL_DAYS, SPAPI_INVENTORY_LEDGER_DAYS,
        )
        assert SPAPI_INVENTORY_LEDGER_DAYS >= 14
        assert SPAPI_INVENTORY_BACKFILL_DAYS > SPAPI_INVENTORY_LEDGER_DAYS


class TestFCMappings:
    """Codes resolved in the 2026-08-20 mapping pass.

    Each was verified against a published facility street address, with the ZIP
    cross-checked against the state. They are pinned here so a future edit to
    fc_codes.json cannot silently drop or change one — a wrong FC->state mapping
    fabricates nexus evidence for a registration decision.
    """

    # code -> (state, city used as evidence)
    MAPPED = {
        "STW1": ("MI", "Wixom"),
        "SNL1": ("TN", "Nashville"),
        "SSP2": ("MN", "Golden Valley"),
        "SYS3": ("TN", "Maryville"),
        "RMN3": ("VA", "Fredericksburg"),
        "SRO1": ("NY", "Pembroke"),
        "SRH2": ("MA", "Wilmington"),
        "SSY1": ("LA", "Elmwood"),
        "MIT2": ("CA", "Shafter"),
        "XCH2": ("GA", "Garden City"),
        "XMD5": ("PA", "Greencastle"),
        "SBW1": ("MD", "Baltimore"),
        # 2026-09-02 — operator-verified street addresses (not inferred from letters)
        "BDU2": ("CO", "Commerce City"),
        "IGA3": ("GA", "Macon"),
        "ILM1": ("NC", "Rocky Point"),
        "IMO1": ("MO", "Kansas City"),
        "ITX3": ("TX", "Amarillo"),
        "IWA6": ("WA", "Pasco"),
    }

    @pytest.mark.parametrize("code", sorted(MAPPED))
    def test_code_resolves(self, code):
        from src.mappers.fc_to_state import fc_to_state
        assert fc_to_state(code) == self.MAPPED[code][0]

    def test_letters_in_the_code_are_not_the_state(self):
        """XMD5 is in Pennsylvania and XCH2 is in Georgia.

        Both would be mis-mapped by inferring a state from the code's letters,
        which is why pattern inference is not used for these.
        """
        from src.mappers.fc_to_state import fc_to_state
        assert fc_to_state("XMD5") == "PA"   # not MD
        assert fc_to_state("XCH2") == "GA"   # not IL/Chicago
        assert fc_to_state("IWA6") == "WA"   # Pasco WA, not Iowa
        assert fc_to_state("ILM1") == "NC"   # Rocky Point NC (ILM airport), not Illinois

    def test_abe_family_is_split_by_actual_address(self):
        """ABE2/3/4 are Pennsylvania; only ABE8 is New Jersey.

        The whole family had been mapped NJ, misattributing 365 Pennsylvania
        events. ABE8 (Florence NJ) is the genuine exception that caused it.
        """
        from src.mappers.fc_to_state import fc_to_state
        assert fc_to_state("ABE2") == "PA"
        assert fc_to_state("ABE3") == "PA"
        assert fc_to_state("ABE4") == "PA"
        assert fc_to_state("ABE8") == "NJ"

    def test_unresolved_codes_stay_unmapped(self):
        """Prefer omit over wrong: no published address was found for these."""
        from src.mappers.fc_to_state import fc_to_state
        for code in ("XSB3", "XIN5", "XPH6", "QBE1"):
            assert fc_to_state(code) is None, f"{code} was mapped without evidence"

    def test_python_map_and_ts_mirror_agree(self):
        """The dashboard parser has its own copy; drift would split the data."""
        import json
        from pathlib import Path

        root = Path(__file__).resolve().parents[1]
        py = json.loads((root / "config" / "fc_codes.json").read_text())["fc_codes"]
        raw = json.loads(
            (root / "dashboard" / "src" / "lib" / "parsers" / "fc-codes-data.json").read_text())
        ts = raw.get("fc_codes", raw)
        assert py == ts, "config/fc_codes.json and the TS mirror disagree"

    def test_live_ts_hardcoded_map_has_the_2026_09_02_codes(self):
        """fc-codes.ts is still the live dashboard parser; keep it in lockstep."""
        from pathlib import Path

        src = (Path(__file__).resolve().parents[1]
               / "dashboard" / "src" / "lib" / "parsers" / "fc-codes.ts").read_text()
        for code, (state, _city) in self.MAPPED.items():
            if code in ("BDU2", "IGA3", "ILM1", "IMO1", "ITX3", "IWA6"):
                assert f'{code}: "{state}"' in src, f"{code} missing from live TS map"

    def test_awd_is_not_a_state(self):
        from src.mappers.fc_to_state import fc_to_state
        assert fc_to_state("AWD") is None
