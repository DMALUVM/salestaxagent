"""Brand Analytics SQP via SP-API.

SQP publishes SHARE, not SERP position. These pin that the derived rank stays a
coarse band, that period bounds align to Amazon's Sunday-Saturday week, and
that a missing Brand Analytics role fails loudly instead of looking like an
ordinary empty week.
"""
import json
from datetime import date

import pytest

from src.amazon_sp.sqp import (
    ASIN_OPTION_MAX_CHARS, REPORT_TYPE, SOURCE, BrandAnalyticsRoleError,
    batch_asins, month_bounds, parse_sqp_json, period_bounds, quarter_bounds,
    share_to_rank, week_bounds,
)

AS_OF = date(2026, 8, 15)


def sqp_doc(records):
    return json.dumps({"reportSpecification": {"reportType": REPORT_TYPE},
                       "dataByAsin": records})


def rec(query, click_share=None, imp_share=None, asin="B0CLHTF8YN"):
    r = {"asin": asin, "searchQueryData": {"searchQuery": query}}
    if click_share is not None:
        r["clickData"] = {"clickShare": click_share}
    if imp_share is not None:
        r["impressionData"] = {"impressionShare": imp_share}
    return r


class TestWeekBounds:
    def test_returns_the_last_complete_sunday_to_saturday(self):
        """2026-08-21 is a Friday; the last complete week is Aug 9-15."""
        start, end = week_bounds(date(2026, 8, 21))
        assert (start, end) == (date(2026, 8, 9), date(2026, 8, 15))
        assert start.weekday() == 6   # Sunday
        assert end.weekday() == 5     # Saturday

    def test_on_a_sunday_the_week_just_ended_is_used(self):
        start, end = week_bounds(date(2026, 8, 16))   # Sunday
        assert (start, end) == (date(2026, 8, 9), date(2026, 8, 15))

    def test_never_returns_an_in_progress_week(self):
        for offset in range(0, 21):
            ref = date(2026, 8, 1) + __import__("datetime").timedelta(days=offset)
            _, end = week_bounds(ref)
            assert end < ref, ref

    def test_span_is_always_seven_days(self):
        for offset in range(0, 30):
            ref = date(2026, 1, 1) + __import__("datetime").timedelta(days=offset)
            start, end = week_bounds(ref)
            assert (end - start).days == 6


class TestOtherPeriods:
    def test_month_bounds(self):
        assert month_bounds(date(2026, 8, 21)) == (date(2026, 7, 1), date(2026, 7, 31))

    def test_quarter_bounds(self):
        assert quarter_bounds(date(2026, 8, 21)) == (date(2026, 4, 1), date(2026, 6, 30))

    def test_period_dispatch_defaults_to_week(self):
        assert period_bounds("nonsense", date(2026, 8, 21)) == \
            week_bounds(date(2026, 8, 21))


class TestAsinBatching:
    def test_respects_the_200_char_option_limit(self):
        batches = batch_asins(["B0CLHTF8YN"] * 25)
        assert all(len(" ".join(b)) <= ASIN_OPTION_MAX_CHARS for b in batches)

    def test_covers_every_asin(self):
        asins = [f"B0{i:08d}" for i in range(25)]
        assert sum(len(b) for b in batch_asins(asins)) == 25

    def test_a_single_batch_when_they_fit(self):
        assert len(batch_asins(["B0CLHTF8YN", "B0DQFKMJFY", "B0HBSZ71XQ"])) == 1

    def test_soft_asin_cap_splits_large_lists(self):
        asins = [f"B0{i:08d}" for i in range(17)]
        batches = batch_asins(asins)
        assert all(len(b) <= 8 for b in batches)
        assert sum(len(b) for b in batches) == 17
        assert len(batches) >= 3

    def test_empty_input(self):
        assert batch_asins([]) == []

    def test_blank_entries_are_dropped(self):
        assert batch_asins(["B0CLHTF8YN", "", "  "]) == [["B0CLHTF8YN"]]


