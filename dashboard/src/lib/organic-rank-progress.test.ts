import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  BASELINE_WEEK_COPY,
  DEO_EMPTY_COPY,
  FAMILY_EMPTY_COPY,
  RANK_EMPTY_COPY,
  WOW_MOVE_POSITIONS,
  WOW_TOP_N,
  buildOrganicRankProgress,
  cellHoverTitle,
  cellPriorRank,
  classifyMovement,
  classifyWowDelta,
  emptyCopyForFamily,
  filterProgress,
  formatCellRank,
  formatSignedDelta,
  rankDelta,
  resolveSfr,
  sortHeatmapRows,
  sparklineGeometry,
  sparklineSeries,
  wowLabel,
} from "./organic-rank-progress";

describe("organic rank WoW classification", () => {
  test("flags improve ≥5 or enter top 50; worsen ≥5 or exit top 50", () => {
    assert.equal(WOW_MOVE_POSITIONS, 5);
    assert.equal(WOW_TOP_N, 50);
    assert.deepEqual(classifyWowDelta(12, 6), {
      direction: "improved", reason: "moved", delta: 6,
    });
    assert.deepEqual(classifyWowDelta(6, 14), {
      direction: "worsened", reason: "moved", delta: -8,
    });
    assert.deepEqual(classifyWowDelta(62, 48), {
      direction: "improved", reason: "entered_top_n", delta: 14,
    });
    assert.deepEqual(classifyWowDelta(48, 62), {
      direction: "worsened", reason: "exited_top_n", delta: -14,
    });
    assert.deepEqual(classifyWowDelta(null, 12), {
      direction: "improved", reason: "entered_top_n", delta: null,
    });
    assert.deepEqual(classifyWowDelta(9, null), {
      direction: "worsened", reason: "exited_top_n", delta: null,
    });
    assert.equal(classifyWowDelta(20, 18), null);
    assert.equal(classifyWowDelta(80, 78), null);
    assert.equal(classifyWowDelta(null, 80), null);
    assert.equal(classifyWowDelta(null, null), null);
  });

  test("SFR is ABA only — never invented from search volume", () => {
    assert.deepEqual(resolveSfr(120), { sfr: 120, source: "aba" });
    assert.deepEqual(resolveSfr(null), { sfr: null, source: null });
    assert.deepEqual(resolveSfr(0), { sfr: null, source: null });
  });
});

