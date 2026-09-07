import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  AUTO_LOOSE_NAME,
  AUTO_LOOSE_TERM_CSV_HEADERS,
  CORE_NEGATIVES,
  FAT_PARENT_NAME,
  GNO_OBSERVE_ONLY,
  KEEP_ALIVE,
  LIP_BE_ACOS,
  NEW_EXACT,
  WATCH_CAMPAIGN_CSV_HEADERS,
  autoLooseSearchTermsCsv,
  buildGnoPack,
  enabledExactKeywords,
  evaluateGnoAlerts,
  extractExactKeyword,
  harvestQueue,
  hoursSinceLaunch,
  isAutoLoose,
  isEnabledStatus,
  keeperHeartbeats,
  keeperMissingPriority,
  newExactTiles,
  spendLookbackDays,
  normalizeName,
  tagAutoLooseTerm,
  watchCampaignsCsv,
  watchCampaignExportRows,
  watchListOf,
  type CampaignDailyRow,
  type PlacementRow,
  type SearchTermRow,
} from "./gno-ppc-watch";
import { zipStore } from "./zip-store";

const ROOT_JSON = path.join(process.cwd(), "..", "config", "gno_ppc_watch.json");
const DASH_JSON = path.join(process.cwd(), "config", "gno_ppc_watch.json");

function camp(
  name: string,
  extra: Partial<CampaignDailyRow> = {},
): CampaignDailyRow {
  return {
    date: "2026-09-06",
    campaign_name: name,
    campaign_type: "SP",
    campaign_status: "enabled",
    budget: 25,
    spend: 0,
    sales_14d: 0,
    orders_14d: 0,
    clicks: 0,
    impressions: 0,
    ...extra,
  };
}

describe("GNO watchlists and matching", () => {
  test("JSON copies stay identical", () => {
    assert.equal(
      readFileSync(ROOT_JSON, "utf8"),
      readFileSync(DASH_JSON, "utf8"),
    );
  });

  test("hard-coded names match Dave's spec", () => {
    assert.equal(KEEP_ALIVE.length, 11);
    assert.equal(NEW_EXACT.length, 7);
    assert.ok(KEEP_ALIVE[0].includes("Loose Match-TOS"));
    assert.ok(NEW_EXACT[0].includes("tallow lip balm"));
    assert.equal(extractExactKeyword(NEW_EXACT[0]), "tallow lip balm");
    assert.equal(extractExactKeyword(NEW_EXACT[3]), "chapstick");
    assert.equal(LIP_BE_ACOS, 42);
    assert.deepEqual([...CORE_NEGATIVES], ["tallow lip balm", "tallow chapstick", "chapstick"]);
  });

  test("normalizes extra spaces in Auto Loose", () => {
    const stored = "SP | TBL - 3Pck | B0CLHTKY3V | Auto | Loose Match-TOS | SSG";
    assert.equal(watchListOf(stored), "KEEPER");
    assert.equal(isAutoLoose(stored), true);
    assert.equal(normalizeName(AUTO_LOOSE_NAME), normalizeName(stored));
  });

  test("Day-5 fragment matches a longer stored name", () => {
    assert.equal(
      watchListOf("Catch-All Auto | leftover harvest"),
      "DAY5_PAUSE",
    );
    assert.equal(watchListOf("Random SP exact"), "OTHER");
  });
});

