import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  ADVERTISED_PRODUCT_L7_CSV_HEADERS,
  AUTO_LOOSE_NAME,
  AUTO_LOOSE_TERM_CSV_HEADERS,
  BALM_BE_ACOS,
  BROAD_M_NAME,
  CM_NOTE,
  CORE_NEGATIVES,
  DEO_BE_ACOS,
  FAT_PARENT_NAME,
  FLAVOR_SHELL,
  GNO_LAUNCHED_AT,
  GNO_NEXT_REVIEW_AT,
  GNO_OBSERVE_ONLY,
  HERO_CHAPSTICK_NAME,
  KEEP_ALIVE,
  KEYWORD_ST_NOTE,
  KEYWORD_TARGET_CSV_HEADERS,
  LIP_BE_ACOS,
  NEW_EXACT,
  PLACEMENT_LAG_NOTE,
  SQP_COMPARISON_FILENAME,
  SQP_SLICE_CSV_HEADERS,
  SQP_STALE_AFTER_DAYS,
  WATCH_CAMPAIGN_CSV_HEADERS,
  isNewExactName,
  isCompleteSqpWeek,
  l2L7MetricsComplete,
  selectSqpSliceWeek,
  sqpComparisonSliceRows,
  stDateLooksDaily,
  sumHarvestSpend,
  acosVsBe,
  breakEvenAcosOf,
  familyOf,
  formatAcosVsBe,
  autoLooseSearchTermsCsv,
  buildGnoPack,
  csvEscape,
  enabledExactKeywords,
  evaluateGnoAlerts,
  extractAsin,
  extractExactKeyword,
  gnoPackStamp,
  harvestQueue,
  isBroadM,
  isFlavorShellName,
  campaignLaunchedAt,
  hoursSinceCampaignLaunch,
  hoursSinceLaunch,
  isAutoLoose,
  isEnabledStatus,
  keeperHeartbeats,
  keywordTargetExportRows,
  keywordTargetsCsv,
  keeperMissingPriority,
  newExactTiles,
  packClosedEnd,
  packWindows,
  spendLookbackDays,
  normalizeName,
  searchTermExportRows,
  sqpWeeklySliceRows,
  tagAutoLooseTerm,
  watchCampaignsCsv,
  watchCampaignExportRows,
  watchListOf,
  daysLiveAsOf,
  type CampaignDailyRow,
  type CampaignMeta,
  type KeywordTarget,
  type PlacementRow,
  type SearchTermRow,
} from "./gno-ppc-watch";
import { zipStore } from "./zip-store";
import { evaluateExportNeed, QUIET } from "./gno-export-state";
import {
  FRESHNESS_LINES,
  bleeder20Threshold,
  contractSearchTermTag,
  dedupeWatchCampaignRows,
  evaluatePackQuality,
  organicTrackerCensus,
  queryNormalized,
  seriesCoversWindow,
} from "./gno-pack-contract";

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
    assert.equal(NEW_EXACT.length, 10);
    assert.equal(FLAVOR_SHELL.length, 24);
    assert.equal(BROAD_M_NAME, "GG - Lip Balm - Broad M");
    assert.equal(isBroadM(BROAD_M_NAME), true);
    assert.ok(KEEP_ALIVE[0].includes("Loose Match-TOS"));
    assert.ok(NEW_EXACT[0].includes("tallow lip balm"));
    assert.equal(extractExactKeyword(NEW_EXACT[0]), "tallow lip balm");
    assert.equal(extractExactKeyword(NEW_EXACT[3]), "chapstick");
    assert.equal(extractExactKeyword(NEW_EXACT[6]), "tallow deodorant");
    assert.equal(extractExactKeyword(NEW_EXACT[7]), "tallow deodorant for men");
    assert.equal(extractExactKeyword(NEW_EXACT[8]), "tallow balm");
    assert.equal(extractExactKeyword(NEW_EXACT[9]), "beef tallow balm");
    assert.ok(NEW_EXACT.includes("SP | DEO | B0CLHYY3BB | EX | tallow deodorant for men | TOS"));
    assert.ok(NEW_EXACT.some((n) => n.includes("B0CLF5B27Y") && n.includes("tallow balm") && n.includes("TOS")));
    assert.equal(NEW_EXACT.some((n) => /tbm/i.test(n) && /deodorant/i.test(n)), false);
    assert.equal(LIP_BE_ACOS, 42);
    assert.equal(DEO_BE_ACOS, 36);
    assert.equal(BALM_BE_ACOS, 36);
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
  test("HARVEST_CANDIDATE needs L7 orders ≥ 3, ACOS ≤ family BE, no Exact home", () => {
    assert.equal(tagAutoLooseTerm({
      orders: 3, spend: 10, sales: 30, search_term: "tallow lip balm organic",
      campaign_name: AUTO_LOOSE_NAME,
    }, false), "HARVEST_CANDIDATE");
    assert.equal(tagAutoLooseTerm({
      orders: 3, spend: 10, sales: 30, search_term: "tallow lip balm",
      campaign_name: AUTO_LOOSE_NAME,
    }, true), "KEEP");
    assert.equal(tagAutoLooseTerm({
      orders: 2, spend: 10, sales: 30, search_term: "foo",
      campaign_name: AUTO_LOOSE_NAME,
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
    assert.equal(enabled.has("tallow balm"), true);
    assert.equal(enabled.has("beef tallow balm"), true);
    assert.equal(enabled.has("tallow deodorant for men"), true);
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
    assert.equal(harvest?.family, "lip_3pk");
    assert.equal(harvest?.break_even_acos, LIP_BE_ACOS);
    assert.ok(harvest?.acos_vs_be != null && harvest.acos_vs_be < 0);
    assert.equal(junk?.proposed_tag, "JUNK_CANDIDATE");
  });
});

describe("family contribution BE", () => {
  const deoCamp = "SP - Auto - Deodorant - B0CLHYY3BB -";
  const balmCamp = "TOS-Tallow Balm";
  const lipCamp = AUTO_LOOSE_NAME;
  // 38% sits between deo/balm BE 36 and lip 3pk BE 42.
  const overDeo = { orders: 3, spend: 11.4, sales: 30, search_term: "tallow deodorant" };
  const underDeo = { orders: 3, spend: 10.2, sales: 30, search_term: "tallow deodorant" };

  test("familyOf / breakEvenAcosOf split lip 3pk vs deo vs balm", () => {
    assert.equal(familyOf(lipCamp), "lip_3pk");
    assert.equal(breakEvenAcosOf(lipCamp), 42);
    assert.equal(familyOf(HERO_CHAPSTICK_NAME), "lip_3pk");
    assert.equal(breakEvenAcosOf(HERO_CHAPSTICK_NAME), 42);

    assert.equal(familyOf(deoCamp), "deo");
    assert.equal(breakEvenAcosOf(deoCamp), 36);
    assert.equal(familyOf(NEW_EXACT[6]), "deo");
    assert.equal(breakEvenAcosOf(NEW_EXACT[6]), 36);

    assert.equal(familyOf(FAT_PARENT_NAME), "lip_3pk");
    assert.equal(breakEvenAcosOf(FAT_PARENT_NAME), 42);
    assert.equal(familyOf(BROAD_M_NAME), "lip_3pk");
    assert.equal(breakEvenAcosOf(BROAD_M_NAME), 42);
    assert.equal(familyOf(NEW_EXACT[0]), "lip_3pk");
    assert.equal(breakEvenAcosOf(NEW_EXACT[0]), 42);
    assert.equal(familyOf(NEW_EXACT[3]), "lip_3pk");
    assert.equal(breakEvenAcosOf(NEW_EXACT[3]), 42);
    assert.equal(familyOf("SP KW - Exact(PM) - Lip Balm - DPB0CLHTKY3V/B0CLHVLG2F -"), "lip_3pk");

    assert.equal(familyOf(balmCamp), "balm");
    assert.equal(breakEvenAcosOf(balmCamp), 36);
    assert.equal(familyOf("SP - Branded KW(TOS) - Exact - Tallow Balm - Mixed -"), "balm");
    assert.equal(breakEvenAcosOf("Auto-Low Tallow balm"), 36);
  });

  test("harvest uses family BE — 38% harvests on lip, not deo or balm", () => {
    assert.equal(tagAutoLooseTerm({ ...overDeo, campaign_name: lipCamp }, false), "HARVEST_CANDIDATE");
    assert.equal(tagAutoLooseTerm({ ...overDeo, campaign_name: deoCamp }, false), "KEEP");
    assert.equal(tagAutoLooseTerm({ ...overDeo, campaign_name: balmCamp }, false), "KEEP");
    assert.equal(tagAutoLooseTerm({ ...underDeo, campaign_name: deoCamp }, false), "HARVEST_CANDIDATE");
    assert.equal(tagAutoLooseTerm({ ...underDeo, campaign_name: balmCamp }, false), "HARVEST_CANDIDATE");
  });

  test("acos_vs_be is ACOS minus BE (negative = under BE / healthier)", () => {
    assert.equal(acosVsBe(34, 36), -2);
    assert.equal(acosVsBe(38, 36), 2);
    assert.equal(acosVsBe(null, 42), null);
    assert.match(formatAcosVsBe(34, deoCamp), /ACOS 34\.0% vs deo BE 36% \(Δ -2\.0\)/);
    assert.match(CM_NOTE, /config family CM BE/);
  });

  test("digest / harvest alerts quote family BE next to ACOS", () => {
    const campaigns = [
      ...KEEP_ALIVE.map((name) => camp(name, { budget: 303, spend: 10, sales_14d: 40, orders_14d: 2 })),
      camp(NEW_EXACT[6], { spend: 8, sales_14d: 20, orders_14d: 1, impressions: 12 }),
    ];
    const terms: SearchTermRow[] = [{
      date: "2026-09-06",
      campaign_name: AUTO_LOOSE_NAME,
      search_term: "organic tallow 3 pack",
      match_type: "TARGETING_EXPRESSION",
      spend: 10, sales_14d: 30, orders_14d: 3, clicks: 8, impressions: 100,
    }];
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns, searchTerms: terms, placements: [],
    });
    const harvest = alerts.find((a) => a.code === "HARVEST_CANDIDATE");
    const deoDigest = alerts.find((a) => a.code === "NEW_EXACT_DIGEST" && a.campaign_name === NEW_EXACT[6]);
    const keeper = alerts.find((a) => a.code === "KEEPER_DIGEST" && a.campaign_name === AUTO_LOOSE_NAME);
    assert.match(harvest?.detail ?? "", /lip_3pk BE 42%/);
    assert.match(deoDigest?.detail ?? "", /deo BE 36%/);
    assert.match(keeper?.detail ?? "", /lip_3pk BE 42%/);
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

describe("per-campaign New Exact launch clock", () => {
  const midnightPt = "2026-09-07T00:00:00-07:00";
  const middayEt = "2026-09-07T12:00:00-04:00";
  const tue7amEt = new Date("2026-09-08T07:00:00-04:00");
  const plus18h = new Date("2026-09-08T06:00:00-04:00");
  const plus25h = new Date("2026-09-08T13:00:00-04:00");
  const tallowMeta: CampaignMeta[] = NEW_EXACT.map((name) => ({
    campaign_name: name,
    created_at: middayEt,
  }));

  function zeroShells(): CampaignDailyRow[] {
    return [
      ...KEEP_ALIVE.map((n) => camp(n, { budget: 303 })),
      ...NEW_EXACT.map((n) => camp(n, { impressions: 0, spend: 0 })),
    ];
  }

  test("config launched_at fallback is Dave midday ET, Wed review seed only", () => {
    assert.equal(GNO_LAUNCHED_AT, middayEt);
    assert.equal(GNO_NEXT_REVIEW_AT, "2026-09-09T18:00:00-07:00");
    assert.ok(hoursSinceLaunch(tue7amEt) < 24);
    assert.ok(hoursSinceLaunch(tue7amEt) > 18);
    assert.ok(hoursSinceLaunch(tue7amEt, midnightPt) >= 28);
  });

  test("midday create → at +18h no P0 even with 0 impressions", () => {
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-08", today: "2026-09-08",
      now: plus18h,
      campaigns: zeroShells(), searchTerms: [], placements: [],
      campaignMeta: tallowMeta,
    });
    assert.equal(alerts.some((a) => a.code === "NEW_EXACT_ZERO_IMPR"), false);
    const hours = hoursSinceCampaignLaunch(plus18h, tallowMeta[0], midnightPt);
    assert.ok(hours >= 17.9 && hours < 24);
  });

  test("midday create → at +25h with 0 impr → P0", () => {
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-08", today: "2026-09-08",
      now: plus25h,
      campaigns: zeroShells(), searchTerms: [], placements: [],
      campaignMeta: tallowMeta,
    });
    const zeros = alerts.filter((a) => a.code === "NEW_EXACT_ZERO_IMPR");
    assert.ok(zeros.length >= 1);
    assert.ok(zeros.every((a) => /tallow lip balm/.test(a.campaign_name ?? "")));
    assert.match(zeros[0].detail, /25h after launch/);
    const hours = hoursSinceCampaignLaunch(plus25h, tallowMeta[0]);
    assert.ok(hours >= 24);
  });

  test("global midnight launched_at must not override a later campaign created_at", () => {
    const laterCreate: CampaignMeta = { campaign_name: NEW_EXACT[0], created_at: middayEt };
    assert.equal(
      campaignLaunchedAt(laterCreate, midnightPt).startsWith("2026-09-07T16:00:00"),
      true,
    );
    const hours = hoursSinceCampaignLaunch(tue7amEt, laterCreate, midnightPt);
    assert.ok(hours < 24, `expected <24h from midday create, got ${hours}`);
    assert.ok(hoursSinceLaunch(tue7amEt, midnightPt) >= 28);

    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-08", today: "2026-09-08",
      now: tue7amEt,
      campaigns: zeroShells(), searchTerms: [], placements: [],
      campaignMeta: tallowMeta,
    });
    assert.equal(alerts.some((a) => a.code === "NEW_EXACT_ZERO_IMPR"), false);
    assert.ok(!alerts.some((a) => /28h/.test(a.detail)));
  });

  test("Tue 7am ET desk tiles are ~19h, not 28h, and not red", () => {
    const tiles = newExactTiles(zeroShells(), "2026-09-08", tue7amEt, tallowMeta);
    assert.ok(tiles.every((t) => t.hours_since_launch < 24));
    assert.ok(tiles.every((t) => t.hours_since_launch > 18));
    assert.ok(tiles.every((t) => !t.zero_impr_after_24h));
    assert.ok(tiles.every((t) => Math.round(t.hours_since_launch) === 19));
  });

  test("export-due / digest window does not raise P0 from the midnight clock", () => {
    const alerts = evaluateGnoAlerts({
      asOf: "2026-09-08", today: "2026-09-08",
      now: tue7amEt,
      campaigns: zeroShells(), searchTerms: [], placements: [],
      campaignMeta: tallowMeta,
    });
    const p0 = alerts.filter((a) => a.priority === "P0");
    const banner = evaluateExportNeed({
      now: tue7amEt,
      nextReviewAt: GNO_NEXT_REVIEW_AT,
      p0,
      p1: [],
    });
    assert.equal(p0.some((a) => a.code === "NEW_EXACT_ZERO_IMPR"), false);
    assert.equal(banner.reasons.includes("P0"), false);
    assert.equal(banner.state, QUIET);
  });
});

