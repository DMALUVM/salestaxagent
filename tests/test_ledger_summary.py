"""GET_LEDGER_SUMMARY_VIEW_DATA — tax inventory $ at COGS.

Pins parser, FC→state (including the 2026-08-30 CA set and the 2026-09-02
street-address mappings), missing-cost exclusion, peak-YTD (not latest-only),
and that we never substitute the detail ledger report.
"""
from datetime import date
from pathlib import Path

import pytest

from src.amazon_sp.ledger_summary import (
    CONFLICT_KEY,
    LEDGER_SUMMARY_OPTIONS,
    LEDGER_SUMMARY_REPORT,
    fetch_ledger_summary,
    parse_ledger_summary,
    peak_by_state,
    summarize_state_day,
)
from src.mappers.fc_to_state import fc_to_state

# Verified 2026-08-30 Mac mini pull (reportId 261418020696).
CA_FCS_2026_08_30 = [
    "BFL1", "BFL2", "FAT1", "LAX9", "LGB3", "LGB7", "OAK4", "ONT2",
    "ONT6", "ONT8", "OXR1", "PSP1", "PSP3", "SAN3", "SAX1", "SAX2",
    "SAX6", "SAX7", "SBD6", "SCA4", "SCA7", "SCA9", "SCK6", "SMF1",
]
# Verified 2026-09-02 from operator street addresses (not inferred from letters).
MAPPED_2026_09_02 = {
    "BDU2": "CO",  # 8350 Quintero St, Commerce City, CO 80022
    "IGA3": "GA",  # 7001 Skipper Rd, Macon, GA 31216
    "ILM1": "NC",  # 163 US-421 N, Rocky Point, NC 28435
    "IMO1": "MO",  # 4001 E 149th St, Kansas City, MO 64147
    "ITX3": "TX",  # 8590 NE 24th Ave, Amarillo, TX 79108
    "IWA6": "WA",  # 1202 S Road 40 E, Pasco, WA 99301
}
# 2026-09-04 — directory / street address / seller-forum (not inferred from letters).
MAPPED_2026_09_04 = {
    "XIN5": "IN",  # Avon, IN — ShipmentBot directory
    "XSB3": "CA",  # 8140 Caliente Rd, Hesperia, CA 92344
    "XPH6": "AZ",  # Phoenix, AZ 85043 — seller-forum / PHX metro
    "QBE1": "MI",  # 4880 Haggerty Road, Belleville, MI 48111
}
STILL_UNMAPPED: list[str] = []
PREFIX_MAPPED_CA = ["LGB7", "SBD6", "SCA9", "SCK6"]

HEADERS = (
    "Date\tFNSKU\tASIN\tMSKU\tTitle\tDisposition\t"
    "Starting Warehouse Balance\tEnding Warehouse Balance\tLocation"
)


def _tsv(rows: list[str]) -> str:
    return HEADERS + "\n" + "\n".join(rows) + "\n"


def _row(day, sku, qty, fc, disposition="SELLABLE"):
    return f"{day}\tX\tB0\t{sku}\tTitle\t{disposition}\t0\t{qty}\t{fc}"


class TestReportContract:
    def test_uses_summary_view_not_detail(self):
        assert LEDGER_SUMMARY_REPORT == "GET_LEDGER_SUMMARY_VIEW_DATA"
        assert "DETAIL" not in LEDGER_SUMMARY_REPORT

    def test_daily_fc_options(self):
        assert LEDGER_SUMMARY_OPTIONS == {
            "aggregatedByTimePeriod": "DAILY",
            "aggregateByLocation": "FC",
        }

    def test_upsert_key_allows_daily_grain(self):
        assert CONFLICT_KEY == "snapshot_date,sku,fc_code,disposition"


class TestFCMapping:
    def test_verified_ca_fcs_map_to_ca(self):
        for fc in CA_FCS_2026_08_30:
            assert fc_to_state(fc) == "CA", f"{fc} should be CA"

    def test_verified_2026_09_02_street_addresses(self):
        for fc, state in MAPPED_2026_09_02.items():
            assert fc_to_state(fc) == state, f"{fc} should be {state}"

    def test_verified_2026_09_04_fc_mappings(self):
        for fc, state in MAPPED_2026_09_04.items():
            assert fc_to_state(fc) == state, f"{fc} should be {state}"

    def test_still_unmapped_stay_unknown(self):
        for fc in STILL_UNMAPPED:
            assert fc_to_state(fc) is None, f"{fc} must not be invented"
        assert STILL_UNMAPPED == []

    def test_prefix_mapped_ca(self):
        for fc in PREFIX_MAPPED_CA:
            assert fc_to_state(fc) == "CA"

    def test_tulsa_amazon_fcs_are_ok_fba(self):
        assert fc_to_state("TUL1") == "OK"
        assert fc_to_state("TUL2") == "OK"