class TestRankBands:
    @pytest.mark.parametrize("share,expected", [
        (0.62, 1), (0.40, 1), (0.39, 5), (0.15, 5), (0.14, 99), (0.0, 99),
    ])
    def test_band_thresholds(self, share, expected):
        assert share_to_rank(share) == expected

    def test_no_share_yields_no_rank(self):
        """No evidence must not become a rank."""
        assert share_to_rank(None) is None

    def test_bands_match_the_csv_importer(self):
        """Manual and automated paths must not disagree about a share."""
        from src.amazon_ads.sqp_import import _rank_from_share
        for s in (0.9, 0.5, 0.4, 0.2, 0.15, 0.05, 0.0):
            assert share_to_rank(s) == _rank_from_share(s)


class TestParsing:
    def test_parses_click_share_into_a_band(self):
        doc = sqp_doc([rec("Beef Tallow Lip Balm", click_share=58.0, imp_share=31.0)])
        r = parse_sqp_json(doc, as_of=AS_OF)
        assert r.parsed == 1
        row = r.rows[0]
        assert row["keyword_normalized"] == "beef tallow lip balm"
        assert row["organic_rank"] == 1
        assert row["source"] == SOURCE
        assert row["as_of"] == "2026-08-15"

    def test_percentages_and_fractions_both_work(self):
        for value in (58.0, 0.58):
            r = parse_sqp_json(sqp_doc([rec("kw", click_share=value)]), as_of=AS_OF)
            assert r.rows[0]["organic_rank"] == 1

    def test_keywords_are_normalized_for_the_join(self):
        r = parse_sqp_json(sqp_doc([rec("  Beef   TALLOW  Balm ", click_share=50)]),
                           as_of=AS_OF)
        assert r.rows[0]["keyword_normalized"] == "beef tallow balm"

    def test_impression_share_is_retained_but_does_not_set_the_band(self):
        r = parse_sqp_json(sqp_doc([rec("kw", click_share=10.0, imp_share=90.0)]),
                           as_of=AS_OF)
        assert r.rows[0]["organic_rank"] == 99          # from click share
        assert r.rows[0]["impression_share_organic"] == pytest.approx(0.90)

    def test_a_record_with_no_click_share_is_skipped(self):
        r = parse_sqp_json(sqp_doc([rec("kw", imp_share=50.0)]), as_of=AS_OF)
        assert r.rows == [] and r.skipped == 1

    def test_the_derivation_is_disclosed(self):
        r = parse_sqp_json(sqp_doc([rec("kw", click_share=50)]), as_of=AS_OF)
        assert any("SHARE, not SERP position" in w for w in r.warnings)

    def test_empty_report_says_the_report_ran_but_had_no_rows(self):
        """Present-but-empty is a real result, not a role failure."""
        r = parse_sqp_json(json.dumps({"dataByAsin": []}), as_of=AS_OF)
        assert r.rows == []
        assert any("present but EMPTY" in w for w in r.warnings)

    def test_non_json_does_not_raise(self):
        r = parse_sqp_json("<html>error</html>", as_of=AS_OF)
        assert r.rows == [] and any("not JSON" in w for w in r.warnings)

    def test_alternate_field_shapes_are_tolerated(self):
        doc = json.dumps({"dataByAsin": [{
            "asin": "B0X", "searchQuery": "tallow balm",
            "asinClickData": {"asinClickShare": 45.0},
        }]})
        r = parse_sqp_json(doc, as_of=AS_OF)
        assert r.rows[0]["organic_rank"] == 1

    def test_blank_queries_are_skipped(self):
        r = parse_sqp_json(sqp_doc([rec("   ", click_share=50)]), as_of=AS_OF)
        assert r.rows == [] and r.skipped == 1


