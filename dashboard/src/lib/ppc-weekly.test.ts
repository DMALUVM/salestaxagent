import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  SEARCH_TERM_EXECUTE_MIN_DAYS,
  WEEKLY_ACTIONS,
  WEEKLY_CADENCE,
  WEEKLY_CSV_HEADERS,
  WEEKLY_GROK_PROMPT,
  WEEKLY_HOLD,
  WEEKLY_LOCK_DAYS,
  applyWeeklyLocks,
  emptyWeeklyList,
  inclusiveDays,
  isExecuteWindowReady,
  isWeeklyLocked,
  newBidDown,
  newBidDownFromAcosPct,
  newBidUp,
  recTypeOfWeekly,
  shouldSkipRegeneration,
  storedWindow,
  weeklyLockKey,
  weeklyToCsv,
} from "./ppc-weekly";
import {
  BLAKE_24D_WINDOW_CHIP,
  BLAKE_24D_WINDOW_LABEL,
  buildBlake24dList,
} from "./ppc-weekly-blake-24d";

describe("90d helper still empty — this week is the 24d Blake list", () => {
  test("Aug 6–29 is 24d; 90d gate stays for later Mondays", () => {
    assert.equal(inclusiveDays("2026-08-06", "2026-08-29"), 24);
    assert.equal(isExecuteWindowReady(24), false);
    assert.equal(isExecuteWindowReady(SEARCH_TERM_EXECUTE_MIN_DAYS - 1), false);
    assert.equal(isExecuteWindowReady(90), true);
  });

  test("emptyWeeklyList still ships zero rows (next-Monday helper)", () => {
    const short = emptyWeeklyList({
      search: storedWindow(["2026-08-06", "2026-08-29"]),
      account_cvr: 27.55,
      click_floor: 10,
    });
    assert.equal(short.rows.length, 0);
    assert.equal(short.open_count, 0);
    assert.equal(short.execute_list, "empty");
    assert.equal(short.execute_ready, false);
  });

  test("GET /api/ppc ships Blake 24d and does not call buildBleeders", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/ppc/route.ts"), "utf8");
    assert.match(route, /buildBlake24dList/);
    assert.doesNotMatch(route, /buildBleeders\s*\(/);
    assert.doesNotMatch(route, /from "@\/lib\/ppc-bleeders"/);
    assert.match(route, /2026-08-06/);
    assert.match(route, /2026-08-29/);
  });
});

