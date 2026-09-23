import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  adsCampaigns,
  adsWaste,
  emptyPhase2,
  gscOpportunities,
  metaSection,
  phase2FromLockedDay,
  seoSection,
  topLandingDrops,
} from "./phase2-digest";

describe("Phase 2 extras are null until OAuth rows exist", () => {
  test("empty extras invent nothing", () => {
    const e = emptyPhase2();
    assert.equal(e.landing_drops, null);
    assert.equal(e.seo, null);
    assert.equal(e.ads, null);
    assert.equal(e.meta, null);
    assert.equal(e.meta_actions, null);
    assert.equal(e.connectors.ga4, false);
    assert.equal(e.connectors.gsc, false);
    assert.equal(e.connectors.google_ads, false);
    assert.equal(e.connectors.meta_ads, false);
  });

  test("older GA4 / GSC days are not substituted", () => {
    const olderGa4 = [{
      metric_date: "2026-09-18", landing_page: "/old", device: "mobile",
      sessions: 80, purchase: 2,
    }];
    assert.equal(topLandingDrops(olderGa4, "2026-09-19"), null);
    const olderSeo = [{
      metric_date: "2026-09-17", query: "tallow balm", clicks: 9,
      impressions: 100, ctr: 0.09, position: 4,
    }];
    assert.equal(seoSection(olderSeo, [], "2026-09-19"), null);
    const extras = phase2FromLockedDay("2026-09-19", {
      ga4: olderGa4,
      gscQueries: olderSeo,
      googleAds: [{
        metric_date: "2026-09-18", campaign_id: "1", campaign_name: "Old",
        spend: 40, clicks: 12, conversions: 0,
      }],
      metaAds: [{
        metric_date: "2026-09-18", campaign_id: "120", campaign_name: "Old Meta",
        spend: 51, clicks: 20, impressions: 800, conversions: 1, conversion_value: 80,
      }],
    });
    assert.equal(extras.landing_drops, null);
    assert.equal(extras.seo, null);
    assert.equal(extras.ads, null);
    assert.equal(extras.meta, null);
    assert.equal(extras.meta_actions, null);
    assert.equal(extras.connectors.ga4, false);
    assert.equal(extras.connectors.gsc, false);
    assert.equal(extras.connectors.google_ads, false);
    assert.equal(extras.connectors.meta_ads, false);
  });

  test("null purchases are skipped — no invented 100% leak", () => {
    const rows = [
      { metric_date: "2026-09-19", landing_page: "/a", device: "", sessions: 50, purchase: null },
      { metric_date: "2026-09-19", landing_page: "/b", device: "desktop", sessions: 40, purchase: 4 },
    ];
    const drops = topLandingDrops(rows, "2026-09-19");
    assert.ok(drops);
    assert.deepEqual(drops.map((d) => d.path), ["/b"]);
    assert.equal(drops[0].lost, 36);
  });

  test("locked-day GSC lists queries when present", () => {
    const q = [{
      metric_date: "2026-09-19", query: "tallow", clicks: 3,
      impressions: 40, ctr: 0.075, position: 8.2,
    }];
    const seo = seoSection(q, [], "2026-09-19");
    assert.ok(seo);
    assert.equal(seo.queries[0].key, "tallow");
    assert.equal(seo.pages.length, 0);
    assert.deepEqual(seo.devices, []);
    assert.deepEqual(seo.countries, []);
    assert.deepEqual(seo.appearances, []);
  });

  test("locked-day GSC dims attach device / country / appearance without inventing", () => {
    const seo = seoSection([], [], "2026-09-19", [
      { metric_date: "2026-09-19", dim_kind: "device", dim_value: "MOBILE", clicks: 8, impressions: 100, ctr: 0.08, position: 5 },
      { metric_date: "2026-09-18", dim_kind: "device", dim_value: "DESKTOP", clicks: 99, impressions: 999, ctr: 0.1, position: 2 },
      { metric_date: "2026-09-19", dim_kind: "country", dim_value: "usa", clicks: 7, impressions: 90, ctr: 0.077, position: 4.8 },
      { metric_date: "2026-09-19", dim_kind: "search_appearance", dim_value: "PRODUCT_SNIPPETS", clicks: 1, impressions: 50, ctr: 0.02, position: 8.1 },
    ]);
    assert.ok(seo);
    assert.equal(seo.queries.length, 0);
    assert.equal(seo.devices?.[0].key, "MOBILE");
    assert.equal(seo.devices?.[0].clicks, 8);
    assert.ok(!seo.devices?.some((d) => d.key === "DESKTOP"));
    assert.equal(seo.countries?.[0].key, "usa");
    assert.equal(seo.appearances?.[0].key, "PRODUCT_SNIPPETS");
    const extras = phase2FromLockedDay("2026-09-19", {
      gscDims: [{
        metric_date: "2026-09-19", dim_kind: "device", dim_value: "MOBILE",
        clicks: 8, impressions: 100,
      }],
    });
    assert.equal(extras.connectors.gsc, true);
    assert.equal(extras.seo?.devices?.[0].key, "MOBILE");
  });

  test("locked-day ads slice names campaigns; older days stay null", () => {
    const rows = [
      {
        metric_date: "2026-09-19", campaign_id: "99", campaign_name: "Brand Search",
        spend: 42, clicks: 18, conversions: 0,
      },
      {
        metric_date: "2026-09-18", campaign_id: "88", campaign_name: "Yesterday",
        spend: 99, clicks: 40, conversions: 0,
      },
    ];
    const ads = adsCampaigns(rows, "2026-09-19");
    assert.ok(ads);
    assert.equal(ads.length, 1);
    assert.equal(ads[0].campaign_name, "Brand Search");
    assert.equal(ads[0].spend, 42);
    assert.equal(ads[0].conversions, 0);
    assert.equal(adsCampaigns(rows, "2026-09-20"), null);
    const extras = phase2FromLockedDay("2026-09-19", { googleAds: rows });
    assert.equal(extras.ads?.[0].campaign_name, "Brand Search");
    assert.equal(extras.connectors.google_ads, true);
  });

  test("locked-day Meta is phase2.meta; Google ads stay Google-only", () => {
    const extras = phase2FromLockedDay("2026-09-21", {
      metaAds: [
        {
          metric_date: "2026-09-21", campaign_id: "120", campaign_name: "UGC Balm",
          spend: 30.1, clicks: 12, impressions: 900, conversions: 1, conversion_value: 40.2,
        },
        {
          metric_date: "2026-09-21", campaign_id: "121", campaign_name: "Retarget",
          spend: 20.9, clicks: 4, impressions: 300, conversions: 0, conversion_value: 0,
        },
        {
          metric_date: "2026-09-21", campaign_id: "", campaign_name: "",
          spend: 5, clicks: 1, impressions: 40, conversions: 0, conversion_value: 0,
        },
        {
          metric_date: "2026-09-20", campaign_id: "119", campaign_name: "Yesterday Meta",
          spend: 99, clicks: 40, impressions: 5000, conversions: 2, conversion_value: 200,
        },
      ],
      googleAds: [
        {
          metric_date: "2026-09-21", campaign_id: "99", campaign_name: "Brand Search",
          spend: 42, clicks: 18, conversions: 0,
        },
        {
          metric_date: "2026-09-18", campaign_id: "88", campaign_name: "Old Google",
          spend: 40, clicks: 12, conversions: 0,
        },
      ],
    });
    assert.equal(extras.connectors.meta_ads, true);
    assert.equal(extras.connectors.google_ads, true);
    assert.equal(extras.ads?.length, 1);
    assert.equal(extras.ads?.[0].campaign_name, "Brand Search");
    assert.equal(extras.ads?.[0].spend, 42);
    assert.ok(!extras.ads?.some((c) => /UGC|Retarget|Meta/i.test(c.campaign_name)));

    const meta = extras.meta;
    assert.ok(meta);
    assert.equal(meta.totals.spend, 56);
    assert.equal(meta.totals.clicks, 17);
    assert.equal(meta.totals.impressions, 1240);
    assert.equal(meta.totals.conversions, 1);
    assert.equal(meta.totals.conversion_value, 40.2);
    assert.equal(meta.totals.roas, Math.round((40.2 / 56) * 10000) / 10000);
    assert.equal(meta.totals.roas, 0.7179);
    assert.equal(meta.campaigns.length, 2);
    assert.equal(meta.campaigns[0].campaign_id, "120");
    assert.equal(meta.campaigns[0].campaign_name, "UGC Balm");
    assert.equal(meta.campaigns[0].spend, 30.1);
    assert.equal(meta.campaigns[0].roas, Math.round((40.2 / 30.1) * 10000) / 10000);
    assert.equal(meta.campaigns[1].campaign_name, "Retarget");
    assert.equal(meta.campaigns[1].roas, 0);
    assert.ok(!meta.campaigns.some((c) => c.campaign_name === "Yesterday Meta"));
    assert.equal(meta.actions.length, 1);
    assert.equal(meta.actions[0].campaign_name, "Retarget");
    assert.equal(meta.actions[0].say, "Pause Retarget.");
    assert.deepEqual(extras.meta_actions, meta.actions);
  });

  test("missing locked day nulls meta and does not invent ROAS", () => {
    assert.equal(metaSection([
      {
        metric_date: "2026-09-20", campaign_id: "1", campaign_name: "Older",
        spend: 51, clicks: 10, impressions: 100, conversions: 1, conversion_value: 80,
      },
    ], "2026-09-21"), null);

    const noValue = phase2FromLockedDay("2026-09-21", {
      metaAds: [{
        metric_date: "2026-09-21T00:00:00+00:00",
        campaign_id: "9", campaign_name: "Prospect",
        spend: 51, clicks: 8, conversions: 0,
      }],
      googleAds: [{
        metric_date: "2026-09-21", campaign_id: "99", campaign_name: "Brand Search",
        spend: 42, clicks: 18, conversions: 1,
      }],
    });
    assert.equal(noValue.connectors.meta_ads, true);
    assert.equal(noValue.ads?.[0].campaign_name, "Brand Search");
    assert.equal(noValue.meta?.totals.spend, 51);
    assert.equal(noValue.meta?.totals.impressions, null);
    assert.equal(noValue.meta?.totals.conversion_value, null);
    assert.equal(noValue.meta?.totals.roas, null);
    assert.equal(noValue.meta?.campaigns[0].roas, null);
    assert.equal(noValue.meta?.campaigns[0].conversion_value, null);

    const partial = metaSection([
      {
        metric_date: "2026-09-21", campaign_id: "1", campaign_name: "Known",
        spend: 34.81, clicks: 37, impressions: 1657, conversions: 3, conversion_value: 92.61,
      },
      {
        metric_date: "2026-09-21", campaign_id: "2", campaign_name: "Unknown value",
        spend: 16.58, clicks: 7, impressions: 1466, conversions: null, conversion_value: null,
      },
    ], "2026-09-21");
    assert.equal(partial?.totals.spend, 51.39);
    assert.equal(partial?.totals.conversion_value, 92.61);
    assert.equal(partial?.totals.roas, null);
    assert.equal(partial?.campaigns[0].campaign_name, "Known");
    assert.equal(partial?.campaigns[0].roas, Math.round((92.61 / 34.81) * 10000) / 10000);
    assert.equal(partial?.campaigns.find((c) => c.campaign_name === "Unknown value")?.roas, null);

    const zeroSpend = metaSection([{
      metric_date: "2026-09-21", campaign_id: "3", campaign_name: "Zero",
      spend: 0, clicks: 0, impressions: 10, conversions: 0, conversion_value: 25,
    }], "2026-09-21");
    assert.equal(zeroSpend?.totals.spend, 0);
    assert.equal(zeroSpend?.totals.roas, null);
    assert.equal(zeroSpend?.campaigns[0].roas, null);

    const emptyDay = phase2FromLockedDay("2026-09-21", { metaAds: [] });
    assert.equal(emptyDay.meta, null);
    assert.equal(emptyDay.meta_actions, null);
    assert.equal(emptyDay.connectors.meta_ads, false);

    const many = Array.from({ length: 12 }, (_, i) => ({
      metric_date: "2026-09-21",
      campaign_id: String(i + 1),
      campaign_name: `Camp ${String(i).padStart(2, "0")}`,
      spend: i + 1,
      clicks: 1,
      impressions: 10,
      conversions: 1,
      conversion_value: 2,
    }));
    const capped = metaSection(many, "2026-09-21");
    assert.equal(capped?.campaigns.length, 10);
    assert.equal(capped?.campaigns[0].campaign_name, "Camp 11");
    assert.equal(capped?.totals.spend, many.reduce((s, r) => s + r.spend, 0));
    assert.ok(!capped?.actions.some((a) => /cut|scale/i.test(a.say)));
  });

  test("locked-day Meta pause lines attach without inventing conversions", () => {
    const extras = phase2FromLockedDay("2026-09-19", {
      metaAds: [
        {
          metric_date: "2026-09-19", campaign_id: "1", campaign_name: "Dead UGC",
          spend: 18, clicks: 6, conversions: 0,
        },
        {
          metric_date: "2026-09-19", campaign_id: "2", campaign_name: "Unknown",
          spend: 40, clicks: 9,
        },
        {
          metric_date: "2026-09-18", campaign_id: "3", campaign_name: "Yesterday",
          spend: 99, clicks: 40, conversions: 0,
        },
      ],
    });
    assert.equal(extras.meta?.actions.length, 1);
    assert.equal(extras.meta?.actions[0].campaign_name, "Dead UGC");
    assert.equal(extras.meta?.actions[0].say, "Pause Dead UGC.");
    assert.equal(extras.meta?.campaigns.length, 2);
    assert.equal(extras.meta?.totals.spend, 58);
    assert.equal(extras.meta?.campaigns.find((c) => c.campaign_name === "Unknown")?.roas, null);
    assert.doesNotMatch(extras.meta?.actions[0].say ?? "", /Brand Search|cut|scale/i);
    assert.deepEqual(extras.meta_actions, extras.meta?.actions);
    assert.equal(extras.ads, null);
  });

  test("ads waste and GSC opportunities fail closed without inventing", () => {
    assert.deepEqual(adsWaste(null), []);
    assert.deepEqual(adsWaste([]), []);
    assert.deepEqual(adsWaste([
      { campaign_id: "1", campaign_name: "Cheap", spend: 2, clicks: 4, conversions: 0 },
      { campaign_id: "2", campaign_name: "Unknown conv", spend: 40, clicks: 9, conversions: null },
    ]), []);
    const waste = adsWaste([
      { campaign_id: "3", campaign_name: "Brand Search", spend: 42, clicks: 18, conversions: 0 },
    ]);
    assert.equal(waste[0]?.campaign_name, "Brand Search");

    assert.deepEqual(gscOpportunities(null), []);
    assert.deepEqual(gscOpportunities([
      { key: "tiny", clicks: 0, impressions: 10, ctr: 0, position: 20 },
      { key: "good", clicks: 12, impressions: 80, ctr: 0.15, position: 4 },
      { key: "null clicks", clicks: null, impressions: 200, ctr: null, position: 18 },
    ]), []);
    const opp = gscOpportunities([
      { key: "tallow balm", clicks: 0, impressions: 120, ctr: 0, position: 22 },
    ]);
    assert.equal(opp[0]?.key, "tallow balm");
    assert.equal(opp[0]?.impressions, 120);
    assert.equal(opp[0]?.clicks, 0);
  });
});

describe("wiring — extras hang on the landed digest", () => {
  const root = process.cwd();
  const route = readFileSync(path.join(root, "src/app/api/conversion-digest/route.ts"), "utf8");
  const lib = readFileSync(path.join(root, "src/lib/conversion-digest.ts"), "utf8");

  test("does not replace Iris fields or add a second Jev route", () => {
    assert.match(route, /buildConversionDigest/);
    assert.match(route, /ensureFunnelJevTriage/);
    assert.match(route, /phase2FromLockedDay/);
    assert.match(route, /emptyPhase2/);
    assert.doesNotMatch(route, /api\/jev-funnel/);
    assert.doesNotMatch(lib, /ga4_landing_daily|gsc_query_daily/);
    assert.doesNotMatch(route, /paid_ga_daily|ryze/i);
    assert.match(route, /gsc_dim_daily/);
    assert.match(route, /meta_ads_daily/);
    assert.match(route, /meta_ads_daily", "metric_date,campaign_id,campaign_name,spend,clicks,impressions,conversions,conversion_value"/);
    assert.match(route, /phase2\.meta/);
    assert.match(lib, /phase2\.meta/);
  });
});