class TestRoleFailureIsLoud:
    def test_role_error_names_the_fix_steps(self):
        from src.amazon_sp.sqp import _role_error
        msg = str(_role_error("Access to requested resource is denied"))
        assert "Brand Analytics" in msg
        assert "RE-AUTHORIZE" in msg
        assert "Brand Registry" in msg

    def test_unauthorized_raises_rather_than_returning_empty(self, monkeypatch):
        import src.amazon_sp.sqp as sqp

        def boom(*a, **k):
            raise RuntimeError("403 Forbidden: Access to requested resource is denied")

        monkeypatch.setattr("src.amazon_sp.client.create_report", boom)
        with pytest.raises(BrandAnalyticsRoleError):
            sqp.fetch_sqp(["B0CLHTF8YN"], period="WEEK", ref=date(2026, 8, 21))

    def test_an_ordinary_batch_failure_is_recorded_not_raised(self, monkeypatch):
        import src.amazon_sp.sqp as sqp

        def boom(*a, **k):
            raise RuntimeError("report timed out")

        monkeypatch.setattr("src.amazon_sp.client.create_report", boom)
        r = sqp.fetch_sqp(["B0CLHTF8YN"], period="WEEK", ref=date(2026, 8, 21))
        assert r["rows"] == [] and len(r["errors"]) == 1


class TestIdempotency:
    def test_the_same_keyword_keeps_the_strongest_evidence(self, monkeypatch):
        import src.amazon_sp.sqp as sqp

        monkeypatch.setattr("src.amazon_sp.client.create_report",
                            lambda *a, **k: "report-1")
        monkeypatch.setattr("src.amazon_sp.client.wait_for_report",
                            lambda *a, **k: "doc-1")
        monkeypatch.setattr(
            "src.amazon_sp.client.download_report",
            lambda *a, **k: sqp_doc([rec("tallow balm", click_share=50),
                                     rec("Tallow  Balm", click_share=10)]))
        r = sqp.fetch_sqp(["B0CLHTF8YN"], period="WEEK", ref=date(2026, 8, 21))
        assert len(r["rows"]) == 1
        assert r["rows"][0]["organic_rank"] == 1

    def test_upsert_key_is_stable_across_runs(self):
        """Re-running the same week must update, not duplicate."""
        doc = sqp_doc([rec("tallow balm", click_share=50)])
        a = parse_sqp_json(doc, as_of=AS_OF).rows[0]
        b = parse_sqp_json(doc, as_of=AS_OF).rows[0]
        key = ("asin", "keyword_normalized", "source", "as_of")
        assert tuple(a[k] for k in key) == tuple(b[k] for k in key)


class TestGateStillWorksWithNoData:
    def test_high_bid_unknown_is_still_blocked_when_the_table_is_empty(self):
        from src.amazon_ads.organic_rank import (
            POLICY_NEEDS_CHECK, apply_rank_policy, build_rank_info,
        )
        cfg = {"enabled": True, "high_bid_threshold": 2.30, "brand_tokens": [],
               "stale_after_days": 14, "rank_1_3_max_increase_pct": 8,
               "rank_4_7_max_increase_pct": 12}
        info = build_rank_info(None, "beef tallow chapstick", cfg, date(2026, 8, 21))
        g = apply_rank_policy(2.35, 2.71, info, cfg)
        assert g.policy == POLICY_NEEDS_CHECK


class TestEmptyVsMalformed:
    """An empty week and a wrong-shaped document must not look the same."""

    def test_empty_dataByAsin_is_reported_as_a_real_empty_report(self):
        r = parse_sqp_json(json.dumps({"dataByAsin": []}), as_of=AS_OF)
        assert r.rows == []
        assert r.had_records_key is True
        assert any("present but EMPTY" in w for w in r.warnings)
        assert not any("role is not granted" in w for w in r.warnings)

    def test_missing_key_names_the_top_level_keys(self):
        doc = json.dumps({"reportSpecification": {}, "somethingElse": []})
        r = parse_sqp_json(doc, as_of=AS_OF)
        assert r.had_records_key is False
        assert "reportSpecification" in r.top_level_keys
        assert any("no dataByAsin" in w for w in r.warnings)

    def test_neither_case_raises(self):
        for doc in (json.dumps({"dataByAsin": []}), json.dumps({}), "[]"):
            parse_sqp_json(doc, as_of=AS_OF)