class TestParser:
    def test_ending_balance_times_cogs(self):
        content = _tsv([
            _row("2026-08-30", "SKU-A", 10, "ONT8"),
            _row("2026-08-30", "SKU-B", 4, "SMF1"),
        ])
        parsed = parse_ledger_summary(content, costs={"SKU-A": 2.5, "SKU-B": 3.0})
        ca = summarize_state_day(parsed["rows"], "2026-08-30", "CA")
        assert ca["cogs_value"] == 37.0
        assert ca["units"] == 14
        assert ca["fc_count"] == 2

    def test_unmapped_fc_is_not_ca(self):
        content = _tsv([
            _row("2026-08-30", "SKU-A", 10, "ONT8"),
            _row("2026-08-30", "SKU-A", 5, "ZZZ9"),
        ])
        parsed = parse_ledger_summary(content, costs={"SKU-A": 1.0})
        ca = summarize_state_day(parsed["rows"], "2026-08-30", "CA")
        unknown = summarize_state_day(parsed["rows"], "2026-08-30", "XX")
        assert ca["cogs_value"] == 10.0
        assert unknown["cogs_value"] == 5.0
        assert "ZZZ9" in parsed["unknown_fcs"]
        assert any(r["state_code"] is None and r["fc_code"] == "ZZZ9" for r in parsed["rows"])

    def test_qbe1_now_maps_to_mi_not_unknown(self):
        content = _tsv([
            _row("2026-08-30", "SKU-A", 10, "ONT8"),
            _row("2026-08-30", "SKU-A", 5, "QBE1"),
        ])
        parsed = parse_ledger_summary(content, costs={"SKU-A": 1.0})
        ca = summarize_state_day(parsed["rows"], "2026-08-30", "CA")
        mi = summarize_state_day(parsed["rows"], "2026-08-30", "MI")
        assert ca["cogs_value"] == 10.0
        assert mi["cogs_value"] == 5.0
        assert "QBE1" not in parsed["unknown_fcs"]
        assert any(r["state_code"] == "MI" and r["fc_code"] == "QBE1" for r in parsed["rows"])

    def test_xsb3_now_maps_to_ca_not_unknown(self):
        content = _tsv([
            _row("2026-08-30", "SKU-A", 10, "ONT8"),
            _row("2026-08-30", "SKU-A", 5, "XSB3"),
        ])
        parsed = parse_ledger_summary(content, costs={"SKU-A": 1.0})
        ca = summarize_state_day(parsed["rows"], "2026-08-30", "CA")
        assert ca["cogs_value"] == 15.0
        assert "XSB3" not in parsed["unknown_fcs"]
        assert any(r["state_code"] == "CA" and r["fc_code"] == "XSB3" for r in parsed["rows"])

    def test_bdu2_now_maps_to_co_not_unknown(self):
        content = _tsv([
            _row("2026-08-30", "SKU-A", 10, "ONT8"),
            _row("2026-08-30", "SKU-A", 5, "BDU2"),
        ])
        parsed = parse_ledger_summary(content, costs={"SKU-A": 1.0})
        ca = summarize_state_day(parsed["rows"], "2026-08-30", "CA")
        co = summarize_state_day(parsed["rows"], "2026-08-30", "CO")
        assert ca["cogs_value"] == 10.0
        assert co["cogs_value"] == 5.0
        assert "BDU2" not in parsed["unknown_fcs"]
        assert any(r["state_code"] == "CO" and r["fc_code"] == "BDU2" for r in parsed["rows"])

    def test_missing_cost_excluded_from_dollars(self):
        content = _tsv([
            _row("2026-08-30", "HAS-COST", 10, "ONT8"),
            _row("2026-08-30", "NO-COST", 7, "SMF1"),
        ])
        parsed = parse_ledger_summary(content, costs={"HAS-COST": 2.0})
        ca = summarize_state_day(parsed["rows"], "2026-08-30", "CA")
        assert ca["cogs_value"] == 20.0
        assert ca["units"] == 17
        assert "NO-COST" in parsed["missing_cost_skus"]
        assert parsed["missing_cost_units"] == 7
        no_cost = next(r for r in parsed["rows"] if r["sku"] == "NO-COST")
        assert no_cost["cogs_per_unit"] is None
        assert no_cost["cogs_value"] == 0.0

    def test_all_dispositions_still_in_warehouse(self):
        content = _tsv([
            _row("2026-08-30", "SKU-A", 3, "ONT8", "SELLABLE"),
            _row("2026-08-30", "SKU-A", 2, "ONT8", "CUSTOMER_DAMAGED"),
        ])
        parsed = parse_ledger_summary(content, costs={"SKU-A": 5.0})
        assert len(parsed["rows"]) == 2
        ca = summarize_state_day(parsed["rows"], "2026-08-30", "CA")
        assert ca["units"] == 5
        assert ca["cogs_value"] == 25.0

    def test_sku_normalized(self):
        content = _tsv([_row("2026-08-30", "ddpe0001", 1, "ONT8")])
        parsed = parse_ledger_summary(content, costs={"DDPE0001": 4.0})
        assert parsed["rows"][0]["sku"] == "DDPE0001"
        assert parsed["rows"][0]["cogs_value"] == 4.0

    def test_quoted_space_delimited_headers(self):
        content = (
            '"Date" "MSKU" "Disposition" "Ending Warehouse Balance" "Location"\n'
            '"2026-08-30" "SKU-A" "SELLABLE" "6" "LAX9"\n'
        )
        parsed = parse_ledger_summary(content, costs={"SKU-A": 1.5})
        assert parsed["rows_parsed"] == 1
        assert parsed["rows"][0]["fc_code"] == "LAX9"
        assert parsed["rows"][0]["cogs_value"] == 9.0

    def test_tulsa_ok_is_fba_not_dropped(self):
        content = _tsv([_row("2026-08-30", "SKU-A", 8, "TUL1")])
        parsed = parse_ledger_summary(content, costs={"SKU-A": 2.0})
        ok = summarize_state_day(parsed["rows"], "2026-08-30", "OK")
        assert ok["cogs_value"] == 16.0
        assert parsed["rows"][0]["state_code"] == "OK"

    def test_verified_ca_fc_set_rolls_up(self):
        """24 CA FCs: CA $ is only those FCs, FC count is 24. No leftover unmapped codes."""
        rows = [
            _row("2026-08-30", "SKU-A", 1, fc) for fc in CA_FCS_2026_08_30
        ] + [
            _row("2026-08-30", "SKU-A", 10, fc) for fc in STILL_UNMAPPED
        ]
        parsed = parse_ledger_summary("\n".join([HEADERS, *rows]), costs={"SKU-A": 3.4028})
        ca = summarize_state_day(parsed["rows"], "2026-08-30", "CA")
        assert ca["fc_count"] == 24
        assert ca["units"] == 24
        assert sorted(ca["fcs"]) == sorted(CA_FCS_2026_08_30)
        assert set(parsed["unknown_fcs"]) == set(STILL_UNMAPPED)
        unknown = summarize_state_day(parsed["rows"], "2026-08-30", "XX")
        assert unknown["units"] == 0
        assert ca["cogs_value"] == pytest.approx(81.67, abs=0.02)

    def test_2026_09_02_codes_are_not_unknown(self):
        rows = [_row("2026-08-30", "SKU-A", 1, fc) for fc in MAPPED_2026_09_02]
        parsed = parse_ledger_summary("\n".join([HEADERS, *rows]), costs={"SKU-A": 1.0})
        assert not parsed["unknown_fcs"]
        for r in parsed["rows"]:
            assert r["state_code"] == MAPPED_2026_09_02[r["fc_code"]]

    def test_2026_09_04_codes_are_not_unknown(self):
        rows = [_row("2026-08-30", "SKU-A", 1, fc) for fc in MAPPED_2026_09_04]
        parsed = parse_ledger_summary("\n".join([HEADERS, *rows]), costs={"SKU-A": 1.0})
        assert not parsed["unknown_fcs"]
        for r in parsed["rows"]:
            assert r["state_code"] == MAPPED_2026_09_04[r["fc_code"]]