describe("Blake 24d execute list", () => {
  const lookup = {
    campaigns: [
      { campaign_id: "193871638584961", campaign_name: "GG - Deodorant - Exact - SQR - CST" },
      { campaign_id: "203560398305186", campaign_name: "GG - Lip Balm - Exact - Untargeted" },
      { campaign_id: "212191849663644", campaign_name: "GG - Lip Balm - Exact - SQR - Untargeted 2" },
      { campaign_id: "16665771966353", campaign_name: "GG - SP - KW - Tallow Balm - B0CLF5B27Y - Exact 4" },
      { campaign_id: "10892789463718", campaign_name: "GG - Lip Balm - Exact - ChapStick related" },
      { campaign_id: "118866948630084", campaign_name: "SP - ASIN - COMP - Exact - Tallow Deodorant - B0CLHYY3BB -" },
      { campaign_id: "256130024359061", campaign_name: "GG - B0CLHYY3BB - Deodorant - Asin Defense" },
      { campaign_id: "167075799532625", campaign_name: "GG - Lip Balm - Asin Offense - Lip Balm Category" },
      { campaign_id: "134972807416543", campaign_name: "SP - KW - Men's Deodorant - Phrase - Deodorant - B0CLHYY3BB -" },
      { campaign_id: "401769304051792", campaign_name: "SP KW - Exact(PM) - Lip Balm - DPB0CLHTKY3V/B0CLHVLG2F -" },
      { campaign_id: "209616848808384", campaign_name: "SP - 1KW(900kSV/ROS-PP) - Exact - Lip Balm - B0CLHTKY3V - -lip balm organic" },
      { campaign_id: "8542882611764", campaign_name: "SP - Hero KW(256KsV/TOS) -  Exact - Lip Balm - 3 Pack - B0CLHTKY3V/B0CLHV3V5C - -chapstick" },
      { campaign_id: "76275037249690", campaign_name: "SP - Auto - AUD (High-Interest) - Catch All - Mixed -" },
      { campaign_id: "239881499201970", campaign_name: "GG - Lip Balm - Broad M" },
      { campaign_id: "101515316407890", campaign_name: "SP - STR - KW Exact - Lip Balm, Unscented  - B0CLHVCPL5 - -8-10ord" },
      { campaign_id: "169866501590598", campaign_name: "SP - STR - KW Exact(2-4kSV) Lip Balm, Unscented  - B0CLHVCPL5 - -5-10ord" },
      { campaign_id: "163118992602031", campaign_name: "SP - STR - KW Exact(500-1kSV/TOS) Lip Balm, Unscented  - B0CLHVCPL5 - -4-14ord" },
      { campaign_id: "482335754572799", campaign_name: "SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match-TOS | SSG" },
      { campaign_id: "169923811781436", campaign_name: "Catch All - Added To Cart - AMC - TOS" },
      { campaign_id: "10182902721153", campaign_name: "SP - KW (TOS) - Broad - Deodorant - B0CLHYY3BB  - -ISO" },
      { campaign_id: "48457303804435", campaign_name: "SP - STR - Comp KW - Exact - Lip Balm, Unscented  - B0CLHVCPL5 - -5-13ord" },
      { campaign_id: "267072451848172", campaign_name: "SP - Branded KW(TOS) - Exact - Tallow Balm - Mixed -" },
      { campaign_id: "98003036923219", campaign_name: "SBH - 1KW Phrase - Tallow deodorant - Mixed - -tallow deodorant 2" },
      { campaign_id: "198220076960084", campaign_name: "SP - Exact - Lip Balm - B0CLHTKY3V - chap stick" },
    ],
    terms: [
      { search_term: "deodorant men", campaign_id: "193871638584961", campaign_name: "GG - Deodorant - Exact - SQR - CST", ad_group_name: "Exact", keyword: "deodorant men", match_type: "EXACT", clicks: 80, spend: 93.99, sales: 0 },
      { search_term: "lip moisturizer for very dry lips", campaign_id: "203560398305186", campaign_name: "GG - Lip Balm - Exact - Untargeted", ad_group_name: "Exact", keyword: "lip moisturizer for very dry lips", match_type: "EXACT", clicks: 51, spend: 88.51, sales: 0 },
      { search_term: "organic lip balm", campaign_id: "401769304051792", campaign_name: "SP KW - Exact(PM) - Lip Balm - DPB0CLHTKY3V/B0CLHVLG2F -", ad_group_name: "Exact AG", keyword: "organic lip balm", match_type: "EXACT", clicks: 614, spend: 1119, sales: 1665 },
      { search_term: "lip balm organic", campaign_id: "209616848808384", campaign_name: "SP - 1KW(900kSV/ROS-PP) - Exact - Lip Balm - B0CLHTKY3V - -lip balm organic", ad_group_name: "B0CLHTKY3V", keyword: "lip balm organic", match_type: "EXACT", clicks: 96, spend: 281, sales: 266 },
      { search_term: "natural chapstick", campaign_id: "115677588379884", campaign_name: "SP - 1KW(1KsV/TOS) - Exact - Lip Balm - B0CLHTKY3V - -natural chapstick", ad_group_name: "B0CLHTKY3V", keyword: "natural chapstick", match_type: "EXACT", clicks: 88, spend: 177, sales: 280 },
      { search_term: "best chapstick", campaign_id: "10892789463718", campaign_name: "GG - Lip Balm - Exact - ChapStick related", ad_group_name: "Exact", keyword: "best chapstick", match_type: "EXACT", clicks: 40, spend: 126, sales: 56 },
      { search_term: "b07xxphqzk", campaign_id: "167075799532625", campaign_name: "GG - Lip Balm - Asin Offense - Lip Balm Category", ad_group_name: "Asin Offense", clicks: 309, spend: 434.44, sales: 559.6 },
      { search_term: "beef tallow lip balm", campaign_id: "482335754572799", campaign_name: "SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match-TOS | SSG", ad_group_name: "Auto Loose", clicks: 95, spend: 155, sales: 518 },
      { search_term: "non toxic organic chapstick", campaign_id: "239881499201970", campaign_name: "GG - Lip Balm - Broad M", ad_group_name: "Broad", clicks: 10, spend: 15.82, sales: 195.86 },
      { search_term: "tallowbourne", campaign_id: "267072451848172", campaign_name: "SP - Branded KW(TOS) - Exact - Tallow Balm - Mixed -", ad_group_name: "Tallow Balm", clicks: 32, spend: 41, sales: 265 },
      { search_term: "chap stick", campaign_id: "198220076960084", campaign_name: "SP - Exact - Lip Balm - B0CLHTKY3V - chap stick", ad_group_name: "B0CLHTKY3V", clicks: 138, spend: 80, sales: 335 },
    ],
    placements: [],
  };

  const list = buildBlake24dList({ lookup });

  test("not empty; window is 24d Aug 6–29, not 90d", () => {
    assert.equal(list.execute_list, "blake_24d");
    assert.equal(list.execute_ready, true);
    assert.ok(list.rows.length >= 28);
    assert.equal(list.window.search.label, BLAKE_24D_WINDOW_LABEL);
    assert.equal(list.window_chip, BLAKE_24D_WINDOW_CHIP);
    assert.match(list.notes[0], /24d Blake-ranked list/);
    assert.match(list.notes[0], /90d backfill continues for next Monday/);
    assert.doesNotMatch(list.window.search.label, /90d/);
    assert.equal(list.account_cvr_branded, 35.6);
    assert.equal(list.account_cvr_nonbranded, 25.6);
    assert.equal(list.click_floor, 10);
    for (const r of list.rows) {
      assert.equal(r.current_bid, null);
      assert.equal(r.window, BLAKE_24D_WINDOW_LABEL);
      assert.doesNotMatch(r.window, /90d/);
    }
  });

  test("open rows stay in Blake order", () => {
    const terms = list.rows.map((r) => r.term);
    assert.equal(terms[0], "deodorant men");
    assert.equal(terms[8], "organic lip balm");
    assert.equal(terms[9], "lip balm organic");
    const pt = list.rows.find((r) => r.term === "B07XXPHQZK");
    assert.equal(pt?.action, "bid_down");
    assert.ok((pt?.sales ?? 0) > 0);
    assert.ok((pt?.acos ?? 0) > 0);
    assert.ok(list.rows.some((r) => r.term === "B00EXPRM7C" && r.action === "bid_down"));
    const harvest = list.rows.filter((r) => r.action === "harvest_exact");
    assert.equal(harvest.at(-1)?.term, "non toxic organic chapstick");
  });

  test("organic lip balm / lip balm organic are bid_down, never pause", () => {
    const organic = list.rows.find((r) => r.term === "organic lip balm");
    const organic2 = list.rows.find((r) => r.term === "lip balm organic");
    assert.equal(organic?.action, "bid_down");
    assert.equal(organic2?.action, "bid_down");
    assert.equal(list.rows.filter((r) => /organic lip balm|lip balm organic/i.test(r.term) && r.action === "pause_keyword").length, 0);
  });

  test("pause_keyword only on the four exact-KW $0 terms", () => {
    const pauses = list.rows.filter((r) => r.action === "pause_keyword");
    assert.deepEqual(pauses.map((r) => r.term), [
      "deodorant men",
      "lip moisturizer for very dry lips",
      "beef tallow moisturizer",
      "chapstick natural",
    ]);
    assert.ok(pauses.every((r) => r.sales === 0));
  });

  test("no hold_tos action; no Aquaphor/Carpe harvest", () => {
    assert.equal(list.rows.some((r) => String(r.action) === "hold_tos"), false);
    assert.ok(WEEKLY_ACTIONS.includes("brand_defense"));
    assert.equal(list.rows.filter((r) => r.action === "cut_detail_page").length, 6);
    assert.equal(list.rows.filter((r) => r.action === "raise_tos").length, 2);
    assert.ok(list.rows.some((r) => r.action === "brand_defense" && r.term === "tallowbourne"));
    for (const r of list.rows) {
      assert.doesNotMatch(r.term, /aquaphor/i);
      if (r.action === "harvest_exact") {
        assert.doesNotMatch(r.term, /carpe/i);
        assert.doesNotMatch(r.campaign, /carpe/i);
      }
    }
  });

  test("ambiguous STR name leaves id blank; unique names fill id", () => {
    const str = list.rows.filter((r) => /STR KW Exact Lip Unscented/i.test(r.campaign));
    assert.ok(str.length >= 2);
    assert.ok(str.every((r) => r.campaign_id === ""));
    const deo = list.rows.find((r) => r.term === "deodorant men");
    assert.equal(deo?.campaign_id, "193871638584961");
    const catchAll = list.rows.find((r) => /Catch Alll/i.test(r.campaign));
    assert.ok(catchAll, "keep Blake Catch Alll spelling");
    const natural = list.rows.find((r) => r.term === "natural chapstick");
    assert.equal(natural?.campaign_id, "", "Hero name does not host the term — leave id blank");
  });

  test("CSV export includes the ranked rows", () => {
    const csv = weeklyToCsv(list.rows);
    assert.match(csv, /deodorant men/);
    assert.match(csv, /organic lip balm/);
    assert.match(csv, /non toxic organic chapstick/);
    assert.match(csv, /2026-08-06\.\.08-29 \(24d\)/);
    assert.doesNotMatch(csv, /90d/);
  });

  test("Done/Skipped lock applies without reopening sold rows", () => {
    const locked = buildBlake24dList({
      lookup,
      now: new Date("2026-09-01T12:00:00.000Z"),
      decisions: [{
        campaign_id: "401769304051792",
        search_term: "organic lip balm",
        action_type: "bid_down",
        status: "applied",
        applied_at: "2026-08-31T12:00:00.000Z",
      }],
    });
    const row = locked.rows.find((r) => r.term === "organic lip balm");
    assert.equal(row?.status, "done");
    assert.ok(locked.done_count >= 1);
  });
});

