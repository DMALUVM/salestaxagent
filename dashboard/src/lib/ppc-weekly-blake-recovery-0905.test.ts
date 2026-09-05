import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  WEEKLY_ACTIONS,
  WEEKLY_GROK_PROMPT_RECOVERY_0905,
  grokPromptFor,
  recTypeOfWeekly,
  weeklyToCsv,
} from "./ppc-weekly";
import {
  BLAKE_RECOVERY_0905_BE,
  BLAKE_RECOVERY_0905_CLICK_FLOOR,
  BLAKE_RECOVERY_0905_ROW_COUNT,
  RECOVERY_0905_CSV,
  buildBlakeRecovery0905List,
  parseRecoverySpecs,
} from "./ppc-weekly-blake-recovery-0905";

const AUTHORITATIVE_CSV = readFileSync(
  path.join(process.cwd(), "src/lib/ppc-weekly-blake-recovery-0905.csv"),
  "utf8",
);

describe("Recovery Sep 5 — exactly 66 execute rows", () => {
  const list = buildBlakeRecovery0905List();

  test("payload has exactly 66 rows; CSV and specs agree", () => {
    assert.equal(BLAKE_RECOVERY_0905_ROW_COUNT, 66);
    assert.equal(list.rows.length, 66);
    assert.equal(list.open_count, 66);
    assert.equal(parseRecoverySpecs().length, 66);
    assert.equal(list.execute_list, "blake_recovery_0905");
    assert.equal(list.execute_ready, true);
    assert.equal(list.click_floor, 6);
    assert.equal(list.break_even_pct, 37.9);
    assert.equal(BLAKE_RECOVERY_0905_BE, 37.9);
    assert.equal(BLAKE_RECOVERY_0905_CLICK_FLOOR, 6);
    assert.equal(list.account_cvr_branded, 41);
    assert.equal(list.account_cvr_nonbranded, 26);
    assert.match(list.window.search.label, /~60d ST/);
    assert.match(list.window.placement?.label ?? "", /~30d placement/);
    assert.match(list.notes[0], /66-row/);
    assert.match(list.notes[0], /BE 37\.9%/);
    assert.match(list.notes[0], /Click floor 6/);
    assert.equal(list.grok_prompt, WEEKLY_GROK_PROMPT_RECOVERY_0905);
    assert.match(list.grok_prompt, /66 rows/);
    assert.doesNotMatch(list.grok_prompt, /36 rows|62-row/);
  });

  test("embedded CSV matches the authoritative file", () => {
    assert.equal(RECOVERY_0905_CSV.replace(/\s+$/, ""), AUTHORITATIVE_CSV.replace(/\s+$/, ""));
  });

  test("ids 1–66 stay in CSV order: cuts, SCALE/DEFEND, GROW, then L7 surgery", () => {
    const ids = list.rows.map((r) => r.id);
    assert.deepEqual(ids, Array.from({ length: 66 }, (_, i) => `recovery-0905-${i + 1}`));
    assert.equal(list.rows[0].rank, "R1");
    assert.equal(list.rows[0].action, "pause_keyword");
    assert.equal(list.rows[0].term, "deodorant men");
    assert.equal(list.rows[14].rank, "R1");
    assert.equal(list.rows[15].rank, "R2");
    assert.equal(list.rows[25].rank, "P1");
    assert.equal(list.rows[31].rank, "HOLD");
    assert.equal(list.rows[31].action, "hold_tos");
    assert.equal(list.rows[32].rank, "SCALE");
    assert.equal(list.rows[35].rank, "DEFEND");
    assert.equal(list.rows[35].action, "brand_defense");
    assert.equal(list.rows[36].rank, "GROW");
    assert.equal(list.rows[36].action, "harvest_exact");
    assert.equal(list.rows[51].action, "raise_tos");
    assert.equal(list.rows[55].action, "budget_up");
    assert.equal(list.rows[61].action, "budget_up");
    assert.equal(list.rows[62].id, "recovery-0905-63");
    assert.equal(list.rows[62].rank, "R2");
    assert.equal(list.rows[62].term, "chapstick");
    assert.equal(list.rows[63].id, "recovery-0905-64");
    assert.equal(list.rows[63].rank, "HOLD");
    assert.equal(list.rows[63].action, "hold_bid");
    assert.equal(list.rows[63].term, "tallow lip balm");
    assert.equal(list.rows[63].campaign, "SP - KW (TOS) - Exact - Tallow Lip Balm KW");
    assert.equal(list.rows[63].new_bid, "DO NOT CHANGE — rank defense");
    assert.match(list.rows[63].why, /Dave 2026-09-05 KEEP tallow lip balm rank defense/);
    assert.doesNotMatch(list.rows[63].why, /Bid down on Exact owner/);
    assert.equal(list.rows[65].id, "recovery-0905-66");
    assert.equal(list.rows[65].term, "tallow deodorant");
    assert.ok(list.rows.slice(0, 32).every((r) => ["R1", "R2", "P1", "HOLD"].includes(r.rank)));
    assert.ok(list.rows.slice(32, 36).every((r) => ["SCALE", "DEFEND"].includes(r.rank)));
    assert.ok(list.rows.slice(36, 62).every((r) => r.rank === "GROW"));
    assert.equal(list.rows[62].action, "bid_down");
    assert.equal(list.rows[64].action, "bid_down");
    assert.equal(list.rows[65].action, "bid_down");
  });

  test("does not invent or alter CSV numbers", () => {
    const organic = list.rows.find((r) => r.id === "recovery-0905-16");
    assert.equal(organic?.clicks, 891);
    assert.equal(organic?.spend, 1616.45);
    assert.equal(organic?.sales, 2804.51);
    assert.equal(organic?.acos, 57.6);
    assert.equal(organic?.term_cvr, 22);
    assert.equal(organic?.new_bid, "live CPC × 0.38 / 0.576");
    const tos = list.rows.find((r) => r.id === "recovery-0905-52");
    assert.equal(tos?.clicks, null);
    assert.equal(tos?.spend, 1052.45);
    assert.equal(tos?.sales, 3345.54);
    assert.equal(tos?.action, "raise_tos");
    const budget = list.rows.find((r) => r.id === "recovery-0905-56");
    assert.equal(budget?.action, "budget_up");
    assert.equal(budget?.current_bid, "budget ~$28/day");
    assert.equal(budget?.new_bid, "+$10–15/day (~$40–45)");
    const spend = list.rows.reduce((s, r) => s + r.spend, 0);
    assert.equal(Math.round(spend * 100) / 100, 21231.34);
  });

  test("action counts and WeeklyAction coverage", () => {
    const count = (action: string) => list.rows.filter((r) => r.action === action).length;
    assert.equal(count("pause_keyword"), 2);
    assert.equal(count("negative_exact"), 13);
    assert.equal(count("bid_down"), 13);
    assert.equal(count("cut_detail_page"), 6);
    assert.equal(count("hold_tos"), 1);
    assert.equal(count("hold_bid"), 1);
    assert.equal(count("bid_up"), 10);
    assert.equal(count("brand_defense"), 1);
    assert.equal(count("harvest_exact"), 8);
    assert.equal(count("raise_tos"), 4);
    assert.equal(count("budget_up"), 7);
    assert.ok(WEEKLY_ACTIONS.includes("hold_tos"));
    assert.ok(WEEKLY_ACTIONS.includes("hold_bid"));
    assert.ok(WEEKLY_ACTIONS.includes("budget_up"));
    assert.ok(WEEKLY_ACTIONS.includes("harvest_exact"));
    assert.ok(WEEKLY_ACTIONS.includes("raise_tos"));
    assert.ok(WEEKLY_ACTIONS.includes("cut_detail_page"));
    assert.ok(WEEKLY_ACTIONS.includes("brand_defense"));
    assert.equal(recTypeOfWeekly("budget_up"), "WEEKLY_BUDGET_UP");
    assert.equal(recTypeOfWeekly("hold_tos"), "WEEKLY_HOLD_TOS");
    assert.equal(recTypeOfWeekly("hold_bid"), "WEEKLY_HOLD_BID");
    for (const r of list.rows) {
      assert.ok(WEEKLY_ACTIONS.includes(r.action), r.action);
    }
  });

  test("organic / lip balm organic stay bid_down; tallow lip balm id 64 is hold_bid; no Amazon writes", () => {
    assert.equal(list.rows.find((r) => r.term === "organic lip balm")?.action, "bid_down");
    assert.equal(list.rows.find((r) => r.term === "lip balm organic")?.action, "bid_down");
    const tallow = list.rows.find((r) => r.id === "recovery-0905-64");
    assert.equal(tallow?.action, "hold_bid");
    assert.equal(tallow?.rank, "HOLD");
    assert.notEqual(tallow?.action, "bid_down");
    assert.equal(
      list.rows.filter((r) => /organic lip balm|lip balm organic/i.test(r.term) && r.action === "pause_keyword").length,
      0,
    );
    const src = readFileSync(path.join(process.cwd(), "src/lib/ppc-weekly-blake-recovery-0905.ts"), "utf8");
    assert.doesNotMatch(src, /amazonads|sp-api.*write|auto-apply/i);
    assert.match(src, /nothing writes to Amazon/i);
  });

  test("CSV export includes Recovery windows and 66 data rows", () => {
    const csv = weeklyToCsv(list.rows);
    const dataLines = csv.trim().split("\n").length - 1;
    assert.equal(dataLines, 66);
    assert.match(csv, /deodorant men/);
    assert.match(csv, /tallow deodorant/);
    assert.match(csv, /2026-07-06\.\.09-04 ~60d ST/);
    assert.match(csv, /budget_up/);
    assert.doesNotMatch(csv, /90d/);
  });

  test("Done/Skipped lock applies without reopening sold rows", () => {
    const locked = buildBlakeRecovery0905List({
      now: new Date("2026-09-05T12:00:00.000Z"),
      decisions: [{
        campaign_id: "401769304051792",
        search_term: "organic lip balm",
        action_type: "bid_down",
        status: "applied",
        applied_at: "2026-09-04T12:00:00.000Z",
      }],
      lookup: {
        campaigns: [{
          campaign_id: "401769304051792",
          campaign_name: "SP KW - Exact(PM) - Lip Balm - DPB0CLHTKY3V/B0CLHVLG2F -",
        }],
        terms: [{
          search_term: "organic lip balm",
          campaign_id: "401769304051792",
          campaign_name: "SP KW - Exact(PM) - Lip Balm - DPB0CLHTKY3V/B0CLHVLG2F -",
        }],
        placements: [],
      },
    });
    const row = locked.rows.find((r) => r.term === "organic lip balm" && r.action === "bid_down");
    assert.equal(row?.status, "done");
    assert.ok(locked.done_count >= 1);
    assert.equal(locked.rows.length, 66);
  });
});