describe("harvest / junk tags", () => {
  test("HARVEST_CANDIDATE needs L7 orders ≥ 3, ACOS ≤ 42, no Exact home", () => {
    assert.equal(tagAutoLooseTerm({
      orders: 3, spend: 10, sales: 30, search_term: "tallow lip balm organic",
    }, false), "HARVEST_CANDIDATE");
    assert.equal(tagAutoLooseTerm({
      orders: 3, spend: 10, sales: 30, search_term: "tallow lip balm",
    }, true), "KEEP");
    assert.equal(tagAutoLooseTerm({
      orders: 2, spend: 10, sales: 30, search_term: "foo",
    }, false), "KEEP");
  });

  test("JUNK_CANDIDATE is L7 spend ≥ $5 and 0 orders", () => {
    assert.equal(tagAutoLooseTerm({
      orders: 0, spend: 5, sales: 0, search_term: "cheap chapstick",
    }, false), "JUNK_CANDIDATE");
    assert.equal(tagAutoLooseTerm({
      orders: 0, spend: 4.99, sales: 0, search_term: "cheap chapstick",
    }, false), "KEEP");
  });

  test("has_enabled_exact_elsewhere reads 1-child Exact keyword from name", () => {
    const campaigns = NEW_EXACT.map((name) => camp(name, { campaign_status: "enabled" }));
    const enabled = enabledExactKeywords(campaigns, [], "2026-09-06");
    assert.equal(enabled.has("tallow lip balm"), true);
    assert.equal(enabled.has("chapstick"), true);
    assert.equal(enabled.has("tallow deodorant"), true);
  });

  test("harvestQueue tags Auto Loose terms only", () => {
    const terms: SearchTermRow[] = [
      {
        date: "2026-09-06",
        campaign_name: AUTO_LOOSE_NAME,
        search_term: "tallow lip balm organic",
        match_type: "TARGETING_EXPRESSION",
        spend: 8, sales_14d: 24, orders_14d: 3, clicks: 10, impressions: 200,
      },
      {
        date: "2026-09-06",
        campaign_name: AUTO_LOOSE_NAME,
        search_term: "random junk",
        match_type: "TARGETING_EXPRESSION",
        spend: 6, sales_14d: 0, orders_14d: 0, clicks: 4, impressions: 80,
      },
      {
        date: "2026-09-06",
        campaign_name: "some other campaign",
        search_term: "should not appear",
        match_type: "EXACT",
        spend: 9, sales_14d: 0, orders_14d: 0, clicks: 3, impressions: 10,
      },
    ];
    const q = harvestQueue(terms, NEW_EXACT.map((n) => camp(n)), "2026-09-06");
    assert.equal(q.some((t) => t.customer_search_term === "should not appear"), false);
    const harvest = q.find((t) => t.customer_search_term === "tallow lip balm organic");
    const junk = q.find((t) => t.customer_search_term === "random junk");
    assert.equal(harvest?.proposed_tag, "HARVEST_CANDIDATE");
    assert.equal(harvest?.has_enabled_exact_elsewhere, false);
    assert.equal(junk?.proposed_tag, "JUNK_CANDIDATE");
  });
});

