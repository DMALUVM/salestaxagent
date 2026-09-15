import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  BLEEDERS_10_BLURB,
  BLEEDERS_10_CAP,
  BLEEDERS_10_CLICK_FLOOR,
  BLEEDERS_10_NONBRAND_CVR,
  BLEEDERS_10_SKIP_TERMS,
  BLEEDERS_10_TITLE,
  BLEEDERS_10_VERIFY,
  BLEEDERS_10_WINDOW_LABEL,
  actionLabelOf10,
  bleeders10DistinctCampaignId,
  bleeders10TermsEqual,
  buildBleeders10,
  resolveBleeders10Action,
  suggestedActionCopy,
} from "./ppc-bleeders-10";
import { buildBlakeRecovery0905List } from "./ppc-weekly-blake-recovery-0905";
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
  test("pause_keyword only when Exact AND search_term equals the keyword", () => {
    assert.equal(resolveBleeders10Action("EXACT", "deodorant men", "deodorant men"), "pause_keyword");
    assert.equal(resolveBleeders10Action("EXACT", "vanmans deodorant", "vanman deodorant"), "negative_exact");
    assert.equal(resolveBleeders10Action("EXACT", "deodorant men", ""), "negative_exact");
    assert.equal(resolveBleeders10Action("EXACT", "deodorant men", null), "negative_exact");
    assert.equal(resolveBleeders10Action("PHRASE", "deodorant men", "deodorant men"), "negative_exact");
    assert.equal(resolveBleeders10Action("BROAD", "coconut oil lip balm", "+lip +moisturizer"), "negative_exact");
    assert.equal(
      resolveBleeders10Action("TARGETING_EXPRESSION", "carpe deodorant", 'asin="B0CLHYY3BB"'),
      "negative_exact",
    );
    assert.equal(
      resolveBleeders10Action("TARGETING_EXPRESSION_PREDEFINED", "wild deodorant", "close-match"),
      "negative_exact",
    );
    assert.equal(resolveBleeders10Action("", "deodorant men", "deodorant men"), null);
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
      assert.equal(row.orders, 0);
      assert.equal(row.click_floor, 6);
    }
  });

  test("Why text repeats the same clicks and spend as row fields", () => {
    for (const row of out.rows) {
      assert.match(row.why, new RegExp(`${row.clicks} click`));
      assert.ok(row.why.includes(row.spend.toFixed(2)), `${row.search_term} why missing spend`);
      assert.equal(row.orders, 0);
      assert.equal(row.sales_14d, 0);
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

  test("every row action matches the classifier; pause rows are Exact term===keyword", () => {
    for (const row of out.rows) {
      assert.equal(
        row.action,
        resolveBleeders10Action(row.match_type, row.search_term, row.keyword),
        `rank ${row.rank} ${row.search_term}`,
      );
      assert.equal(row.action_label, actionLabelOf10(row));
      assert.equal(row.suggested_action, suggestedActionCopy(row));
      if (row.action === "pause_keyword") {
        assert.equal(row.match_type.toUpperCase(), "EXACT");
        assert.ok(row.keyword, `rank ${row.rank} pause needs a keyword`);
        assert.ok(
          bleeders10TermsEqual(row.search_term, row.keyword),
          `rank ${row.rank} pause requires search_term === keyword`,
        );
        assert.match(row.action_label, /Pause Exact keyword/);
        assert.match(row.suggested_action, /Keywords → find Exact/);
        assert.match(row.suggested_action, /do not add Negative exact/i);
        assert.match(row.why, /this search term IS the Exact keyword/i);
        assert.match(row.why, /do not invent a pause/i);
      } else {
        assert.equal(row.action, "negative_exact");
        assert.match(row.action_label, /Negative exact on search term/);
        assert.match(row.suggested_action, /Negative keywords/);
        assert.match(row.suggested_action, /search term/);
        assert.doesNotMatch(row.suggested_action, /Keywords → find Exact/);
        assert.match(row.why, /Do not pause a keyword/);
      }
    }
  });

  test("mismatched Exact, Auto, and ASIN rows are negative_exact — not pause", () => {
    const r2 = out.rows.find((r) => r.rank === 2);
    const r5 = out.rows.find((r) => r.rank === 5);
    const r6 = out.rows.find((r) => r.rank === 6);
    const r7 = out.rows.find((r) => r.rank === 7);
    const r8 = out.rows.find((r) => r.rank === 8);
    const r9 = out.rows.find((r) => r.rank === 9);
    assert.equal(r2?.search_term, "carpe deodorant");
    assert.match(r2?.keyword ?? "", /B0CLHYY3BB/);
    assert.equal(r2?.action, "negative_exact");
    assert.match(r2?.why ?? "", /ASIN targeting asin="B0CLHYY3BB"/);
    assert.equal(r5?.search_term, "vanmans deodorant");
    assert.equal(r5?.keyword, "vanman deodorant");
    assert.equal(r5?.match_type, "EXACT");
    assert.equal(r5?.action, "negative_exact");
    assert.equal(r6?.search_term, "beef tallow and honey balm");
    assert.equal(r6?.keyword, "beef tallow honey balm");
    assert.equal(r6?.action, "negative_exact");
    assert.equal(r7?.match_type, "BROAD");
    assert.equal(r7?.action, "negative_exact");
    assert.equal(r8?.search_term, "wild deodorant");
    assert.equal(r8?.match_type, "TARGETING_EXPRESSION_PREDEFINED");
    assert.equal(r8?.action, "negative_exact");
    assert.equal(r9?.search_term, "goats milk chapstick");
    assert.equal(r9?.keyword, "goat milk chapstick");
    assert.equal(r9?.action, "negative_exact");
  });

  test("pause rows 1/3/10 are the Exact KW that equals the search term", () => {
    for (const rank of [1, 3, 10]) {
      const row = out.rows.find((r) => r.rank === rank);
      assert.ok(row);
      assert.equal(row?.action, "pause_keyword");
      assert.equal(row?.match_type, "EXACT");
      assert.ok(bleeders10TermsEqual(row?.search_term, row?.keyword));
    }
    assert.equal(out.rows[0].search_term, "deodorant men");
    assert.equal(out.rows[0].keyword, "deodorant men");
    assert.match(out.rows[0].suggested_action, /deodorant men/);
    assert.match(out.notes.join("\n"), /SP Search Term report/);
    assert.match(BLEEDERS_10_BLURB, /Pause only when the customer query equals an Exact keyword/);
    assert.match(BLEEDERS_10_VERIFY, /Nothing writes to Amazon/);
  });

  test("desk UI always shows search term, keyword, and baked-in how-to", () => {
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-bleeders-10.tsx"), "utf8");
    assert.match(ui, /BLEEDERS_10_BLURB/);
    assert.match(ui, /BLEEDERS_10_VERIFY/);
    assert.match(ui, /Search term/);
    assert.match(ui, /Keyword \/ targeting/);
    assert.match(ui, /action_label/);
    assert.match(ui, /suggested_action/);
    assert.match(ui, /same Exact KW as the search term/);
    assert.match(ui, /already_applied/);
    assert.match(ui, /Already applied in Ads/);
    assert.doesNotMatch(ui, />\{r\.action\}</);
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

describe("This week Recovery list is not the 1.0 10", () => {
  test("buildBlakeRecovery0905List is This week and is not the 1.0 10", () => {
    const week = buildBlakeRecovery0905List();
    assert.equal(week.execute_list, "blake_recovery_0905");
    assert.equal(week.rows.length, 66);
    assert.equal(week.click_floor, 6);
    assert.ok(week.rows.some((r) => r.action === "bid_down"));
    const retired = buildBlake63dList();
    assert.equal(retired.execute_list, "blake_63d");
    assert.ok(retired.rows.length > 10);
  });

  test("GET ships bleeders10 as the pasted 10 and bleeders as Recovery 66", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/ppc/route.ts"), "utf8");
    const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
    assert.match(route, /buildBleeders10\s*\(\s*\{/);
    assert.match(route, /ads_negatives/);
    assert.match(route, /ads_keyword_targets/);
    assert.match(route, /bleeders10/);
    assert.match(route, /buildBlakeRecovery0905List/);
    assert.doesNotMatch(route, /buildBlake63dList/);
    assert.doesNotMatch(route, /buildBleeders\s*\(/);
    assert.doesNotMatch(route, /from "@\/lib\/ppc-bleeders"/);
    assert.doesNotMatch(route, /Bleeders10TermRow|allCampaignRows as Bleeders10/);
    assert.doesNotMatch(route, /ppc-bleeders-10-live/);
    assert.equal(
      existsSync(path.join(process.cwd(), "src/lib/ppc-bleeders-10-live.ts")),
      false,
      "live 1.0 scanner stays off until Monday",
    );
    assert.match(page, /PpcBleeders10/);
    assert.match(page, /Bleeders 1\.0/);
    assert.match(page, /<PpcBleeders/);
    assert.match(page, /This week/);
    assert.match(page, /useState<"search" \| "campaigns" \| "bleeders">\("bleeders"\)/);
  });

  test("Bleeders 1.0 table surfaces Orders/Sales and one copyable campaign name", () => {
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-bleeders-10.tsx"), "utf8");
    assert.match(ui, />Orders</);
    assert.match(ui, />Sales</);
    assert.match(ui, /\{r\.orders\}/);
    assert.match(ui, /r\.sales_14d/);
    assert.match(ui, /navigator\.clipboard/);
    assert.match(ui, /CampaignCell name=\{r\.campaign_name\} campaignId=\{r\.campaign_id\}/);
    assert.match(ui, /CopyableName value=\{name\} label="campaign name"/);
    assert.match(ui, /bleeders10DistinctCampaignId/);
    assert.match(ui, /no SP-API id on pasted 1\.0/);
    assert.doesNotMatch(ui, /Campaign ID \(= name/);
    assert.doesNotMatch(ui, /CopyableName value=\{r\.campaign_id\}/);
    assert.match(ui, /CopyableName value=\{r\.ad_group_name\}/);
    assert.match(ui, /CopyableName value=\{r\.search_term\}/);
    assert.match(ui, /CopyableName value=\{r\.match_type\}/);
    assert.match(ui, /Verify in Amazon Ads/);
    assert.match(ui, /Verify in Ads: SP Search Term report/);
    assert.match(ui, /data\.window\.window_start/);
    assert.match(ui, /data\.window\.window_end/);
    assert.match(ui, /Hide evidence/);
    assert.doesNotMatch(ui, /max-w-\[12rem\] truncate/);
    assert.doesNotMatch(
      ui,
      /CampaignCell[\s\S]{0,400}window_start\}\.\.\{data\.window\.window_end\}/,
    );
  });
});

describe("Bleeders 1.0 campaign id is not a second copy of the name", () => {
  test("pasted 1.0 rows store campaign_id as the name", () => {
    for (const row of buildBleeders10().rows) {
      assert.equal(row.campaign_id, row.campaign_name, row.search_term);
      assert.equal(bleeders10DistinctCampaignId(row.campaign_name, row.campaign_id), null);
    }
  });

  test("distinct Ads id is returned only when it differs from the name", () => {
    assert.equal(bleeders10DistinctCampaignId("GG - Lip Balm - Asin Offense", "GG - Lip Balm - Asin Offense"), null);
    assert.equal(bleeders10DistinctCampaignId("GG - Lip Balm - Asin Offense", "  GG - Lip Balm - Asin Offense  "), null);
    assert.equal(bleeders10DistinctCampaignId("GG - Lip Balm - Asin Offense", ""), null);
    assert.equal(bleeders10DistinctCampaignId("GG - Lip Balm - Asin Offense", null), null);
    assert.equal(
      bleeders10DistinctCampaignId("GG - Lip Balm - Asin Offense", "1234567890"),
      "1234567890",
    );
  });
});
