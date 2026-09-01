import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isBranded, laneOf } from "./brand-terms";
import {
  buildBleeders, clickFloor, cvrPct, isGnoTenZero, inclusiveDays,
  resolveBleederAction, checklistId, recTypeOf,
  type BleederCampaignRow, type BleederTermRow,
} from "./ppc-bleeders";

function camp(partial: Partial<BleederCampaignRow> & { campaign_id: string }): BleederCampaignRow {
  return {
    date: "2026-08-29",
    campaign_status: "ENABLED",
    campaign_type: "SP",
    campaign_name: "SP Exact Lip Balm",
    orders_14d: 1846,
    clicks: 6700,
    ...partial,
  };
}

function term(partial: Partial<BleederTermRow> & { search_term: string }): BleederTermRow {
  return {
    date: "2026-08-29",
    campaign_id: "c1",
    campaign_name: "SP Exact Lip Balm",
    ad_group_id: "ag1",
    ad_group_name: "AG 1",
    keyword: "lip balm",
    match_type: "BROAD",
    spend: 12,
    sales_14d: 0,
    orders_14d: 0,
    clicks: 15,
    ...partial,
  };
}

describe("click floor from blended account CVR (GNO)", () => {
  test("<4% is 25 clicks", () => {
    assert.equal(clickFloor(3.9), 25);
    assert.equal(clickFloor(0), 25);
  });
  test("5–10% inclusive is 15 clicks", () => {
    assert.equal(clickFloor(5), 15);
    assert.equal(clickFloor(10), 15);
    assert.equal(clickFloor(7.2), 15);
  });
  test("otherwise (incl. 4–5% silence and >10%) is 10", () => {
    assert.equal(clickFloor(4), 10);
    assert.equal(clickFloor(4.9), 10);
    assert.equal(clickFloor(10.01), 10);
    assert.equal(clickFloor(27.55), 10);
  });
});

describe("CVR math and 10/$0 flag", () => {
  test("account CVR is orders/clicks, never invented", () => {
    assert.equal(cvrPct(1846, 6700)?.toFixed(2), "27.55");
    assert.equal(cvrPct(0, 0), null);
  });
  test("10/$0 is clicks>=10 and sales=$0", () => {
    assert.equal(isGnoTenZero(10, 0), true);
    assert.equal(isGnoTenZero(9, 0), false);
    assert.equal(isGnoTenZero(25, 1), false);
  });
  test("calendar window Aug 6–29 is 24 days", () => {
    assert.equal(inclusiveDays("2026-08-06", "2026-08-29"), 24);
  });
});

describe("lane split uses brand_terms, not campaign name", () => {
  test("tallowbourn is branded; beef tallow lip balm is not", () => {
    assert.equal(isBranded("tallowbourn lip balm"), true);
    assert.equal(isBranded("beef tallow lip balm"), false);
    assert.equal(laneOf("dr dave lip balm"), "branded");
    assert.equal(laneOf("chapstick alternative"), "nonbranded");
  });
});

describe("action split", () => {
  test("PHRASE/BROAD search terms are negative_exact", () => {
    assert.equal(resolveBleederAction("BROAD", "chapstick", "lip balm"), "negative_exact");
    assert.equal(resolveBleederAction("PHRASE", "tallow balm", "tallow balm"), "negative_exact");
  });
  test("EXACT where term equals keyword is pause_keyword", () => {
    assert.equal(resolveBleederAction("EXACT", "lip balm", "lip balm"), "pause_keyword");
  });
  test("EXACT where term differs is negative_exact", () => {
    assert.equal(resolveBleederAction("EXACT", "organic lip balm", "lip balm"), "negative_exact");
  });
  test("TARGETING_* where term equals the expression is pause_target", () => {
    assert.equal(
      resolveBleederAction("TARGETING_EXPRESSION", "asin=\"B0CLHTKY3V\"", "asin=\"B0CLHTKY3V\""),
      "pause_target",
    );
  });
  test("TARGETING_* customer query (≠ expression) is negative_exact, not an invented target", () => {
    assert.equal(
      resolveBleederAction("TARGETING_EXPRESSION_PREDEFINED", "beef tallow", "close-match"),
      "negative_exact",
    );
  });
});

