import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  DEO_EMPTY_COPY,
  FAMILY_EMPTY_COPY,
  RANK_EMPTY_COPY,
  WOW_MOVE_POSITIONS,
  WOW_TOP_N,
  buildOrganicRankProgress,
  classifyWowDelta,
  emptyCopyForFamily,
  filterProgress,
  resolveSfr,
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