describe("new_bid formulas — current_bid always null", () => {
  test("down is CPC × 0.42 / ACOS", () => {
    assert.equal(newBidDown(1.0, 0.30), 1.4);
    assert.equal(newBidDownFromAcosPct(1.0, 30), 1.4);
    assert.equal(newBidDown(0, 0.3), null);
  });
  test("up is CPC × 1.15", () => {
    assert.equal(newBidUp(1.0), 1.15);
    assert.equal(newBidUp(0), null);
  });
  test("payload current_bid is null", () => {
    assert.equal(emptyWeeklyList().new_bid.current_bid, null);
  });
});

describe("7-day lock after Done/Skipped", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const done3d: Parameters<typeof isWeeklyLocked>[0] = {
    campaign_id: "c1",
    search_term: "cheap chapstick",
    action_type: "negative_exact",
    status: "applied",
    applied_at: "2026-08-29T12:00:00.000Z",
  };
  const skipped3d: Parameters<typeof isWeeklyLocked>[0] = {
    campaign_id: "c1",
    search_term: "cheap chapstick",
    action_type: "negative_exact",
    status: "dismissed",
    dismissed_at: "2026-08-29T12:00:00.000Z",
  };

  test("natural key is campaign+term+action", () => {
    assert.equal(
      weeklyLockKey("C1", " Cheap  Chapstick ", "Negative_Exact"),
      weeklyLockKey("c1", "cheap chapstick", "negative_exact"),
    );
  });

  test("Done within 7d with sales skips regeneration", () => {
    assert.equal(isWeeklyLocked(done3d, now, 14), true);
    assert.equal(shouldSkipRegeneration(done3d, now, 14), true);
  });

  test("Skipped within 7d with sales skips regeneration", () => {
    assert.equal(isWeeklyLocked(skipped3d, now, 14), true);
  });

  test("still-$0 bleeders may reappear", () => {
    assert.equal(isWeeklyLocked(done3d, now, 0), false);
    assert.equal(shouldSkipRegeneration(done3d, now, 0), false);
  });

  test("lock expires after 7 days", () => {
    const done8d = { ...done3d, applied_at: "2026-08-24T12:00:00.000Z" };
    assert.equal(WEEKLY_LOCK_DAYS, 7);
    assert.equal(isWeeklyLocked(done8d, now, 14), false);
  });

  test("applyWeeklyLocks marks locked rows done/skipped, keeps $0 open", () => {
    const rows = applyWeeklyLocks(
      [
        {
          campaign_id: "c1", term: "cheap chapstick", action: "negative_exact",
          sales: 14, status: "open" as const,
        },
        {
          campaign_id: "c1", term: "free lip balm", action: "negative_exact",
          sales: 0, status: "open" as const,
        },
      ],
      [done3d, {
        campaign_id: "c1", search_term: "free lip balm", action_type: "negative_exact",
        status: "applied", applied_at: "2026-08-29T12:00:00.000Z",
      }],
      now,
    );
    assert.equal(rows[0].status, "done");
    assert.equal(rows[1].status, "open");
  });
});