class TestPeakYTD:
    def test_peak_is_max_day_not_latest(self):
        rows = [
            {"snapshot_date": "2026-03-01", "state_code": "CA", "fc_code": "ONT8",
             "cogs_value": 100.0, "ending_qty": 10},
            {"snapshot_date": "2026-08-30", "state_code": "CA", "fc_code": "ONT8",
             "cogs_value": 40.0, "ending_qty": 4},
            {"snapshot_date": "2026-08-30", "state_code": "TX", "fc_code": "DFW7",
             "cogs_value": 12.0, "ending_qty": 2},
        ]
        peaks = {p["state_code"]: p for p in peak_by_state(rows, 2026)}
        assert peaks["CA"]["peak_cogs"] == 100.0
        assert peaks["CA"]["peak_date"] == "2026-03-01"
        assert peaks["CA"]["current_cogs"] == 40.0
        assert peaks["CA"]["current_units"] == 4
        assert peaks["TX"]["peak_cogs"] == 12.0

    def test_other_years_excluded(self):
        rows = [
            {"snapshot_date": "2025-12-31", "state_code": "CA", "fc_code": "ONT8",
             "cogs_value": 999.0, "ending_qty": 9},
            {"snapshot_date": "2026-01-02", "state_code": "CA", "fc_code": "ONT8",
             "cogs_value": 5.0, "ending_qty": 1},
        ]
        peaks = peak_by_state(rows, 2026)
        assert len(peaks) == 1
        assert peaks[0]["peak_cogs"] == 5.0


