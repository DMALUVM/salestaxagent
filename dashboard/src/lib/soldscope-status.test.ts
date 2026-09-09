import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  EMPTY_STATE_COPY,
  HERO_ASINS,
  RT_EMPTY_COPY,
  SOLDSCOPE_OBSERVE_ONLY,
  attachKeywordIntel,
  formatSoldScopeRank,
  formatSoldScopeStars,
  formatSoldScopeVol,
  heroList,
  mergeAsinIntel,
  mergeKeywordIntel,
  normalizeKeyword,
  rankTrackerCopy,
  summarizeFreshness,
} from "./soldscope-status";

describe("SoldScope status (enrich existing desks, no second warehouse UI)", () => {
  test("heroes are the three locked parents only", () => {
    const heroes = heroList();
    assert.deepEqual(heroes.map((h) => h.asin), [...HERO_ASINS]);
    assert.equal(heroes[0].title.includes("Lip"), true);
    assert.equal(SOLDSCOPE_OBSERVE_ONLY, true);
  });

  test("drops ASINs that are not locked heroes", () => {
    const heroes = heroList(["B0CLHTF8YN", "B00FAKEASIN"]);
    assert.deepEqual(heroes.map((h) => h.asin), ["B0CLHTF8YN"]);
  });

  test("empty freshness invents no stored rows", () => {
    const empty = summarizeFreshness({
      salesRows: 0, bsrRows: 0, priceRows: 0, rankRows: 0,
      ratingsRows: 0, volumeRows: 0, newestDate: null,
    });
    assert.equal(empty.empty, true);
    assert.equal(empty.stored, false);
    assert.match(EMPTY_STATE_COPY, /not a sales or ads number/i);
    assert.match(RT_EMPTY_COPY, /observe-only/);
    assert.equal(rankTrackerCopy(0, 0), RT_EMPTY_COPY);
  });

  test("normalizeKeyword matches the Python rank-gate join key", () => {
    assert.equal(normalizeKeyword("  Tallow   Lip Balm "), "tallow lip balm");
    assert.equal(normalizeKeyword(null), "");
  });

  test("mergeKeywordIntel prefers volume table and keeps newest ranks", () => {
    const intel = mergeKeywordIntel(
      [{ keyword_normalized: "tallow lip balm", search_volume: 900, sv30: 2100, as_of: "2026-09-01" }],
      [
        { phrase: "Tallow Lip Balm", organic_position: 7, sponsored_position: 2, search_volume: 100, as_of: "2026-08-01" },
        { phrase: "tallow lip balm", organic_position: 3, sponsored_position: 1, search_volume: 120, as_of: "2026-09-07" },
      ],
    );
    const hit = intel.get("tallow lip balm");
    assert.equal(hit?.organic_position, 3);
    assert.equal(hit?.sponsored_position, 1);
    assert.equal(hit?.search_volume, 900);
    assert.equal(hit?.sv30, 2100);
  });

  test("attachKeywordIntel leaves gaps as null — never invents", () => {
    const intel = mergeKeywordIntel(
      [{ keyword_normalized: "known term", search_volume: 50, sv30: null, as_of: "2026-09-01" }],
      [],
    );
    const rows = attachKeywordIntel(
      [{ customer_search_term: "known term" }, { customer_search_term: "unknown junk" }],
      (r) => r.customer_search_term,
      intel,
    );
    assert.equal(rows[0].soldscope_sv, 50);
    assert.equal(rows[1].soldscope_sv, null);
    assert.equal(rows[1].soldscope_organic, null);
    assert.equal(formatSoldScopeVol(null), "—");
    assert.equal(formatSoldScopeRank(null), "—");
    assert.equal(formatSoldScopeStars(4.6), "4.6");
  });

  test("mergeAsinIntel keeps latest rating and estimate on heroes only", () => {
    const map = mergeAsinIntel(
      [
        { asin: "B0CLHTF8YN", rating: 4.4, ratings_count: 10, date: "2026-08-01" },
        { asin: "B0CLHTF8YN", rating: 4.7, ratings_count: 18, date: "2026-09-01" },
        { asin: "B00NOTHERO", rating: 5, ratings_count: 99, date: "2026-09-01" },
      ],
      [
        { asin: "B0CLHTF8YN", units: 3, date: "2026-08-01" },
        { asin: "B0CLHTF8YN", units: 11, date: "2026-09-08" },
      ],
    );
    const lip = map.get("B0CLHTF8YN");
    assert.equal(lip?.rating, 4.7);
    assert.equal(lip?.ratings_count, 18);
    assert.equal(lip?.estimate_units, 11);
    assert.equal(map.has("B00NOTHERO"), false);
  });

  test("no dedicated SoldScope page, stub card, or chart payload", () => {
    const root = process.cwd();
    assert.equal(existsSync(path.join(root, "src/app/ppc/soldscope")), false);
    assert.equal(existsSync(path.join(root, "src/components/soldscope-card.tsx")), false);
    const page = readFileSync(path.join(root, "src/app/ppc/page.tsx"), "utf8");
    assert.doesNotMatch(page, /SoldScopeCard/);
    assert.doesNotMatch(page, /href="\/ppc\/soldscope"/);
    assert.match(page, /soldscope_sv/);
    const api = readFileSync(path.join(root, "src/app/api/soldscope/route.ts"), "utf8");
    assert.match(api, /No time series/);
    assert.doesNotMatch(api, /sparkline|polyline|salesSeries|bsrSeries/);
    const gno = readFileSync(path.join(root, "src/components/ppc-gno-watch.tsx"), "utf8");
    assert.match(gno, /SS Vol/);
    assert.match(gno, /Org/);
    assert.match(gno, /Sp/);
    const amazon = readFileSync(path.join(root, "src/app/amazon/page.tsx"), "utf8");
    assert.match(amazon, /Stars/);
    assert.match(amazon, /Reviews/);
    assert.match(amazon, /estimate/);
    const sqp = readFileSync(path.join(root, "src/components/sqp-status.tsx"), "utf8");
    assert.match(sqp, /SoldScope Rank Tracker/);
  });
});
