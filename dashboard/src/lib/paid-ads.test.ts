import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import {
  deriveRatios,
  inferWindowBounds,
  metricsFromUnknown,
  normalizePaidAdsChannel,
  normalizePaidAdsPayload,
  normalizePaidAdsWindow,
  parseIsoDate,
  rowToCampaignWindow,
  rowToSnapshot,
  selectChannelWindow,
  sumMetrics,
  toUpsertRows,
  PAID_ADS_ATTRIBUTION,
  type PaidAdsCampaignWindowRow,
  type PaidAdsSnapshotRow,
} from "./paid-ads";

function snap(partial: Partial<PaidAdsSnapshotRow> & Pick<PaidAdsSnapshotRow, "window_days" | "as_of">): PaidAdsSnapshotRow {
  return {
    channel: "google_ads",
    window_start: null,
    window_end: null,
    account_label: null,
    spend: 0,
    conv_value: 0,
    roas: null,
    clicks: 0,
    impressions: 0,
    conversions: 0,
    cpc: null,
    currency: "USD",
    source: "ads_ops",
    notes: [],
    ...partial,
  };
}

describe("normalizePaidAdsChannel", () => {
  test("accepts google/meta aliases", () => {
    assert.equal(normalizePaidAdsChannel("google_ads"), "google_ads");
    assert.equal(normalizePaidAdsChannel("Google"), "google_ads");
    assert.equal(normalizePaidAdsChannel("facebook-ads"), "meta_ads");
    assert.equal(normalizePaidAdsChannel("meta"), "meta_ads");
  });

  test("rejects Amazon PPC so those rows stay in ads_* tables", () => {
    assert.equal(normalizePaidAdsChannel("amazon"), null);
    assert.equal(normalizePaidAdsChannel("amazon_ads"), null);
    assert.equal(normalizePaidAdsChannel("amazon_ppc"), null);
    assert.equal(normalizePaidAdsChannel("ppc"), null);
  });
});

describe("normalizePaidAdsWindow + dates", () => {
  test("accepts 1/7/14/30 and 7d", () => {
    assert.equal(normalizePaidAdsWindow(7), 7);
    assert.equal(normalizePaidAdsWindow("14d"), 14);
    assert.equal(normalizePaidAdsWindow("30"), 30);
    assert.equal(normalizePaidAdsWindow(90), null);
    assert.equal(normalizePaidAdsWindow("2"), null);
  });

  test("parseIsoDate rejects overflow dates", () => {
    assert.equal(parseIsoDate("2026-08-22"), "2026-08-22");
    assert.equal(parseIsoDate("2026-02-31"), null);
    assert.equal(parseIsoDate("yesterday"), null);
  });

  test("inferWindowBounds matches production Ads Ops windows", () => {
    assert.deepEqual(inferWindowBounds("2026-08-22", 7), {
      window_start: "2026-08-15", window_end: "2026-08-21",
    });
    assert.deepEqual(inferWindowBounds("2026-08-22", 14), {
      window_start: "2026-08-08", window_end: "2026-08-21",
    });
    assert.deepEqual(inferWindowBounds("2026-08-22", 30), {
      window_start: "2026-07-23", window_end: "2026-08-21",
    });
  });
});

describe("metric rollup", () => {
  test("sums additive fields and re-derives CPC/ROAS", () => {
    const sum = sumMetrics([
      { spend: 50, sales_or_conv_value: 200, clicks: 25, impressions: 100, conversions: 2, cpc: 99, roas: 99 },
      { spend: 50, sales_or_conv_value: 100, clicks: 25, impressions: 100, conversions: 1, cpc: 99, roas: 99 },
    ]);
    assert.equal(sum.spend, 100);
    assert.equal(sum.sales_or_conv_value, 300);
    assert.equal(sum.clicks, 50);
    assert.equal(sum.conversions, 3);
    assert.equal(sum.cpc, 2);
    assert.equal(sum.roas, 3);
  });

  test("does not add stored ratios across days", () => {
    const sum = sumMetrics([
      { ...deriveRatios({ spend: 10, clicks: 5, sales_or_conv_value: 40 }), spend: 10, sales_or_conv_value: 40, clicks: 5, impressions: 1, conversions: 1, cpc: 99, roas: 99 },
      { spend: 30, sales_or_conv_value: 60, clicks: 15, impressions: 1, conversions: 1, cpc: 99, roas: 99 },
    ]);
    assert.equal(sum.cpc, 2);
    assert.equal(sum.roas, 2.5);
  });

  test("metricsFromUnknown accepts Ads Ops aliases including conv_value", () => {
    const m = metricsFromUnknown({
      cost: "12.50",
      conv_value: 50,
      clicks: "4",
      imps: 200,
      purchases: 2,
    });
    assert.equal(m.spend, 12.5);
    assert.equal(m.sales_or_conv_value, 50);
    assert.equal(m.impressions, 200);
    assert.equal(m.conversions, 2);
    assert.equal(m.cpc, 3.125);
    assert.equal(m.roas, 4);
  });
});