class TestFetchOrchestrator:
    def test_fetch_upserts_chunked_summary_never_detail(self, monkeypatch):
        from src.amazon_sp import ledger_summary as mod

        calls = {"upsert": 0, "delete": 0, "on_conflict": None, "reports": []}

        def fake_download(report_type, start, end, on_poll=None, report_options=None):
            calls["reports"].append((report_type, start, end, dict(report_options or {})))
            return _tsv([_row(start.isoformat(), "SKU-A", 2, "ONT8")])

        def fake_upsert(table, rows, on_conflict=None):
            calls["upsert"] += 1
            calls["on_conflict"] = on_conflict
            calls["table"] = table
            return len(rows)

        monkeypatch.setattr(mod, "_client", lambda: fake_download)
        monkeypatch.setattr(mod, "_db", lambda: type("DB", (), {
            "upsert_rows": staticmethod(fake_upsert),
            "log_ingestion": staticmethod(lambda **k: None),
            "log_audit": staticmethod(lambda **k: None),
        })())
        monkeypatch.setattr(mod, "load_sku_costs", lambda: {"SKU-A": 1.0})

        summary = fetch_ledger_summary(date(2026, 1, 1), date(2026, 2, 15))

        assert summary["chunks"] >= 2
        assert all(r[0] == "GET_LEDGER_SUMMARY_VIEW_DATA" for r in calls["reports"])
        assert all(
            r[3] == {"aggregatedByTimePeriod": "DAILY", "aggregateByLocation": "FC"}
            for r in calls["reports"]
        )
        for _rt, c_start, c_end, _opt in calls["reports"]:
            assert (c_end - c_start).days <= 29
        assert calls["upsert"] == 1
        assert calls["delete"] == 0
        assert calls["table"] == "inventory_ledger_summary_daily"
        assert calls["on_conflict"] == CONFLICT_KEY

    def test_source_does_not_import_detail_as_fallback(self):
        src = Path("src/amazon_sp/ledger_summary.py").read_text()
        assert "GET_LEDGER_DETAIL_VIEW_DATA" in src  # the guard
        assert 'LEDGER_SUMMARY_REPORT = "GET_LEDGER_DETAIL_VIEW_DATA"' not in src
        assert "GET_LEDGER_SUMMARY_VIEW_DATA" in src


class TestCLIAndScheduler:
    def test_commands_and_nightly_job_are_wired(self):
        src = Path("src/main.py").read_text()
        assert '@cli.command("spapi-ledger-summary")' in src
        assert '@cli.command("backfill-ledger-summary")' in src
        assert '@cli.command("inventory-remap-fc")' in src
        assert "inventory_ledger_summary_daily" in src[src.index("def inventory_remap_fc_cmd"):src.index("def inventory_remap_fc_cmd") + 1800]
        assert "id=\"ledger_summary_daily\"" in src
        assert "def _run_ledger_summary" in src
        assert "fetch_ledger_summary" in src
        assert "GET_LEDGER_DETAIL_VIEW_DATA" in src  # existing detail job
        # Nightly tax pull must call the summary module, not fetch_inventory.
        start = src.index("def _run_ledger_summary")
        chunk = src[start : start + 1200]
        assert "fetch_ledger_summary" in chunk
        assert "fetch_inventory" not in chunk
        assert "amazon_as_of" in chunk
