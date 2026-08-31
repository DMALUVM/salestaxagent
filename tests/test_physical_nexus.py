"""Physical nexus upsert must not clobber Tess/Dave registration confidence.

FBA-inventory legal posture (PA contested / Online Merchants Guild) is a
different fact from registration-record confidence. Once a registered row
already has confidence, evaluate_physical_nexus must preserve it.
"""
from __future__ import annotations

import json

import pytest

from src.config import PROJECT_ROOT
from src.engines.physical_nexus import evaluate_physical_nexus


def _inv(state_code: str, fc_code: str = "PHL5") -> dict:
    return {
        "state_code": state_code,
        "event_date": "2026-01-15",
        "quantity": 12,
        "fc_code": fc_code,
    }


def _stub_physical(monkeypatch, *, inventory, nexus_rows, intel=None):
    """Mock DB + intelligence so evaluate_physical_nexus is unit-testable."""
    upserted: list[tuple[str, list, str | None]] = []

    def fake_fetch(table, filters=None, order=None):
        if table == "inventory_events":
            return list(inventory)
        if table == "nexus_status":
            sc = (filters or {}).get("state_code")
            rows = list(nexus_rows)
            if sc:
                return [r for r in rows if r.get("state_code") == sc]
            return rows
        return []

    def fake_upsert(table, rows, on_conflict=None, batch_size=500):
        upserted.append((table, list(rows), on_conflict))
        return len(rows)

    monkeypatch.setattr("src.engines.physical_nexus.fetch_all", fake_fetch)
    monkeypatch.setattr("src.engines.physical_nexus.upsert_rows", fake_upsert)
    monkeypatch.setattr("src.engines.physical_nexus.log_audit", lambda *a, **k: None)
    monkeypatch.setattr(
        "src.engines.physical_nexus._get_intelligence_citations",
        lambda sc: (intel or {}).get(sc, {}),
    )
    monkeypatch.setattr("src.db.insert_rows", lambda *a, **k: 0)
    return upserted


def _nexus_upserts(upserted):
    rows = []
    for table, batch, _conflict in upserted:
        if table == "nexus_status":
            rows.extend(batch)
    return {r["state_code"]: r for r in rows}


class TestRegisteredConfidenceLock:
    def test_registered_pa_high_survives_contested_fba_posture(self, monkeypatch):
        """PA is_registered + confidence=high must stay high even if FBA is contested."""
        existing = [{
            "state_code": "PA",
            "is_registered": True,
            "account_number": "67903742",
            "assigned_frequency": "monthly",
            "registration_date": "2026-08-18",
            "confidence": "high",
        }]
        upserted = _stub_physical(
            monkeypatch,
            inventory=[_inv("PA")],
            nexus_rows=existing,
            intel={"PA": {"confidence": "contested"}},
        )

        evaluate_physical_nexus()
        pa = _nexus_upserts(upserted)["PA"]

        assert pa["confidence"] == "high"
        assert pa["is_registered"] is True
        assert pa["account_number"] == "67903742"
        assert pa["assigned_frequency"] == "monthly"
        assert pa["registration_date"] == "2026-08-18"

    def test_registered_without_confidence_gets_first_time_engine_value(self, monkeypatch):
        """No registration lock when confidence has never been set — engine may write."""
        existing = [{
            "state_code": "PA",
            "is_registered": True,
            "account_number": "67903742",
        }]
        upserted = _stub_physical(
            monkeypatch,
            inventory=[_inv("PA")],
            nexus_rows=existing,
            intel={"PA": {"confidence": "contested"}},
        )

        evaluate_physical_nexus()
        pa = _nexus_upserts(upserted)["PA"]

        assert pa["confidence"] == "contested"
        assert pa["is_registered"] is True

    def test_unregistered_contested_fba_state_still_gets_contested(self, monkeypatch):
        upserted = _stub_physical(
            monkeypatch,
            inventory=[_inv("PA")],
            nexus_rows=[],
            intel={"PA": {"confidence": "contested"}},
        )

        evaluate_physical_nexus()
        pa = _nexus_upserts(upserted)["PA"]

        assert pa["confidence"] == "contested"
        assert pa.get("is_registered") is not True
        assert not pa.get("account_number")


class TestUnregisteredStatesStayUnregistered:
    def test_ga_wa_is_registered_stays_false(self, monkeypatch):
        existing = [
            {"state_code": "GA", "is_registered": False},
            {"state_code": "WA", "is_registered": False},
        ]
        upserted = _stub_physical(
            monkeypatch,
            inventory=[_inv("GA", "ATL2"), _inv("WA", "BFI1")],
            nexus_rows=existing,
        )

        evaluate_physical_nexus()
        rows = _nexus_upserts(upserted)

        assert rows["GA"].get("is_registered") is False
        assert rows["WA"].get("is_registered") is False
        assert not rows["GA"].get("account_number")
        assert not rows["WA"].get("account_number")

    def test_ga_wa_without_existing_row_do_not_invent_registration(self, monkeypatch):
        upserted = _stub_physical(
            monkeypatch,
            inventory=[_inv("GA", "ATL2"), _inv("WA", "BFI1")],
            nexus_rows=[],
        )

        evaluate_physical_nexus()
        rows = _nexus_upserts(upserted)

        assert rows["GA"].get("is_registered") is not True
        assert rows["WA"].get("is_registered") is not True
        assert not rows["GA"].get("account_number")
        assert not rows["WA"].get("account_number")


class TestPostureFileUnchanged:
    def test_pa_fba_posture_stays_contested(self):
        """Litigation note stays — this fix does not reclassify PA FBA posture."""
        path = PROJECT_ROOT / "config" / "fba_nexus_posture.json"
        data = json.loads(path.read_text())
        pa = data["postures"]["PA"]
        assert pa["posture"] == "contested"
        assert "Online Merchants Guild" in pa["notes"]


class TestEconomicNexusDoesNotWriteConfidence:
    def test_economic_upsert_omits_confidence(self, monkeypatch):
        """economic_nexus preserves registration but must not write confidence."""
        upserted: list[list] = []

        def fake_fetch(table, filters=None, order=None):
            if table == "sales_by_state":
                return [{
                    "state_code": "PA",
                    "channel": "shopify",
                    "period_start": "2026-01-01",
                    "period_end": "2026-01-31",
                    "gross_sales": 5000,
                    "order_count": 10,
                    "source": "shopify",
                }]
            if table == "nexus_status":
                return [{
                    "state_code": "PA",
                    "is_registered": True,
                    "account_number": "67903742",
                    "confidence": "high",
                }]
            return []

        def fake_upsert(table, rows, on_conflict=None, batch_size=500):
            if table == "nexus_status":
                upserted.extend(rows)
            return len(rows)

        monkeypatch.setattr("src.engines.economic_nexus.fetch_all", fake_fetch)
        monkeypatch.setattr("src.engines.economic_nexus.upsert_rows", fake_upsert)
        monkeypatch.setattr("src.engines.economic_nexus.log_audit", lambda *a, **k: None)
        monkeypatch.setattr(
            "src.engines.economic_nexus._get_economic_citations",
            lambda sc: {},
        )

        from src.engines.economic_nexus import evaluate_economic_nexus
        from datetime import date

        evaluate_economic_nexus(reference_date=date(2026, 8, 31))
        assert upserted, "economic nexus should upsert PA"
        for row in upserted:
            assert "confidence" not in row
            assert row.get("is_registered") is True
            assert row.get("account_number") == "67903742"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