class TestAsinResolution:
    def test_placeholder_asins_fall_back_to_the_catalog(self, monkeypatch):
        """The live bug: configured ASINs existed in no table."""
        import src.amazon_sp.sqp as sqp
        monkeypatch.setattr(sqp, "catalog_asins",
                            lambda **k: [{"asin": "B0REAL0001", "events": 100}])
        r = sqp.resolve_asins(["B0FAKE00001", "B0FAKE00002"])
        assert r["basis"] == "catalog_fallback"
        assert r["asins"] == ["B0REAL0001"]
        assert "appear in no inventory" in r["note"]

    def test_valid_configured_asins_are_used_as_is(self, monkeypatch):
        import src.amazon_sp.sqp as sqp
        monkeypatch.setattr(sqp, "catalog_asins",
                            lambda **k: [{"asin": "B0REAL0001", "events": 5}])
        r = sqp.resolve_asins(["B0REAL0001"])
        assert r["basis"] == "config" and r["asins"] == ["B0REAL0001"]

    def test_no_config_uses_the_catalog(self, monkeypatch):
        import src.amazon_sp.sqp as sqp
        monkeypatch.setattr(sqp, "catalog_asins",
                            lambda **k: [{"asin": "B0REAL0001", "events": 5}])
        assert sqp.resolve_asins([])["basis"] == "catalog"

    def test_a_partially_valid_list_is_kept(self, monkeypatch):
        """One stale ASIN should not discard the operator's whole list."""
        import src.amazon_sp.sqp as sqp
        monkeypatch.setattr(sqp, "catalog_asins",
                            lambda **k: [{"asin": "B0REAL0001", "events": 5}])
        r = sqp.resolve_asins(["B0REAL0001", "B0GONE0001"])
        assert r["basis"] == "config"
        assert r["unknown"] == ["B0GONE0001"]

    def test_catalog_read_failure_does_not_crash(self, monkeypatch):
        import src.amazon_sp.sqp as sqp

        def boom(**k):
            raise RuntimeError("db down")

        monkeypatch.setattr(sqp, "catalog_asins", boom)
        r = sqp.resolve_asins(["B0CONFIG001"])
        assert r["asins"] == ["B0CONFIG001"]


class TestPreviousPeriodRetry:
    def test_an_empty_latest_week_retries_the_one_before(self, monkeypatch):
        import src.amazon_sp.sqp as sqp

        calls = []

        def fake_fetch(asins, period="WEEK", ref=None, timeout=1800):
            calls.append(ref)
            if len(calls) == 1:
                return {"rows": [], "errors": [], "warnings": [], "period": period,
                        "start": "2026-08-09", "end": "2026-08-15", "batches": 1}
            return {"rows": [{"keyword_normalized": "kw"}], "errors": [],
                    "warnings": [], "period": period, "start": "2026-08-02",
                    "end": "2026-08-08", "batches": 1}

        monkeypatch.setattr(sqp, "fetch_sqp", fake_fetch)
        monkeypatch.setattr(sqp, "resolve_asins",
                            lambda *a, **k: {"asins": ["B0X"], "basis": "config",
                                             "unknown": [], "note": ""})
        monkeypatch.setattr("src.amazon_ads.organic_rank.load_config",
                            lambda: {"sqp_auto": {"report_period": "WEEK"}})
        monkeypatch.setattr("src.amazon_ads.organic_rank.upsert_ranks",
                            lambda rows: len(rows))

        r = sqp.sync_sqp(dry_run=True)
        assert len(calls) == 2
        assert r["retried_previous_period"] is True
        assert r["end"] == "2026-08-08"
        assert any("24-48h" in w for w in r["warnings"])

    def test_no_retry_when_the_latest_period_has_data(self, monkeypatch):
        import src.amazon_sp.sqp as sqp
        calls = []

        def fake_fetch(asins, period="WEEK", ref=None, timeout=1800):
            calls.append(ref)
            return {"rows": [{"k": 1}], "errors": [], "warnings": [],
                    "period": period, "start": "2026-08-09", "end": "2026-08-15",
                    "batches": 1}

        monkeypatch.setattr(sqp, "fetch_sqp", fake_fetch)
        monkeypatch.setattr(sqp, "resolve_asins",
                            lambda *a, **k: {"asins": ["B0X"], "basis": "config",
                                             "unknown": [], "note": ""})
        monkeypatch.setattr("src.amazon_ads.organic_rank.load_config",
                            lambda: {"sqp_auto": {}})
        sqp.sync_sqp(dry_run=True)
        assert len(calls) == 1

    def test_no_retry_after_a_transport_error(self, monkeypatch):
        """An error is not evidence of an empty week."""
        import src.amazon_sp.sqp as sqp
        calls = []

        def fake_fetch(asins, period="WEEK", ref=None, timeout=1800):
            calls.append(ref)
            return {"rows": [], "errors": ["timeout"], "warnings": [],
                    "period": period, "start": "2026-08-09", "end": "2026-08-15",
                    "batches": 1}

        monkeypatch.setattr(sqp, "fetch_sqp", fake_fetch)
        monkeypatch.setattr(sqp, "resolve_asins",
                            lambda *a, **k: {"asins": ["B0X"], "basis": "config",
                                             "unknown": [], "note": ""})
        monkeypatch.setattr("src.amazon_ads.organic_rank.load_config",
                            lambda: {"sqp_auto": {}})
        sqp.sync_sqp(dry_run=True)
        assert len(calls) == 1


