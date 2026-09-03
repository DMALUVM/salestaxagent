import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  BLEEDERS_10_CAP,
  BLEEDERS_10_CLICK_FLOOR,
  BLEEDERS_10_NONBRAND_CVR,
  BLEEDERS_10_SKIP_TERMS,
  BLEEDERS_10_TITLE,
  BLEEDERS_10_WINDOW_LABEL,
  buildBleeders10,
  resolveBleeders10Action,
} from "./ppc-bleeders-10";
import { buildBlake63dList } from "./ppc-weekly-blake-63d";

const EXPECTED: Array<{
  rank: number; action: "pause_keyword" | "negative_exact";
  term: string; clicks: number; spend: number;
}> = [
  { rank: 1, action: "pause_keyword", term: "deodorant men", clicks: 96, spend: 113.18 },
  { rank: 2, action: "negative_exact", term: "carpe deodorant", clicks: 42, spend: 78.66 },
  { rank: 3, action: "pause_keyword", term: "beef tallow moisturizer", clicks: 31, spend: 59.40 },
  { rank: 4, action: "negative_exact", term: "dr dans cortibalm lip balm", clicks: 32, spend: 58.55 },
  { rank: 5, action: "negative_exact", term: "vanmans deodorant", clicks: 38, spend: 42.78 },
  { rank: 6, action: "negative_exact", term: "beef tallow and honey balm", clicks: 24, spend: 42.37 },
  { rank: 7, action: "negative_exact", term: "coconut oil lip balm", clicks: 21, spend: 40.93 },
  { rank: 8, action: "negative_exact", term: "wild deodorant", clicks: 35, spend: 31.18 },
  { rank: 9, action: "negative_exact", term: "goats milk chapstick", clicks: 18, spend: 29.27 },
  { rank: 10, action: "pause_keyword", term: "tallow balm for face", clicks: 14, spend: 28.48 },
];

describe("Bleeders 1.0 action split", () => {
  test("term equals exact keyword → pause_keyword; else negative_exact", () => {
    assert.equal(resolveBleeders10Action("EXACT", "deodorant men", "deodorant men"), "pause_keyword");
    assert.equal(resolveBleeders10Action("EXACT", "vanmans deodorant", "vanman deodorant"), "negative_exact");
    assert.equal(resolveBleeders10Action("BROAD", "coconut oil lip balm", "+lip +moisturizer"), "negative_exact");
    assert.equal(
      resolveBleeders10Action("TARGETING_EXPRESSION", "carpe deodorant", 'asin="B0CLHYY3BB"'),
      "negative_exact",
    );
  });
});

describe("Bleeders 1.0 is the pasted 10 — not a live scanner, not 22", () => {
  const out = buildBleeders10();

  test("exactly 10 rows in this rank with these numbers", () => {
    assert.equal(out.rows.length, 10);
    assert.equal(BLEEDERS_10_CAP, 10);
    assert.equal(out.click_floor, 6);
    assert.equal(BLEEDERS_10_CLICK_FLOOR, 6);
    assert.equal(out.account_cvr, 25.79);
    assert.equal(BLEEDERS_10_NONBRAND_CVR, 25.79);
    assert.equal(out.title, BLEEDERS_10_TITLE);
    assert.equal(out.window.label, BLEEDERS_10_WINDOW_LABEL);
    assert.equal(out.window.window_start, "2026-06-30");
    assert.equal(out.window.window_end, "2026-08-31");
    assert.match(out.title, /floor 6/);
    assert.match(out.window.label, /63d, SP search terms/);
    for (const exp of EXPECTED) {
      const row = out.rows[exp.rank - 1];
      assert.equal(row.rank, exp.rank);
      assert.equal(row.action, exp.action);
      assert.equal(row.search_term, exp.term);
      assert.equal(row.clicks, exp.clicks);
      assert.equal(row.spend, exp.spend);
      assert.equal(row.sales_14d, 0);
      assert.equal(row.click_floor, 6);
    }
  });

  test("does not re-aggregate — pasted spend/clicks stay put", () => {
    const out2 = buildBleeders10();
    const row = out2.rows[0];
    assert.equal(row.clicks, 96);
    assert.equal(row.spend, 113.18);
    assert.equal(row.sales_14d, 0);
    assert.equal(row.campaign_name, "GG - Deodorant - Exact - SQR - CST");
  });

  test("skips branded $0 and Monday increment rows", () => {
    const terms = out.rows.map((r) => r.search_term.toLowerCase());
    for (const skip of BLEEDERS_10_SKIP_TERMS) {
      assert.equal(terms.includes(skip), false, `must not load ${skip}`);
    }
    assert.equal(terms.includes("vitamin c chapstick"), false);
    assert.equal(terms.includes("orange lip balm"), false);
    assert.equal(terms.includes("nontoxic lip balm"), false);
  });

  test("Done/Skipped from decisions persist on $0 rows", () => {
    const marked = buildBleeders10({
      decisions: [{
        id: "dec-1",
        search_term: "deodorant men",
        action_type: "pause_keyword",
        campaign_id: "GG - Deodorant - Exact - SQR - CST",
        status: "applied",
      }],
    });
    assert.equal(marked.rows[0].status, "done");
    assert.equal(marked.done_count, 1);
    assert.equal(marked.open_count, 9);
  });
});

describe("This week 63d execute list is unchanged", () => {
  test("buildBlake63dList is still This week and is not the 1.0 10", () => {
    const week = buildBlake63dList();
    assert.equal(week.execute_list, "blake_63d");
    assert.ok(week.rows.length > 10, "63d execute list is larger than the 1.0 10");
    assert.equal(week.click_floor, 10);
    assert.ok(week.rows.some((r) => r.action === "bid_down"), "63d still has bid_down");
  });

  test("GET ships bleeders10 as the pasted 10 and bleeders as Blake 63d", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/ppc/route.ts"), "utf8");
    const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
    assert.match(route, /buildBleeders10\s*\(\s*\{/);
    assert.match(route, /bleeders10/);
    assert.match(route, /buildBlake63dList/);
    assert.doesNotMatch(route, /buildBleeders\s*\(/);
    assert.doesNotMatch(route, /from "@\/lib\/ppc-bleeders"/);
    assert.doesNotMatch(route, /Bleeders10TermRow|allCampaignRows as Bleeders10/);
    assert.match(page, /PpcBleeders10/);
    assert.match(page, /Bleeders 1\.0/);
    assert.match(page, /<PpcBleeders/);
    assert.match(page, /This week/);
    assert.match(page, /useState<"search" \| "campaigns" \| "bleeders">\("bleeders"\)/);
  });
});