describe("rules engine P0/P1", () => {
  test("observe-only flag is on and alerts never request an auto action", () => {
    assert.equal(GNO_OBSERVE_ONLY, true);
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-06",
      today: "2026-09-07",
      now: new Date("2026-09-07T12:00:00-07:00"),
      campaigns: [],
      searchTerms: [],
      placements: [],
      lookbackDays: 3,
    });
    assert.ok(alerts.every((a) => a.auto_action === false));
    const missing = alerts.filter((a) => a.code === "KEEPER_MISSING");
    assert.ok(missing.length >= 1);
    assert.ok(missing.every((a) => a.priority === "P2"));
    assert.equal(alerts.filter((a) => a.priority === "P0").length, 0);
    assert.ok(!alerts.some((a) => a.priority === "P0" && a.code.startsWith("KEEPER_")));
    assert.equal(keeperMissingPriority(3), "P2");
    assert.equal(keeperMissingPriority(90), "P2");
  });

  test("KEEP-ALIVE absent from a 3-day / 14-day spend lookback is not a P0", () => {
    const present = KEEP_ALIVE.slice(0, 3).map((name) =>
      camp(name, { date: "2026-09-06", budget: 303, spend: 4 }));
    const threeDay = evaluateGnoAlerts({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns: present, searchTerms: [], placements: [],
      lookbackDays: 3,
    });
    const fourteen = evaluateGnoAlerts({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns: present, searchTerms: [], placements: [],
      lookbackDays: 14,
    });
    for (const alerts of [threeDay, fourteen]) {
      const missing = alerts.filter((a) => a.code === "KEEPER_MISSING");
      assert.ok(missing.length >= KEEP_ALIVE.length - 3);
      assert.ok(missing.every((a) => a.priority === "P2"));
      assert.equal(alerts.some((a) => a.code === "KEEPER_MISSING" && a.priority === "P0"), false);
    }
    assert.equal(spendLookbackDays(present, "2026-09-06", 3), 3);
    assert.equal(spendLookbackDays(present, "2026-09-06", 14), 14);
  });

  test("omitted zero-impression ENABLED keeper is not a P0", () => {
    const campaigns = KEEP_ALIVE.map((name) =>
      camp(name, { date: "2026-09-04", campaign_status: "enabled", budget: 303, impressions: 12 }));
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns, searchTerms: [], placements: [],
    });
    assert.ok(!alerts.some((a) => a.code === "KEEPER_MISSING"));
    assert.ok(!alerts.some((a) => a.code === "KEEPER_NOT_ENABLED"));
    const auto = keeperHeartbeats(campaigns, "2026-09-06").find((k) => k.role === "auto_loose");
    assert.equal(auto?.enabled, true);
    assert.equal(auto?.state, "enabled");
  });

  test("blank status on a later spend row does not override last ENABLED", () => {
    const name = AUTO_LOOSE_NAME;
    const campaigns = [
      camp(name, { date: "2026-09-04", campaign_status: "enabled", budget: 303 }),
      camp(name, { date: "2026-09-06", campaign_status: "", budget: 303, impressions: 0 }),
      ...KEEP_ALIVE.filter((n) => n !== name).map((n) =>
        camp(n, { campaign_status: "enabled", budget: 25 })),
    ];
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns, searchTerms: [], placements: [],
    });
    assert.ok(!alerts.some((a) => a.code === "KEEPER_NOT_ENABLED"));
    assert.ok(!alerts.some((a) => a.code === "AUTO_LOOSE_NOT_ENABLED"));
  });

  test("P0 keeper not enabled", () => {
    const campaigns = KEEP_ALIVE.map((name) =>
      camp(name, { campaign_status: name === AUTO_LOOSE_NAME ? "paused" : "enabled", budget: 303 }));
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns, searchTerms: [], placements: [],
    });
    assert.ok(alerts.some((a) => a.code === "AUTO_LOOSE_NOT_ENABLED" || a.code === "KEEPER_NOT_ENABLED"));
  });

  test("P0 Auto Loose budget off $303", () => {
    const campaigns = KEEP_ALIVE.map((name) =>
      camp(name, { budget: name === AUTO_LOOSE_NAME ? 200 : 25, campaign_status: "enabled" }));
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns, searchTerms: [], placements: [],
    });
    assert.ok(alerts.some((a) => a.code === "AUTO_LOOSE_BUDGET"));
  });

  test("P0 new Exact $15+ same day 0 orders", () => {
    const campaigns = [
      ...KEEP_ALIVE.map((name) => camp(name, { budget: 303 })),
      camp(NEW_EXACT[0], { spend: 16, orders_14d: 0, impressions: 40 }),
      ...NEW_EXACT.slice(1).map((name) => camp(name, { impressions: 10 })),
    ];
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns, searchTerms: [], placements: [],
    });
    assert.ok(alerts.some((a) => a.code === "NEW_EXACT_BURN"));
  });

  test("P0 zero impressions after 24h on tallow lip balm Exact", () => {
    const campaigns = [
      ...KEEP_ALIVE.map((name) => camp(name, { budget: 303 })),
      ...NEW_EXACT.map((name) => camp(name, { impressions: 0, spend: 0 })),
    ];
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-08", today: "2026-09-09",
      now: new Date("2026-09-08T12:00:00-07:00"),
      campaigns, searchTerms: [], placements: [],
    });
    const zeros = alerts.filter((a) => a.code === "NEW_EXACT_ZERO_IMPR");
    assert.ok(zeros.length >= 1);
    assert.ok(zeros.every((a) => /tallow lip balm/.test(a.campaign_name ?? "")));
  });

  test("P0 fat parent spend drop vs trailing-7", () => {
    const days = ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];
    const fatRows = days.map((date, idx) => camp(FAT_PARENT_NAME, {
      date,
      spend: idx === days.length - 1 ? 2 : 20,
      budget: 40,
    }));
    const campaigns = [
      ...KEEP_ALIVE.filter((n) => n !== FAT_PARENT_NAME).map((n) => camp(n, { budget: 303 })),
      ...fatRows,
    ];
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns, searchTerms: [], placements: [],
    });
    assert.ok(alerts.some((a) => a.code === "FAT_PARENT_SPEND_DROP"));
  });

  test("P0 core negative only when negatives snapshot exists", () => {
    const campaigns = KEEP_ALIVE.map((n) => camp(n, { budget: 303 }));
    const none = evaluateGnoAlerts({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns, searchTerms: [], placements: [],
      negativesAvailable: false,
    });
    assert.equal(none.some((a) => a.code === "CORE_NEGATIVE"), false);

    const withNeg = evaluateGnoAlerts({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns, searchTerms: [], placements: [],
      negativesAvailable: true,
      negatives: [{ campaign_name: AUTO_LOOSE_NAME, keyword: "chapstick", match_type: "EXACT" }],
    });
    assert.ok(withNeg.some((a) => a.code === "CORE_NEGATIVE"));
  });

  test("P1 Product Page share > 25%", () => {
    const campaigns = KEEP_ALIVE.map((n) => camp(n, { budget: 303 }));
    const placements: PlacementRow[] = [
      { date: "2026-09-06", campaign_name: AUTO_LOOSE_NAME, placement: "Top of Search on-Amazon", spend: 10 },
      { date: "2026-09-06", campaign_name: AUTO_LOOSE_NAME, placement: "Detail Page on-Amazon", spend: 20 },
    ];
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns, searchTerms: [], placements,
    });
    assert.ok(alerts.some((a) => a.code === "PP_SHARE"));
  });

  test("does not fire zero-impr P0 before 24h", () => {
    const campaigns = [
      ...KEEP_ALIVE.map((n) => camp(n, { budget: 303 })),
      ...NEW_EXACT.map((n) => camp(n, { impressions: 0 })),
    ];
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-07", today: "2026-09-07",
      now: new Date("2026-09-07T12:00:00-07:00"),
      campaigns, searchTerms: [], placements: [],
    });
    assert.equal(alerts.some((a) => a.code === "NEW_EXACT_ZERO_IMPR"), false);
    assert.ok(hoursSinceLaunch(new Date("2026-09-07T12:00:00-07:00")) < 24);
  });
});

