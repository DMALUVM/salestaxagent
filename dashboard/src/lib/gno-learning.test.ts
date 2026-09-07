import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  applyHarvestLearning,
  lastCallForCampaign,
  parseGnoOutcomeLines,
  skipCountFor,
  strongerHarvestOrdersNeeded,
  termFamily,
  type GnoLedgerRow,
} from "./gno-learning";
import { AUTO_LOOSE_NAME, harvestQueue, tagAutoLooseTerm } from "./gno-ppc-watch";
import type { SearchTermRow } from "./gno-ppc-watch";

function skip(term: string, n = 1): GnoLedgerRow[] {
  return Array.from({ length: n }, (_, i) => ({
    dave_action: "skip" as const,
    search_term: term,
    term_family: termFamily(term),
    proposed_tag: "HARVEST_CANDIDATE",
    created_at: `2026-09-0${7 - i}T12:00:00Z`,
  }));
}

describe("GNO learning v1", () => {
  test("term family ignores order and stop words", () => {
    assert.equal(termFamily("organic tallow lip balm"), termFamily("tallow lip balm organic"));
    assert.equal(termFamily("the cheap chapstick"), termFamily("cheap chapstick"));
  });

  test("two skips down-rank HARVEST until stronger L7 orders", () => {
    const term = { orders: 3, spend: 10, search_term: "tallow lip balm organic" };
    assert.equal(tagAutoLooseTerm({ ...term, sales: 30 }, false), "HARVEST_CANDIDATE");
    const once = applyHarvestLearning("HARVEST_CANDIDATE", term, skip(term.search_term, 1));
    assert.equal(once.tag, "HARVEST_CANDIDATE");
    const twice = applyHarvestLearning("HARVEST_CANDIDATE", term, skip(term.search_term, 2));
    assert.equal(twice.tag, "KEEP");
    assert.match(twice.note ?? "", /downranked/);
    assert.equal(strongerHarvestOrdersNeeded(term.search_term, skip(term.search_term, 2)), 5);
    const strong = applyHarvestLearning(
      "HARVEST_CANDIDATE",
      { ...term, orders: 5 },
      skip(term.search_term, 2),
    );
    assert.equal(strong.tag, "HARVEST_CANDIDATE");
  });

  test("approve_harvest_neg remembers a junk pattern", () => {
    const ledger: GnoLedgerRow[] = [{
      dave_action: "approve_harvest_neg",
      search_term: "cheap chapstick",
      term_family: termFamily("cheap chapstick"),
      proposed_tag: "JUNK_CANDIDATE",
    }];
    const learned = applyHarvestLearning(
      "KEEP",
      { orders: 0, spend: 2.5, search_term: "cheap chapstick review" },
      ledger,
    );
    assert.equal(learned.tag, "JUNK_CANDIDATE");
    const unrelated = applyHarvestLearning(
      "KEEP",
      { orders: 0, spend: 3, search_term: "tallow deodorant men" },
      ledger,
    );
    assert.equal(unrelated.tag, "KEEP");
  });

  test("last call on a NEW_EXACT campaign is the newest bid action", () => {
    const name = "SP | TBL | B0CLHVCPL5 | EX | tallow lip balm | TOS";
    const ledger: GnoLedgerRow[] = [
      { dave_action: "hold", campaign_name: name, created_at: "2026-09-07T10:00:00Z" },
      { dave_action: "bid_down", campaign_name: name, created_at: "2026-09-08T10:00:00Z" },
    ];
    assert.equal(lastCallForCampaign(ledger, name), "bid_down");
    assert.equal(lastCallForCampaign(ledger, "other"), null);
  });

  test("paste parser accepts action-first campaigns and action-last terms", () => {
    const rows = parseGnoOutcomeLines([
      "tallow lip balm organic skip",
      "cheap chapstick approve_harvest_neg",
      "hold SP | TBL | B0CLHVCPL5 | EX | tallow lip balm | TOS",
      "bid_down SP | TBL | B0CLHVLG2F | EX | tallow lip balm | TOS",
      "# comment",
      "",
    ].join("\n"));
    assert.equal(rows.length, 4);
    assert.equal(rows[0].dave_action, "skip");
    assert.equal(rows[0].search_term, "tallow lip balm organic");
    assert.equal(rows[1].dave_action, "approve_harvest_neg");
    assert.equal(rows[2].dave_action, "hold");
    assert.match(rows[2].campaign_name ?? "", /B0CLHVCPL5/);
    assert.equal(rows[3].dave_action, "bid_down");
  });

  test("harvestQueue applies learning without changing CSV columns", () => {
    const terms: SearchTermRow[] = [{
      date: "2026-09-06",
      campaign_name: AUTO_LOOSE_NAME,
      search_term: "tallow lip balm organic",
      match_type: "TARGETING_EXPRESSION",
      spend: 8, sales_14d: 24, orders_14d: 3, clicks: 10, impressions: 200,
    }];
    const raw = harvestQueue(terms, [], "2026-09-06");
    assert.equal(raw[0].proposed_tag, "HARVEST_CANDIDATE");
    const learned = harvestQueue(terms, [], "2026-09-06", skip("tallow lip balm organic", 2));
    assert.equal(learned[0].proposed_tag, "KEEP");
    assert.match(learned[0].learning_note ?? "", /downranked/);
    assert.equal(skipCountFor("tallow lip balm organic", skip("organic tallow lip balm", 2)), 2);
  });
});

describe("learning never writes Amazon", () => {
  test("source forbids auto-negate", () => {
    const lib = readFileSync(path.join(process.cwd(), "src/lib/gno-learning.ts"), "utf8");
    const api = readFileSync(path.join(process.cwd(), "src/app/api/ppc/gno-outcome/route.ts"), "utf8");
    for (const src of [lib, api]) {
      assert.match(src, /observe/i);
      assert.doesNotMatch(src, /amazonads|autoPause\(|auto_pause\s*=\s*true/i);
    }
  });
});