describe("This week wiring is Recovery 66, not 63d or Bleeders 1.0", () => {
  test("GET /api/ppc ships Recovery and keeps bleeders10 secondary", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/ppc/route.ts"), "utf8");
    assert.match(route, /buildBlakeRecovery0905List/);
    assert.match(route, /BLAKE_RECOVERY_0905_START/);
    assert.match(route, /BLAKE_RECOVERY_0905_END/);
    assert.doesNotMatch(route, /buildBlake63dList/);
    assert.doesNotMatch(route, /buildBlake24dList/);
    assert.doesNotMatch(route, /buildBleeders\s*\(/);
    assert.match(route, /buildBleeders10/);
    assert.match(route, /2026-07-06|BLAKE_RECOVERY_0905_START/);
    assert.equal(grokPromptFor("blake_recovery_0905"), WEEKLY_GROK_PROMPT_RECOVERY_0905);
  });

  test("UI is Recovery 66, recommend-only", () => {
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-bleeders.tsx"), "utf8");
    assert.match(ui, /grokPromptFor\("blake_recovery_0905"\)/);
    assert.match(ui, /66-row/);
    assert.match(ui, /BE 37\.9%/);
    assert.match(ui, /Click floor 6/);
    assert.match(ui, /Recovery execute list/);
    assert.match(ui, /ids 63–66/);
    assert.doesNotMatch(ui, /63d Blake-ranked list/);
    assert.doesNotMatch(ui, /amazonads|auto-apply/i);
    assert.match(ui, /Nothing writes to Amazon/);
  });
});
