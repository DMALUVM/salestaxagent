import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { NEW_EXACT } from "./gno-ppc-watch";
import { buildOrganicRankJoinIndex } from "./organic-rank-progress";
import {
  COMPETITOR_ASINS,
  COMPETITOR_KR_CSV_HEADERS,
  COMPETITOR_OUTLIER_EMPTY_COPY,
  EXCLUDED_OURS,
  buildCompetitorOutliers,
  classifyExactBidding,
  competitorKrOutliersCsv,
  competitorPresent,
  digestShouldPing,
  extraExactFromWatch,
  netNewActionable,
  suggestLever,
} from "./soldscope-competitor-outliers";

const LIP_COMP = "B0DVVDDR6Y";
const BALM_COMP = "B0BJMSH4JX";
const LIP = "B0CLHTF8YN";

describe("Competitor reverse-ASIN outliers", () => {
  test("config pins 30 competitors and excludes our 1oz balm", () => {
    assert.equal(COMPETITOR_ASINS.length, 30);
    assert.equal(new Set(COMPETITOR_ASINS).size, 30);
    assert.equal(COMPETITOR_ASINS.includes(EXCLUDED_OURS), false);
    assert.equal(COMPETITOR_ASINS.includes(LIP), false);
    const root = JSON.parse(readFileSync(
      path.join(process.cwd(), "config/soldscope_competitors.json"),
      "utf8",
    ));
    assert.equal(root.competitors.length, 30);
    assert.deepEqual(root.excluded_asins, [EXCLUDED_OURS]);
  });

  test("already_bidding is enabled Exact only — Phrase/paused do not count", () => {
    const exact = classifyExactBidding(
      "Tallow Lip Balm",
      [{ keyword_text: "tallow lip balm", match_type: "exact", state: "enabled" }],
    );
    assert.equal(exact.already, true);
    assert.equal(exact.already_bidding, "Y");

    const phrase = classifyExactBidding(
      "grass fed tallow",
      [{ keyword_text: "grass fed tallow", match_type: "phrase", state: "enabled" }],
    );
    assert.equal(phrase.already, false);
    assert.equal(phrase.already_bidding, "N");

    const paused = classifyExactBidding(
      "paused exact",
      [{ keyword_text: "paused exact", match_type: "exact", state: "paused" }],
    );
    assert.equal(paused.already, false);

    const watch = extraExactFromWatch(NEW_EXACT);
    assert.ok(watch.includes("tallow deodorant for men") || watch.some((k) => k.includes("tallow deodorant")));
    const elsewhere = classifyExactBidding(
      "tallow deodorant for men",
      [],
      extraExactFromWatch(NEW_EXACT),
    );
    assert.equal(elsewhere.already, true);
  });

  test("presence + opportunity floor + Exact join set harvest/watch/skip", () => {
    assert.equal(competitorPresent({ organic_rank: 4 }, LIP_COMP), true);
    assert.equal(competitorPresent({ sponsored_asin: LIP_COMP, sponsored_rank: 2 }, LIP_COMP), true);
    assert.equal(competitorPresent({ organic_rank: 0 }, LIP_COMP), false);
    assert.equal(suggestLever({
      alreadyExact: false, present: true, familyFit: true, opportunity: 210,
    }), "harvest_exact");
    assert.equal(suggestLever({
      alreadyExact: true, present: true, familyFit: true, opportunity: 900,
    }), "skip");

    const organicIndex = buildOrganicRankJoinIndex([{
      phrase: "grass fed tallow lip",
      asin: LIP,
      organic_position: 14,
      as_of: "2026-09-11",
      group_id: 3537,
    }]);
    const rows = buildCompetitorOutliers({
      krRows: [
        {
          competitor_asin: LIP_COMP, family: "lip",
          keyword: "grass fed tallow lip", search_volume: 400,
          opportunity_score: 220, organic_rank: 6, as_of: "2026-09-11",
        },
        {
          competitor_asin: LIP_COMP, family: "lip",
          keyword: "tallow lip balm", search_volume: 8000,
          opportunity_score: 500, organic_rank: 2, as_of: "2026-09-11",
        },
        {
          competitor_asin: BALM_COMP, family: "balm",
          keyword: "long tail tallow", search_volume: 90,
          opportunity_score: 40, sponsored_rank: 8, as_of: "2026-09-11",
        },
        {
          competitor_asin: EXCLUDED_OURS, family: "balm",
          keyword: "should drop", opportunity_score: 900, organic_rank: 1,
        },
        {
          competitor_asin: "B0FTS2DC7Y", family: "deo",
          keyword: "no presence", opportunity_score: 800,
        },
      ],
      targets: [
        { keyword_text: "tallow lip balm", match_type: "exact", state: "enabled" },
      ],
      organicIndex,
    });
    const byKw = Object.fromEntries(rows.map((r) => [r.keyword, r]));
    assert.equal(byKw["should drop"], undefined);
    assert.equal(byKw["no presence"], undefined);
    assert.equal(byKw["grass fed tallow lip"]?.already_bidding, "N");
    assert.equal(byKw["grass fed tallow lip"]?.suggested_lever, "harvest_exact");
    assert.equal(byKw["grass fed tallow lip"]?.our_organic_rank, 14);
    assert.equal(byKw["tallow lip balm"]?.already_bidding, "Y");
    assert.equal(byKw["tallow lip balm"]?.suggested_lever, "skip");
    assert.equal(byKw["long tail tallow"]?.suggested_lever, "watch");
  });

  test("net-new harvest_exact is the digest hook; repeats are not", () => {
    const harvest = {
      keyword: "grass fed tallow lip",
      keyword_normalized: "grass fed tallow lip",
      competitor_asin: LIP_COMP,
      our_hero_family: "lip" as const,
      volume: 400,
      sfr: 88,
      opportunity: 220,
      competitor_organic_rank: 6,
      competitor_sponsored_rank: null,
      our_organic_rank: 14,
      already_bidding: "N" as const,
      suggested_lever: "harvest_exact" as const,
      as_of: "2026-09-11",
    };
    const newer = { ...harvest, keyword: "new outlier balm", keyword_normalized: "new outlier balm", competitor_asin: BALM_COMP };
    const net = netNewActionable([harvest, newer], [harvest]);
    assert.deepEqual(net.map((r) => r.keyword), ["new outlier balm"]);
    assert.equal(digestShouldPing(net), true);
    assert.equal(digestShouldPing([]), false);
    assert.deepEqual(netNewActionable([harvest], [harvest]), []);
  });

  test("CSV headers match Blake action fields; empty pack is headers only", () => {
    assert.deepEqual([...COMPETITOR_KR_CSV_HEADERS], [
      "keyword", "competitor_asin", "our_hero_family", "volume", "sfr",
      "opportunity", "competitor_organic_rank", "competitor_sponsored_rank",
      "our_organic_rank", "already_bidding", "suggested_lever",
    ]);
    const empty = competitorKrOutliersCsv([]);
    assert.equal(empty.split("\n")[0], COMPETITOR_KR_CSV_HEADERS.join(","));
    assert.match(COMPETITOR_OUTLIER_EMPTY_COPY, /does not create Rank Tracker/);
  });

  test("GNO hosts the strip — no new research page or SoldScope desk", () => {
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-gno-watch.tsx"), "utf8");
    const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
    const gno = readFileSync(path.join(process.cwd(), "src/app/ppc/gno/page.tsx"), "utf8");
    assert.match(ui, /competitor-kr-outliers/);
    assert.match(ui, /suggested_lever/);
    assert.doesNotMatch(page, /href="\/ppc\/research"/);
    assert.doesNotMatch(gno, /href="\/ppc\/soldscope"/);
    assert.equal(existsSync(path.join(process.cwd(), "src/app/ppc/research")), false);
    const exp = readFileSync(path.join(process.cwd(), "src/app/api/ppc/gno-export/route.ts"), "utf8");
    assert.match(exp, /competitor_kr_outliers/);
    const pack = readFileSync(path.join(process.cwd(), "src/lib/gno-ppc-watch.ts"), "utf8");
    assert.match(pack, /competitor_kr_outliers\.csv/);
  });
});
