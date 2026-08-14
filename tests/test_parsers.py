"""Tests for Amazon inventory and Shopify order parsers. No DB required."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

SAMPLE_DIR = Path(__file__).resolve().parent / "sample_data"


class TestAmazonInventoryParser:
    def test_parse_sample_file(self):
        from src.parsers.amazon_inventory import parse_amazon_inventory_file
        result = parse_amazon_inventory_file(SAMPLE_DIR / "amazon_inventory_sample.csv")

        assert result["rows_total"] == 19
        assert result["rows_parsed"] >= 18
        assert len(result["events"]) >= 18
        assert "TX" in result["states_found"]
        assert "CA" in result["states_found"]
        assert "PA" in result["states_found"]
        assert "TN" in result["states_found"]
        assert "UNKNOWN1" in result["unknown_fcs"]

    def test_state_mapping(self):
        from src.parsers.amazon_inventory import parse_amazon_inventory_file
        result = parse_amazon_inventory_file(SAMPLE_DIR / "amazon_inventory_sample.csv")

        states = result["states_found"]
        assert "TX" in states
        assert "CA" in states
        assert "PA" in states
        assert "TN" in states
        assert "NJ" in states
        assert "KY" in states
        assert "IN" in states
        assert "WI" in states
        assert "FL" in states

    def test_unknown_fc_flagged(self):
        from src.parsers.amazon_inventory import parse_amazon_inventory_file
        result = parse_amazon_inventory_file(SAMPLE_DIR / "amazon_inventory_sample.csv")

        assert "UNKNOWN1" in result["unknown_fcs"]
        warning_text = " ".join(result["warnings"])
        assert "UNKNOWN1" in warning_text

    def test_file_not_found(self):
        from src.parsers.amazon_inventory import parse_amazon_inventory_file
        with pytest.raises(FileNotFoundError):
            parse_amazon_inventory_file("/nonexistent/file.csv")


class TestShopifyOrderParser:
    def test_parse_sample_file(self):
        from src.parsers.shopify_orders import parse_shopify_csv
        result = parse_shopify_csv(SAMPLE_DIR / "shopify_orders_sample.csv")

        assert result["rows_total"] == 15
        assert len(result["sales"]) > 0

        states = {s.state_code for s in result["sales"]}
        assert "TX" in states
        assert "CA" in states

    def test_sales_aggregation(self):
        from src.parsers.shopify_orders import parse_shopify_csv
        result = parse_shopify_csv(SAMPLE_DIR / "shopify_orders_sample.csv")

        tx_sales = [s for s in result["sales"] if s.state_code == "TX"]
        assert len(tx_sales) == 1
        assert tx_sales[0].order_count >= 3
        assert tx_sales[0].gross_sales > 0

    def test_non_us_skipped(self):
        from src.parsers.shopify_orders import parse_shopify_csv
        result = parse_shopify_csv(SAMPLE_DIR / "shopify_orders_sample.csv")

        states = {s.state_code for s in result["sales"]}
        for s in states:
            assert len(s) == 2
            assert s.isalpha()

    def test_file_not_found(self):
        from src.parsers.shopify_orders import parse_shopify_csv
        with pytest.raises(FileNotFoundError):
            parse_shopify_csv("/nonexistent/file.csv")


class TestFCMapper:
    def test_known_codes(self):
        from src.mappers.fc_to_state import fc_to_state
        assert fc_to_state("DFW7") == "TX"
        assert fc_to_state("ONT8") == "CA"
        assert fc_to_state("PHL7") == "PA"
        assert fc_to_state("BNA5") == "TN"
        assert fc_to_state("EWR9") == "NJ"

    def test_unknown_code(self):
        from src.mappers.fc_to_state import fc_to_state
        assert fc_to_state("ZZZZZ99") is None

    def test_case_insensitive(self):
        from src.mappers.fc_to_state import fc_to_state
        assert fc_to_state("dfw7") == "TX"
        assert fc_to_state("Ont8") == "CA"

    def test_get_unknown_fcs(self):
        from src.mappers.fc_to_state import get_unknown_fcs
        result = get_unknown_fcs(["DFW7", "UNKNOWN1", "PHL7", "FAKE99"])
        assert "UNKNOWN1" in result
        assert "FAKE99" in result
        assert "DFW7" not in result


class TestStateRules:
    def test_load_rules(self):
        from src.config import load_state_rules
        rules = load_state_rules()
        states = rules.get("states", {})
        assert len(states) >= 45

    def test_ca_rules(self):
        from src.config import load_state_rules
        rules = load_state_rules()
        ca = rules["states"]["CA"]
        assert ca["economic_threshold_amount"] == 500000
        assert ca["fba_inventory_creates_nexus"] is True
        assert ca["franchise_tax_notes"] is not None
        assert "$800" in ca["franchise_tax_notes"]

    def test_tx_rules(self):
        from src.config import load_state_rules
        rules = load_state_rules()
        tx = rules["states"]["TX"]
        assert tx["economic_threshold_amount"] == 500000
        assert tx["fba_inventory_creates_nexus"] is True
        assert tx["franchise_tax_notes"] is not None

    def test_no_sales_tax_states(self):
        from src.config import load_state_rules
        rules = load_state_rules()
        for code in ("OR", "MT", "NH", "DE"):
            assert rules["states"][code]["has_sales_tax"] is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
