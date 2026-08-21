"""Brand Analytics SQP import.

SQP reports click SHARE, not SERP position. Where an export has no rank column
the parser derives a coarse BAND from share and says so — it must never present
a derived band as a measured rank, and must never invent one from nothing.
"""
import pytest

from datetime import date

from src.amazon_ads.sqp_import import parse_sqp

AS_OF = date(2026, 8, 21)


class TestExplicitRankColumn:
    CSV = (
        "Search Query,ASIN,Organic Rank,Reporting Date\n"
        "Tallow Lip Balm,B0CLHTF8YN,2,2026-08-18\n"
        "  BEEF   tallow  balm ,B0CLHTF8YN,14,2026-08-18\n"
    )

    def test_rank_is_taken_verbatim(self):
        r = parse_sqp(self.CSV, as_of=AS_OF)
        by = {x["keyword_normalized"]: x for x in r["rows"]}
        assert by["tallow lip balm"]["organic_rank"] == 2
        assert by["beef tallow balm"]["organic_rank"] == 14

    def test_keywords_are_normalized_for_the_join(self):
        r = parse_sqp(self.CSV, as_of=AS_OF)
        assert "beef tallow balm" in {x["keyword_normalized"] for x in r["rows"]}

    def test_reporting_date_is_used(self):
        r = parse_sqp(self.CSV, as_of=AS_OF)
        assert all(x["as_of"] == "2026-08-18" for x in r["rows"])

    def test_no_share_derivation_warning_when_rank_is_present(self):
        r = parse_sqp(self.CSV, as_of=AS_OF)
        assert r["derived_from_share"] == 0


class TestShareDerivedBands:
    CSV = (
        "Search Query,Click Share\n"
        "tallow lip balm,62%\n"
        "beef tallow balm,22%\n"
        "grass fed tallow,3%\n"
    )

    def test_bands_are_derived_from_share(self):
        r = parse_sqp(self.CSV, default_asin="A1", as_of=AS_OF)
        by = {x["keyword_normalized"]: x["organic_rank"] for x in r["rows"]}
        assert by["tallow lip balm"] == 1     # >=40%
        assert by["beef tallow balm"] == 5    # >=15%
        assert by["grass fed tallow"] == 99   # below

    def test_the_derivation_is_disclosed(self):
        r = parse_sqp(self.CSV, default_asin="A1", as_of=AS_OF)
        assert r["derived_from_share"] == 3
        assert any("bands, not" in w for w in r["warnings"])

    def test_share_is_retained_alongside_the_band(self):
        r = parse_sqp(self.CSV, default_asin="A1", as_of=AS_OF)
        top = next(x for x in r["rows"] if x["keyword_normalized"] == "tallow lip balm")
        assert top["impression_share_organic"] == pytest.approx(0.62)

    @pytest.mark.parametrize("raw,expected", [
        ("0.62", 0.62), ("62%", 0.62), ("62", 0.62), ("", None),
    ])
    def test_share_formats(self, raw, expected):
        csv = f"Search Query,Click Share\nkw,{raw}\n"
        r = parse_sqp(csv, default_asin="A1", as_of=AS_OF)
        if expected is None:
            assert r["rows"] == []
        else:
            assert r["rows"][0]["impression_share_organic"] == pytest.approx(expected)


class TestNoEvidenceMeansNoRow:
    def test_a_row_with_neither_rank_nor_share_is_skipped(self):
        r = parse_sqp("Search Query,Impressions\ntallow balm,1000\n", as_of=AS_OF)
        assert r["rows"] == []
        assert r["skipped"] == 1

    def test_an_export_with_no_query_column_fails_loudly(self):
        r = parse_sqp("Impressions,Clicks\n100,5\n", as_of=AS_OF)
        assert r["rows"] == []
        assert any("no search-query column" in w for w in r["warnings"])

    def test_an_empty_file_does_not_raise(self):
        assert parse_sqp("", as_of=AS_OF)["rows"] == []

    def test_blank_queries_are_skipped(self):
        r = parse_sqp("Search Query,Organic Rank\n   ,3\n", as_of=AS_OF)
        assert r["rows"] == [] and r["skipped"] == 1


class TestHeaderMatching:
    @pytest.mark.parametrize("header", [
        "Search Query", "Query", "Customer Search Term", "Search Term",
    ])
    def test_query_header_synonyms(self, header):
        r = parse_sqp(f"{header},Organic Rank\ntallow,3\n", as_of=AS_OF)
        assert r["rows"][0]["keyword_normalized"] == "tallow"

    def test_headers_with_units_still_match(self):
        r = parse_sqp("Search Query,Click Share (%)\ntallow,55\n",
                      default_asin="A1", as_of=AS_OF)
        assert r["rows"][0]["organic_rank"] == 1


class TestDeduplication:
    def test_best_evidenced_row_wins_per_keyword(self):
        csv = ("Search Query,ASIN,Organic Rank\n"
               "tallow balm,A1,9\n"
               "Tallow  Balm,A1,4\n")
        r = parse_sqp(csv, as_of=AS_OF)
        assert len(r["rows"]) == 1
        assert r["rows"][0]["organic_rank"] == 4


class TestJoinIntegration:
    def test_imported_rows_join_against_a_ppc_search_term(self):
        """The end-to-end point: SQP query -> normalized key -> gate input."""
        from src.amazon_ads.organic_rank import build_rank_info, lookup

        parsed = parse_sqp("Search Query,ASIN,Organic Rank\nTallow  Lip Balm,A1,2\n",
                           as_of=AS_OF)
        ranks = {(r["asin"], r["keyword_normalized"]): r for r in parsed["rows"]}
        cfg = {"brand_tokens": [], "stale_after_days": 14}
        # The PPC side holds the raw, differently-cased term.
        info = lookup(ranks, "  tallow   LIP  balm ", "A1", cfg, AS_OF)
        assert info.effective_rank == 2
