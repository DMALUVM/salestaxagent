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
  SQP_SLICE_COVER_END,
  SQP_SLICE_COVER_START,
  SQP_SLICE_CSV_HEADERS,
  WATCH_CAMPAIGN_CSV_HEADERS,
  isNewExactName,
  selectSqpSliceWeek,
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
  type CampaignDailyRow,
  type CampaignMeta,
  type KeywordTarget,
  type PlacementRow,
  type SearchTermRow,
} from "./gno-ppc-watch";
import { zipStore } from "./zip-store";
import { evaluateExportNeed, QUIET } from "./gno-export-state";

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
    assert.ok(names.includes("README.txt"));
    const competitorCsv = pack.files.find((f) => f.name === "competitor_kr_outliers.csv")!.body;
    assert.match(competitorCsv, /^keyword,competitor_asin,our_hero_family,/);
    assert.match(competitorCsv, /already_bidding,suggested_lever/);
    assert.match(pack.files.find((f) => f.name === "README.txt")!.body, /competitor_kr_outliers\.csv/);
    assert.equal(names.includes("sqp_weekly_slice.csv"), false);
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
      "src/lib/gno-store.ts",
      "src/app/ppc/gno/page.tsx",
      "src/components/ppc-gno-watch.tsx",
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
    assert.equal(today?.cm_note, CM_NOTE);
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
    assert.match(withSqp.files.find((f) => f.name === "README.txt")!.body, /STALE PRE-RAISE/);
    assert.match(sqp!.body, /stale_pre_raise/);

    const empty = sqpWeeklySliceRows([]);
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

  test("SQP slice prefers the week covering Sep 7-10 over a pre-raise week", () => {
    assert.equal(SQP_SLICE_COVER_START, "2026-09-07");
    assert.equal(SQP_SLICE_COVER_END, "2026-09-10");
    const rows = [
      {
        week_start: "2026-08-30", week_end: "2026-09-05",
        search_query: "lip balm", query_normalized: "lip balm",
        search_query_volume: 90000, click_share: 0.1, source: "sqp_brand_csv",
      },
      {
        week_start: "2026-09-06", week_end: "2026-09-12",
        search_query: "lip balm", query_normalized: "lip balm",
        search_query_volume: 92000, click_share: 0.12, source: "sqp_brand_csv",
      },
      {
        week_start: "2026-09-06", week_end: "2026-09-12",
        search_query: "chapstick", query_normalized: "chapstick",
        search_query_volume: 78000, click_share: 0.3, source: "sqp_brand_csv",
      },
    ];
    const picked = selectSqpSliceWeek(rows);
    assert.equal(picked?.weekEnd, "2026-09-12");
    assert.equal(picked?.coversTarget, true);
    assert.match(picked?.note ?? "", /stale_pre_raise=false/);
    const slice = sqpWeeklySliceRows(rows);
    assert.ok(slice.every((r) => r.week_end === "2026-09-12"));
    assert.ok(slice.every((r) => r.stale_pre_raise === false));
    assert.doesNotMatch(slice.map((r) => r.week_end).join(","), /2026-09-05/);
    const pack = buildGnoPack({
      asOf: "2026-09-10", today: "2026-09-11",
      campaigns: [], searchTerms: [], placements: [],
      sqpWeekly: rows,
    });
    assert.doesNotMatch(pack.files.find((f) => f.name === "README.txt")!.body, /STALE PRE-RAISE/);
    assert.match(pack.files.find((f) => f.name === "sqp_weekly_slice.csv")!.body, /false/);
  });

  test("SQP slice ships latest week with an honest pre-raise note when Sep 7-10 is missing", () => {
    const rows = [
      {
        week_start: "2026-08-30", week_end: "2026-09-05",
        search_query: "lip balm", query_normalized: "lip balm",
        search_query_volume: 90000, source: "sqp_brand_csv",
      },
    ];
    const picked = selectSqpSliceWeek(rows);
    assert.equal(picked?.weekEnd, "2026-09-05");
    assert.equal(picked?.coversTarget, false);
    assert.match(picked?.note ?? "", /SQP week covering Sep 7–10 not in warehouse yet/);
    assert.match(picked?.note ?? "", /stale_pre_raise=true/);
    const pack = buildGnoPack({
      asOf: "2026-09-10", today: "2026-09-11",
      campaigns: [], searchTerms: [], placements: [],
      sqpWeekly: rows,
    });
    const readme = pack.files.find((f) => f.name === "README.txt")!.body;
    const sqp = pack.files.find((f) => f.name === "sqp_weekly_slice.csv")!.body;
    assert.match(readme, /SQP week covering Sep 7–10 not in warehouse yet/);
    assert.match(readme, /STALE PRE-RAISE/);
    assert.match(sqp, /2026-09-05/);
    assert.match(sqp, /true/);
    assert.ok(sqpWeeklySliceRows(rows).every((r) => r.stale_pre_raise === true));
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
    assert.ok(l7 > 0);
    assert.match(st.find((r) => r.label === "L7")?.cm_note ?? "", /watch_campaigns is SoT/);
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