describe("export pack columns", () => {
  test("watch_campaigns.csv headers and L2+L7 rows", () => {
    const campaigns = [
      camp(NEW_EXACT[0], { date: "2026-09-05", spend: 4, impressions: 20, clicks: 2, orders_14d: 0 }),
      camp(NEW_EXACT[0], { date: "2026-09-06", spend: 6, impressions: 30, clicks: 3, orders_14d: 1, sales_14d: 12 }),
    ];
    const rows = watchCampaignExportRows({ asOf: "2026-09-06", campaigns, placements: [] });
    const forNew = rows.filter((r) => r.campaign_name === NEW_EXACT[0]);
    assert.equal(forNew.length, 2);
    assert.deepEqual([...new Set(forNew.map((r) => `${r.date_start}..${r.date_end}`))].sort(), [
      "2026-08-31..2026-09-06",
      "2026-09-05..2026-09-06",
    ]);
    assert.equal(forNew[0].watch_list, "NEW_EXACT");
    const csv = watchCampaignsCsv(rows);
    assert.equal(csv.split("\n")[0], WATCH_CAMPAIGN_CSV_HEADERS.join(","));
  });

  test("auto_loose_search_terms.csv headers and tags", () => {
    const terms: SearchTermRow[] = [{
      date: "2026-09-06",
      campaign_name: AUTO_LOOSE_NAME,
      search_term: "tallow lip balm organic",
      match_type: "TARGETING_EXPRESSION",
      spend: 8, sales_14d: 24, orders_14d: 3, clicks: 10, impressions: 200,
    }];
    const q = harvestQueue(terms, [], "2026-09-06");
    const csv = autoLooseSearchTermsCsv(q);
    assert.equal(csv.split("\n")[0], AUTO_LOOSE_TERM_CSV_HEADERS.join(","));
    assert.match(csv, /HARVEST_CANDIDATE/);
    assert.match(csv, /false/);
  });

  test("zip contains the two required files", () => {
    const pack = buildGnoPack({
      asOf: "2026-09-06",
      campaigns: [camp(NEW_EXACT[0], { spend: 1 })],
      searchTerms: [],
      placements: [],
    });
    assert.deepEqual(pack.files.map((f) => f.name), [
      "watch_campaigns.csv",
      "auto_loose_search_terms.csv",
    ]);
    const zip = zipStore(pack.files);
    const text = new TextDecoder().decode(zip);
    assert.match(text, /watch_campaigns\.csv/);
    assert.match(text, /auto_loose_search_terms\.csv/);
    assert.equal(zip[0], 0x50);
    assert.equal(zip[1], 0x4b);
  });
});

