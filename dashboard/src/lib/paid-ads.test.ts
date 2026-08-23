import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import {
  deriveRatios,
  metricsFromUnknown,
  normalizePaidAdsChannel,
  normalizePaidAdsPayload,
  normalizePaidAdsWindow,
  parseIsoDate,
  rollupCampaignsWindow,
  rollupDailyWindow,
  selectChannelWindow,
  sumMetrics,
  toUpsertRows,
  PAID_ADS_ATTRIBUTION,
  type PaidAdsCampaignDailyRow,
  type PaidAdsDailyRow,
  type PaidAdsSnapshotRow,
} from "./paid-ads";

function daily(
  date: string,
  spend: number,
  sales: number,
  extra: Partial<PaidAdsDailyRow> = {},
): PaidAdsDailyRow {
  return {
    channel: "google_ads",
    date,
    spend,
    sales_or_conv_value: sales,
    clicks: extra.clicks ?? 10,
    impressions: extra.impressions ?? 100,
    conversions: extra.conversions ?? 1,
    currency: "USD",
    source: "ads_ops",
    ...deriveRatios({ spend, clicks: extra.clicks ?? 10, sales_or_conv_value: sales }),
    ...extra,
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
});

describe("metric rollup", () => {
  test("sums additive fields and re-derives CPC/ROAS", () => {
    const a = daily("2026-08-20", 50, 200, { clicks: 25, conversions: 2 });
    const b = daily("2026-08-21", 50, 100, { clicks: 25, conversions: 1 });
    const sum = sumMetrics([a, b]);
    assert.equal(sum.spend, 100);
    assert.equal(sum.sales_or_conv_value, 300);
    assert.equal(sum.clicks, 50);
    assert.equal(sum.conversions, 3);
    assert.equal(sum.cpc, 2);
    assert.equal(sum.roas, 3);
  });

  test("does not add stored ratios across days", () => {
    const rows = [
      { ...daily("2026-08-20", 10, 40, { clicks: 5 }), cpc: 99, roas: 99 },
      { ...daily("2026-08-21", 30, 60, { clicks: 15 }), cpc: 99, roas: 99 },
    ];
    const sum = sumMetrics(rows);
    assert.equal(sum.cpc, 2);
    assert.equal(sum.roas, 2.5);
  });

  test("window rollup is inclusive of as_of", () => {
    const rows = [
      daily("2026-08-14", 10, 20),
      daily("2026-08-15", 10, 20),
      daily("2026-08-20", 10, 20),
      daily("2026-08-21", 10, 20),
    ];
    const week = rollupDailyWindow(rows, "2026-08-20", 7);
    assert.equal(week.days_in_window, 3);
    assert.equal(week.spend, 30);
    const day = rollupDailyWindow(rows, "2026-08-20", 1);
    assert.equal(day.days_in_window, 1);
    assert.equal(day.spend, 10);
  });

  test("campaign rollup keys on campaign_id and sorts by spend", () => {
    const rows: PaidAdsCampaignDailyRow[] = [
      { ...daily("2026-08-19", 10, 20), campaign_id: "a", campaign_name: "Alpha" },
      { ...daily("2026-08-20", 40, 80), campaign_id: "b", campaign_name: "Bravo" },
      { ...daily("2026-08-20", 5, 10), campaign_id: "a", campaign_name: "Alpha" },
    ];
    const out = rollupCampaignsWindow(rows, "2026-08-20", 7);
    assert.equal(out[0].campaign_id, "b");
    assert.equal(out[1].campaign_id, "a");
    assert.equal(out[1].spend, 15);
  });

  test("metricsFromUnknown accepts Ads Ops aliases", () => {
    const m = metricsFromUnknown({
      cost: "12.50",
      conversion_value: 50,
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
  test("builds daily + snapshot + campaign rows from a structured feed", () => {
    const result = normalizePaidAdsPayload({
      channel: "google",
      as_of: "2026-08-22",
      currency: "usd",
      source: "ads_ops",
      account: { spend: 20, sales: 80, clicks: 10, impressions: 400, conversions: 2 },
      windows: [
        { window_days: 7, spend: 140, sales_or_conv_value: 560, clicks: 70, impressions: 2800, conversions: 14 },
      ],
      campaigns: [
        { campaign_id: "c1", campaign_name: "Brand", spend: 12, sales: 50, clicks: 6, impressions: 200, conversions: 1 },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.channel, "google_ads");
    assert.equal(result.data.daily.length, 1);
    assert.equal(result.data.daily[0].date, "2026-08-22");
    assert.equal(result.data.daily[0].spend, 20);
    assert.equal(result.data.campaigns[0].campaign_id, "c1");
    assert.equal(result.data.campaigns[0].date, "2026-08-22");
    const seven = result.data.snapshots.find((s) => s.window_days === 7);
    assert.ok(seven);
    assert.equal(seven?.spend, 140);
    assert.equal(seven?.roas, 4);
    const rows = toUpsertRows(result.data, "2026-08-23T00:00:00.000Z");
    assert.equal(rows.daily[0].ingested_at, "2026-08-23T00:00:00.000Z");
  });

  test("dated daily rows do not require a top-level as_of", () => {
    const result = normalizePaidAdsPayload({
      channel: "meta_ads",
      daily: [
        { date: "2026-08-20", spend: 5, clicks: 2 },
        { date: "2026-08-21", spend: 7, clicks: 3 },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.as_of, "2026-08-21");
    assert.equal(result.data.daily.length, 2);
  });

  test("attaches undated campaigns to a declared window snapshot", () => {
    const result = normalizePaidAdsPayload({
      channel: "google_ads",
      as_of: "2026-08-22",
      window_days: 7,
      windows: [{ window_days: 7, spend: 100, sales_or_conv_value: 300, clicks: 50 }],
      campaigns: [{ campaign_id: "x", name: "Prospecting", spend: 40, sales: 90, clicks: 20 }],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const seven = result.data.snapshots.find((s) => s.window_days === 7);
    const camps = (seven?.metrics.campaigns ?? []) as Array<{ campaign_id: string }>;
    assert.equal(camps[0]?.campaign_id, "x");
    assert.equal(result.data.campaigns.length, 0);
  });

  test("rejects Amazon and missing channel", () => {
    assert.equal(normalizePaidAdsPayload({ channel: "amazon_ads", as_of: "2026-08-22" }).ok, false);
    assert.equal(normalizePaidAdsPayload({ as_of: "2026-08-22" }).ok, false);
    assert.equal(normalizePaidAdsPayload({ channel: "google_ads" }).ok, false);
  });

  test("does not keep a scrape-looking source label", () => {
    const result = normalizePaidAdsPayload({
      channel: "google_ads",
      as_of: "2026-08-22",
      source: "ads-manager-scrape",
      account: { spend: 1 },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.source, "ads_ops");
  });
});

describe("selectChannelWindow", () => {
  const dailyRows = [
    daily("2026-08-19", 10, 20),
    daily("2026-08-20", 10, 30),
  ];
  const snap: PaidAdsSnapshotRow = {
    channel: "google_ads",
    as_of: "2026-08-20",
    window_days: 7,
    spend: 999,
    sales_or_conv_value: 1998,
    clicks: 10,
    impressions: 100,
    conversions: 4,
    cpc: 0,
    roas: 0,
    currency: "USD",
    source: "ads_ops",
    metrics: {
      campaigns: [{ campaign_id: "snap", campaign_name: "From snapshot", spend: 50, sales: 100, clicks: 5 }],
    },
  };

  test("prefers snapshot KPIs and snapshot campaigns at the latest as_of", () => {
    const view = selectChannelWindow({
      channel: "google_ads",
      windowDays: 7,
      daily: dailyRows,
      campaigns: [],
      snapshots: [snap],
    });
    assert.equal(view.source, "snapshot");
    assert.equal(view.kpis.spend, 999);
    assert.equal(view.kpis.roas, 2);
    assert.equal(view.campaigns[0].campaign_id, "snap");
  });

  test("falls back to daily rollup when the snapshot window is missing", () => {
    const view = selectChannelWindow({
      channel: "google_ads",
      windowDays: 14,
      daily: dailyRows,
      campaigns: [{ ...dailyRows[1], campaign_id: "c", campaign_name: "C" }],
      snapshots: [snap],
    });
    assert.equal(view.source, "daily_rollup");
    assert.equal(view.kpis.spend, 20);
    assert.equal(view.campaigns[0].campaign_id, "c");
  });

  test("newer daily as_of ignores a stale snapshot", () => {
    const view = selectChannelWindow({
      channel: "google_ads",
      windowDays: 7,
      daily: [...dailyRows, daily("2026-08-21", 5, 10)],
      campaigns: [],
      snapshots: [snap],
    });
    assert.equal(view.as_of, "2026-08-21");
    assert.equal(view.source, "daily_rollup");
    assert.equal(view.kpis.spend, 25);
  });

  test("meta stays empty when only google rows exist", () => {
    const view = selectChannelWindow({
      channel: "meta_ads",
      windowDays: 7,
      daily: dailyRows,
      campaigns: [],
      snapshots: [snap],
    });
    assert.equal(view.source, "empty");
    assert.equal(view.kpis.spend, 0);
    assert.equal(view.campaigns.length, 0);
  });
});

describe("page / API invariants", () => {
  const root = process.cwd();
  const page = readFileSync(path.join(root, "src/app/paid-ads/page.tsx"), "utf8");
  const ingest = readFileSync(path.join(root, "src/app/api/paid-ads/ingest/route.ts"), "utf8");
  const read = readFileSync(path.join(root, "src/app/api/paid-ads/route.ts"), "utf8");
  const nav = readFileSync(path.join(root, "src/components/nav.tsx"), "utf8");
  const migration = readFileSync(path.join(root, "../supabase/migration_paid_ads.sql"), "utf8");

  test("nav lists Paid Ads under MONITORING near Amazon PPC", () => {
    assert.match(nav, /href: "\/ppc"/);
    assert.match(nav, /href: "\/paid-ads"/);
    assert.match(nav, /Paid Ads \(Shopify\)/);
    const ppc = nav.indexOf('href: "/ppc"');
    const paid = nav.indexOf('href: "/paid-ads"');
    assert.ok(paid > ppc && paid - ppc < 400);
  });

  test("copy names the Ads Ops feed and forbids a live scrape", () => {
    assert.match(page, /Ads Ops structured feed/);
    assert.match(page, /not a live/);
    assert.match(page, /Waiting for Ads Ops Meta payload/);
    assert.equal(PAID_ADS_ATTRIBUTION.includes("not a live"), true);
    assert.doesNotMatch(page, /puppeteer|playwright|ads\.google\.com|business\.facebook\.com/i);
    assert.doesNotMatch(ingest, /puppeteer|playwright|ads\.google\.com/i);
  });

  test("ingest upserts paid_ads_* only — never Amazon ads_* tables", () => {
    assert.match(ingest, /paid_ads_daily/);
    assert.match(ingest, /paid_ads_campaigns_daily/);
    assert.match(ingest, /paid_ads_snapshots/);
    assert.match(ingest, /getServerSupabase/);
    assert.match(ingest, /normalizePaidAdsPayload/);
    assert.doesNotMatch(ingest, /\.from\(["']ads_/);
    assert.doesNotMatch(read, /\.from\(["']ads_/);
  });

  test("migration keeps google_ads|meta_ads and does not enable RLS lockdown", () => {
    assert.match(migration, /google_ads/);
    assert.match(migration, /meta_ads/);
    assert.match(migration, /paid_ads_daily/);
    assert.match(migration, /paid_ads_campaigns_daily/);
    assert.match(migration, /paid_ads_snapshots/);
    assert.doesNotMatch(migration, /ENABLE ROW LEVEL SECURITY/);
    assert.doesNotMatch(migration, /CREATE POLICY/i);
    assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS ads_/);
  });

  test("paid-ads page has an error boundary", () => {
    assert.ok(existsSync(path.join(root, "src/app/paid-ads/error.tsx")));
  });
});