describe("organic rank progress view", () => {
  test("empty snapshots keep honest empty copy — including deo", () => {
    const empty = buildOrganicRankProgress({ snapshots: [] });
    assert.equal(empty.empty, true);
    assert.equal(empty.rows.length, 0);
    assert.equal(empty.movers.length, 0);
    assert.equal(empty.emptyCopy, RANK_EMPTY_COPY);
    assert.match(RANK_EMPTY_COPY, /never creates Rank Tracker groups/);
    assert.match(DEO_EMPTY_COPY, /B0HBSZ71XQ/);
    assert.match(DEO_EMPTY_COPY, /never creates/);
    assert.equal(emptyCopyForFamily("deo"), DEO_EMPTY_COPY);
    assert.equal(emptyCopyForFamily("lip"), FAMILY_EMPTY_COPY);
    const deo = filterProgress(empty, "deo");
    assert.equal(deo.empty, true);
    assert.equal(deo.emptyCopy, DEO_EMPTY_COPY);
  });

  test("heatmap sorts by SFR and flags WoW from prior week", () => {
    const progress = buildOrganicRankProgress({
      snapshots: [
        {
          phrase: "tallow lip balm", asin: "B0CLHTF8YN", as_of: "2026-08-30",
          organic_position: 18, aba_search_frequency_rank: 90,
        },
        {
          phrase: "tallow lip balm", asin: "B0CLHTF8YN", as_of: "2026-09-06",
          organic_position: 8, aba_search_frequency_rank: 80,
        },
        {
          phrase: "chapstick", asin: "B0CLHTF8YN", as_of: "2026-09-06",
          organic_position: 40, aba_search_frequency_rank: 20,
        },
        {
          phrase: "tallow balm", asin: "B0DQFKMJFY", as_of: "2026-09-06",
          organic_position: 55, organic_previous_position: 30,
          aba_search_frequency_rank: 200,
        },
      ],
      sqpRows: [{
        asin: "B0CLHTF8YN", query_normalized: "tallow lip balm",
        week_start: "2026-08-30", click_share: 0.12,
      }],
      korRows: [{
        asin: "B0CLHTF8YN", keyword_normalized: "tallow lip balm",
        as_of: "2026-08-30", organic_rank: 5,
      }],
    });
    assert.equal(progress.empty, false);
    assert.deepEqual(progress.weeks, ["2026-08-30", "2026-09-06"]);
    assert.equal(progress.rows[0].keyword_normalized, "chapstick");
    assert.equal(progress.rows[0].sfr, 20);
    const lip = progress.rows.find((r) => r.keyword_normalized === "tallow lip balm");
    assert.equal(lip?.current, 8);
    assert.equal(lip?.previous, 18);
    assert.equal(lip?.wow?.direction, "improved");
    assert.equal(lip?.sfr, 80);
    assert.equal(lip?.sfr_source, "aba");
    assert.equal(lip?.sqp_click_share, 0.12);
    assert.equal(lip?.sqp_organic_rank, 5);
    const balm = progress.rows.find((r) => r.keyword_normalized === "tallow balm");
    assert.equal(balm?.previous, 30);
    assert.equal(balm?.wow?.reason, "exited_top_n");
    assert.equal(progress.movers.length >= 2, true);
    assert.match(wowLabel(lip!.wow), /Up 10/);
    const deoOnly = filterProgress(progress, "deo");
    assert.equal(deoOnly.empty, true);
    assert.equal(deoOnly.emptyCopy, DEO_EMPTY_COPY);
  });

  test("does not invent SFR from SoldScope searchVolume on snapshots", () => {
    const progress = buildOrganicRankProgress({
      snapshots: [{
        phrase: "tallow lip balm", asin: "B0CLHTF8YN", as_of: "2026-09-06",
        organic_position: 4, search_volume: 8800,
      }],
    });
    assert.equal(progress.rows[0].sfr, null);
    assert.equal(progress.rows[0].sfr_source, null);
    assert.equal(progress.rows[0].current, 4);
  });

  test("lives on existing PPC surfaces — no parallel SoldScope desk", () => {
    const root = process.cwd();
    const ppc = readFileSync(path.join(root, "src/app/ppc/page.tsx"), "utf8");
    const gno = readFileSync(path.join(root, "src/components/ppc-gno-watch.tsx"), "utf8");
    assert.match(ppc, /OrganicRankHeatmap/);
    assert.match(ppc, /organic-rank/);
    assert.match(gno, /OrganicRankHeatmap/);
    assert.equal(existsSync(path.join(root, "src/app/ppc/soldscope")), false);
    assert.equal(existsSync(path.join(root, "src/app/ppc/organic-rank")), false);
    assert.doesNotMatch(ppc, /href="\/ppc\/soldscope"/);
  });
});

