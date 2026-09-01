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

describe("90d gate — no 24d execute list", () => {
  test("Aug 6–29 is 24d and not execute-ready", () => {
    assert.equal(inclusiveDays("2026-08-06", "2026-08-29"), 24);
    assert.equal(isExecuteWindowReady(24), false);
    assert.equal(isExecuteWindowReady(SEARCH_TERM_EXECUTE_MIN_DAYS - 1), false);
    assert.equal(isExecuteWindowReady(90), true);
  });

  test("emptyWeeklyList always ships zero rows", () => {
    const short = emptyWeeklyList({
      search: storedWindow(["2026-08-06", "2026-08-29"]),
      account_cvr: 27.55,
      click_floor: 10,
    });
    assert.equal(short.rows.length, 0);
    assert.equal(short.open_count, 0);
    assert.equal(short.execute_list, "empty");
    assert.equal(short.execute_ready, false);
    assert.match(short.window.search.label, /2026-08-06/);
    assert.match(short.window.search.label, /not 60d/);
    assert.match(short.notes[0], /Not 90d/);

    const ready = emptyWeeklyList({
      search: storedWindow(["2026-06-03", "2026-08-31"]),
    });
    assert.equal(ready.execute_ready, true);
    assert.equal(ready.rows.length, 0);
    assert.match(ready.notes[0], /stays empty until Blake ranks/);
  });

  test("GET /api/ppc does not call buildBleeders", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/ppc/route.ts"), "utf8");
    assert.match(route, /emptyWeeklyList/);
    assert.doesNotMatch(route, /buildBleeders\s*\(/);
    assert.doesNotMatch(route, /from "@\/lib\/ppc-bleeders"/);
  });

  test("does not encode the 24d ranked row set", () => {
    const weekly = readFileSync(path.join(process.cwd(), "src/lib/ppc-weekly.ts"), "utf8");
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-bleeders.tsx"), "utf8");
    const route = readFileSync(path.join(process.cwd(), "src/app/api/ppc/route.ts"), "utf8");
    for (const src of [weekly, ui, route]) {
      assert.doesNotMatch(src, /deodorant men/i);
      assert.doesNotMatch(src, /non toxic organic chapstick/i);
      assert.doesNotMatch(src, /checklist_id:\s*["']2026-08-29/);
    }
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

describe("/ppc This week tab — empty shell, nightly 7d unchanged", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
  const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-bleeders.tsx"), "utf8");
  const main = readFileSync(path.join(process.cwd(), "..", "src", "main.py"), "utf8");

  test("This week stays on /ppc, not a third ads home", () => {
    assert.match(page, /tab === "bleeders"/);
    assert.match(page, /<PpcBleeders/);
    assert.match(page, /This week/);
    assert.doesNotMatch(page, /href="\/paid-ads"/);
  });

  test("UI ships Done, Skipped, CSV, standing Grok prompt", () => {
    assert.match(ui, /Done/);
    assert.match(ui, /Skipped/);
    assert.match(ui, /weeklyToCsv/);
    assert.match(ui, /grok_prompt/);
    assert.match(ui, /"dismissed"/);
    assert.match(ui, /"applied"/);
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