describe("export pack columns", () => {
  test("watch_campaigns.csv headers and Today+Last2+Last7 rows", () => {
    const campaigns = [
      camp(NEW_EXACT[0], { date: "2026-09-05", spend: 4, impressions: 20, clicks: 2, orders_14d: 0 }),
      camp(NEW_EXACT[0], { date: "2026-09-06", spend: 6, impressions: 30, clicks: 3, orders_14d: 1, sales_14d: 12 }),
    ];
    const rows = watchCampaignExportRows({ asOf: "2026-09-06", today: "2026-09-07", campaigns, placements: [] });
    const forNew = rows.filter((r) => r.campaign_name === NEW_EXACT[0]);
    assert.equal(forNew.length, 3);
    assert.deepEqual([...new Set(forNew.map((r) => `${r.date_start}..${r.date_end}`))].sort(), [
      "2026-08-31..2026-09-06",
      "2026-09-05..2026-09-06",
      "2026-09-07..2026-09-07",
    ]);
    assert.equal(forNew[0].watch_list, "NEW_EXACT");
    const csv = watchCampaignsCsv(rows);
    assert.equal(csv.split("\n")[0], WATCH_CAMPAIGN_CSV_HEADERS.join(","));
    assert.match(csv, /tos_modifier_pct/);
    assert.match(csv, /tos_spend_share/);
    assert.match(csv, /metrics_complete/);
    assert.ok(WATCH_CAMPAIGN_CSV_HEADERS.includes("family"));
    assert.ok(WATCH_CAMPAIGN_CSV_HEADERS.includes("break_even_acos"));
    assert.ok(WATCH_CAMPAIGN_CSV_HEADERS.includes("acos_vs_be"));
    assert.ok(WATCH_CAMPAIGN_CSV_HEADERS.includes("cm_note"));
    assert.match(csv.split("\n")[0], /family,break_even_acos,acos_vs_be,cm_note/);
    assert.doesNotMatch(csv.split("\n")[0], /(?<!modifier_|spend_share)tos_pct/);
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
    assert.equal(AUTO_LOOSE_TERM_CSV_HEADERS.includes("learning_note" as never), false);
    assert.ok(AUTO_LOOSE_TERM_CSV_HEADERS.includes("family"));
    assert.ok(AUTO_LOOSE_TERM_CSV_HEADERS.includes("break_even_acos"));
    assert.ok(AUTO_LOOSE_TERM_CSV_HEADERS.includes("acos_vs_be"));
    assert.match(csv.split("\n")[0], /family,break_even_acos,acos_vs_be,cm_note/);
    assert.match(csv, /HARVEST_CANDIDATE/);
    assert.match(csv, /lip_3pk/);
    assert.match(csv, /false/);
    assert.match(csv, /L7/);
  });

  test("zip contains the four required files and stamped filename", () => {
    const pack = buildGnoPack({
      asOf: "2026-09-06",
      today: "2026-09-07",
      now: new Date("2026-09-07T15:04:00-07:00"),
      campaigns: [camp(NEW_EXACT[0], { spend: 1 })],
      searchTerms: [],
      placements: [],
    });
    const names = pack.files.map((f) => f.name);
    assert.ok(names.includes("watch_campaigns.csv"));
    assert.ok(names.includes("auto_loose_search_terms.csv"));
    assert.ok(names.includes("fat_parent_search_terms.csv"));
    assert.ok(names.includes("broad_m_search_terms.csv"));
    assert.ok(names.includes("keyword_targets.csv"));
    assert.ok(names.includes("advertised_product_l7.csv"));
    assert.ok(names.includes("organic_rank_snapshot.csv"));
    assert.ok(names.includes("competitor_kr_outliers.csv"));
    assert.ok(names.includes("gno_decision_rules.txt"));
    assert.ok(names.includes("gno_outcomes.csv"));
    assert.ok(names.includes("README.txt"));
    const rules = pack.files.find((f) => f.name === "gno_decision_rules.txt")!.body;
    assert.match(rules, /Family CM break-even/);
    assert.match(rules, /Observe only/);
    const outcomes = pack.files.find((f) => f.name === "gno_outcomes.csv")!.body;
    assert.match(outcomes, /^created_at,pack_date,dave_action,/);
    const competitorCsv = pack.files.find((f) => f.name === "competitor_kr_outliers.csv")!.body;
    assert.match(competitorCsv, /^keyword,competitor_asin,our_hero_family,/);
    assert.match(competitorCsv, /already_bidding,suggested_lever/);
    assert.match(pack.files.find((f) => f.name === "README.txt")!.body, /competitor_kr_outliers\.csv/);
    assert.match(pack.files.find((f) => f.name === "README.txt")!.body, /gno_decision_rules\.txt/);
    assert.match(pack.files.find((f) => f.name === "README.txt")!.body, /gno_outcomes\.csv/);
    const emptySqp = pack.files.find((f) => f.name === "sqp_weekly_slice.csv");
    assert.ok(emptySqp);
    assert.equal(emptySqp!.body.trim().split("\n").length, 1);
    assert.equal(pack.files.some((f) => f.name === SQP_COMPARISON_FILENAME), false);
    assert.ok(names.length >= 5);
    assert.equal(pack.filename, "gno-pack-2026-09-07_1504.zip");
    const zip = zipStore(pack.files);
    const text = new TextDecoder().decode(zip);
    assert.match(text, /watch_campaigns\.csv/);
    assert.match(text, /auto_loose_search_terms\.csv/);
    assert.match(text, /fat_parent_search_terms\.csv/);
    assert.match(text, /broad_m_search_terms\.csv/);
    assert.match(text, /keyword_targets\.csv/);
    assert.match(pack.files.find((f) => f.name === "README.txt")!.body, /OMITTED/);
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
    assert.equal(tiles.length, NEW_EXACT.length);
    assert.ok(tiles.every((t) => t.zero_impr_after_24h));
    assert.equal(tiles[0].family, "lip_3pk");
    assert.equal(tiles[0].break_even_acos, 42);
    assert.equal(tiles[6].family, "deo");
    assert.equal(tiles[6].break_even_acos, 36);
    assert.equal(tiles[7].family, "deo");
    assert.equal(tiles[7].break_even_acos, 36);
    assert.equal(tiles[8].family, "balm");
    assert.equal(tiles[8].break_even_acos, BALM_BE_ACOS);
    assert.equal(tiles[9].family, "balm");
  });

  test("keeper heartbeat marks Auto Loose enabled + sparkline length 7", () => {
    const beats = keeperHeartbeats(
      [camp(AUTO_LOOSE_NAME, { budget: 303, spend: 12, campaign_status: "enabled" })],
      "2026-09-06",
    );
    assert.equal(beats[0].enabled, true);
    assert.equal(beats[0].family, "lip_3pk");
    assert.equal(beats[0].break_even_acos, 42);
    assert.equal(beats[0].sparkline.length, 7);
    assert.equal(isEnabledStatus("ENABLED"), true);
    assert.equal(isEnabledStatus("paused"), false);
  });

  test("source forbids auto-pause / auto-negate / auto-bid", () => {
    const files = [
      "src/lib/gno-ppc-watch.ts",
      "src/lib/gno-export-state.ts",
      "src/lib/gno-learning.ts",
      "src/lib/gno-methodology.ts",
      "src/lib/gno-store.ts",
      "src/app/ppc/gno/page.tsx",
      "src/components/ppc-gno-watch.tsx",
      "src/components/gno-desk-reference.tsx",
      "src/app/api/ppc/gno-export/route.ts",
      "src/app/api/ppc/gno-state/route.ts",
      "src/app/api/ppc/gno-outcome/route.ts",
      "src/app/api/ppc/gno-ack/route.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(path.join(process.cwd(), rel), "utf8");
      assert.doesNotMatch(src, /amazonads|autoPause\(|auto_pause\s*=\s*true/i);
      assert.match(src, /observe/i);
    }
    const ui = readFileSync(path.join(process.cwd(), "src/components/ppc-gno-watch.tsx"), "utf8");
    const lib = readFileSync(path.join(process.cwd(), "src/lib/gno-ppc-watch.ts"), "utf8");
    assert.match(ui, /Mark Done/);
    assert.match(ui, /acosWithBe/);
    assert.match(ui, /Family BE ACOS/);
    assert.doesNotMatch(lib, /alert\("P0", "KEEPER_MISSING"/);
    assert.doesNotMatch(lib, /acos <= LIP_BE_ACOS/);
    assert.match(lib, /breakEvenAcosOf\(term\.campaign_name/);
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
    assert.equal(existsSync(path.join(process.cwd(), "src/app/api/ppc/gno-state/route.ts")), true);
    assert.equal(existsSync(path.join(process.cwd(), "src/app/api/ppc/gno-ack/route.ts")), true);
    assert.equal(existsSync(path.join(process.cwd(), "src/app/api/ppc/gno-outcome/route.ts")), true);
  });

  test("GNO API pages with a date + campaign_id order", () => {
    for (const rel of ["src/app/api/ppc/gno/route.ts", "src/app/api/ppc/gno-export/route.ts"]) {
      const src = readFileSync(path.join(process.cwd(), rel), "utf8");
      assert.match(src, /\.order\("date"/);
      assert.match(src, /\.order\(order2/);
      assert.match(src, /campaign_id/);
    }
    const exp = readFileSync(path.join(process.cwd(), "src/app/api/ppc/gno-export/route.ts"), "utf8");
    assert.match(exp, /sqp_weekly/);
    assert.match(exp, /pageSqpSlice/);
    assert.match(exp, /\.range\(/);
    assert.match(exp, /query_normalized/);
  });
});

describe("GNO pack v2 — Dave 7 Sep feedback", () => {
  test("never omits watch-list campaigns with zero report rows", () => {
    const rows = watchCampaignExportRows({
      asOf: "2026-09-06",
      today: "2026-09-07",
      campaigns: [],
      placements: [],
      campaignMeta: NEW_EXACT.map((name) => ({
        campaign_name: name,
        state: "ENABLED",
        daily_budget: 25,
        portfolio_name: "Lip",
        tos_modifier_pct: 140,
        ros_modifier_pct: 0,
        pp_modifier_pct: 0,
      })),
    });
    const today = rows.filter((r) => r.date_start === "2026-09-07" && r.watch_list === "NEW_EXACT");
    assert.equal(today.length, NEW_EXACT.length);
    assert.ok(today.every((r) => r.state === "ENABLED"));
    assert.ok(today.every((r) => r.daily_budget === 25));
    assert.ok(today.every((r) => r.impressions === 0 && r.spend === 0));
    assert.ok(today.every((r) => r.metrics_complete === false));
    assert.ok(today.every((r) => r.tos_modifier_pct === 140 && r.ros_modifier_pct === 0 && r.pp_modifier_pct === 0));
    assert.ok(!today.some((r) => Number.isNaN(r.impressions)));
  });

  test("portfolio joins campaign meta name, else none", () => {
    const rows = watchCampaignExportRows({
      asOf: "2026-09-07",
      today: "2026-09-07",
      campaigns: [camp(NEW_EXACT[0])],
      placements: [],
      campaignMeta: [
        { campaign_name: NEW_EXACT[0], portfolio_name: "Lip", state: "ENABLED" },
        { campaign_name: NEW_EXACT[6], portfolio_name: "Deo", state: "ENABLED" },
      ],
    });
    const today = rows.filter((r) => r.date_start === "2026-09-07");
    assert.equal(today.find((r) => r.campaign_name === NEW_EXACT[0])?.portfolio, "Lip");
    assert.equal(today.find((r) => r.campaign_name === NEW_EXACT[6])?.portfolio, "Deo");
    assert.equal(today.find((r) => r.campaign_name === NEW_EXACT[1])?.portfolio, "none");
  });

  test("placement modifiers are not spend share", () => {
    const placements: PlacementRow[] = [
      { date: "2026-09-06", campaign_name: NEW_EXACT[0], placement: "Top of Search on-Amazon", spend: 8 },
      { date: "2026-09-06", campaign_name: NEW_EXACT[0], placement: "Detail Page on-Amazon", spend: 2 },
    ];
    const meta: CampaignMeta[] = [{
      campaign_name: NEW_EXACT[0],
      tos_modifier_pct: 140, ros_modifier_pct: 0, pp_modifier_pct: 0,
      portfolio_name: "Lip",
    }];
    const rows = watchCampaignExportRows({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns: [camp(NEW_EXACT[0], { date: "2026-09-06", spend: 10 })],
      placements, campaignMeta: meta,
    });
    const today = rows.find((r) => r.campaign_name === NEW_EXACT[0] && r.date_start === "2026-09-07");
    const l2 = rows.find((r) => r.campaign_name === NEW_EXACT[0] && r.date_start === "2026-09-05");
    assert.equal(today?.tos_modifier_pct, 140);
    assert.equal(today?.ros_modifier_pct, 0);
    assert.equal(today?.pp_modifier_pct, 0);
    assert.equal(today?.tos_spend_share, null);
    assert.equal(today?.metrics_complete, false);
    assert.equal(l2?.tos_spend_share, 80);
    assert.equal(l2?.pp_spend_share, 20);
    assert.equal(l2?.metrics_complete, true);
  });

  test("has_enabled_exact_elsewhere matches account-wide Exact keyword text", () => {
    const terms: SearchTermRow[] = [{
      date: "2026-09-07",
      campaign_name: AUTO_LOOSE_NAME,
      search_term: "Beef Tallow Lip Balm",
      match_type: "TARGETING_EXPRESSION",
      spend: 8, sales_14d: 24, orders_14d: 3, clicks: 10, impressions: 200,
    }];
    const targets: KeywordTarget[] = [
      {
        campaign_name: "SP | Orange Assorted Peppermint | Exact",
        keyword_text: "beef tallow lip balm",
        match_type: "EXACT",
        state: "ENABLED",
        bid: 1.2,
      },
      {
        campaign_name: FAT_PARENT_NAME,
        keyword_text: "  Beef Tallow Lip Balm ",
        match_type: "exact",
        state: "enabled",
        bid: 2.4,
      },
    ];
    const enabled = enabledExactKeywords([], terms, "2026-09-07", targets);
    assert.equal(enabled.has("beef tallow lip balm"), true);
    const q = harvestQueue(terms, [], "2026-09-07", targets);
    const row = q.find((t) => normalizeName(t.customer_search_term) === "beef tallow lip balm");
    assert.equal(row?.has_enabled_exact_elsewhere, true);
    assert.equal(row?.proposed_tag, "KEEP");
  });

  test("paused Exact elsewhere does not count as enabled", () => {
    const targets: KeywordTarget[] = [{
      campaign_name: "some paused exact",
      keyword_text: "beef tallow lip balm",
      match_type: "EXACT",
      state: "PAUSED",
    }];
    const enabled = enabledExactKeywords([], [], "2026-09-07", targets);
    assert.equal(enabled.has("beef tallow lip balm"), false);
  });

  test("auto loose and fat parent term CSVs carry L2/L7 dates", () => {
    const terms: SearchTermRow[] = [{
      date: "2026-09-06",
      campaign_name: FAT_PARENT_NAME,
      search_term: "tallow lip balm",
      match_type: "EXACT",
      keyword: "tallow lip balm",
      spend: 12, sales_14d: 40, orders_14d: 2, clicks: 6, impressions: 90,
    }];
    const fat = searchTermExportRows(terms, [], "2026-09-06", (n) => n === FAT_PARENT_NAME);
    assert.deepEqual([...new Set(fat.map((r) => r.label))].sort(), ["L2", "L7"]);
    assert.ok(fat.every((r) => r.date_end === "2026-09-06"));
    assert.ok(fat.some((r) => r.date_start === "2026-09-05" && r.label === "L2"));
    assert.ok(fat.some((r) => r.date_start === "2026-08-31" && r.label === "L7"));
    const csv = autoLooseSearchTermsCsv(fat);
    assert.match(csv, /date_start,date_end,label/);
    assert.match(csv, /family,break_even_acos,acos_vs_be,cm_note/);
    assert.ok(fat.every((r) => r.family === "lip_3pk" && r.break_even_acos === 42));
  });

  test("keyword_targets.csv covers NEW_EXACT + KEEPER with bid and metrics", () => {
    const targets: KeywordTarget[] = [{
      campaign_name: FAT_PARENT_NAME,
      keyword_text: "tallow lip balm",
      match_type: "EXACT",
      state: "ENABLED",
      bid: 2.45,
    }];
    const terms: SearchTermRow[] = [{
      date: "2026-09-07",
      campaign_name: FAT_PARENT_NAME,
      search_term: "tallow lip balm",
      keyword: "tallow lip balm",
      match_type: "EXACT",
      spend: 12, sales_14d: 40, orders_14d: 2, clicks: 6, impressions: 90,
    }];
    const pack = buildGnoPack({
      asOf: "2026-09-06",
      today: "2026-09-07",
      campaigns: [camp(FAT_PARENT_NAME, { date: "2026-09-07" })],
      searchTerms: terms,
      placements: [],
      keywordTargets: targets,
      negatives: [{ campaign_name: AUTO_LOOSE_NAME, keyword: "chapstick", match_type: "EXACT" }],
    });
    assert.ok(pack.files.some((f) => f.name === "keyword_targets.csv"));
    assert.ok(pack.files.some((f) => f.name === "negatives_snapshot.csv"));
    const kw = pack.files.find((f) => f.name === "keyword_targets.csv")!.body;
    assert.equal(kw.split("\n")[0], KEYWORD_TARGET_CSV_HEADERS.join(","));
    assert.match(kw.split("\n")[0], /family,break_even_acos,acos_vs_be,cm_note/);
    assert.ok(KEYWORD_TARGET_CSV_HEADERS.includes("family"));
    assert.ok(KEYWORD_TARGET_CSV_HEADERS.includes("break_even_acos"));
    assert.ok(KEYWORD_TARGET_CSV_HEADERS.includes("acos_vs_be"));
    assert.match(kw, /tallow lip balm/);
    assert.match(kw, /2.45/);
    assert.match(kw, /ENABLED/);
    assert.match(kw, /lip_3pk/);
    const csv = keywordTargetsCsv([{
      date_start: "2026-09-07", date_end: "2026-09-07",
      campaign_name: FAT_PARENT_NAME, asin: "", keyword_text: "tallow lip balm",
      match_type: "EXACT", keyword_state: "ENABLED", bid: 2.45,
      impressions: 90, clicks: 6, spend: 12, orders: 2, sales: 40, acos: 30,
      metrics_complete: false,
      family: "lip_3pk", break_even_acos: 42, acos_vs_be: -12, cm_note: CM_NOTE,
      organic_rank: null, organic_rank_prev: null, organic_rank_delta: null,
      aba_sfr: null, organic_as_of: null,
    }]);
    assert.match(csv, /2.45/);
    assert.match(csv, /metrics_complete/);
    assert.match(csv, /lip_3pk/);
  });

  test("csvEscape never writes NaN", () => {
    assert.equal(csvEscape(Number.NaN), "");
    assert.equal(csvEscape(Number.POSITIVE_INFINITY), "");
    assert.equal(gnoPackStamp(new Date("2026-09-07T15:04:00-07:00")), "2026-09-07_1504");
  });
});

describe("GNO pack nits — closed-day L2 + Today config-only", () => {
  test("as of 2026-09-07: Today / L2 / L7 are closed-day windows", () => {
    assert.equal(packClosedEnd("2026-09-07", "2026-09-06"), "2026-09-06");
    assert.equal(packClosedEnd("2026-09-07", "2026-09-07"), "2026-09-06");
    const windows = packWindows("2026-09-07", "2026-09-06");
    assert.deepEqual(windows, [
      { start: "2026-09-07", end: "2026-09-07", label: "Today", metrics_complete: false },
      { start: "2026-09-05", end: "2026-09-06", label: "Last2", metrics_complete: true },
      { start: "2026-08-31", end: "2026-09-06", label: "Last7", metrics_complete: true },
    ]);
    assert.equal(windows[1].end < windows[0].start, true);
    assert.equal(windows[2].end < windows[0].start, true);
  });

  test("Today $0 keeper stays ENABLED with metrics_complete=false", () => {
    const campaigns = [
      camp(AUTO_LOOSE_NAME, {
        date: "2026-09-06", campaign_status: "enabled", budget: 303, spend: 40,
      }),
    ];
    const rows = watchCampaignExportRows({
      asOf: "2026-09-06",
      today: "2026-09-07",
      campaigns,
      placements: [],
      campaignMeta: [{
        campaign_name: AUTO_LOOSE_NAME,
        state: "ENABLED",
        daily_budget: 303,
        portfolio_name: "Lip",
        tos_modifier_pct: 0,
      }],
    });
    const today = rows.find((r) => r.campaign_name === AUTO_LOOSE_NAME && r.date_start === "2026-09-07");
    const l2 = rows.find((r) => r.campaign_name === AUTO_LOOSE_NAME && r.date_start === "2026-09-05");
    const l7 = rows.find((r) => r.campaign_name === AUTO_LOOSE_NAME && r.date_start === "2026-08-31");
    assert.equal(today?.state, "enabled");
    assert.equal(today?.daily_budget, 303);
    assert.equal(today?.portfolio, "Lip");
    assert.equal(today?.spend, 0);
    assert.equal(today?.metrics_complete, false);
    assert.equal(l2?.spend, 40);
    assert.equal(l2?.metrics_complete, true);
    assert.equal(l7?.spend, 40);
    assert.equal(l7?.metrics_complete, true);
    assert.equal(today?.asin, "B0CLHTKY3V");
    assert.equal(today?.family, "lip_3pk");
    assert.equal(today?.break_even_acos, 42);
    assert.equal(today?.acos_vs_be, null);
    assert.match(today?.cm_note ?? "", /config family CM BE \(not TACOS\)/);
    assert.match(today?.cm_note ?? "", /days_live blank: created_at missing/);
    assert.equal(today?.days_live ?? null, null);
    assert.equal(l2?.family, "lip_3pk");
    assert.equal(l2?.break_even_acos, 42);
  });

  test("keyword_targets Today is config-only and keeps PAUSED fat-parent Exact", () => {
    const targets: KeywordTarget[] = [
      {
        campaign_name: FAT_PARENT_NAME,
        keyword_text: "tallow lip balm",
        match_type: "EXACT",
        state: "PAUSED",
        bid: 1.75,
      },
      {
        campaign_name: FAT_PARENT_NAME,
        keyword_text: "tallow lip balms",
        match_type: "EXACT",
        state: "ENABLED",
        bid: 1.60,
      },
    ];
    const terms: SearchTermRow[] = [{
      date: "2026-09-06",
      campaign_name: FAT_PARENT_NAME,
      search_term: "tallow lip balms",
      keyword: "tallow lip balms",
      match_type: "EXACT",
      spend: 8, sales_14d: 20, orders_14d: 1, clicks: 4, impressions: 50,
    }];
    const rows = keywordTargetExportRows({
      today: "2026-09-07",
      asOf: "2026-09-06",
      keywordTargets: targets,
      searchTerms: terms,
    });
    const todayPaused = rows.find((r) =>
      r.date_start === "2026-09-07" && r.keyword_text === "tallow lip balm");
    const todayPlural = rows.find((r) =>
      r.date_start === "2026-09-07" && r.keyword_text === "tallow lip balms");
    const l2Plural = rows.find((r) =>
      r.date_start === "2026-09-05" && r.keyword_text === "tallow lip balms");
    assert.equal(todayPaused?.keyword_state, "PAUSED");
    assert.equal(todayPaused?.bid, 1.75);
    assert.equal(todayPaused?.spend, 0);
    assert.equal(todayPaused?.metrics_complete, false);
    assert.equal(todayPlural?.keyword_state, "ENABLED");
    assert.equal(todayPlural?.bid, 1.6);
    assert.equal(todayPlural?.metrics_complete, false);
    assert.equal(l2Plural?.spend, 8);
    assert.equal(l2Plural?.metrics_complete, true);
    assert.equal(rows.filter((r) => r.keyword_text === "tallow lip balm").length, 3);
    assert.equal(rows.filter((r) => r.keyword_state === "PAUSED").length, 3);
  });

  test("extractAsin keeps mixed-ASIN keepers visible", () => {
    assert.equal(extractAsin(NEW_EXACT[0]), "B0CLHVCPL5");
    assert.equal(extractAsin(HERO_CHAPSTICK_NAME), "B0CLHTKY3V/B0CLHV3V5C");
    assert.equal(
      extractAsin("SP KW - Exact(PM) - Lip Balm - DPB0CLHTKY3V/B0CLHVLG2F -"),
      "B0CLHTKY3V/B0CLHVLG2F",
    );
    assert.equal(extractAsin(FAT_PARENT_NAME), "");
  });
});

describe("GNO pack v3 — Wed review upgrades", () => {
  const orangeChapstick = "Orange Lip Balm - SP - Tallow Chapstick - KWs - Exact";
  const assortedLipBalm = "Assorted Lip Balm - SP - Lip Balm - KWs - Exact";
  const unscentedOrganic = "Unscented Lip Balm - SP - Organic Lip Balm - KWs - Exact";
  const peppermintBalms = "Peppermint Lip Balm - SP- Tallow Lip Balms -KW - Exact";
  const strUnscented = "SP - STR - KW Exact - Lip Balm, Unscented  - B0CLHVCPL5 - -8-10ord";

  test("FLAVOR_SHELL classifies discovered 1-keyword Exact flavor names only", () => {
    assert.equal(watchListOf(orangeChapstick), "FLAVOR_SHELL");
    assert.equal(watchListOf(assortedLipBalm), "FLAVOR_SHELL");
    assert.equal(watchListOf(unscentedOrganic), "FLAVOR_SHELL");
    assert.equal(watchListOf(peppermintBalms), "FLAVOR_SHELL");
    assert.equal(isFlavorShellName(orangeChapstick), true);
    assert.equal(isFlavorShellName(strUnscented), false);
    assert.equal(watchListOf(strUnscented), "OTHER");
    assert.equal(watchListOf("GG - Peppermint - Asin Off - Competitor 1"), "OTHER");
    assert.equal(watchListOf(NEW_EXACT[0]), "NEW_EXACT");
    assert.equal(watchListOf(FAT_PARENT_NAME), "KEEPER");
    assert.equal(watchListOf("Catch-All Auto"), "DAY5_PAUSE");
    assert.ok(FLAVOR_SHELL.includes(orangeChapstick));
  });

  test("watch_campaigns includes FLAVOR_SHELL without dropping NEW_EXACT / KEEPER / DAY5", () => {
    const rows = watchCampaignExportRows({
      asOf: "2026-09-06",
      today: "2026-09-07",
      campaigns: [
        camp(orangeChapstick, { date: "2026-09-06", spend: 9, impressions: 40 }),
      ],
      placements: [],
    });
    const today = rows.filter((r) => r.date_start === "2026-09-07");
    assert.ok(today.some((r) => r.watch_list === "FLAVOR_SHELL" && r.campaign_name === orangeChapstick));
    assert.equal(today.filter((r) => r.watch_list === "NEW_EXACT").length, NEW_EXACT.length);
    assert.ok(today.filter((r) => r.watch_list === "KEEPER").length >= KEEP_ALIVE.length);
    assert.ok(today.some((r) => r.watch_list === "DAY5_PAUSE"));
    const flavor = today.find((r) => r.campaign_name === orangeChapstick);
    assert.equal(flavor?.family, "lip_3pk");
    assert.equal(flavor?.break_even_acos, 42);
  });

  test("broad_m_search_terms.csv matches Auto Loose columns and L2+L7 windows", () => {
    const terms: SearchTermRow[] = [{
      date: "2026-09-06",
      campaign_name: BROAD_M_NAME,
      search_term: "all natural chapstick",
      match_type: "BROAD",
      spend: 15.82, sales_14d: 0, orders_14d: 0, clicks: 10, impressions: 80,
    }];
    const pack = buildGnoPack({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns: [camp(BROAD_M_NAME, { spend: 16 })],
      searchTerms: terms,
      placements: [],
    });
    const file = pack.files.find((f) => f.name === "broad_m_search_terms.csv");
    assert.ok(file);
    const header = file!.body.split("\n")[0];
    assert.equal(header, AUTO_LOOSE_TERM_CSV_HEADERS.join(","));
    assert.match(file!.body, /GG - Lip Balm - Broad M/);
    assert.match(file!.body, /all natural chapstick/);
    assert.match(file!.body, /L2/);
    assert.match(file!.body, /L7/);
    assert.match(file!.body, /lip_3pk/);
    assert.match(file!.body, /42/);
    assert.match(file!.body, /has_enabled_exact_elsewhere/);
    assert.equal(file!.body.split("\n").filter((l) => l.includes("all natural chapstick")).length, 2);
  });

  test("keyword_targets do not copy search-term rollups onto every match type", () => {
    const targets: KeywordTarget[] = [
      {
        keyword_id: "paused-exact",
        campaign_name: FAT_PARENT_NAME,
        keyword_text: "tallow lip balm",
        match_type: "EXACT",
        state: "PAUSED",
        bid: 1.75,
      },
      {
        keyword_id: "paused-broad",
        campaign_name: FAT_PARENT_NAME,
        keyword_text: "tallow lip balm",
        match_type: "BROAD",
        state: "PAUSED",
        bid: 0.53,
      },
      {
        keyword_id: "enabled-plural",
        campaign_name: FAT_PARENT_NAME,
        keyword_text: "tallow lip balms",
        match_type: "EXACT",
        state: "ENABLED",
        bid: 1.60,
      },
    ];
    const terms: SearchTermRow[] = [{
      date: "2026-09-06",
      campaign_name: FAT_PARENT_NAME,
      search_term: "tallow lip balm",
      keyword: "tallow lip balms",
      keyword_id: "enabled-plural",
      match_type: "EXACT",
      spend: 36, sales_14d: 80, orders_14d: 2, clicks: 13, impressions: 504,
    }];
    const rows = keywordTargetExportRows({
      today: "2026-09-07",
      asOf: "2026-09-06",
      keywordTargets: targets,
      searchTerms: terms,
    });
    const l2Paused = rows.find((r) =>
      r.date_start === "2026-09-05" && r.keyword_text === "tallow lip balm" && r.match_type === "EXACT");
    const l2Broad = rows.find((r) =>
      r.date_start === "2026-09-05" && r.keyword_text === "tallow lip balm" && r.match_type === "BROAD");
    const l2Enabled = rows.find((r) =>
      r.date_start === "2026-09-05" && r.keyword_text === "tallow lip balms");
    const todayPaused = rows.find((r) =>
      r.date_start === "2026-09-07" && r.keyword_text === "tallow lip balm" && r.match_type === "EXACT");
    assert.equal(l2Enabled?.impressions, 504);
    assert.equal(l2Enabled?.clicks, 13);
    assert.equal(l2Enabled?.spend, 36);
    assert.equal(l2Enabled?.keyword_state, "ENABLED");
    assert.equal(l2Paused?.impressions, 0);
    assert.equal(l2Paused?.spend, 0);
    assert.equal(l2Paused?.keyword_state, "PAUSED");
    assert.equal(l2Broad?.impressions, 0);
    assert.equal(todayPaused?.metrics_complete, false);
    assert.equal(todayPaused?.spend, 0);
    assert.equal(todayPaused?.bid, 1.75);
    assert.ok(!KEYWORD_ST_NOTE.includes("tallow lip balms") || l2Paused?.spend === 0);
  });

  test("L2/L7 keeper placement lag writes a cm_note instead of silent blanks", () => {
    const campaigns = [
      camp(FAT_PARENT_NAME, { date: "2026-09-06", spend: 40, impressions: 100, clicks: 8 }),
    ];
    const missing = watchCampaignExportRows({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns, placements: [],
    });
    const l2 = missing.find((r) => r.campaign_name === FAT_PARENT_NAME && r.date_start === "2026-09-05");
    const today = missing.find((r) => r.campaign_name === FAT_PARENT_NAME && r.date_start === "2026-09-07");
    assert.equal(l2?.spend, 40);
    assert.equal(l2?.tos_spend_share, null);
    assert.equal(l2?.ros_spend_share, null);
    assert.equal(l2?.pp_spend_share, null);
    assert.match(l2?.cm_note ?? "", /placement report lag/i);
    assert.ok((l2?.cm_note ?? "").includes(PLACEMENT_LAG_NOTE));
    assert.equal(today?.tos_spend_share, null);
    assert.doesNotMatch(today?.cm_note ?? "", /placement report lag/i);

    const present = watchCampaignExportRows({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns,
      placements: [
        { date: "2026-09-06", campaign_name: FAT_PARENT_NAME, placement: "Top of Search on-Amazon", spend: 30 },
        { date: "2026-09-06", campaign_name: FAT_PARENT_NAME, placement: "Other on-Amazon", spend: 10 },
      ],
    });
    const l2p = present.find((r) => r.campaign_name === FAT_PARENT_NAME && r.date_start === "2026-09-05");
    assert.equal(l2p?.tos_spend_share, 75);
    assert.equal(l2p?.ros_spend_share, 25);
    assert.equal(l2p?.pp_spend_share, 0);
    assert.doesNotMatch(l2p?.cm_note ?? "", /placement report lag/i);
  });

  test("advertised_product_l7.csv splits mixed-ASIN keepers without inventing ASIN spend", () => {
    const pack = buildGnoPack({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns: [camp(HERO_CHAPSTICK_NAME, { date: "2026-09-06", spend: 22, orders_14d: 2, sales_14d: 80 })],
      searchTerms: [],
      placements: [],
      asinCatalog: [
        { asin: "B0CLHTKY3V", sku: "DDPE0003Shop", product_name: "Sweet Orange 3pk" },
        { asin: "B0CLHV3V5C", sku: "DDPE0002Shop", product_name: "Peppermint 3pk" },
      ],
    });
    const file = pack.files.find((f) => f.name === "advertised_product_l7.csv");
    assert.ok(file);
    assert.equal(file!.body.split("\n")[0], ADVERTISED_PRODUCT_L7_CSV_HEADERS.join(","));
    assert.match(file!.body, /B0CLHTKY3V/);
    assert.match(file!.body, /B0CLHV3V5C/);
    assert.match(file!.body, /Sweet Orange 3pk/);
    assert.match(file!.body, /campaign-level L7/);
    const hero = file!.body.split("\n").filter((l) => l.includes("Hero KW"));
    assert.equal(hero.length, 2);
    assert.ok(hero.every((l) => l.includes("22")));
    assert.ok(hero.some((l) => l.includes("B0CLHTKY3V") && l.includes("Sweet Orange 3pk")));
    assert.ok(hero.some((l) => l.includes("B0CLHV3V5C") && l.includes("Peppermint 3pk")));
  });

  test("SQP slice includes latest week only and omits the file when empty", () => {
    const withSqp = buildGnoPack({
      asOf: "2026-09-06", today: "2026-09-07",
      campaigns: [], searchTerms: [], placements: [],
      sqpWeekly: [
        {
          week_start: "2026-08-16", week_end: "2026-08-22",
          asin: "B0CLHTKY3V", search_query: "lip balm", query_normalized: "lip balm",
          search_query_volume: 90000, click_share: 0.11, source: "sqp_spapi",
        },
        {
          week_start: "2026-08-23", week_end: "2026-08-29",
          asin: "", search_query: "lip balm", query_normalized: "lip balm",
          search_query_volume: 91047, click_share: 0.15, source: "sqp_brand_csv",
        },
        {
          week_start: "2026-08-23", week_end: "2026-08-29",
          asin: "", search_query: "chapstick", query_normalized: "chapstick",
          search_query_volume: 78344, click_share: 0.39, source: "sqp_brand_csv",
        },
        {
          week_start: "2026-08-23", week_end: "2026-08-29",
          asin: "", search_query: "ignored", query_normalized: "beef tallow moisturizer",
          search_query_volume: 10, source: "sqp_brand_csv",
        },
      ],
    });
    const sqp = withSqp.files.find((f) => f.name === "sqp_weekly_slice.csv");
    assert.ok(sqp);
    assert.equal(sqp!.body.split("\n")[0], SQP_SLICE_CSV_HEADERS.join(","));
    assert.match(sqp!.body, /2026-08-29/);
    assert.doesNotMatch(sqp!.body, /2026-08-22/);
    assert.match(sqp!.body, /chapstick/);
    assert.doesNotMatch(sqp!.body, /beef tallow moisturizer/);
    const readme = withSqp.files.find((f) => f.name === "README.txt")!.body;
    assert.match(readme, /CURRENT newest stored complete/);
    assert.match(readme, /stale_pre_raise=false/);
    assert.doesNotMatch(readme, /STALE PRE-RAISE/);
    assert.match(sqp!.body, /stale_pre_raise/);
    assert.match(sqp!.body, /false/);
    assert.match(sqp!.body, /sqp_csv/);
    assert.doesNotMatch(sqp!.body, /sqp_brand_csv/);
    const comparison = withSqp.files.find((f) => f.name === SQP_COMPARISON_FILENAME);
    assert.ok(comparison);
    assert.match(comparison!.body, /2026-08-22/);
    assert.match(comparison!.body, /sqp_spapi/);
    assert.match(readme, /COMPARISON \/ PRE_RAISE/);

    const empty = sqpWeeklySliceRows([], "2026-09-07");
    assert.deepEqual(empty, []);
  });
});

describe("GNO pack — NEW_EXACT TBM shells + SQP week + ST L2 SoT + organic rank", () => {
  const tbmBalm = "SP | TBM | B0CLF5B27Y | EX | tallow balm | TOS";
  const tbmBeef = "SP | TBM | B0CLF5B27Y | EX | beef tallow balm | TOS";
  const tbmBalmNoTos = "SP | TBM | B0CLF5B27Y | EX | tallow balm";
  const tbmDeoWrong = "SP | TBM | B0CLF5B27Y | EX | tallow deodorant for men";
  const deoForMen = "SP | DEO | B0CLHYY3BB | EX | tallow deodorant for men | TOS";

  test("NEW_EXACT keeps two TBM Exact shells and the live DEO for-men TOS campaign", () => {
    assert.ok(NEW_EXACT.includes(tbmBalm));
    assert.ok(NEW_EXACT.includes(tbmBeef));
    assert.ok(NEW_EXACT.includes(deoForMen));
    assert.equal(NEW_EXACT.includes(tbmDeoWrong), false);
    assert.equal(watchListOf(tbmBalm), "NEW_EXACT");
    assert.equal(watchListOf(tbmBalmNoTos), "NEW_EXACT");
    assert.equal(isNewExactName(tbmBalm), true);
    assert.equal(isNewExactName(tbmDeoWrong), false);
    assert.equal(watchListOf(tbmDeoWrong), "OTHER");
    assert.equal(watchListOf(deoForMen), "NEW_EXACT");
    assert.equal(extractExactKeyword(tbmBalm), "tallow balm");
    assert.equal(extractExactKeyword(tbmBalmNoTos), "tallow balm");
    const rows = watchCampaignExportRows({
      asOf: "2026-09-10",
      today: "2026-09-11",
      campaigns: [],
      placements: [],
      campaignMeta: [
        { campaign_name: tbmBalm, state: "ENABLED", daily_budget: 25 },
        { campaign_name: tbmBeef, state: "ENABLED", daily_budget: 25 },
        { campaign_name: tbmDeoWrong, state: "ENABLED", daily_budget: 25 },
        { campaign_name: deoForMen, state: "ENABLED", daily_budget: 20 },
      ],
    });
    const today = rows.filter((r) => r.date_start === "2026-09-11" && r.watch_list === "NEW_EXACT");
    assert.ok(today.some((r) => r.campaign_name === tbmBalm));
    assert.ok(today.some((r) => r.campaign_name === tbmBeef));
    assert.ok(today.some((r) => r.campaign_name === deoForMen));
    assert.equal(today.some((r) => /tbm/i.test(r.campaign_name) && /deodorant/i.test(r.campaign_name)), false);
    assert.equal(today.filter((r) => /b0clf5b27y/i.test(r.campaign_name)).length, 2);
  });

  test("current SQP slice is the max complete week_end even when that week is the bid-raise week", () => {
    const rows = [
      {
        week_start: "2026-08-30", week_end: "2026-09-05",
        search_query: "lip balm", query_normalized: "lip balm",
        search_query_volume: 90000, click_share: 0.1, source: "sqp_brand_csv",
      },
      {
        week_start: "2026-09-06", week_end: "2026-09-12",
        search_query: "lip balm", query_normalized: "lip balm",
        search_query_volume: 92000, click_share: 0.12, source: "sqp_spapi",
      },
    ];
    const picked = selectSqpSliceWeek(rows, "2026-09-13");
    assert.equal(picked.current?.weekEnd, "2026-09-12");
    assert.equal(picked.stale, false);
    assert.match(picked.note, /stale_pre_raise=false/);
    const slice = sqpWeeklySliceRows(rows, "2026-09-13");
    assert.ok(slice.every((r) => r.week_end === "2026-09-12"));
    assert.ok(slice.every((r) => r.stale_pre_raise === false));
    assert.ok(slice.every((r) => r.source === "sqp_spapi"));
  });

  test("Auto Loose L2 ST sum does not inflate vs campaign L2 (SUMMARY grain)", () => {
    assert.equal(stDateLooksDaily(658, 144), false);
    assert.equal(stDateLooksDaily(70, 72), true);
    const campaigns = [
      camp(AUTO_LOOSE_NAME, { date: "2026-09-09", spend: 70, impressions: 400, clicks: 40 }),
      camp(AUTO_LOOSE_NAME, { date: "2026-09-10", spend: 74, impressions: 420, clicks: 42 }),
    ];
    const terms: SearchTermRow[] = [
      {
        date: "2026-09-10",
        campaign_name: AUTO_LOOSE_NAME,
        search_term: "tallow lip balm organic",
        match_type: "TARGETING_EXPRESSION",
        spend: 300, sales_14d: 400, orders_14d: 8, clicks: 80, impressions: 2000,
      },
      {
        date: "2026-09-10",
        campaign_name: AUTO_LOOSE_NAME,
        search_term: "chapstick 3 pack",
        match_type: "TARGETING_EXPRESSION",
        spend: 358, sales_14d: 200, orders_14d: 4, clicks: 90, impressions: 1800,
      },
    ];
    const st = searchTermExportRows(terms, campaigns, "2026-09-10", isAutoLoose);
    const l2 = sumHarvestSpend(st, "L2");
    const campL2 = 144;
    assert.ok(l2 <= campL2 * 1.25 + 2, `Auto Loose L2 ST $${l2} ≫ campaign L2 $${campL2}`);
    assert.equal(l2, 0);
    assert.equal(st.filter((r) => r.label === "L2").length, 0);
    const l7 = sumHarvestSpend(st, "L7");
    assert.equal(l7, 0);
    assert.equal(st.filter((r) => r.label === "L7").length, 0);
  });

  test("Auto Loose L2 ST sums 1-day stamps and stays near campaign L2", () => {
    const campaigns = [
      camp(AUTO_LOOSE_NAME, { date: "2026-09-09", spend: 70 }),
      camp(AUTO_LOOSE_NAME, { date: "2026-09-10", spend: 74 }),
    ];
    const terms: SearchTermRow[] = [
      {
        date: "2026-09-09",
        campaign_name: AUTO_LOOSE_NAME,
        search_term: "tallow lip balm organic",
        match_type: "TARGETING_EXPRESSION",
        spend: 40, sales_14d: 80, orders_14d: 2, clicks: 10, impressions: 200,
      },
      {
        date: "2026-09-09",
        campaign_name: AUTO_LOOSE_NAME,
        search_term: "chapstick 3 pack",
        match_type: "TARGETING_EXPRESSION",
        spend: 28, sales_14d: 40, orders_14d: 1, clicks: 8, impressions: 160,
      },
      {
        date: "2026-09-10",
        campaign_name: AUTO_LOOSE_NAME,
        search_term: "tallow lip balm organic",
        match_type: "TARGETING_EXPRESSION",
        spend: 44, sales_14d: 90, orders_14d: 2, clicks: 12, impressions: 220,
      },
      {
        date: "2026-09-10",
        campaign_name: AUTO_LOOSE_NAME,
        search_term: "chapstick 3 pack",
        match_type: "TARGETING_EXPRESSION",
        spend: 30, sales_14d: 50, orders_14d: 1, clicks: 9, impressions: 170,
      },
    ];
    const st = searchTermExportRows(terms, campaigns, "2026-09-10", isAutoLoose);
    const l2 = sumHarvestSpend(st, "L2");
    assert.equal(l2, 142);
    assert.ok(l2 <= 144 * 1.25 + 2);
    assert.ok(st.some((r) => r.label === "L2" && r.customer_search_term === "tallow lip balm organic"));
  });

  test("organic rank/SFR join onto keyword + ST files; empty stays blank; volume is not SFR", () => {
    const snapshots = [
      {
        phrase: "tallow lip balm",
        asin: "B0CLHTF8YN",
        organic_position: 4,
        organic_previous_position: 9,
        aba_search_frequency_rank: 120,
        search_volume: 999999,
        as_of: "2026-09-07",
      },
    ];
    const pack = buildGnoPack({
      asOf: "2026-09-10", today: "2026-09-11",
      campaigns: [camp(FAT_PARENT_NAME, { date: "2026-09-10", spend: 12 })],
      searchTerms: [{
        date: "2026-09-10",
        campaign_name: FAT_PARENT_NAME,
        search_term: "tallow lip balm",
        keyword: "tallow lip balm",
        match_type: "EXACT",
        spend: 12, sales_14d: 40, orders_14d: 2, clicks: 6, impressions: 90,
      }],
      placements: [],
      keywordTargets: [{
        campaign_name: FAT_PARENT_NAME,
        keyword_text: "tallow lip balm",
        match_type: "EXACT",
        state: "ENABLED",
        bid: 2.45,
      }],
      organicSnapshots: snapshots,
    });
    const kw = pack.files.find((f) => f.name === "keyword_targets.csv")!.body;
    const fat = pack.files.find((f) => f.name === "fat_parent_search_terms.csv")!.body;
    const snap = pack.files.find((f) => f.name === "organic_rank_snapshot.csv")!.body;
    const readme = pack.files.find((f) => f.name === "README.txt")!.body;
    assert.match(kw.split("\n")[0], /organic_rank,organic_rank_prev,organic_rank_delta,aba_sfr,organic_as_of/);
    assert.match(kw, /tallow lip balm/);
    assert.match(kw, /,4,9,5,120,2026-09-07/);
    assert.doesNotMatch(kw, /999999/);
    assert.match(fat, /,4,9,5,120,2026-09-07/);
    assert.match(snap, /B0CLHTF8YN/);
    assert.match(snap, /120/);
    assert.match(readme, /Brand Analytics SFR/);
    assert.match(readme, /never creates SoldScope Rank Tracker groups/);
    assert.match(readme, /Exact protect/);

    const emptyPack = buildGnoPack({
      asOf: "2026-09-10", today: "2026-09-11",
      campaigns: [camp(NEW_EXACT[0])],
      searchTerms: [],
      placements: [],
      organicSnapshots: [{
        phrase: "tallow lip balm",
        asin: "B0CLHTF8YN",
        organic_position: null,
        search_volume: 888888,
        as_of: "2026-09-07",
      }],
    });
    const emptyKw = emptyPack.files.find((f) => f.name === "watch_campaigns.csv")!.body;
    assert.match(emptyKw.split("\n")[0], /organic_rank/);
    assert.doesNotMatch(emptyKw, /888888/);
  });
});

describe("GNO pack freshness — SQP current slice and unslid L2/L7", () => {
  const PACK = "2026-09-24";
  const currentWeek = {
    week_start: "2026-09-13",
    week_end: "2026-09-19",
    search_query: "lip balm",
    query_normalized: "lip balm",
    search_query_volume: 88000,
    click_share: 0.14,
    source: "sqp_spapi",
  };
  const bidRaise = {
    week_start: "2026-09-06",
    week_end: "2026-09-12",
    search_query: "chapstick",
    query_normalized: "chapstick",
    search_query_volume: 77000,
    source: "sqp_brand_csv",
  };
  const inProgress = {
    week_start: "2026-09-20",
    week_end: "2026-09-26",
    search_query: "lip balm",
    query_normalized: "lip balm",
    search_query_volume: 1,
    impression_share: 0.5,
    click_share: 0.5,
    purchase_share: 0.5,
    source: "sqp_spapi",
  };

  test("current SQP slice is the max complete week_end", () => {
    assert.equal(SQP_STALE_AFTER_DAYS, 10);
    assert.equal(isCompleteSqpWeek("2026-09-13", "2026-09-19", PACK), true);
    assert.equal(isCompleteSqpWeek("2026-09-20", "2026-09-26", PACK), false);
    const rows = [bidRaise, currentWeek, inProgress];
    const plan = selectSqpSliceWeek(rows, PACK);
    assert.equal(plan.stale, false);
    assert.equal(plan.current?.weekStart, "2026-09-13");
    assert.equal(plan.current?.weekEnd, "2026-09-19");
    assert.equal(plan.lastCompleteWeekEnd, "2026-09-19");
    const slice = sqpWeeklySliceRows(rows, PACK);
    assert.ok(slice.length > 0);
    assert.ok(slice.every((r) => r.week_end === "2026-09-19" && r.stale_pre_raise === false));
    assert.ok(slice.every((r) => r.source === "sqp_spapi"));
    const pack = buildGnoPack({
      asOf: "2026-09-23",
      today: PACK,
      campaigns: [],
      searchTerms: [],
      placements: [],
      sqpWeekly: rows,
    });
    const file = pack.files.find((f) => f.name === "sqp_weekly_slice.csv")!;
    assert.match(file.body, /2026-09-19/);
    assert.doesNotMatch(file.body, /2026-09-12/);
    assert.doesNotMatch(file.body, /2026-09-26/);
    assert.match(pack.files.find((f) => f.name === "README.txt")!.body, /CURRENT newest stored complete/);
    assert.match(pack.files.find((f) => f.name === "README.txt")!.body, /stale_pre_raise=false/);
    const header = file.body.split("\n")[0].split(",");
    const data = file.body.trim().split("\n")[1].split(",");
    const shareAt = header.indexOf("impression_share");
    const purchaseAt = header.indexOf("purchase_share");
    assert.equal(data[shareAt], "");
    assert.equal(data[purchaseAt], "");
  });

  test("older SQP weeks ship only as COMPARISON PRE_RAISE with stale_pre_raise true", () => {
    const rows = [bidRaise, currentWeek];
    const comparison = sqpComparisonSliceRows(rows, PACK);
    assert.ok(comparison.length > 0);
    assert.ok(comparison.every((r) => r.week_end === "2026-09-12" && r.stale_pre_raise === true));
    assert.ok(comparison.every((r) => r.source === "sqp_csv"));
    const pack = buildGnoPack({
      asOf: "2026-09-23",
      today: PACK,
      campaigns: [],
      searchTerms: [],
      placements: [],
      sqpWeekly: rows,
    });
    const current = pack.files.find((f) => f.name === "sqp_weekly_slice.csv")!.body;
    const older = pack.files.find((f) => f.name === SQP_COMPARISON_FILENAME)!.body;
    assert.match(current, /2026-09-19/);
    assert.doesNotMatch(current, /2026-09-12/);
    assert.match(older, /2026-09-12/);
    assert.match(older, /true/);
    assert.doesNotMatch(older, /2026-09-19/);
    const readme = pack.files.find((f) => f.name === "README.txt")!.body;
    assert.match(readme, /COMPARISON \/ PRE_RAISE/);
    assert.match(readme, /stale_pre_raise=true/);
    assert.match(readme, /Not the current slice/);
  });

  test("SQP_STALE when newest complete week_end is more than 10 days before pack_date", () => {
    assert.equal(isCompleteSqpWeek("2026-09-06", "2026-09-12", "2026-09-22"), true);
    const freshEnough = selectSqpSliceWeek([bidRaise], "2026-09-22");
    assert.equal(freshEnough.stale, false);
    assert.equal(freshEnough.current?.weekEnd, "2026-09-12");
    const stale = selectSqpSliceWeek([bidRaise, inProgress], "2026-09-23");
    assert.equal(stale.stale, true);
    assert.equal(stale.current, null);
    assert.equal(stale.staleReason, "newest_complete_week_older_than_10_days");
    assert.equal(stale.lastCompleteWeekEnd, "2026-09-12");
    assert.match(stale.note, /SQP_STALE reason=newest_complete_week_older_than_10_days last_week_end=2026-09-12/);
    const pack = buildGnoPack({
      asOf: "2026-09-22",
      today: "2026-09-23",
      campaigns: [],
      searchTerms: [],
      placements: [],
      sqpWeekly: [bidRaise, inProgress],
    });
    const staleCurrent = pack.files.find((f) => f.name === "sqp_weekly_slice.csv");
    assert.ok(staleCurrent);
    assert.equal(staleCurrent!.body.trim().split("\n").length, 1);
    assert.doesNotMatch(staleCurrent!.body, /2026-09-12/);
    assert.equal(pack.files.some((f) => f.name === SQP_COMPARISON_FILENAME), false);
    const readme = pack.files.find((f) => f.name === "README.txt")!.body;
    assert.match(readme, /SQP_STALE reason=newest_complete_week_older_than_10_days last_week_end=2026-09-12/);
    assert.doesNotMatch(readme, /stale_pre_raise=false/);
    assert.doesNotMatch(readme, /CURRENT newest stored complete/);
  });

  test("in-progress incomplete SQP week is never selected", () => {
    assert.equal(isCompleteSqpWeek("2026-09-20", "2026-09-24", PACK), false);
    assert.equal(isCompleteSqpWeek("2026-09-20", "2026-09-26", "2026-09-26"), false);
    const onlyOpen = selectSqpSliceWeek([inProgress], PACK);
    assert.equal(onlyOpen.current, null);
    assert.equal(onlyOpen.staleReason, "no_complete_sun_sat_week");
    assert.deepEqual(sqpWeeklySliceRows([inProgress], PACK), []);
    const pack = buildGnoPack({
      asOf: "2026-09-23",
      today: PACK,
      campaigns: [],
      searchTerms: [],
      placements: [],
      sqpWeekly: [inProgress],
    });
    const openCurrent = pack.files.find((f) => f.name === "sqp_weekly_slice.csv");
    assert.ok(openCurrent);
    assert.equal(openCurrent!.body.trim().split("\n").length, 1);
    assert.doesNotMatch(openCurrent!.body, /2026-09-26/);
    assert.equal(pack.files.some((f) => f.name === SQP_COMPARISON_FILENAME), false);
    assert.match(
      pack.files.find((f) => f.name === "README.txt")!.body,
      /SQP_STALE reason=no_complete_sun_sat_week last_week_end=2026-09-26/,
    );
    const withCurrent = sqpWeeklySliceRows([currentWeek, inProgress], PACK);
    assert.ok(withCurrent.every((r) => r.week_end === "2026-09-19"));
    assert.equal(withCurrent.some((r) => r.week_end === "2026-09-26"), false);
  });

  test("L2 and L7 end yesterday and do not slide when yesterday ads are open", () => {
    assert.equal(packClosedEnd("2026-09-24", "2026-09-20"), "2026-09-23");
    assert.equal(l2L7MetricsComplete("2026-09-24", "2026-09-20"), false);
    const campaigns = [camp(AUTO_LOOSE_NAME, { date: "2026-09-20", spend: 50, campaign_status: "enabled" })];
    const windows = packWindows("2026-09-24", "2026-09-20", campaigns);
    assert.deepEqual(windows, [
      { start: "2026-09-24", end: "2026-09-24", label: "Today", metrics_complete: false },
      { start: "2026-09-22", end: "2026-09-23", label: "Last2", metrics_complete: false },
      { start: "2026-09-17", end: "2026-09-23", label: "Last7", metrics_complete: false },
    ]);
    const rows = watchCampaignExportRows({
      asOf: "2026-09-20",
      today: "2026-09-24",
      campaigns,
      placements: [],
    });
    const today = rows.find((r) => r.campaign_name === AUTO_LOOSE_NAME && r.date_start === "2026-09-24");
    const l2 = rows.find((r) => r.campaign_name === AUTO_LOOSE_NAME && r.date_end === "2026-09-23" && r.date_start === "2026-09-22");
    const l7 = rows.find((r) => r.campaign_name === AUTO_LOOSE_NAME && r.date_end === "2026-09-23" && r.date_start === "2026-09-17");
    assert.equal(today?.metrics_complete, false);
    assert.equal(today?.spend, 0);
    assert.equal(today?.state, "enabled");
    assert.equal(l2?.metrics_complete, false);
    assert.equal(l2?.spend, 0);
    assert.equal(l7?.metrics_complete, false);
    assert.equal(l7?.spend, 0);
    assert.equal(rows.some((r) => r.campaign_name === AUTO_LOOSE_NAME && r.date_end === "2026-09-20"), false);
  });

  test("SUMMARY search-term stamp is not used as L2 or L7", () => {
    const campaigns = [
      camp(AUTO_LOOSE_NAME, { date: "2026-09-22", spend: 40 }),
      camp(AUTO_LOOSE_NAME, { date: "2026-09-23", spend: 44 }),
    ];
    const terms: SearchTermRow[] = [
      {
        date: "2026-09-23",
        campaign_name: AUTO_LOOSE_NAME,
        search_term: "tallow lip balm organic",
        match_type: "TARGETING_EXPRESSION",
        spend: 400, sales_14d: 0, orders_14d: 0, clicks: 90, impressions: 2000,
      },
    ];
    const st = searchTermExportRows(terms, campaigns, "2026-09-23", isAutoLoose);
    assert.equal(sumHarvestSpend(st, "L2"), 0);
    assert.equal(sumHarvestSpend(st, "L7"), 0);
    assert.equal(st.length, 0);
    const kw = keywordTargetExportRows({
      today: "2026-09-24",
      asOf: "2026-09-23",
      campaigns,
      keywordTargets: [{
        campaign_name: AUTO_LOOSE_NAME,
        keyword_text: "tallow lip balm organic",
        match_type: "TARGETING_EXPRESSION",
        state: "ENABLED",
        bid: 0.8,
      }],
      searchTerms: terms.map((t) => ({ ...t, keyword: t.search_term })),
    });
    const l2 = kw.find((r) => r.date_start === "2026-09-22");
    const l7 = kw.find((r) => r.date_start === "2026-09-17");
    assert.equal(l2?.metrics_complete, true);
    assert.equal(l2?.spend, 0);
    assert.equal(l7?.spend, 0);
  });
});

describe("GNO pack contract 2026-09-24", () => {
  const RANK = "Unscented Lip Balm - SP - Lip Balm - KWs - Exact";
  const ASSORTED = "Assorted Lip Balm - SP - Lip Balm - KWs - Exact";
  const PEPPER = "Peppermint Lip Balm - SP - Lip Balm - KWs - Exact";

  test("README freshness block is first and names every required key", () => {
    const pack = buildGnoPack({
      asOf: "2026-09-23",
      today: "2026-09-24",
      now: new Date("2026-09-24T18:00:00-07:00"),
      campaigns: [],
      searchTerms: [],
      placements: [],
    });
    const readme = pack.files.find((f) => f.name === "README.txt")!.body;
    const lines = readme.split("\n");
    assert.equal(lines[0].startsWith("pack_id:"), true);
    for (const key of FRESHNESS_LINES) {
      assert.ok(lines.some((line) => line.startsWith(key)), key);
    }
    const notesAt = lines.findIndex((line) => line.startsWith("quality_gate_notes:"));
    const methodAt = lines.findIndex((line) => line.startsWith("GNO Export pack"));
    assert.ok(notesAt >= 0 && methodAt > notesAt);
    assert.match(readme, /America\/Los_Angeles/);
    assert.match(readme, /lip_3pk=42/);
    assert.match(readme, /deo=36/);
    assert.match(readme, /balm=36/);
    assert.match(readme, /Never writes to Amazon/);
    assert.match(readme, /WINDOW_AGG/);
    assert.match(readme, /NOT_SOT/);
    for (const name of [
      "pack_manifest.json", "watch_placements.csv", "bleeders_10.csv", "bleeders_20.csv",
      "lifetime_zero.csv", "bid_review_candidates.csv", "harvest_queue.csv",
      "structure_audit.csv", "agreements.csv", "sqp_wow.csv", "gno_outcomes.csv",
    ]) {
      assert.ok(pack.files.some((f) => f.name === name), name);
    }
    assert.match(pack.files.find((f) => f.name === "agreements.csv")!.body, /ranking campaign/);
    assert.match(pack.files.find((f) => f.name === "agreements.csv")!.body, /42/);
    assert.match(pack.files.find((f) => f.name === "lifetime_zero.csv")!.body, /product_cvr/);
    assert.match(readme, /ltd_unavailable/);
    const manifest = JSON.parse(pack.files.find((f) => f.name === "pack_manifest.json")!.body);
    assert.equal(manifest.observe_only, true);
    assert.ok(manifest.files.some((f: { name: string; sha256: string }) => f.name === "README.txt" && f.sha256.length === 64));
  });

  test("review search terms are WINDOW_AGG and SUMMARY is not labeled L7", () => {
    const campaigns = [
      camp(AUTO_LOOSE_NAME, { date: "2026-09-22", spend: 20, campaign_id: "auto-1" }),
      camp(AUTO_LOOSE_NAME, { date: "2026-09-23", spend: 22, campaign_id: "auto-1" }),
    ];
    const terms: SearchTermRow[] = [
      {
        date: "2026-09-22", campaign_id: "auto-1", campaign_name: AUTO_LOOSE_NAME,
        search_term: "tallow lip balm", match_type: "TARGETING_EXPRESSION",
        spend: 8, sales_14d: 0, orders_14d: 0, clicks: 3, impressions: 40,
      },
      {
        date: "2026-09-23", campaign_id: "auto-1", campaign_name: AUTO_LOOSE_NAME,
        search_term: "tallow lip balm", match_type: "TARGETING_EXPRESSION",
        spend: 9, sales_14d: 0, orders_14d: 0, clicks: 4, impressions: 50,
      },
    ];
    const st = searchTermExportRows(terms, campaigns, "2026-09-23", isAutoLoose);
    const l7 = st.filter((r) => r.label === "L7" && r.customer_search_term === "tallow lip balm");
    assert.equal(l7.length, 1);
    assert.equal(l7[0].grain, "WINDOW_AGG");
    assert.equal(l7[0].clicks, 7);
    assert.equal(l7[0].window_label, "L7");
    const summary: SearchTermRow[] = [{
      date: "2026-09-23", campaign_name: AUTO_LOOSE_NAME, search_term: "tallow lip balm",
      match_type: "TARGETING_EXPRESSION", spend: 400, clicks: 90, impressions: 2000, orders_14d: 0, sales_14d: 0,
    }];
    const hidden = searchTermExportRows(summary, campaigns, "2026-09-23", isAutoLoose);
    assert.equal(hidden.filter((r) => r.label === "L7").length, 0);
    const scored = contractSearchTermTag({
      clicks: 2, orders: 2, search_term: "tallow lip balm", has_enabled_exact_elsewhere: false,
    });
    assert.notEqual(scored.proposed_tag, "HARVEST_EXACT");
  });

  test("watch_campaigns dedups campaign_id+window and keeps distinct ids", () => {
    const doubled = dedupeWatchCampaignRows([
      { campaign_id: "111", campaign_name: "Catch-All-Lip Balm-Auto High Interest", window_label: "L7" },
      { campaign_id: "111", campaign_name: "Catch-All-Lip Balm-Auto High Interest", window_label: "L7" },
    ]);
    assert.equal(doubled.length, 1);
    const both = dedupeWatchCampaignRows([
      { campaign_id: "111", campaign_name: "Catch-All-Lip Balm-Auto High Interest", window_label: "L7" },
      { campaign_id: "222", campaign_name: "Catch-All-Lip Balm-Auto High Interest", window_label: "L7" },
    ]);
    assert.equal(both.length, 2);
    assert.ok(both.every((r) => r.duplicate_reason === "name_collision"));
  });

  test("Bleeders 2.0 uses family BE plus points, never 37", () => {
    assert.equal(bleeder20Threshold(42, "SP"), 62);
    assert.equal(bleeder20Threshold(36, "SP"), 56);
    assert.equal(bleeder20Threshold(36, "SB"), 46);
    assert.equal(bleeder20Threshold(36, "SBV"), 46);
    assert.notEqual(bleeder20Threshold(36, "SP"), 37);
    const deo = "SP | DEO | B0CLHYY3BB | EX | tallow deodorant | TOS";
    const pack = buildGnoPack({
      asOf: "2026-09-23", today: "2026-09-24",
      campaigns: [camp(deo, { date: "2026-09-23", spend: 60, campaign_id: "deo-1" })],
      searchTerms: [{
        date: "2026-09-23", campaign_id: "deo-1", campaign_name: deo,
        search_term: "tallow deodorant", keyword: "tallow deodorant", keyword_id: "deo-kw",
        match_type: "EXACT", spend: 60, sales_14d: 100, orders_14d: 2, clicks: 12, impressions: 80,
      }],
      placements: [],
      keywordTargets: [{
        campaign_id: "deo-1", keyword_id: "deo-kw", campaign_name: deo,
        keyword_text: "tallow deodorant", match_type: "EXACT", state: "ENABLED", bid: 1.2,
      }],
    });
    const body = pack.files.find((f) => f.name === "bleeders_20.csv")!.body;
    assert.match(body, /56/);
    assert.match(body, /deo/);
    assert.doesNotMatch(body, /,37,/);
    const under = buildGnoPack({
      asOf: "2026-09-23", today: "2026-09-24",
      campaigns: [camp(deo, { date: "2026-09-23", spend: 50, campaign_id: "deo-1" })],
      searchTerms: [{
        date: "2026-09-23", campaign_id: "deo-1", campaign_name: deo,
        search_term: "tallow deodorant", keyword: "tallow deodorant", keyword_id: "deo-kw",
        match_type: "EXACT", spend: 50, sales_14d: 100, orders_14d: 2, clicks: 12, impressions: 80,
      }],
      placements: [],
      keywordTargets: [{
        campaign_id: "deo-1", keyword_id: "deo-kw", campaign_name: deo,
        keyword_text: "tallow deodorant", match_type: "EXACT", state: "ENABLED", bid: 1.2,
      }],
    });
    const underBody = under.files.find((f) => f.name === "bleeders_20.csv")!.body;
    assert.equal(underBody.trim().split("\n").length, 1);
  });

  test("ranking Exact lip balm is exempt from ACOS cut and Bleeders 2.0 pause suggestions", () => {
    const pack = buildGnoPack({
      asOf: "2026-09-23", today: "2026-09-24",
      campaigns: [
        camp(RANK, { date: "2026-09-23", spend: 40, sales_14d: 40, orders_14d: 2, campaign_id: "rank-1", campaign_status: "ENABLED" }),
        camp(ASSORTED, { date: "2026-09-23", spend: 5, campaign_id: "as-1", campaign_status: "ENABLED" }),
        camp(PEPPER, { date: "2026-09-23", spend: 5, campaign_id: "pep-1", campaign_status: "ENABLED" }),
      ],
      campaignMeta: [
        { campaign_id: "rank-1", campaign_name: RANK, state: "ENABLED", daily_budget: 25 },
        { campaign_id: "as-1", campaign_name: ASSORTED, state: "ENABLED", daily_budget: 25 },
        { campaign_id: "pep-1", campaign_name: PEPPER, state: "ENABLED", daily_budget: 25 },
      ],
      searchTerms: [{
        date: "2026-09-23", campaign_id: "rank-1", campaign_name: RANK,
        search_term: "lip balm", keyword: "lip balm", keyword_id: "kw-lip",
        match_type: "EXACT", spend: 40, sales_14d: 40, orders_14d: 2, clicks: 18, impressions: 200,
      }],
      placements: [],
      keywordTargets: [
        { campaign_id: "rank-1", keyword_id: "kw-lip", campaign_name: RANK, keyword_text: "lip balm", match_type: "EXACT", state: "ENABLED", bid: 1.8 },
        { campaign_id: "as-1", keyword_id: "kw-as", campaign_name: ASSORTED, keyword_text: "lip balm", match_type: "EXACT", state: "ENABLED", bid: 1.1 },
        { campaign_id: "pep-1", keyword_id: "kw-pep", campaign_name: PEPPER, keyword_text: "lip balm", match_type: "EXACT", state: "ENABLED", bid: 0.9 },
      ],
    });
    const watch = pack.files.find((f) => f.name === "watch_campaigns.csv")!.body;
    assert.match(watch, /ranking/);
    const b20 = pack.files.find((f) => f.name === "bleeders_20.csv")!.body;
    const b20lines = b20.trim().split("\n");
    const header = b20lines[0].split(",");
    const purposeAt = header.indexOf("campaign_purpose");
    const cutAt = header.indexOf("cut_suggestion");
    const tagAt = header.indexOf("proposed_tag");
    const threshAt = header.indexOf("threshold_acos");
    const rankLine = b20lines.find((line) => line.includes(RANK));
    assert.ok(rankLine);
    const cols = rankLine!.split(",");
    assert.equal(cols[purposeAt], "ranking");
    assert.equal(cols[cutAt], "false");
    assert.equal(cols[tagAt], "SKIP");
    assert.equal(cols[threshAt], "62");
    assert.doesNotMatch(rankLine!, /review_bid_down|pause/);
    const bids = pack.files.find((f) => f.name === "bid_review_candidates.csv")!.body;
    const bidHeader = bids.trim().split("\n")[0].split(",");
    const sugAt = bidHeader.indexOf("one_lever_suggestion");
    const rankBid = bids.trim().split("\n").find((line) => line.includes(RANK));
    assert.ok(rankBid);
    assert.notEqual(rankBid!.split(",")[sugAt], "review_bid_down");
    assert.doesNotMatch(rankBid!, /pause/);
    const audit = pack.files.find((f) => f.name === "structure_audit.csv")!.body;
    assert.match(audit, /sibling_exact_auction/);
    assert.match(audit, /lip balm/);
  });

  test("keyword spend above the campaign tile sets window_mismatch and keeps campaign SoT", () => {
    const pack = buildGnoPack({
      asOf: "2026-09-23", today: "2026-09-24",
      campaigns: [camp(AUTO_LOOSE_NAME, { date: "2026-09-23", spend: 10, campaign_id: "auto-1", campaign_status: "ENABLED" })],
      searchTerms: [{
        date: "2026-09-23", campaign_id: "auto-1", campaign_name: AUTO_LOOSE_NAME,
        search_term: "loose query", keyword: "loose query", keyword_id: "kw-loose",
        match_type: "TARGETING_EXPRESSION", spend: 14, sales_14d: 0, orders_14d: 0, clicks: 4, impressions: 40,
      }],
      placements: [],
      keywordTargets: [{
        campaign_id: "auto-1", keyword_id: "kw-loose", campaign_name: AUTO_LOOSE_NAME,
        keyword_text: "loose query", match_type: "TARGETING_EXPRESSION", state: "ENABLED", bid: 0.5,
      }],
    });
    const watch = pack.files.find((f) => f.name === "watch_campaigns.csv")!.body;
    const watchHeader = watch.trim().split("\n")[0].split(",");
    const spendAt = watchHeader.indexOf("spend");
    const winAt = watchHeader.indexOf("window_label");
    const misAt = watchHeader.indexOf("window_mismatch");
    const l7 = watch.trim().split("\n").find((line) => {
      const cols = line.split(",");
      return cols[winAt] === "L7" && line.includes(AUTO_LOOSE_NAME);
    });
    assert.ok(l7);
    assert.equal(l7!.split(",")[spendAt], "10");
    assert.equal(l7!.split(",")[misAt], "true");
    const kw = pack.files.find((f) => f.name === "keyword_targets.csv")!.body;
    const kwHeader = kw.trim().split("\n")[0].split(",");
    const kwMis = kwHeader.indexOf("window_mismatch");
    const kwL7 = kw.trim().split("\n").find((line) => line.includes("loose query") && line.includes("2026-09-17"));
    assert.ok(kwL7);
    assert.equal(kwL7!.split(",")[kwMis], "true");
  });

  test("quality gates FAIL the contract cases", () => {
    const base = {
      today: "2026-09-24",
      yesterday: "2026-09-23",
      sqpCurrentWeekEnd: "2026-09-19",
      sqpNewestCompleteWeekEnd: "2026-09-19",
      sqpLagDays: 5,
      sqpStaleOver10: false,
      sqpFiles: [] as { name: string; week_type: string; week_end: string; stale_pre_raise: boolean }[],
      watchRows: [] as {
        campaign_id?: string; campaign_name: string; window_label: string; date_end: string;
        metrics_complete: boolean; watch_list: string; state?: string; meta_sync?: boolean;
      }[],
      spendMismatches: [] as { disagrees: boolean; window_mismatch: boolean }[],
      stPresentedAsCampaignSot: false,
      stFiles: [{ name: "auto_loose_search_terms.csv", rows: 1, emptyReason: true, grains: ["WINDOW_AGG"], labels: ["L7"] }],
      organicAsOf: "2026-09-23",
      organicZeroFilled: false,
      inventedSqpShares: false,
      bleeders20: [] as { campaign_purpose: string; threshold_acos: number; break_even_acos: number; ad_product: string; cut_suggestion: boolean; proposed_tag: string }[],
      bidReview: [] as { purpose: string; suggestion: string }[],
      priorCounts: null,
      currentCounts: { auto_loose: 1, broad_m: 0, watch: 1, sqp: 1 },
      rowFiltersApplied: "WINDOW_AGG",
      fatParentEmpty: false,
      ltdUnavailable: false,
      addsThisWeekUnknown: false,
      skuCostsMissing: false,
      outcomesImplementedUnknown: false,
      placementLag: false,
    };
    assert.equal(evaluatePackQuality(base).level, "PASS");
    assert.equal(evaluatePackQuality({ ...base, sqpStaleOver10: true }).level, "FAIL");
    assert.ok(evaluatePackQuality({
      ...base,
      sqpFiles: [{ name: "sqp_weekly_slice_COMPARISON_PRE_RAISE.csv", week_type: "comparison", week_end: "2026-09-12", stale_pre_raise: false }],
    }).fails.some((f) => f.startsWith("2 ")));
    assert.ok(evaluatePackQuality({
      ...base,
      watchRows: [{ campaign_name: "A", window_label: "L7", date_end: "2026-09-20", metrics_complete: true, watch_list: "KEEPER" }],
    }).fails.some((f) => f.startsWith("3 ")));
    assert.ok(evaluatePackQuality({ ...base, organicAsOf: "2026-09-20" }).fails.some((f) => f.startsWith("4 ")));
    assert.ok(evaluatePackQuality({ ...base, stPresentedAsCampaignSot: true }).fails.some((f) => f.startsWith("5 ")));
    assert.ok(evaluatePackQuality({
      ...base, spendMismatches: [{ disagrees: true, window_mismatch: false }],
    }).fails.some((f) => f.startsWith("6 ")));
    assert.ok(evaluatePackQuality({
      ...base,
      watchRows: [
        { campaign_id: "1", campaign_name: "Catch-All", window_label: "L7", date_end: "2026-09-23", metrics_complete: true, watch_list: "DAY5_PAUSE" },
        { campaign_id: "1", campaign_name: "Catch-All", window_label: "L7", date_end: "2026-09-23", metrics_complete: true, watch_list: "DAY5_PAUSE" },
      ],
    }).fails.some((f) => f.startsWith("7 ")));
    assert.ok(evaluatePackQuality({
      ...base,
      watchRows: [{ campaign_name: "New", window_label: "Today", date_end: "2026-09-24", metrics_complete: false, watch_list: "NEW_EXACT", state: "", meta_sync: true }],
    }).fails.some((f) => f.startsWith("8 ")));
    assert.ok(evaluatePackQuality({
      ...base,
      stFiles: [{ name: "auto_loose_search_terms.csv", rows: 0, emptyReason: false, grains: [], labels: [] }],
    }).fails.some((f) => f.startsWith("9 ")));
    assert.ok(evaluatePackQuality({
      ...base,
      priorCounts: { auto_loose: 100 },
      currentCounts: { auto_loose: 10, broad_m: 0, watch: 1, sqp: 1 },
      rowFiltersApplied: "",
    }).fails.some((f) => f.startsWith("10 ")));
    assert.ok(evaluatePackQuality({ ...base, organicZeroFilled: true }).fails.some((f) => f.startsWith("11 ")));
    assert.ok(evaluatePackQuality({
      ...base,
      bleeders20: [{ campaign_purpose: "ranking", threshold_acos: 62, break_even_acos: 42, ad_product: "SP", cut_suggestion: true, proposed_tag: "WATCH" }],
    }).fails.some((f) => f.startsWith("12 ")));
    assert.ok(evaluatePackQuality({
      ...base,
      bidReview: [{ purpose: "ranking", suggestion: "review_bid_down" }],
    }).fails.some((f) => f.startsWith("12 ")));
    assert.ok(evaluatePackQuality({
      ...base,
      bleeders20: [{ campaign_purpose: "profit", threshold_acos: 37, break_even_acos: 42, ad_product: "SP", cut_suggestion: false, proposed_tag: "WATCH" }],
    }).fails.some((f) => f.startsWith("13 ")));
    assert.ok(evaluatePackQuality({ ...base, inventedSqpShares: true }).fails.some((f) => f.startsWith("14 ")));
    assert.ok(evaluatePackQuality({
      ...base,
      stFiles: [{ name: "auto_loose_search_terms.csv", rows: 2, emptyReason: true, grains: ["DAILY", "SUMMARY"], labels: ["L7", "L7"] }],
    }).fails.some((f) => f.startsWith("15 ")));
    const warn = evaluatePackQuality({ ...base, sqpLagDays: 9, fatParentEmpty: true, skuCostsMissing: true });
    assert.equal(warn.level, "WARN");
    assert.match(warn.notes, /SQP_LAG_DAYS 9/);
    assert.match(warn.notes, /fat_parent empty/);
    assert.match(warn.notes, /sku_costs missing/);
  });
});

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === "\"" && line[i + 1] === "\"") {
      cur += "\"";
      i += 1;
      continue;
    }
    if (c === "\"") {
      quoted = !quoted;
      continue;
    }
    if (c === "," && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseCsv(body: string): Record<string, string>[] {
  const lines = body.trim().split(/\n/).filter((l) => l.length > 0);
  const headers = splitCsvLine(lines[0] ?? "");
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cols[i] ?? ""; });
    return row;
  });
}

describe("Dave nine zipper-audit fixes", () => {
  const kwName = "SP | DEO | B0CLHYY3BB | EX | tallow deodorant | TOS";

  test("query_normalized folds women to woman and quotes Amazon ids", () => {
    assert.equal(queryNormalized("  Déodorant   for   Women "), "deodorant for woman");
    assert.equal(queryNormalized("tallow deodorant for men"), "tallow deodorant for men");
    assert.equal(queryNormalized("for woman"), queryNormalized("for women"));
    const pack = buildGnoPack({
      asOf: "2026-09-23",
      today: "2026-09-24",
      campaigns: [camp(kwName, {
        date: "2026-09-23", spend: 4, campaign_id: "123456789012345678", campaign_status: "ENABLED",
      })],
      campaignMeta: [{
        campaign_id: "123456789012345678",
        campaign_name: kwName,
        state: "ENABLED",
        portfolio_id: "998877665544332211",
      }],
      searchTerms: [],
      placements: [],
      keywordTargets: [{
        campaign_id: "123456789012345678",
        ad_group_id: "222333444555666777",
        keyword_id: "111222333444555666",
        campaign_name: kwName,
        keyword_text: "deodorant for women",
        match_type: "EXACT",
        state: "ENABLED",
        bid: 1,
      }],
    });
    const watch = pack.files.find((f) => f.name === "watch_campaigns.csv")!.body;
    const kw = pack.files.find((f) => f.name === "keyword_targets.csv")!.body;
    assert.match(watch, /"123456789012345678"/);
    assert.match(watch, /"998877665544332211"/);
    assert.match(kw, /"111222333444555666"/);
    assert.match(kw, /"222333444555666777"/);
    const kwRows = parseCsv(kw);
    assert.ok(kwRows.some((r) => r.query_normalized === "deodorant for woman"));
    const readme = pack.files.find((f) => f.name === "README.txt")!.body;
    assert.match(readme, /women→woman/);
    assert.match(readme, /man\/men are not folded/);
  });

  test("L60 is blank unless daily facts cover 60 closed days; days_live comes from created_at", () => {
    assert.equal(seriesCoversWindow(["2026-09-23"], "2026-07-26", "2026-09-23").covers, false);
    assert.equal(seriesCoversWindow(["2026-07-26", "2026-09-23"], "2026-07-26", "2026-09-23").covers, true);
    assert.equal(daysLiveAsOf("2026-09-01T17:00:00Z", "2026-09-24"), 23);

    const short = buildGnoPack({
      asOf: "2026-09-23",
      today: "2026-09-24",
      campaigns: [camp(kwName, {
        date: "2026-09-23", spend: 91.01, clicks: 12, orders_14d: 0, campaign_id: "deo-1", campaign_status: "ENABLED",
      })],
      searchTerms: [{
        date: "2026-09-23", campaign_id: "deo-1", campaign_name: kwName,
        search_term: "tallow deodorant", keyword: "tallow deodorant", keyword_id: "deo-kw",
        match_type: "EXACT", spend: 91.01, sales_14d: 0, orders_14d: 0, clicks: 12, impressions: 80,
      }],
      placements: [],
      keywordTargets: [{
        campaign_id: "deo-1", keyword_id: "deo-kw", campaign_name: kwName,
        keyword_text: "tallow deodorant", match_type: "EXACT", state: "ENABLED", bid: 1.2,
      }],
    });
    const shortKw = parseCsv(short.files.find((f) => f.name === "keyword_targets.csv")!.body)
      .filter((r) => r.keyword_text === "tallow deodorant");
    const shortL30 = shortKw.find((r) => r.window_label === "L30");
    const shortL60 = shortKw.find((r) => r.window_label === "L60");
    assert.equal(shortL30?.metrics_complete, "true");
    assert.equal(shortL30?.spend, "91.01");
    assert.equal(shortL60?.metrics_complete, "false");
    assert.equal(shortL60?.spend, "");
    assert.notEqual(shortL60?.spend, shortL30?.spend);
    const shortBleed = short.files.find((f) => f.name === "bleeders_10.csv")!.body.trim().split("\n");
    assert.equal(shortBleed.length, 1);
    assert.match(short.files.find((f) => f.name === "README.txt")!.body, /Bleeders 1\.0 window \(60d\): .* untrusted coverage_days=/);
    assert.match(short.files.find((f) => f.name === "watch_campaigns.csv")!.body, /days_live blank: created_at missing/);

    const dated = "2026-09-10T12:00:00Z";
    const long = buildGnoPack({
      asOf: "2026-09-23",
      today: "2026-09-24",
      campaigns: [
        camp(kwName, { date: "2026-07-26", spend: 10, clicks: 12, orders_14d: 0, campaign_id: "deo-1", campaign_status: "ENABLED" }),
        camp(kwName, { date: "2026-09-23", spend: 91.01, clicks: 1, orders_14d: 0, campaign_id: "deo-1", campaign_status: "ENABLED" }),
      ],
      campaignMeta: [{ campaign_id: "deo-1", campaign_name: kwName, state: "ENABLED", created_at: dated }],
      searchTerms: [
        {
          date: "2026-07-26", campaign_id: "deo-1", campaign_name: kwName,
          search_term: "tallow deodorant", keyword: "tallow deodorant", keyword_id: "deo-kw",
          match_type: "EXACT", spend: 10, sales_14d: 0, orders_14d: 0, clicks: 12, impressions: 40,
        },
        {
          date: "2026-09-23", campaign_id: "deo-1", campaign_name: kwName,
          search_term: "tallow deodorant", keyword: "tallow deodorant", keyword_id: "deo-kw",
          match_type: "EXACT", spend: 91.01, sales_14d: 0, orders_14d: 0, clicks: 1, impressions: 20,
        },
      ],
      placements: [],
      keywordTargets: [{
        campaign_id: "deo-1", keyword_id: "deo-kw", campaign_name: kwName,
        keyword_text: "tallow deodorant", match_type: "EXACT", state: "ENABLED", bid: 1.2,
        created_at: dated,
      }],
    });
    const longKw = parseCsv(long.files.find((f) => f.name === "keyword_targets.csv")!.body)
      .filter((r) => r.keyword_text === "tallow deodorant");
    const longL60 = longKw.find((r) => r.window_label === "L60");
    const longL30 = longKw.find((r) => r.window_label === "L30");
    assert.equal(longL60?.metrics_complete, "true");
    assert.equal(longL60?.spend, "101.01");
    assert.equal(longL30?.spend, "91.01");
    const todayKw = longKw.find((r) => r.window_label === "Today");
    assert.equal(todayKw?.days_live, "14");
    const bleed = parseCsv(long.files.find((f) => f.name === "bleeders_10.csv")!.body);
    assert.equal(bleed.length, 1);
    assert.equal(bleed[0].window_untrusted, "false");
    assert.equal(bleed[0].metrics_complete, "true");
    assert.equal(bleed[0].clicks_60, "13");
    assert.equal(bleed[0].spend_60, "101.01");
    assert.doesNotMatch(
      long.files.find((f) => f.name === "README.txt")!.body,
      /Bleeders 1\.0 window \(60d\): .*untrusted/,
    );
  });

  test("spend_yesterday and SOP flags stay on Today rows", () => {
    const pack = buildGnoPack({
      asOf: "2026-09-23",
      today: "2026-09-24",
      campaigns: [
        camp(kwName, { date: "2026-07-26", spend: 10, clicks: 12, budget: 20, campaign_id: "deo-1", campaign_status: "ENABLED" }),
        camp(kwName, { date: "2026-09-22", spend: 3, budget: 20, campaign_id: "deo-1", campaign_status: "ENABLED" }),
        camp(kwName, { date: "2026-09-23", spend: 91.01, clicks: 1, budget: 20, campaign_id: "deo-1", campaign_status: "ENABLED" }),
      ],
      searchTerms: [
        {
          date: "2026-07-26", campaign_id: "deo-1", campaign_name: kwName,
          search_term: "tallow deodorant", keyword: "tallow deodorant", keyword_id: "deo-kw",
          match_type: "EXACT", spend: 10, orders_14d: 0, clicks: 12, impressions: 40,
        },
        {
          date: "2026-09-23", campaign_id: "deo-1", campaign_name: kwName,
          search_term: "tallow deodorant", keyword: "tallow deodorant", keyword_id: "deo-kw",
          match_type: "EXACT", spend: 5, orders_14d: 0, clicks: 1, impressions: 10,
        },
      ],
      placements: [],
      keywordTargets: [{
        campaign_id: "deo-1", keyword_id: "deo-kw", campaign_name: kwName,
        keyword_text: "tallow deodorant", match_type: "EXACT", state: "ENABLED", bid: 1.2,
      }],
    });
    const watch = parseCsv(pack.files.find((f) => f.name === "watch_campaigns.csv")!.body)
      .filter((r) => r.campaign_name === kwName);
    const today = watch.find((r) => r.window_label === "Today");
    assert.equal(today?.spend_yesterday, "91.01");
    assert.equal(today?.spend_dby, "3");
    assert.ok(today?.budget_util_yesterday);
    assert.equal(today?.budget_capped_yesterday, "true");
    for (const label of ["L1", "L2", "L7", "L30", "L60"]) {
      const row = watch.find((r) => r.window_label === label);
      assert.ok(row, label);
      assert.equal(row?.spend_yesterday, "", label);
      assert.equal(row?.spend_dby, "", label);
      assert.equal(row?.budget_util_yesterday, "", label);
      assert.equal(row?.budget_capped_yesterday, "", label);
    }
    const kw = parseCsv(pack.files.find((f) => f.name === "keyword_targets.csv")!.body)
      .filter((r) => r.keyword_text === "tallow deodorant");
    const todayKw = kw.find((r) => r.window_label === "Today");
    assert.equal(todayKw?.bleeders10_flag, "true");
    for (const label of ["L1", "L2", "L7", "L30", "L60"]) {
      const row = kw.find((r) => r.window_label === label);
      assert.equal(row?.bleeders10_flag, "", label);
      assert.equal(row?.bleeders20_flag, "", label);
      assert.equal(row?.lifetime_zero_flag, "", label);
    }
    assert.match(pack.files.find((f) => f.name === "README.txt")!.body, /SOP flags bleeders10_flag/);
  });

  test("competitor brand conquest and body butter never harvest_exact", () => {
    const pack = buildGnoPack({
      asOf: "2026-09-23",
      today: "2026-09-24",
      campaigns: [],
      searchTerms: [],
      placements: [],
      competitorOutliers: [
        {
          keyword: "native deodorant",
          keyword_normalized: "native deodorant",
          competitor_asin: "B0FTS2DC7Y",
          our_hero_family: "deo",
          volume: 280,
          sfr: null,
          opportunity: 170,
          competitor_organic_rank: 5,
          competitor_sponsored_rank: null,
          our_organic_rank: null,
          already_bidding: "N",
          suggested_lever: "harvest_exact",
          as_of: "2026-09-23",
          organic_asin: "B0FTS2DC7Y",
        },
        {
          keyword: "medicube collagen cream",
          keyword_normalized: "medicube collagen cream",
          competitor_asin: "B0MEDICUBE1",
          our_hero_family: "balm",
          volume: 400,
          sfr: null,
          opportunity: 200,
          competitor_organic_rank: 3,
          competitor_sponsored_rank: null,
          our_organic_rank: null,
          already_bidding: "N",
          suggested_lever: "harvest_exact",
          as_of: "2026-09-23",
          sponsored_asin: "B0MEDICUBE1",
        },
        {
          keyword: "whipped body butter",
          keyword_normalized: "whipped body butter",
          competitor_asin: "B0BUTTER111",
          our_hero_family: "balm",
          volume: 700,
          sfr: null,
          opportunity: 220,
          competitor_organic_rank: 4,
          competitor_sponsored_rank: null,
          our_organic_rank: null,
          already_bidding: "N",
          suggested_lever: "harvest_exact",
          as_of: "2026-09-23",
          organic_asin: "B0BUTTER111",
        },
      ],
    });
    const rows = parseCsv(pack.files.find((f) => f.name === "competitor_kr_outliers.csv")!.body);
    const byKw = Object.fromEntries(rows.map((r) => [r.keyword, r]));
    for (const keyword of ["native deodorant", "medicube collagen cream", "whipped body butter"]) {
      assert.notEqual(byKw[keyword].suggested_lever, "harvest_exact", keyword);
      assert.ok(byKw[keyword].family_fit, keyword);
      assert.ok(byKw[keyword].competitor_on_serp_evidence, keyword);
      assert.ok(byKw[keyword].cap_slot, keyword);
      assert.ok(byKw[keyword].suggested_lever_reason, keyword);
      assert.ok(byKw[keyword].harvest_blocked_reason, keyword);
    }
    assert.equal(byKw["native deodorant"].harvest_blocked_reason, "brand_conquest");
    assert.equal(byKw["medicube collagen cream"].harvest_blocked_reason, "brand_conquest");
    assert.equal(byKw["whipped body butter"].family_fit, "soft");
    assert.equal(byKw["whipped body butter"].harvest_blocked_reason, "soft_watch");
    assert.match(byKw["native deodorant"].competitor_on_serp_evidence, /organic_asin=B0FTS2DC7Y/);
    assert.match(byKw["medicube collagen cream"].competitor_on_serp_evidence, /sponsored_asin=B0MEDICUBE1/);
  });

  test("organic snapshot joins Exact L7 spend and counts phrases apart from rows", () => {
    const phrase = "tallow lip balm";
    const pack = buildGnoPack({
      asOf: "2026-09-23",
      today: "2026-09-24",
      campaigns: [camp(kwName, {
        date: "2026-09-23", spend: 12.5, campaign_id: "deo-1", campaign_status: "ENABLED",
      })],
      searchTerms: [{
        date: "2026-09-23", campaign_id: "deo-1", campaign_name: kwName,
        search_term: phrase, keyword: phrase, keyword_id: "kw-1",
        match_type: "EXACT", spend: 12.5, orders_14d: 1, clicks: 4, impressions: 40,
      }],
      placements: [],
      keywordTargets: [{
        campaign_id: "deo-1", keyword_id: "kw-1", campaign_name: kwName,
        keyword_text: phrase, match_type: "EXACT", state: "ENABLED", bid: 1,
      }],
      organicSnapshots: [
        { phrase, asin: "B0CLHTF8YN", organic_position: 8, as_of: "2026-09-23", group_id: 3537 },
        { phrase, asin: "B0DQFKMJFY", organic_position: 12, as_of: "2026-09-23", group_id: 3553 },
        { phrase: "lonely phrase", asin: "B0HBSZ71XQ", organic_position: 20, as_of: "2026-09-23", group_id: 3624 },
      ],
    });
    const organic = parseCsv(pack.files.find((f) => f.name === "organic_rank_snapshot.csv")!.body);
    const paid = organic.filter((r) => r.query_normalized === phrase);
    assert.ok(paid.length >= 2);
    assert.ok(paid.every((r) => r.paid_spend_l7_on_phrase === "12.50"));
    const lonely = organic.find((r) => r.query_normalized === "lonely phrase");
    assert.equal(lonely?.paid_spend_l7_on_phrase, "");
    const census = organicTrackerCensus(
      [
        { phrase, group_id: 3537 },
        { phrase, group_id: 3553 },
        { phrase: "lonely phrase", group_id: 3624 },
      ],
      organic,
    );
    assert.equal(census.phrases, 2);
    assert.ok(census.snapshot_rows > census.phrases);
    const readme = pack.files.find((f) => f.name === "README.txt")!.body;
    assert.match(readme, /organic_groups: 3 \/ phrases: 2 \/ snapshot_rows: \d+/);
    assert.match(readme, /multi-ASIN/);
    assert.equal(census.groups, 3);
  });

  test("prior pack id, outcomes carry-forward, and harvest floor are always printed", () => {
    const pack = buildGnoPack({
      asOf: "2026-09-23",
      today: "2026-09-24",
      campaigns: [],
      searchTerms: [],
      placements: [],
      priorPack: {
        id: "gno-pack-2026-09-24_0824",
        counts: { auto_loose: 10, broad_m: 4, watch: 20, sqp: 3 },
      },
      ledger: [{
        created_at: "2026-09-20T15:00:00Z",
        pack_date: "2026-09-20",
        campaign_id: "555666777888999000",
        campaign_name: kwName,
        search_term: "deodorant for women",
        proposed_tag: "WATCH",
        dave_action: "hold",
        source: "ui",
        notes: "desk note",
      }],
    });
    const readme = pack.files.find((f) => f.name === "README.txt")!.body;
    const manifest = JSON.parse(pack.files.find((f) => f.name === "pack_manifest.json")!.body);
    assert.equal(manifest.prior_pack_id, "gno-pack-2026-09-24_0824");
    assert.equal(manifest.row_count_deltas.auto_loose.prior, 10);
    assert.match(readme, /prior_pack_id: gno-pack-2026-09-24_0824/);
    assert.match(readme, /auto_loose BEFORE 10 AFTER/);
    assert.match(readme, /harvest_min_clicks: 5/);
    assert.match(readme, /harvest_min_orders: 2/);
    assert.match(readme, /max_new_structures_per_week: 3/);
    assert.match(readme, /adds_this_week_already: unknown/);
    assert.match(readme, /remaining_slots: 0/);
    assert.match(readme, /harvest_queue_rows: 0/);
    const outcomes = parseCsv(pack.files.find((f) => f.name === "gno_outcomes.csv")!.body);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].dave_action, "hold");
    assert.equal(outcomes[0].query_normalized, "deodorant for woman");
    assert.equal(outcomes[0].implemented, "unknown");
    assert.equal(outcomes[0].campaign_id, "555666777888999000");
    assert.match(pack.files.find((f) => f.name === "gno_outcomes.csv")!.body, /"555666777888999000"/);

    const empty = buildGnoPack({
      asOf: "2026-09-23",
      today: "2026-09-24",
      campaigns: [],
      searchTerms: [],
      placements: [],
      priorPack: { id: "gno-pack-2026-09-24_0824" },
    });
    const emptyOut = empty.files.find((f) => f.name === "gno_outcomes.csv")!.body.trim().split("\n");
    assert.equal(emptyOut.length, 1);
    assert.match(empty.files.find((f) => f.name === "README.txt")!.body, /outcomes_empty_reason:/);
    assert.match(empty.files.find((f) => f.name === "README.txt")!.body, /harvest_queue_rows: 0/);
  });

  test("sibling audit is one row per phrase and README lists every Today meta_sync=false name", () => {
    const pack = buildGnoPack({
      asOf: "2026-09-23",
      today: "2026-09-24",
      campaigns: NEW_EXACT.map((name) => camp(name, {
        date: "2026-09-23", campaign_status: "", campaign_id: "",
      })),
      searchTerms: [],
      placements: [],
      keywordTargets: [
        { campaign_id: "111", campaign_name: "Unscented Lip Balm - SP - Lip Balm - KWs - Exact", keyword_text: "lip balm", match_type: "EXACT", state: "ENABLED", bid: 1.5 },
        { campaign_id: "222", campaign_name: "Assorted Lip Balm - SP - Lip Balm - KWs - Exact", keyword_text: "Lip  Balm", match_type: "EXACT", state: "ENABLED", bid: 1.1 },
        { campaign_id: "333", campaign_name: "Peppermint Lip Balm - SP - Lip Balm - KWs - Exact", keyword_text: "lip balm", match_type: "EXACT", state: "ENABLED", bid: 0.9 },
        { campaign_id: "444", campaign_name: "Women Exact A", keyword_text: "deodorant for women", match_type: "EXACT", state: "ENABLED", bid: 0.8 },
        { campaign_id: "555", campaign_name: "Woman Exact B", keyword_text: "deodorant for woman", match_type: "EXACT", state: "ENABLED", bid: 0.7 },
      ],
    });
    const audit = parseCsv(pack.files.find((f) => f.name === "structure_audit.csv")!.body)
      .filter((r) => r.finding_type === "sibling_exact_auction");
    const lip = audit.filter((r) => r.evidence.includes("lip balm"));
    assert.equal(lip.length, 1);
    assert.match(lip[0].entity_names, /Unscented Lip Balm/);
    assert.match(lip[0].entity_names, /Assorted Lip Balm/);
    assert.match(lip[0].entity_names, /Peppermint Lip Balm/);
    assert.match(lip[0].entity_ids, /111/);
    assert.match(lip[0].entity_ids, /222/);
    assert.match(lip[0].entity_ids, /333/);
    const woman = audit.filter((r) => r.evidence.includes("deodorant for woman"));
    assert.equal(woman.length, 1);
    assert.match(woman[0].entity_names, /Women Exact A/);
    assert.match(woman[0].entity_names, /Woman Exact B/);
    const readme = pack.files.find((f) => f.name === "README.txt")!.body;
    const line = readme.split("\n").find((l) => l.startsWith("NEW_EXACT / flavor rows with meta_sync=false:"));
    assert.ok(line);
    for (const name of NEW_EXACT) assert.match(line!, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