describe("normalizePaidAdsPayload", () => {
  test("maps a production-shaped Ads Ops payload onto the live uniques", () => {
    const result = normalizePaidAdsPayload({
      channel: "google_ads",
      as_of: "2026-08-22",
      currency: "USD",
      source: "scheduled_report_baselines",
      account_label: "Tallowbourn 533-220-6723",
      notes: ["Meta not connected"],
      windows: [
        { window_days: 7, spend: 593.47, conv_value: 721.26, roas: 1.22, clicks: 343, impressions: 55183, conversions: 30, cpc: 1.73 },
        { window_days: 14, spend: 1236.68, conv_value: 1657.71, roas: 1.34, clicks: 673, impressions: 110170, conversions: 63.99, cpc: 1.84 },
        { window_days: 30, spend: 2175.01, conv_value: 3435.53, roas: 1.58, clicks: 1301, impressions: 212233, conversions: 119.86, cpc: 1.67 },
      ],
      campaigns: [
        { campaign_name: "PMAX Max Conversions V4", window_days: 30, spend: 964.80, roas: 1.37, status: "active", note: "dominant last 7d" },
        { campaign_name: "BRANDED Search V1", window_days: 30, spend: 378.11, roas: 2.16, status: "active" },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.snapshots.length, 3);
    const seven = result.data.snapshots.find((s) => s.window_days === 7);
    assert.equal(seven?.conv_value, 721.26);
    assert.equal(seven?.window_start, "2026-08-15");
    assert.equal(seven?.window_end, "2026-08-21");
    assert.equal(seven?.account_label, "Tallowbourn 533-220-6723");
    assert.equal(result.data.campaignWindows.length, 2);
    assert.equal(result.data.campaignWindows[0].campaign_name, "PMAX Max Conversions V4");
    assert.equal(result.data.campaignWindows[0].campaign_id, null);
    assert.equal(result.data.campaignWindows[0].window_days, 30);
    assert.equal(result.data.campaignWindows[0].conv_value, null);

    const rows = toUpsertRows(result.data, "2026-08-23T00:00:00.000Z");
    assert.equal(rows.snapshots[0].conv_value, 721.26);
    assert.equal("sales_or_conv_value" in rows.snapshots[0], false);
    assert.equal(rows.campaignWindows[0].campaign_name, "PMAX Max Conversions V4");
    assert.equal(rows.snapshots[0].ingested_at, "2026-08-23T00:00:00.000Z");
  });

  test("name-only campaigns attach to the declared window", () => {
    const result = normalizePaidAdsPayload({
      channel: "google",
      as_of: "2026-08-22",
      window_days: 7,
      windows: [{ window_days: 7, spend: 100, conv_value: 300, clicks: 50 }],
      campaigns: [{ name: "Prospecting", spend: 40, sales: 90, clicks: 20 }],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.campaignWindows[0].campaign_name, "Prospecting");
    assert.equal(result.data.campaignWindows[0].window_days, 7);
    assert.equal(result.data.campaignWindows[0].conv_value, 90);
  });

  test("rejects Amazon and missing as_of / channel", () => {
    assert.equal(normalizePaidAdsPayload({ channel: "amazon_ads", as_of: "2026-08-22", windows: [] }).ok, false);
    assert.equal(normalizePaidAdsPayload({ as_of: "2026-08-22", windows: [{ window_days: 7, spend: 1 }] }).ok, false);
    assert.equal(normalizePaidAdsPayload({ channel: "google_ads" }).ok, false);
  });

  test("does not keep a scrape-looking source label", () => {
    const result = normalizePaidAdsPayload({
      channel: "google_ads",
      as_of: "2026-08-22",
      source: "ads-manager-scrape",
      windows: [{ window_days: 7, spend: 1 }],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.source, "ads_ops");
  });
});

describe("selectChannelWindow", () => {
  const snapshots: PaidAdsSnapshotRow[] = [
    snap({ as_of: "2026-08-22", window_days: 7, spend: 593.47, conv_value: 721.26, roas: 1.22, clicks: 343, notes: ["Meta not connected"] }),
    snap({ as_of: "2026-08-22", window_days: 30, spend: 2175.01, conv_value: 3435.53, roas: 1.58 }),
  ];
  const campaignWindows: PaidAdsCampaignWindowRow[] = [
    {
      channel: "google_ads", as_of: "2026-08-22", window_days: 30,
      campaign_id: null, campaign_name: "PMAX Max Conversions V4",
      spend: 964.8, conv_value: null, roas: 1.37,
      clicks: null, impressions: null, conversions: null, cpc: null,
      status: "active", note: "dominant last 7d",
    },
  ];

  test("reads snapshot KPIs and same-window campaign rows", () => {
    const view = selectChannelWindow({
      channel: "google_ads", windowDays: 30, snapshots, campaignWindows,
    });
    assert.equal(view.source, "snapshot");
    assert.equal(view.kpis.spend, 2175.01);
    assert.equal(view.kpis.sales_or_conv_value, 3435.53);
    assert.equal(view.campaigns[0].campaign_name, "PMAX Max Conversions V4");
    assert.equal(view.campaigns[0].sales_or_conv_value, null);
  });

  test("7D snapshot can exist without campaign rows", () => {
    const view = selectChannelWindow({
      channel: "google_ads", windowDays: 7, snapshots, campaignWindows,
    });
    assert.equal(view.source, "snapshot");
    assert.equal(view.kpis.spend, 593.47);
    assert.equal(view.campaigns.length, 0);
    assert.deepEqual(view.notes, ["Meta not connected"]);
  });

  test("missing window stays empty (does not invent a daily rollup)", () => {
    const view = selectChannelWindow({
      channel: "google_ads", windowDays: 1, snapshots, campaignWindows,
    });
    assert.equal(view.source, "empty");
    assert.equal(view.kpis.spend, 0);
  });

  test("meta stays empty when only google rows exist", () => {
    const view = selectChannelWindow({
      channel: "meta_ads", windowDays: 7, snapshots, campaignWindows,
    });
    assert.equal(view.source, "empty");
    assert.equal(view.campaigns.length, 0);
  });

  test("row mappers accept production column names", () => {
    const s = rowToSnapshot({
      channel: "google_ads", as_of: "2026-08-22", window_days: 7,
      spend: "593.47", conv_value: "721.26", clicks: "343",
    });
    assert.equal(s?.conv_value, 721.26);
    assert.equal(s?.spend, 593.47);
    const c = rowToCampaignWindow({
      channel: "google_ads", as_of: "2026-08-22", window_days: 30,
      campaign_name: "BRANDED Search V1", spend: 378.11, roas: 2.16,
    });
    assert.equal(c?.campaign_name, "BRANDED Search V1");
    assert.equal(c?.conv_value, null);
  });
});

describe("page / API invariants", () => {
  const root = process.cwd();
  const page = readFileSync(path.join(root, "src/app/paid-ads/page.tsx"), "utf8");
  const intelUi = readFileSync(path.join(root, "src/components/paid-ads-intel.tsx"), "utf8");
  const ingest = readFileSync(path.join(root, "src/app/api/paid-ads/ingest/route.ts"), "utf8");
  const csvIngest = readFileSync(path.join(root, "src/app/api/paid-ads/csv/route.ts"), "utf8");
  const read = readFileSync(path.join(root, "src/app/api/paid-ads/route.ts"), "utf8");
  const intelRead = readFileSync(path.join(root, "src/app/api/paid-ads/intel/route.ts"), "utf8");
  const nav = readFileSync(path.join(root, "src/components/nav.tsx"), "utf8");
  const migration = readFileSync(path.join(root, "../supabase/migration_paid_ads.sql"), "utf8");
  const intelMig = readFileSync(path.join(root, "../supabase/migration_paid_intel.sql"), "utf8");

  test("nav lists Paid Ads under MONITORING near Amazon PPC", () => {
    assert.match(nav, /href: "\/ppc"/);
    assert.match(nav, /href: "\/paid-ads"/);
    assert.match(nav, /Paid Ads \(Shopify\)/);
    const ppc = nav.indexOf('href: "/ppc"');
    const paid = nav.indexOf('href: "/paid-ads"');
    assert.ok(paid > ppc && paid - ppc < 400);
  });

  test("copy names CSV intel and forbids a live scrape", () => {
    assert.match(intelUi, /Tallowbourn ads Intel/);
    assert.match(intelUi, /newest date/);
    assert.match(intelUi, /Upload CSVs/);
    assert.match(intelUi, /Copy for Grok/);
    assert.match(intelUi, /EMPTY_BRIEF|brief \?\?/);
    assert.equal(PAID_ADS_ATTRIBUTION.includes("not a live"), true);
    assert.doesNotMatch(page, /puppeteer|playwright|ads\.google\.com|business\.facebook\.com/i);
    assert.doesNotMatch(intelUi, /puppeteer|playwright/i);
    assert.match(intelUi, /No OAuth/);
    assert.doesNotMatch(ingest, /puppeteer|playwright|ads\.google\.com/i);
    assert.doesNotMatch(csvIngest, /puppeteer|playwright|ads\.google\.com/i);
  });

  test("DataStatus How-to is the manual CSV pull; re-export opens it", () => {
    const status = intelUi.slice(intelUi.indexOf("function DataStatus("));
    assert.match(status, /What data is loaded/);
    assert.match(status, /PaidAdsCsvHowto/);
    assert.match(intelUi, /How-to: pull CSVs/);
    assert.match(status, /setHowtoOpen\(true\)/);
    const stale = status.slice(status.indexOf("s.stale ?"), status.indexOf("s.days_behind}d"));
    assert.match(stale, /<button/);
    assert.doesNotMatch(stale, /<span/);
    assert.match(status, /\{s\.days_behind\}d — re-export/);
    const reexport = status.slice(
      status.lastIndexOf("<button", status.indexOf("{s.days_behind}d — re-export")),
      status.indexOf("{s.days_behind}d — re-export") + 40,
    );
    assert.match(reexport, /onClick=\{\(\) => setHowtoOpen\(true\)\}/);
    assert.match(reexport, /\{s\.days_behind\}d — re-export/);
  });

  test("How-to has exact Google/Meta/GSC URLs and GSC file names", () => {
    const howto = intelUi.slice(
      intelUi.indexOf("const GOOGLE_ADS_CSV_URL"),
      intelUi.indexOf("async function copyText("),
    );
    assert.match(
      howto,
      /https:\/\/ads\.google\.com\/aw\/reporteditor\/view\?ocid=1485260312&reportId=933344634/,
    );
    assert.match(
      howto,
      /https:\/\/adsmanager\.facebook\.com\/adsmanager\/reporting\?act=156983680801147&business_id=1028304628604309/,
    );
    assert.match(howto, /https:\/\/search\.google\.com\/search-console/);
    assert.match(howto, /Queries\.csv/);
    assert.match(howto, /Pages\.csv/);
    assert.match(howto, /Chart\.csv/);
    assert.doesNotMatch(howto, /resource_id/);
    assert.match(howto, /Tallowbourn Ads Ops Daily/);
    assert.match(howto, /Tallowbourn Meta Ads Ops Daily/);
  });

  test("How-to Meta step requires Day / Campaign × Day and warns on range summaries", () => {
    const howto = intelUi.slice(
      intelUi.indexOf("const GOOGLE_ADS_CSV_URL"),
      intelUi.indexOf("async function copyText("),
    );
    const metaStart = howto.indexOf("<p className=\"font-medium\">Meta</p>");
    const metaEnd = howto.indexOf("<p className=\"font-medium\">Search Console</p>");
    assert.ok(metaStart >= 0 && metaEnd > metaStart);
    const meta = howto.slice(metaStart, metaEnd);
    assert.match(meta, /Tallowbourn Meta Ads Ops Daily/);
    assert.match(meta, /breakdown Day/);
    assert.match(meta, /Campaign × Day/);
    assert.match(meta, /same bar as Google Ads Daily/);
    assert.match(meta, /Reporting starts/);
    assert.match(meta, /no Day column/);
    assert.match(meta, /lands as one day/);
    assert.match(meta, /will not fill the week/);
    assert.match(meta, /href=\{META_ADS_CSV_URL\}/);
    assert.match(
      howto,
      /const META_ADS_CSV_URL =\n  "https:\/\/adsmanager\.facebook\.com\/adsmanager\/reporting\?act=156983680801147&business_id=1028304628604309"/,
    );
    assert.match(
      howto,
      /const GOOGLE_ADS_CSV_URL =\n  "https:\/\/ads\.google\.com\/aw\/reporteditor\/view\?ocid=1485260312&reportId=933344634"/,
    );
    assert.doesNotMatch(meta, /schedule/i);
    assert.doesNotMatch(meta, /e-?mail/i);
    assert.doesNotMatch(meta, /\/ppc|\/inventory/);
  });

  test("How-to lists GA4 columns and does not invent an Explore name", () => {
    const howto = intelUi.slice(
      intelUi.indexOf("const GOOGLE_ADS_CSV_URL"),
      intelUi.indexOf("async function copyText("),
    );
    for (const col of [
      "Date",
      "Session default channel group",
      "Landing page",
      "Device category",
      "Sessions",
      "Active users",
      "Key events",
      "Total revenue",
    ]) {
      assert.match(howto, new RegExp(col.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(howto, /Save an Explore/);
    assert.doesNotMatch(howto, /Tallowbourn GA4|Explore Daily|saved Explore name/i);
  });

  test("How-to is Dashboard upload only — no schedule or email export copy", () => {
    const howto = intelUi.slice(
      intelUi.indexOf("const GOOGLE_ADS_CSV_URL"),
      intelUi.indexOf("async function copyText("),
    );
    assert.match(howto, /Dashboard/);
    assert.match(howto, /\/paid-ads → Upload/);
    assert.match(howto, /select ALL files at once/);
    assert.doesNotMatch(howto, /warehouse/i);
    assert.doesNotMatch(howto, /schedule/i);
    assert.doesNotMatch(howto, /e-?mail/i);
  });

  test("ingest/read use production window tables and uniques", () => {
    assert.match(ingest, /paid_ads_snapshots/);
    assert.match(ingest, /paid_ads_campaigns_window/);
    assert.match(ingest, /channel,as_of,window_days,campaign_name/);
    assert.match(ingest, /getServerSupabase/);
    assert.match(read, /paid_ads_snapshots/);
    assert.match(read, /paid_ads_campaigns_window/);
    assert.match(read, /conv_value/);
    assert.doesNotMatch(ingest, /paid_ads_daily|paid_ads_campaigns_daily/);
    assert.doesNotMatch(read, /paid_ads_daily|paid_ads_campaigns_daily/);
    assert.doesNotMatch(ingest, /\.from\(["']ads_/);
    assert.doesNotMatch(read, /\.from\(["']ads_/);
    assert.match(csvIngest, /paid_campaign_daily/);
    assert.match(csvIngest, /paid_search_query_daily/);
    assert.match(csvIngest, /paid_ga_daily/);
    assert.match(intelRead, /buildIntel/);
    assert.match(intelMig, /CREATE TABLE IF NOT EXISTS paid_campaign_daily/);
    assert.doesNotMatch(intelMig, /DROP TABLE|TRUNCATE TABLE/i);
    assert.doesNotMatch(intelMig, /ENABLE ROW LEVEL SECURITY/);
  });

  test("migration matches production and does not drop or lock down", () => {
    assert.match(migration, /CREATE TABLE IF NOT EXISTS paid_ads_snapshots/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS paid_ads_campaigns_window/);
    assert.match(migration, /UNIQUE \(channel, as_of, window_days\)/);
    assert.match(migration, /UNIQUE \(channel, as_of, window_days, campaign_name\)/);
    assert.match(migration, /conv_value/);
    assert.match(migration, /google_ads/);
    assert.match(migration, /meta_ads/);
    assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|TRUNCATE TABLE/i);
    assert.doesNotMatch(migration, /ENABLE ROW LEVEL SECURITY/);
    assert.doesNotMatch(migration, /CREATE POLICY/i);
    assert.doesNotMatch(migration, /paid_ads_daily|paid_ads_campaigns_daily/);
  });

  test("paid-ads page has an error boundary", () => {
    assert.ok(existsSync(path.join(root, "src/app/paid-ads/error.tsx")));
  });
});
