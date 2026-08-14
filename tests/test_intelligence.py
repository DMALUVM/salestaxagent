"""Tests for the intelligence layer — knowledge base, rulings, health report, extractor."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.config import PROJECT_ROOT


# ---------------------------------------------------------------------------
# Seed data loading tests (no DB needed)
# ---------------------------------------------------------------------------

class TestSeedDataIntegrity:
    """Verify seed JSON files are valid and internally consistent."""

    def test_seed_nexus_rules_valid_json(self):
        path = PROJECT_ROOT / "config" / "seed_nexus_rules.json"
        data = json.loads(path.read_text())
        assert "rules" in data
        assert len(data["rules"]) > 0

    def test_seed_nexus_rules_have_required_fields(self):
        path = PROJECT_ROOT / "config" / "seed_nexus_rules.json"
        rules = json.loads(path.read_text())["rules"]
        for r in rules:
            assert "state_code" in r, f"Missing state_code in {r}"
            assert "rule_type" in r, f"Missing rule_type in {r}"
            assert "confidence" in r, f"Missing confidence in {r}"
            assert r["confidence"] in ("high", "medium", "low", "contested"), \
                f"Invalid confidence '{r['confidence']}' in {r['state_code']}/{r['rule_type']}"
            assert "primary_sources" in r, f"Missing primary_sources in {r['state_code']}/{r['rule_type']}"
            assert isinstance(r["primary_sources"], list)

    def test_seed_franchise_rules_valid(self):
        path = PROJECT_ROOT / "config" / "seed_franchise_rules.json"
        data = json.loads(path.read_text())
        assert "rules" in data
        for r in data["rules"]:
            assert "state_code" in r
            assert "rule_type" in r

    def test_seed_filing_rules_valid(self):
        path = PROJECT_ROOT / "config" / "seed_filing_rules.json"
        data = json.loads(path.read_text())
        assert "rules" in data
        for r in data["rules"]:
            assert "state_code" in r
            assert "default_frequency" in r

    def test_seed_rulings_valid(self):
        path = PROJECT_ROOT / "config" / "seed_rulings.json"
        data = json.loads(path.read_text())
        assert "court_rulings" in data
        assert "admin_rulings" in data
        for r in data["court_rulings"]:
            assert "case_name" in r
            assert "states_affected" in r
            assert isinstance(r["states_affected"], list)
        for r in data["admin_rulings"]:
            assert "title" in r

    def test_seed_rulings_wayfair_present(self):
        path = PROJECT_ROOT / "config" / "seed_rulings.json"
        data = json.loads(path.read_text())
        names = [r["case_name"] for r in data["court_rulings"]]
        assert any("Wayfair" in n for n in names), "Wayfair ruling must be seeded"

    def test_seed_rulings_pa_omg_present(self):
        path = PROJECT_ROOT / "config" / "seed_rulings.json"
        data = json.loads(path.read_text())
        names = [r["case_name"] for r in data["court_rulings"]]
        assert any("Online Merchants Guild" in n or "Hassell" in n for n in names), \
            "PA Online Merchants Guild v. Hassell must be seeded"

    def test_source_registry_valid(self):
        path = PROJECT_ROOT / "config" / "source_registry.json"
        data = json.loads(path.read_text())
        sources = data.get("sources", data)
        assert len(sources) > 0
        for s in sources:
            assert "url" in s
            assert "state_code" in s
            assert s["url"].startswith("http")

    def test_source_registry_covers_key_states(self):
        path = PROJECT_ROOT / "config" / "source_registry.json"
        data = json.loads(path.read_text())
        sources = data.get("sources", data)
        states = {s["state_code"] for s in sources}
        for needed in ("CA", "TX", "PA", "NY"):
            assert needed in states, f"Source registry should cover {needed}"

    def test_nexus_rules_pa_is_contested(self):
        path = PROJECT_ROOT / "config" / "seed_nexus_rules.json"
        rules = json.loads(path.read_text())["rules"]
        pa_fba = [r for r in rules if r["state_code"] == "PA" and r["rule_type"] == "physical_inventory_fba"]
        assert len(pa_fba) == 1, "PA should have one physical_inventory_fba rule"
        assert pa_fba[0]["confidence"] == "contested", "PA FBA nexus should be contested"

    def test_all_nexus_rules_have_citations(self):
        path = PROJECT_ROOT / "config" / "seed_nexus_rules.json"
        rules = json.loads(path.read_text())["rules"]
        for r in rules:
            sources = r.get("primary_sources", [])
            assert len(sources) > 0, \
                f"{r['state_code']}/{r['rule_type']} has no primary sources — every rule must cite sources"


# ---------------------------------------------------------------------------
# Knowledge base query tests (mock DB)
# ---------------------------------------------------------------------------

MOCK_NEXUS_RULE_CA = {
    "id": "1",
    "state_code": "CA",
    "rule_type": "physical_inventory_fba",
    "position_summary": "FBA inventory in CA creates nexus",
    "confidence": "high",
    "primary_sources": [{"type": "statute", "citation": "Cal. Rev. & Tax. Code § 6203(c)"}],
    "is_active": True,
    "last_reviewed": "2026-01-15",
}

MOCK_NEXUS_RULE_PA = {
    "id": "2",
    "state_code": "PA",
    "rule_type": "physical_inventory_fba",
    "position_summary": "PA FBA nexus is contested per Online Merchants Guild v. Hassell",
    "confidence": "contested",
    "conservative_position": "Register if inventory present",
    "aggressive_position": "Rely on OMG ruling — no nexus from FBA alone",
    "open_questions": "Whether PA DOR will pursue further",
    "primary_sources": [{"type": "court_opinion", "citation": "Online Merchants Guild v. Hassell"}],
    "is_active": True,
    "last_reviewed": "2026-01-15",
}

MOCK_STATE_RULE_CA = {
    "state_code": "CA",
    "state_name": "California",
    "has_sales_tax": True,
    "fba_inventory_creates_nexus": True,
    "economic_threshold_amount": 500000,
}


class TestKnowledgeBase:
    """Test knowledge_base.py query functions with mocked DB."""

    @patch("src.intelligence.knowledge_base.fetch_all")
    @patch("src.intelligence.knowledge_base.fetch_one")
    def test_query_fba_nexus_position_ca(self, mock_fetch_one, mock_fetch_all):
        mock_fetch_all.return_value = [MOCK_NEXUS_RULE_CA]
        mock_fetch_one.return_value = MOCK_STATE_RULE_CA

        from src.intelligence.knowledge_base import query_fba_nexus_position
        result = query_fba_nexus_position("CA")

        assert result["state_code"] == "CA"
        assert result["confidence"] == "high"
        assert result["position"] == "creates_nexus"
        assert "disclaimer" in result

    @patch("src.intelligence.knowledge_base.fetch_all")
    @patch("src.intelligence.knowledge_base.fetch_one")
    def test_query_fba_nexus_position_contested(self, mock_fetch_one, mock_fetch_all):
        mock_fetch_all.return_value = [MOCK_NEXUS_RULE_PA]
        mock_fetch_one.return_value = {"state_code": "PA", "fba_inventory_creates_nexus": True}

        from src.intelligence.knowledge_base import query_fba_nexus_position
        result = query_fba_nexus_position("PA")

        assert result["position"] == "contested"
        assert result["confidence"] == "contested"
        assert result["conservative_position"] is not None
        assert result["aggressive_position"] is not None

    @patch("src.intelligence.knowledge_base.fetch_all")
    @patch("src.intelligence.knowledge_base.fetch_one")
    def test_query_fba_fallback_no_intel(self, mock_fetch_one, mock_fetch_all):
        mock_fetch_all.return_value = []
        mock_fetch_one.return_value = {"state_code": "FL", "fba_inventory_creates_nexus": True}

        from src.intelligence.knowledge_base import query_fba_nexus_position
        result = query_fba_nexus_position("FL")

        assert result["confidence"] == "medium"
        assert result["position"] == "creates_nexus"

    @patch("src.intelligence.knowledge_base.fetch_all")
    @patch("src.intelligence.knowledge_base.fetch_one")
    def test_build_citation_block_includes_disclaimer(self, mock_fetch_one, mock_fetch_all):
        mock_fetch_all.return_value = [MOCK_NEXUS_RULE_CA]
        mock_fetch_one.return_value = MOCK_STATE_RULE_CA

        from src.intelligence.knowledge_base import build_citation_block
        block = build_citation_block("CA", "physical")

        assert "CA" in block
        assert "not legal or tax advice" in block.lower()
        assert "6203" in block

    @patch("src.intelligence.knowledge_base.fetch_all")
    def test_search_rulings_by_keyword(self, mock_fetch_all):
        mock_fetch_all.return_value = [
            {
                "case_name": "South Dakota v. Wayfair",
                "holding_summary": "Overruled Quill",
                "relevance_to_fba": "Foundational",
                "tags": ["economic_nexus"],
                "states_affected": ["ALL"],
            }
        ]

        from src.intelligence.knowledge_base import search_rulings
        results = search_rulings("wayfair")
        assert len(results) == 1
        assert "Wayfair" in results[0]["case_name"]

    @patch("src.intelligence.knowledge_base.fetch_all")
    def test_search_rulings_no_match(self, mock_fetch_all):
        mock_fetch_all.return_value = [
            {
                "case_name": "South Dakota v. Wayfair",
                "holding_summary": "Overruled Quill",
                "relevance_to_fba": "",
                "tags": [],
                "states_affected": ["ALL"],
            }
        ]

        from src.intelligence.knowledge_base import search_rulings
        results = search_rulings("xyznonexistent")
        assert len(results) == 0

    @patch("src.intelligence.knowledge_base.fetch_all")
    def test_get_all_contested_positions(self, mock_fetch_all):
        mock_fetch_all.side_effect = [
            [MOCK_NEXUS_RULE_PA],  # nexus_rules query
            [],                     # court_rulings for PA
        ]

        from src.intelligence.knowledge_base import get_all_contested_positions
        results = get_all_contested_positions()
        assert len(results) == 1
        assert results[0]["state_code"] == "PA"


# ---------------------------------------------------------------------------
# Ruling ingestion tests (mock DB)
# ---------------------------------------------------------------------------

class TestRulingIngestion:
    """Test ruling ingestion from JSON files."""

    @patch("src.intelligence.rulings.insert_rows")
    @patch("src.intelligence.rulings.log_audit")
    def test_ingest_ruling_file_court(self, mock_audit, mock_insert):
        mock_insert.return_value = 1

        ruling_data = {
            "court_ruling": {
                "case_name": "Test v. State",
                "citation": "123 Test 456",
                "court": "Test Court",
                "states_affected": ["TX"],
                "holding_summary": "Test holding",
            }
        }

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(ruling_data, f)
            tmp_path = f.name

        try:
            from src.intelligence.rulings import ingest_ruling_file
            result = ingest_ruling_file(tmp_path)
            assert result["court_rulings_added"] == 1
            assert result["admin_rulings_added"] == 0
        finally:
            os.unlink(tmp_path)

    @patch("src.intelligence.rulings.insert_rows")
    @patch("src.intelligence.rulings.log_audit")
    def test_ingest_ruling_file_not_found(self, mock_audit, mock_insert):
        from src.intelligence.rulings import ingest_ruling_file
        with pytest.raises(FileNotFoundError):
            ingest_ruling_file("/nonexistent/ruling.json")

    @patch("src.intelligence.rulings.insert_rows")
    @patch("src.intelligence.rulings.log_audit")
    def test_ingest_raw_document(self, mock_audit, mock_insert):
        mock_insert.return_value = 1

        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
            f.write("Sample tax ruling text for testing.")
            tmp_path = f.name

        try:
            from src.intelligence.rulings import ingest_raw_document
            result = ingest_raw_document(tmp_path, jurisdiction="CA", document_type="admin_ruling")
            assert result["extraction_status"] == "pending"
            assert result["research_task_created"] is True
        finally:
            os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# Health report tests (mock DB)
# ---------------------------------------------------------------------------

class TestHealthReport:
    @patch("src.intelligence.health_report.fetch_all")
    def test_health_report_generates(self, mock_fetch_all):
        mock_fetch_all.return_value = []

        from src.intelligence.health_report import generate_health_report
        report = generate_health_report()

        assert "RULES HEALTH REPORT" in report
        assert "not legal or tax advice" in report.lower()
        assert "RECOMMENDED ACTIONS" in report

    @patch("src.intelligence.health_report.fetch_all")
    def test_health_report_shows_stale_rules(self, mock_fetch_all):
        def side_effect(table, *args, **kwargs):
            if table == "nexus_rules":
                return [{
                    "state_code": "CA",
                    "rule_type": "physical_inventory_fba",
                    "last_reviewed": "2024-01-01",
                    "is_active": True,
                }]
            return []

        mock_fetch_all.side_effect = side_effect

        from src.intelligence.health_report import generate_health_report
        report = generate_health_report(stale_threshold_days=90)

        assert "CA" in report
        assert "Stale" in report


# ---------------------------------------------------------------------------
# Extractor tests (mock DB)
# ---------------------------------------------------------------------------

class TestExtractor:
    @patch("src.intelligence.extractor.fetch_all")
    def test_prepare_extraction_doc_not_found(self, mock_fetch_all):
        mock_fetch_all.return_value = []

        from src.intelligence.extractor import prepare_extraction
        result = prepare_extraction("nonexistent-id")
        assert "error" in result

    @patch("src.intelligence.extractor.fetch_all")
    def test_prepare_extraction_generates_prompt(self, mock_fetch_all):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
            f.write("This is a test tax document with nexus information.")
            tmp_path = f.name

        mock_fetch_all.return_value = [{
            "id": "test-123",
            "file_path": tmp_path,
            "document_type": "admin_ruling",
            "jurisdiction": "CA",
        }]

        try:
            from src.intelligence.extractor import prepare_extraction
            result = prepare_extraction("test-123")
            assert "prompt" in result
            assert "multi-state sales tax" in result["prompt"].lower()
            assert "Do not invent" in result["prompt"]
        finally:
            os.unlink(tmp_path)

    @patch("src.intelligence.extractor.insert_rows")
    @patch("src.intelligence.extractor.update_row")
    @patch("src.intelligence.extractor.fetch_all")
    @patch("src.intelligence.extractor.log_audit")
    def test_store_extraction_creates_review_tasks(self, mock_audit, mock_fetch_all, mock_update, mock_insert):
        mock_fetch_all.return_value = [{
            "id": "doc-456",
            "title": "Test Document",
        }]
        mock_insert.return_value = 1

        from src.intelligence.extractor import store_extraction_results
        items = [
            {"type": "nexus_rule", "states_affected": ["TX"], "summary": "TX threshold changed"},
            {"type": "court_ruling", "states_affected": ["CA"], "summary": "New CA ruling"},
        ]
        result = store_extraction_results("doc-456", items)

        assert result["items_extracted"] == 2
        assert result["tasks_created"] == 2
        assert "pending human review" in result["status"]


# ---------------------------------------------------------------------------
# Classify position logic test
# ---------------------------------------------------------------------------

class TestClassifyPosition:
    def test_creates_nexus(self):
        from src.intelligence.knowledge_base import _classify_position
        assert _classify_position({"position_summary": "Creates nexus in CA", "confidence": "high"}) == "creates_nexus"

    def test_does_not_create(self):
        from src.intelligence.knowledge_base import _classify_position
        assert _classify_position({"position_summary": "Does not create nexus", "confidence": "high"}) == "does_not_create_nexus"

    def test_contested(self):
        from src.intelligence.knowledge_base import _classify_position
        assert _classify_position({"position_summary": "Unclear position", "confidence": "contested"}) == "contested"

    def test_unclear(self):
        from src.intelligence.knowledge_base import _classify_position
        assert _classify_position({"position_summary": "Some other phrasing", "confidence": "medium"}) == "unclear"


# ---------------------------------------------------------------------------
# Matches ruling logic test
# ---------------------------------------------------------------------------

class TestMatchesRuling:
    def test_matches_case_name(self):
        from src.intelligence.knowledge_base import _matches_ruling
        ruling = {
            "case_name": "South Dakota v. Wayfair",
            "holding_summary": "",
            "relevance_to_fba": "",
            "tags": [],
            "states_affected": [],
        }
        assert _matches_ruling(ruling, "wayfair", "case_name") is True
        assert _matches_ruling(ruling, "quill", "case_name") is False

    def test_matches_tags(self):
        from src.intelligence.knowledge_base import _matches_ruling
        ruling = {
            "case_name": "Some Case",
            "holding_summary": "",
            "relevance_to_fba": "",
            "tags": ["economic_nexus", "landmark"],
            "states_affected": [],
        }
        assert _matches_ruling(ruling, "landmark", "case_name") is True

    def test_matches_state(self):
        from src.intelligence.knowledge_base import _matches_ruling
        ruling = {
            "case_name": "Some v. Other",
            "holding_summary": "",
            "relevance_to_fba": "",
            "tags": [],
            "states_affected": ["PA"],
        }
        assert _matches_ruling(ruling, "pa", "case_name") is True
