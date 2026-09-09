import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { AUTO_LOOSE_NAME } from "./gno-ppc-watch";
import {
  OUTLIER_EMPTY_COPY,
  buildKeywordOutliers,
  classifyBidding,
  hasOpportunitySignal,
} from "./soldscope-outliers";

const LIP = "B0CLHTF8YN";
const BALM = "B0DQFKMJFY";

describe("SoldScope keyword outliers", () => {
  test("empty sources invent no rows", () => {
    const rows = buildKeywordOutliers({
      rankRows: [],
      researchRows: [],
      targets: [{ keyword_text: "tallow lip balm", match_type: "exact", state: "enabled" }],
    });
    assert.deepEqual(rows, []);
    assert.match(OUTLIER_EMPTY_COPY, /does not create Rank Tracker groups/);
  });

  test("already_bidding Y for enabled Exact and Auto Loose ST", () => {
    const exact = classifyBidding(
      "Tallow Lip Balm",
      [{ keyword_text: "tallow lip balm", match_type: "exact", state: "enabled" }],
      [],
    );
    assert.equal(exact.already, true);
    assert.match(exact.note, /Exact/);

    const auto = classifyBidding(
      "beef tallow deodorant",
      [],
      [{ search_term: "beef tallow deodorant", campaign_name: AUTO_LOOSE_NAME }],
    );
    assert.equal(auto.already, true);
    assert.match(auto.note, /Auto Loose/);
  });

  test("paused targets and unknown ASINs do not count as bidding or candidates", () => {
    const paused = classifyBidding(
      "unrelated paused term",
      [{ keyword_text: "unrelated paused term", match_type: "exact", state: "paused" }],
      [],
    );
    assert.equal(paused.already, false);

    const rows = buildKeywordOutliers({
      rankRows: [
        { phrase: "secret competitor term", asin: "B00NOTHERO", search_volume: 9000 },
      ],
    });
    assert.deepEqual(rows, []);
  });

  test("unused high-volume RT phrase is an N outlier", () => {
    const rows = buildKeywordOutliers({
      rankRows: [
        { phrase: "tallow lip balm organic", asin: LIP, search_volume: 2400, organic_position: 12 },
        { phrase: "tallow lip balm", asin: LIP, search_volume: 800, organic_position: 3 },
      ],
      targets: [
        { keyword_text: "tallow lip balm", match_type: "exact", state: "enabled" },
      ],
    });
    assert.equal(rows.some((r) => r.keyword === "tallow lip balm organic" && r.already_bidding === "N"), true);
    const organic = rows.find((r) => r.keyword === "tallow lip balm organic");
    assert.equal(organic?.volume, 2400);
    assert.equal(organic?.asin, LIP);
    assert.match(organic?.note ?? "", /RT phrase/);
  });

  test("KR opportunity scores unused keywords without inventing volume", () => {
    const rows = buildKeywordOutliers({
      researchRows: [
        { keyword: "grass fed tallow balm", asin: BALM, search_volume: null, opportunity_score: 620 },
      ],
      targets: [],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].already_bidding, "N");
    assert.equal(rows[0].volume, null);
    assert.equal(rows[0].opportunity, 620);
    assert.equal(hasOpportunitySignal(null, null), false);
    assert.equal(hasOpportunitySignal(0, null), false);
  });

  test("already-bidding whale stays as Y; low-volume covered term is dropped", () => {
    const rows = buildKeywordOutliers({
      rankRows: [
        { phrase: "tallow lip balm", asin: LIP, search_volume: 200 },
      ],
      researchRows: [
        { keyword: "tallow lip balm", asin: LIP, search_volume: 200, opportunity_score: 80 },
        { keyword: "luxury tallow balm", asin: LIP, search_volume: 5000, opportunity_score: 800 },
      ],
      targets: [
        { keyword_text: "tallow lip balm", match_type: "exact", state: "enabled" },
        { keyword_text: "luxury tallow balm", match_type: "phrase", state: "enabled" },
      ],
    });
    assert.equal(rows.some((r) => r.keyword === "tallow lip balm"), false);
    const whale = rows.find((r) => r.keyword === "luxury tallow balm");
    assert.equal(whale?.already_bidding, "Y");
  });

  test("GNO page hosts the checklist — no new SoldScope route", () => {
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-gno-watch.tsx"), "utf8");
    const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
    assert.match(ui, /soldscope-outliers/);
    assert.match(ui, /already_bidding/);
    assert.doesNotMatch(page, /SoldScopeCard/);
    assert.doesNotMatch(page, /href="\/ppc\/soldscope"/);
  });
});