describe("buildBleeders — CVR vs lane, not sales=$0-only", () => {
  const campaigns: BleederCampaignRow[] = [
    camp({ campaign_id: "c1", date: "2026-08-06", orders_14d: 100, clicks: 400 }),
    camp({ campaign_id: "c1", date: "2026-08-29", orders_14d: 1746, clicks: 6300 }),
    camp({ campaign_id: "paused", date: "2026-08-29", campaign_status: "PAUSED", orders_14d: 0, clicks: 50 }),
  ];
  // Blended 1846/6700 = 27.55% → floor 10.
  // Non-branded terms: 2 orders / 40 clicks = 5% vs a high lane bar once we add a converting generic.
  // Build a window whose non-brand lane CVR is ~25% and branded is higher.

  test("includes below-lane-CVR rows that have sales (R2) — not $0-only", () => {
    const terms: BleederTermRow[] = [
      // Generic converting account mass — sets non-branded lane ~25.6%
      term({ search_term: "lip balm", match_type: "EXACT", keyword: "chapstick",
             clicks: 1000, orders_14d: 256, sales_14d: 4000, spend: 800,
             date: "2026-08-06" }),
      // Below-lane generic WITH sales — must be a cut (R2)
      term({ search_term: "cheap chapstick", match_type: "BROAD", keyword: "lip balm",
             clicks: 20, orders_14d: 1, sales_14d: 14, spend: 18,
             date: "2026-08-29" }),
      // Below-lane generic $0 — R1 / P0
      term({ search_term: "free lip balm", match_type: "BROAD", keyword: "lip balm",
             clicks: 15, orders_14d: 0, sales_14d: 0, spend: 9,
             date: "2026-08-29" }),
    ];
    const out = buildBleeders(terms, campaigns);
    assert.equal(out.window.window_days, 24);
    assert.equal(out.window.label.includes("2026-08-06"), true);
    assert.equal(out.window.label.includes("not 60d"), true);
    assert.equal(out.click_floor, 10);
    assert.ok(out.account_cvr > 27 && out.account_cvr < 28);

    const withSales = out.rows.find((r) => r.search_term === "cheap chapstick");
    const zero = out.rows.find((r) => r.search_term === "free lip balm");
    assert.ok(withSales, "converting-but-below-lane must be included");
    assert.equal(withSales?.rank, "R2");
    assert.equal(withSales?.priority, "P1");
    assert.equal(withSales?.gno_10_0, false);
    assert.ok(zero, "zero-sales below-lane must be included");
    assert.equal(zero?.rank, "R1");
    assert.equal(zero?.priority, "P0");
    assert.equal(zero?.gno_10_0, true);
  });

  test("does not include a term at or above its lane CVR", () => {
    const terms: BleederTermRow[] = [
      term({ search_term: "lip balm", match_type: "BROAD", keyword: "x",
             clicks: 1000, orders_14d: 256, sales_14d: 4000, spend: 800 }),
      term({ search_term: "winner generic", match_type: "BROAD", keyword: "x",
             clicks: 20, orders_14d: 10, sales_14d: 150, spend: 20 }),
    ];
    const out = buildBleeders(terms, campaigns);
    assert.equal(out.rows.some((r) => r.search_term === "winner generic"), false);
  });

  test("click floor of 25 drops a 15-click $0 row when account CVR is <4%", () => {
    const lowCamps = [camp({ campaign_id: "c1", orders_14d: 10, clicks: 400 })]; // 2.5%
    const terms: BleederTermRow[] = [
      term({ search_term: "lip balm", clicks: 400, orders_14d: 10, sales_14d: 80, spend: 40 }),
      term({ search_term: "dud", clicks: 15, orders_14d: 0, sales_14d: 0, spend: 8 }),
      term({ search_term: "big dud", clicks: 25, orders_14d: 0, sales_14d: 0, spend: 20 }),
    ];
    const out = buildBleeders(terms, lowCamps);
    assert.equal(out.click_floor, 25);
    assert.equal(out.rows.some((r) => r.search_term === "dud"), false);
    assert.equal(out.rows.some((r) => r.search_term === "big dud"), true);
  });

  test("branded terms are ranked against branded lane CVR, not the blend", () => {
    const terms: BleederTermRow[] = [
      // Non-brand mass at ~25%
      term({ search_term: "lip balm", clicks: 1000, orders_14d: 250, sales_14d: 4000, spend: 800 }),
      // Branded mass at ~40%
      term({ search_term: "tallowbourn lip balm", clicks: 100, orders_14d: 40, sales_14d: 600, spend: 80 }),
      // Branded 30% — above non-brand 25%, below brand 40% → MUST cut
      term({ search_term: "tallowbourn balm", match_type: "PHRASE", keyword: "tallowbourn",
             clicks: 20, orders_14d: 6, sales_14d: 90, spend: 30 }),
    ];
    const out = buildBleeders(terms, campaigns);
    const row = out.rows.find((r) => r.search_term === "tallowbourn balm");
    assert.ok(row, "branded-below-brand-lane must cut even if above non-brand CVR");
    assert.equal(row?.lane, "branded");
    assert.ok((row?.account_cvr_branded ?? 0) > 35);
    assert.ok(row!.term_cvr < row!.account_cvr_branded!);
  });

  test("paused campaigns are excluded", () => {
    const terms: BleederTermRow[] = [
      term({ search_term: "lip balm", clicks: 100, orders_14d: 25, sales_14d: 200, spend: 40 }),
      term({ search_term: "dud", campaign_id: "paused", clicks: 20, orders_14d: 0, sales_14d: 0, spend: 10 }),
    ];
    const out = buildBleeders(terms, campaigns);
    assert.equal(out.rows.some((r) => r.campaign_id === "paused"), false);
  });

  test("applied decision flips status to done", () => {
    const terms: BleederTermRow[] = [
      term({ search_term: "lip balm", clicks: 100, orders_14d: 25, sales_14d: 200, spend: 40 }),
      term({ search_term: "dud", clicks: 12, orders_14d: 0, sales_14d: 0, spend: 7 }),
    ];
    const id = checklistId({
      windowEnd: "2026-08-29", campaignId: "c1", adGroupId: "ag1",
      termKey: "dud", matchType: "BROAD", action: "negative_exact",
    });
    const out = buildBleeders(terms, campaigns, [
      { entity_name: id, status: "applied", id: "dec-1" },
    ]);
    const row = out.rows.find((r) => r.search_term === "dud");
    assert.equal(row?.status, "done");
    assert.equal(row?.decision_id, "dec-1");
    assert.equal(out.applied_count, 1);
    assert.equal(out.open_count, out.rows.length - 1);
  });

  test("does not ship harvest or placement views", () => {
    const src = readFileSync(path.join(process.cwd(), "src/lib/ppc-bleeders.ts"), "utf8");
    assert.match(src, /harvest_exact/);
    assert.match(src, /placement_modifier/);
    assert.match(src, /later cadence/);
    const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
    assert.doesNotMatch(page, /placement_modifier/);
  });
});

describe("surfaces stay on /ppc; nightly 7d unchanged", () => {
  const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
  const main = readFileSync(path.join(process.cwd(), "..", "src", "main.py"), "utf8");

  test("Bleeders is a tab on /ppc, not a third ads home", () => {
    assert.match(page, /tab === "bleeders"/);
    assert.match(page, /<PpcBleeders/);
    assert.match(page, /Bleeders \(\$\{data\?\.bleeders\?\.open_count/);
    assert.doesNotMatch(page, /href="\/paid-ads"/);
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

describe("rec type + checklist id are stable", () => {
  test("rec types match ads_action_decisions rec_type", () => {
    assert.equal(recTypeOf("negative_exact"), "BLEEDER_NEGATIVE_EXACT");
    assert.equal(recTypeOf("pause_keyword"), "BLEEDER_PAUSE_KEYWORD");
    assert.equal(recTypeOf("pause_target"), "BLEEDER_PAUSE_TARGET");
  });
});