describe("cadence + HOLD live in copy, not extra pages", () => {
  test("standing Grok prompt carries cadence, lock, HOLD, formulas", () => {
    assert.match(WEEKLY_GROK_PROMPT, /one Monday pass/i);
    assert.match(WEEKLY_GROK_PROMPT, /Harvest every other week/i);
    assert.match(WEEKLY_GROK_PROMPT, /Monthly extras first Monday/i);
    assert.match(WEEKLY_GROK_PROMPT, /7 days/);
    assert.match(WEEKLY_GROK_PROMPT, /still-\$0 bleeders/i);
    assert.match(WEEKLY_GROK_PROMPT, /Hero Exact or Auto Loose/);
    assert.match(WEEKLY_GROK_PROMPT, /Aquaphor or Carpe/);
    assert.match(WEEKLY_GROK_PROMPT, /bid_down, not pause/);
    assert.match(WEEKLY_GROK_PROMPT, /CPC × 0\.42 \/ ACOS/);
    assert.match(WEEKLY_GROK_PROMPT, /CPC × 1\.15/);
    assert.doesNotMatch(WEEKLY_GROK_PROMPT, /deodorant men/i);
  });

  test("cadence and HOLD arrays match Dave's lock", () => {
    assert.ok(WEEKLY_CADENCE[0].includes("Monday"));
    assert.ok(WEEKLY_HOLD.some((h) => /Aquaphor/.test(h)));
    assert.ok(WEEKLY_ACTIONS.includes("harvest_exact"));
    assert.ok(WEEKLY_ACTIONS.includes("raise_tos"));
    assert.equal(recTypeOfWeekly("bid_down"), "WEEKLY_BID_DOWN");
  });

  test("CSV headers are the Blake column set", () => {
    assert.deepEqual([...WEEKLY_CSV_HEADERS], [
      "id", "rank", "action", "campaign", "ad_group", "term", "match_type",
      "clicks", "spend", "sales", "acos", "term_cvr", "account_cvr_lane",
      "current_bid", "new_bid", "placement", "window", "why",
    ]);
    const csv = weeklyToCsv([]);
    assert.equal(csv, WEEKLY_CSV_HEADERS.join(","));
  });
});