class TestUpsertShape:
    def test_rows_carry_everything_the_gate_and_table_need(self):
        doc = sqp_doc([rec("Beef Tallow Lip Balm", click_share=58.0, imp_share=31.0)])
        row = parse_sqp_json(doc, as_of=AS_OF).rows[0]
        for k in ("asin", "keyword_normalized", "organic_rank", "source",
                  "as_of", "impression_share_organic"):
            assert k in row, k
        assert row["source"] == SOURCE
        assert row["organic_rank"] == 1

    def test_a_write_failure_is_reported_not_raised(self, monkeypatch):
        import src.amazon_sp.sqp as sqp

        monkeypatch.setattr(sqp, "fetch_sqp",
                            lambda *a, **k: {"rows": [{"x": 1}], "errors": [],
                                             "warnings": [], "period": "WEEK",
                                             "start": "2026-08-09",
                                             "end": "2026-08-15", "batches": 1})
        monkeypatch.setattr(sqp, "resolve_asins",
                            lambda *a, **k: {"asins": ["B0X"], "basis": "config",
                                             "unknown": [], "note": ""})
        monkeypatch.setattr("src.amazon_ads.organic_rank.load_config",
                            lambda: {"sqp_auto": {}})

        def boom(rows):
            from src.amazon_ads.organic_rank import RankSchemaError
            raise RankSchemaError(
                "keyword_organic_rank does not exist — run "
                "supabase/migration_organic_rank.sql")

        monkeypatch.setattr("src.amazon_ads.organic_rank.upsert_ranks", boom)
        monkeypatch.setattr(sqp, "_upsert_weekly", lambda rows: 0)
        r = sqp.sync_sqp(dry_run=False)
        assert r["written"] == 0
        # The real message is surfaced, not a guess about what went wrong.
        assert any("migration_organic_rank.sql" in e for e in r["errors"])


class TestApiErrorDocuments:
    """An SP-API error payload is valid JSON — it must not read as an empty week.

    Discovered live: three ad-hoc runs exhausted the SQP report quota, and the
    QuotaExceeded document parsed as "0 rows", which would then have triggered
    the previous-period retry and spent another unit of the quota that had just
    run out.
    """

    QUOTA = json.dumps({"errors": [{"code": "QuotaExceeded",
                                    "message": "You exceeded your quota for the "
                                               "requested resource.", "details": ""}]})

    def test_quota_document_is_flagged_as_an_error(self):
        r = parse_sqp_json(self.QUOTA, as_of=AS_OF)
        assert r.rows == []
        assert r.api_error_codes == ["QuotaExceeded"]
        assert any("QuotaExceeded" in w for w in r.warnings)

    def test_quota_is_not_reported_as_an_empty_period(self):
        r = parse_sqp_json(self.QUOTA, as_of=AS_OF)
        assert not any("present but EMPTY" in w for w in r.warnings)

    def test_quota_does_not_trigger_the_previous_period_retry(self, monkeypatch):
        """Retrying on a rate limit spends the quota that just ran out."""
        import src.amazon_sp.sqp as sqp
        calls = []

        def fake_fetch(asins, period="WEEK", ref=None, timeout=1800):
            calls.append(ref)
            return {"rows": [], "errors": ["batch 1: SP-API error QuotaExceeded"],
                    "warnings": [], "period": period, "start": "2026-08-09",
                    "end": "2026-08-15", "batches": 1}

        monkeypatch.setattr(sqp, "fetch_sqp", fake_fetch)
        monkeypatch.setattr(sqp, "resolve_asins",
                            lambda *a, **k: {"asins": ["B0X"], "basis": "config",
                                             "unknown": [], "note": ""})
        monkeypatch.setattr("src.amazon_ads.organic_rank.load_config",
                            lambda: {"sqp_auto": {}})
        r = sqp.sync_sqp(dry_run=True)
        assert len(calls) == 1, "must not retry after a quota error"
        assert r["quota_exceeded"] is True
        assert any("QUOTA exceeded" in w for w in r["warnings"])

    def test_a_generic_error_document_is_also_caught(self):
        doc = json.dumps({"errors": [{"code": "InvalidInput", "message": "bad asin"}]})
        r = parse_sqp_json(doc, as_of=AS_OF)
        assert r.api_error_codes == ["InvalidInput"]