describe("organic rank Δ display + any-move vs meaningful", () => {
  test("rankDelta is prev − current and null when either side is missing", () => {
    assert.equal(rankDelta(12, 9), 3);
    assert.equal(rankDelta(9, 12), -3);
    assert.equal(rankDelta(12, 12), 0);
    assert.equal(rankDelta(null, 12), null);
    assert.equal(rankDelta(12, null), null);
    assert.equal(rankDelta(0, 4), null);
  });

  test("classifyMovement splits any-move (1–4) from meaningful (≥5 / top 50)", () => {
    assert.deepEqual(classifyMovement(20, 18), {
      delta: 2, direction: "improved", anyMove: true, meaningful: false,
    });
    assert.deepEqual(classifyMovement(18, 20), {
      delta: -2, direction: "worsened", anyMove: true, meaningful: false,
    });
    assert.deepEqual(classifyMovement(12, 6), {
      delta: 6, direction: "improved", anyMove: true, meaningful: true,
    });
    assert.deepEqual(classifyMovement(6, 14), {
      delta: -8, direction: "worsened", anyMove: true, meaningful: true,
    });
    assert.deepEqual(classifyMovement(20, 20), {
      delta: 0, direction: "unchanged", anyMove: false, meaningful: false,
    });
    assert.deepEqual(classifyMovement(null, 12), {
      delta: null, direction: "improved", anyMove: false, meaningful: true,
    });
    assert.deepEqual(classifyMovement(null, 80), {
      delta: null, direction: "unknown", anyMove: false, meaningful: false,
    });
    assert.deepEqual(classifyMovement(null, null), {
      delta: null, direction: "unknown", anyMove: false, meaningful: false,
    });
  });

  test("Δ labels and hover copy never invent ranks or SFR", () => {
    assert.equal(formatSignedDelta(3), "↑3");
    assert.equal(formatSignedDelta(-2), "↓2");
    assert.equal(formatSignedDelta(0), "0");
    assert.equal(formatSignedDelta(null), "");
    assert.equal(formatCellRank(12), "#12");
    assert.equal(formatCellRank(null), "—");
    assert.equal(cellHoverTitle({ previous: 18, current: 12, sfr: 80 }), "18 → 12 (↑6) · SFR 80");
    assert.equal(cellHoverTitle({ previous: 12, current: 12, sfr: 80 }), "12 → 12 (0) · SFR 80");
    assert.equal(cellHoverTitle({ previous: null, current: 12, sfr: null }), "— → 12 · SFR —");
    assert.equal(cellHoverTitle({ previous: 18, current: null }), "18 → —");
  });

  test("one-week sparkline is prior→current; cell prior uses SoldScope previous", () => {
    const progress = buildOrganicRankProgress({
      snapshots: [{
        phrase: "eos lip balm", asin: "B0CLHTF8YN", as_of: "2026-09-11",
        organic_position: 119, organic_previous_position: 121,
        aba_search_frequency_rank: 3715,
      }],
    });
    assert.equal(progress.baselineOnly, true);
    assert.match(BASELINE_WEEK_COPY, /First baseline week/);
    const row = progress.rows[0];
    assert.equal(row.previous, 121);
    assert.equal(row.current, 119);
    assert.equal(row.wow, null);
    assert.equal(classifyMovement(row.previous, row.current).anyMove, true);
    assert.equal(classifyMovement(row.previous, row.current).meaningful, false);
    assert.deepEqual(sparklineSeries(row, progress.weeks), [121, 119]);
    assert.equal(cellPriorRank(row, "2026-09-11", progress.weeks), 121);
    const geo = sparklineGeometry([121, 119]);
    assert.equal(geo.direction, "improved");
    assert.equal(geo.points.length, 2);
    assert.ok(geo.points[1].y < geo.points[0].y);
  });

  test("two-week cells use the prior week column, not API previous", () => {
    const progress = buildOrganicRankProgress({
      snapshots: [
        {
          phrase: "tallow lip balm", asin: "B0CLHTF8YN", as_of: "2026-08-30",
          organic_position: 18, aba_search_frequency_rank: 90,
        },
        {
          phrase: "tallow lip balm", asin: "B0CLHTF8YN", as_of: "2026-09-06",
          organic_position: 8, organic_previous_position: 99,
          aba_search_frequency_rank: 80,
        },
      ],
    });
    const row = progress.rows[0];
    assert.equal(progress.baselineOnly, false);
    assert.deepEqual(sparklineSeries(row, progress.weeks), [18, 8]);
    assert.equal(cellPriorRank(row, "2026-08-30", progress.weeks), null);
    assert.equal(cellPriorRank(row, "2026-09-06", progress.weeks), 18);
    assert.equal(row.previous, 18);
  });

  test("Moved sort puts meaningful, then any-move, then still", () => {
    const progress = buildOrganicRankProgress({
      snapshots: [
        {
          phrase: "still", asin: "B0CLHTF8YN", as_of: "2026-09-11",
          organic_position: 10, organic_previous_position: 10,
          aba_search_frequency_rank: 1,
        },
        {
          phrase: "nudge", asin: "B0CLHTF8YN", as_of: "2026-09-11",
          organic_position: 18, organic_previous_position: 20,
          aba_search_frequency_rank: 2,
        },
        {
          phrase: "leap", asin: "B0CLHTF8YN", as_of: "2026-09-11",
          organic_position: 8, organic_previous_position: 20,
          aba_search_frequency_rank: 3,
        },
      ],
    });
    const sorted = sortHeatmapRows(progress.rows, "moved");
    assert.deepEqual(sorted.map((r) => r.keyword_normalized), ["leap", "nudge", "still"]);
  });

  test("deo with snapshots is not the stale empty copy", () => {
    const progress = buildOrganicRankProgress({
      snapshots: [{
        phrase: "natural deodorant", asin: "B0HBSZ71XQ", as_of: "2026-09-11",
        organic_position: 104, aba_search_frequency_rank: 24985,
      }],
    });
    const deo = filterProgress(progress, "deo");
    assert.equal(deo.empty, false);
    assert.equal(deo.rows[0].current, 104);
    assert.equal(deo.rows[0].previous, null);
    assert.notEqual(deo.emptyCopy, DEO_EMPTY_COPY);
  });

  test("heatmap encodes Δ, sparkline, and drops the stale deo legend", () => {
    const root = process.cwd();
    const heat = readFileSync(path.join(root, "src/components/organic-rank-heatmap.tsx"), "utf8");
    assert.match(heat, /formatSignedDelta/);
    assert.match(heat, /RankSpark/);
    assert.match(heat, /BASELINE_WEEK_COPY/);
    assert.match(heat, /Moved/);
    assert.doesNotMatch(heat, /Deo stays empty/);
    assert.doesNotMatch(heat, /until a Rank Tracker group exists/);
  });
});