describe("widgets + safety rails", () => {
  test("new Exact tiles go red after 24h with 0 impr", () => {
    const tiles = newExactTiles(
      NEW_EXACT.map((n) => camp(n, { impressions: 0 })),
      "2026-09-08",
      new Date("2026-09-08T12:00:00-07:00"),
    );
    assert.equal(tiles.length, 7);
    assert.ok(tiles.every((t) => t.zero_impr_after_24h));
  });

  test("keeper heartbeat marks Auto Loose enabled + sparkline length 7", () => {
    const beats = keeperHeartbeats(
      [camp(AUTO_LOOSE_NAME, { budget: 303, spend: 12, campaign_status: "enabled" })],
      "2026-09-06",
    );
    assert.equal(beats[0].enabled, true);
    assert.equal(beats[0].sparkline.length, 7);
    assert.equal(isEnabledStatus("ENABLED"), true);
    assert.equal(isEnabledStatus("paused"), false);
  });

  test("source forbids auto-pause / auto-negate / auto-bid", () => {
    const lib = readFileSync(path.join(process.cwd(), "src/lib/gno-ppc-watch.ts"), "utf8");
    const page = readFileSync(path.join(process.cwd(), "src/app/ppc/gno/page.tsx"), "utf8");
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-gno-watch.tsx"), "utf8");
    const api = readFileSync(path.join(process.cwd(), "src/app/api/ppc/gno-export/route.ts"), "utf8");
    const ack = readFileSync(path.join(process.cwd(), "src/app/api/ppc/gno-ack/route.ts"), "utf8");
    for (const src of [lib, page, ui, api, ack]) {
      assert.doesNotMatch(src, /amazonads|autoPause\(|auto_pause\s*=\s*true/i);
      assert.match(src, /observe/i);
    }
    assert.match(ui, /Mark Done/);
    assert.doesNotMatch(lib, /alert\("P0", "KEEPER_MISSING"/);
  });

  test("/ppc tab union still defaults to This week", () => {
    const page = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
    assert.match(page, /useState<"search" \| "campaigns" \| "bleeders">\("bleeders"\)/);
    assert.match(page, /\(\["bleeders", "search", "campaigns"\] as const\)/);
    assert.match(page, /href="\/ppc\/gno"/);
    assert.doesNotMatch(page, /id: "ppc-queue", label: "Actions"/);
  });

  test("GNO page and export route exist", () => {
    assert.equal(existsSync(path.join(process.cwd(), "src/app/ppc/gno/page.tsx")), true);
    assert.equal(existsSync(path.join(process.cwd(), "src/app/ppc/gno/error.tsx")), true);
    assert.equal(existsSync(path.join(process.cwd(), "src/app/api/ppc/gno/route.ts")), true);
    assert.equal(existsSync(path.join(process.cwd(), "src/app/api/ppc/gno-export/route.ts")), true);
    assert.equal(existsSync(path.join(process.cwd(), "src/app/api/ppc/gno-ack/route.ts")), true);
  });

  test("GNO API pages with a date + campaign_id order", () => {
    for (const rel of ["src/app/api/ppc/gno/route.ts", "src/app/api/ppc/gno-export/route.ts"]) {
      const src = readFileSync(path.join(process.cwd(), rel), "utf8");
      assert.match(src, /\.order\("date"/);
      assert.match(src, /\.order\(order2/);
      assert.match(src, /campaign_id/);
    }
  });
});