describe("/ppc This week tab — Blake 24d list, nightly 7d unchanged", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
  const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-bleeders.tsx"), "utf8");
  const main = readFileSync(path.join(process.cwd(), "..", "src", "main.py"), "utf8");

  test("This week stays on /ppc, not a third ads home", () => {
    assert.match(page, /tab === "bleeders"/);
    assert.match(page, /<PpcBleeders/);
    assert.match(page, /This week/);
    assert.doesNotMatch(page, /href="\/paid-ads"/);
  });

  test("UI ships Done, Skipped, CSV, 24d window chip, standing Grok prompt", () => {
    assert.match(ui, /Done/);
    assert.match(ui, /Skipped/);
    assert.match(ui, /weeklyToCsv/);
    assert.match(ui, /grok_prompt/);
    assert.match(ui, /"dismissed"/);
    assert.match(ui, /"applied"/);
    assert.match(ui, /window_chip/);
    assert.match(ui, /24d Blake-ranked list/);
    assert.match(ui, /Lane CVR/);
    assert.doesNotMatch(ui, /amazonads|auto-apply/i);
  });

  test("weekday search-term ingest is still 7 closed days", () => {
    const daily = main.slice(main.indexOf("def _run_ads_search_terms_sync"),
                             main.indexOf("def _run_ads_search_terms_backfill"));
    assert.match(daily, /days=7/);
    assert.doesNotMatch(daily, /days=90/);
    const nightly = main.slice(main.indexOf("def _run_ads_campaigns_sync"),
                               main.indexOf("def _run_ads_sb_sd_heal"));
    assert.match(nightly, /_run_ads_search_terms_sync/);
    assert.doesNotMatch(nightly, /_run_ads_search_terms_backfill/);
  });
});
