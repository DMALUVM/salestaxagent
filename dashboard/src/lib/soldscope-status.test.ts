import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  EMPTY_STATE_COPY,
  HERO_ASINS,
  RT_EMPTY_COPY,
  SOLDSCOPE_OBSERVE_ONLY,
  heroList,
  summarizeFreshness,
} from "./soldscope-status";

describe("SoldScope status (additive research, no second warehouse UI)", () => {
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
      salesRows: 0, bsrRows: 0, priceRows: 0, rankRows: 0, newestDate: null,
    });
    assert.equal(empty.empty, true);
    assert.equal(empty.stored, false);
    assert.match(EMPTY_STATE_COPY, /not a sales or ads number/i);
    assert.match(RT_EMPTY_COPY, /observe-only/);
  });

  test("no dedicated SoldScope page or chart payload", () => {
    const root = process.cwd();
    assert.equal(existsSync(path.join(root, "src/app/ppc/soldscope")), false);
    const page = readFileSync(path.join(root, "src/app/ppc/page.tsx"), "utf8");
    assert.match(page, /SoldScopeCard/);
    assert.doesNotMatch(page, /href="\/ppc\/soldscope"/);
    const api = readFileSync(path.join(root, "src/app/api/soldscope/route.ts"), "utf8");
    assert.match(api, /No time series/);
    assert.doesNotMatch(api, /sparkline|polyline|salesSeries|bsrSeries/);
    const card = readFileSync(path.join(root, "src/components/soldscope-card.tsx"), "utf8");
    assert.doesNotMatch(card, /sparkline|polyline|<svg/);
    assert.match(card, /not a second sales or BSR chart/);
  });
});