class TestSchemaErrorReporting:
    """A rejected write must never be reported as a missing table.

    Live bug: the CHECK on `source` predated the 'sqp_spapi' value, so every
    automated row was rejected with 23514. The caller matched on the table name
    appearing in the error and reported "table missing", which sent the operator
    looking for a schema gap that did not exist while 623 good rows were dropped.
    """

    def test_constraint_violation_is_not_called_a_missing_table(self, monkeypatch):
        import src.amazon_ads.organic_rank as orank

        def boom(table, rows, on_conflict=None):
            raise RuntimeError(
                'new row for relation "keyword_organic_rank" violates check '
                'constraint "keyword_organic_rank_source_check"')

        monkeypatch.setattr("src.db.upsert_rows", boom)
        monkeypatch.setattr(orank, "table_exists", lambda: True)
        with pytest.raises(orank.RankSchemaError) as exc:
            orank.upsert_ranks([{"asin": "A", "keyword_normalized": "k",
                                 "source": "manual", "as_of": "2026-08-15"}])
        assert "not a missing table" in str(exc.value)

    def test_a_genuinely_missing_table_still_says_so(self, monkeypatch):
        import src.amazon_ads.organic_rank as orank

        def boom(table, rows, on_conflict=None):
            raise RuntimeError('relation "keyword_organic_rank" does not exist')

        monkeypatch.setattr("src.db.upsert_rows", boom)
        monkeypatch.setattr(orank, "table_exists", lambda: False)
        with pytest.raises(orank.RankSchemaError) as exc:
            orank.upsert_ranks([{"asin": "A", "keyword_normalized": "k"}])
        assert "does not exist" in str(exc.value)
        assert "migration_organic_rank.sql" in str(exc.value)

    def test_sqp_spapi_falls_back_to_sqp_when_the_check_is_old(self, monkeypatch):
        """Works before the widening migration; warns rather than dropping rows."""
        import src.amazon_ads.organic_rank as orank

        attempts = []

        def flaky(table, rows, on_conflict=None):
            attempts.append([r["source"] for r in rows])
            if attempts[-1][0] == "sqp_spapi":
                raise RuntimeError("violates check constraint "
                                   '"keyword_organic_rank_source_check"')
            return len(rows)

        monkeypatch.setattr("src.db.upsert_rows", flaky)
        monkeypatch.setattr(orank, "table_exists", lambda: True)
        n = orank.upsert_ranks([{"asin": "A", "keyword_normalized": "k",
                                 "source": "sqp_spapi", "as_of": "2026-08-15"}])
        assert n == 1
        assert attempts == [["sqp_spapi"], ["sqp"]]

    def test_table_exists_treats_unknown_errors_as_present(self, monkeypatch):
        """Only 'does not exist'/'schema cache' mean absent."""
        import src.amazon_ads.organic_rank as orank

        class C:
            def table(self, *a):
                raise RuntimeError("permission denied")

        monkeypatch.setattr("src.db.get_client", lambda: C())
        assert orank.table_exists() is True
