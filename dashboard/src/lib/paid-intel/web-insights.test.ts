import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { buildIntel } from "./intel";
import type { CampaignDaily, GaDaily, SearchQueryDaily } from "./types";
import {
  buildWebInsights,
  isBrandQuery,
  isMoneyQuery,
  pagePath,
} from "./web-insights";

const SRC = readFileSync(path.join(process.cwd(), "src/lib/paid-intel/web-insights.ts"), "utf8");
const CARD = readFileSync(path.join(process.cwd(), "src/components/web-insights-card.tsx"), "utf8");
const INTEL_UI = readFileSync(path.join(process.cwd(), "src/components/paid-ads-intel.tsx"), "utf8");
const PAGE = readFileSync(path.join(process.cwd(), "src/app/paid-ads/page.tsx"), "utf8");
const PPC = readFileSync(path.join(process.cwd(), "src/app/ppc/page.tsx"), "utf8");
const INV = readFileSync(path.join(process.cwd(), "src/app/inventory/page.tsx"), "utf8");

function camp(partial: Partial<CampaignDaily> & Pick<CampaignDaily, "platform" | "date" | "campaign_name" | "spend">): CampaignDaily {
  return {
    campaign_type: "Other",
    product: "other",
    is_brand: false,
    audience: "unknown",
    conv_value: 0,
    clicks: 0,
    impressions: 0,
    conversions: 0,
    lost_is_budget: null,
    lost_is_rank: null,
    frequency: null,
    frequency_peak: null,
    status: "ACTIVE",
    ...partial,
  };
}

function ga(partial: Partial<GaDaily> & Pick<GaDaily, "date" | "channel_group" | "landing_page">): GaDaily {
  return {
    device: "mobile",
    sessions: 0,
    active_users: 0,
    key_events: 0,
    revenue: 0,
    bounce_rate: null,
    ...partial,
  };
}

function q(partial: Partial<SearchQueryDaily> & Pick<SearchQueryDaily, "kind" | "query">): SearchQueryDaily {
  return {
    date: "",
    clicks: 0,
    impressions: 0,
    ctr: null,
    position: null,
    ...partial,
  };
}

/** Dave lock 2026-09-01 — real column names, this upload's numbers. */
function lockUpload() {
  const deodorant = "/products/natural-tallow-deodorant-extra-strength";
  return {
    campaigns: [
      camp({
        platform: "meta",
        date: "2026-08-25",
        campaign_name: "UGC | Tallow Balm | CBO",
        product: "balm",
        spend: 180,
        conv_value: 40,
        clicks: 20,
        impressions: 1000,
        conversions: 1,
      }),
      camp({
        platform: "meta",
        date: "2026-08-31",
        campaign_name: "UGC | Tallow Balm | CBO",
        product: "balm",
        spend: 183,
        conv_value: 40,
        clicks: 20,
        impressions: 1000,
        conversions: 1,
      }),
      camp({
        platform: "google",
        date: "2026-08-31",
        campaign_name: "TALLOWBOURN- PMAX - Max Conversions - Campaign V4",
        campaign_type: "PMax",
        spend: 120,
        conv_value: 140,
        clicks: 60,
        impressions: 3000,
        conversions: 4,
      }),
    ],
    ga: [
      ga({
        date: "2026-08-25",
        channel_group: "Organic Search",
        landing_page: deodorant,
        sessions: 300,
        active_users: 280,
        key_events: 16,
        revenue: 330.21,
      }),
      ga({
        date: "2026-08-31",
        channel_group: "Paid Search",
        landing_page: deodorant,
        sessions: 203,
        active_users: 190,
        key_events: 10,
        revenue: 207.50,
      }),
      ga({
        date: "2026-08-31",
        channel_group: "Paid Social",
        landing_page: "/products/tallow-balm",
        sessions: 5,
        active_users: 5,
        key_events: 0,
        revenue: 0,
      }),
    ],
    queries: [
      q({
        kind: "page",
        query: "https://tallowbourn.com/products/tallow-balm",
        clicks: 5,
        impressions: 836,
        ctr: 0.6,
        position: 8.2,
      }),
      q({
        kind: "page",
        query: "https://tallowbourn.com/blogs/news/tallow-shea-butter-coconut-oil-skincare",
        clicks: 2,
        impressions: 1098,
        ctr: 0.18,
        position: 6.4,
      }),
      q({
        kind: "query",
        query: "tallow deodorant",
        clicks: 12,
        impressions: 220,
        ctr: 5.5,
        position: 14.7,
      }),
      q({
        kind: "query",
        query: "tallow balm",
        clicks: 8,
        impressions: 190,
        ctr: 4.2,
        position: 17.1,
      }),
      q({
        kind: "query",
        query: "tallowbourn grass-fed tallow balm",
        clicks: 0,
        impressions: 73,
        ctr: 0,
        position: 1,
      }),
      q({
        kind: "chart",
        date: "2025-10-12",
        query: "(site)",
        clicks: 40,
        impressions: 800,
        ctr: 5,
        position: 8,
      }),
      q({
        kind: "chart",
        date: "2026-08-29",
        query: "(site)",
        clicks: 55,
        impressions: 900,
        ctr: 6.1,
        position: 7.4,
      }),
    ],
  };
}

describe("web insights — five blocks on real columns", () => {
  test("uses paid_ga_daily / paid_search_query_daily / paid_campaign_daily column names", () => {
    for (const col of [
      "channel_group", "landing_page", "sessions", "key_events", "revenue",
      "kind", "query", "clicks", "impressions", "ctr", "position",
      "platform", "campaign_name", "spend",
    ]) {
      assert.match(SRC, new RegExp(col));
    }
    assert.doesNotMatch(SRC, /shopify_ads|Shopify Ads|paid_shopify/);
    assert.doesNotMatch(SRC, /platform === "shopify"/);
    assert.doesNotMatch(INTEL_UI, /shopify_ads|Shopify Ads/);
    assert.doesNotMatch(CARD, /shopify_ads|Shopify Ads/);
  });

  test("1) GA4 converting landings vs paid destinations — 2026-08-25..08-31 deodorant lock", () => {
    const { campaigns, ga, queries } = lockUpload();
    const w = buildWebInsights({ campaigns, ga, queries, range: 7, asOf: "2026-08-31" });
    assert.equal(w.present, true);
    assert.equal(w.windows.ga4?.label, "2026-08-25..2026-08-31");
    const top = w.converting_landings[0];
    assert.equal(top.page, "/products/natural-tallow-deodorant-extra-strength");
    assert.equal(top.sessions, 503);
    assert.equal(top.key_events, 26);
    assert.equal(top.revenue, 537.71);
    const paid = w.ad_landings.find((r) => r.page === "/products/tallow-balm");
    assert.ok(paid, "Paid Social landing is where ads sent traffic, not invented");
    assert.equal(paid!.sessions, 5);
    assert.ok(w.ad_landings.some((r) => r.page === top.page), "Paid Search also landed on the converting PDP");
    assert.match(w.site_vs_ad, /do not 404 either live URL/);
  });

  test("2) GSC pages: high impressions + CTR < ~1%, query column is the URL", () => {
    const { campaigns, ga, queries } = lockUpload();
    const w = buildWebInsights({ campaigns, ga, queries });
    assert.equal(w.windows.gsc_pages?.label, "Last-7 undated");
    const balm = w.low_ctr_pages.find((p) => p.path === "/products/tallow-balm");
    const blog = w.low_ctr_pages.find((p) => /tallow-shea-butter-coconut-oil-skincare/.test(p.path));
    assert.ok(balm);
    assert.equal(balm!.impressions, 836);
    assert.equal(balm!.ctr, 0.6);
    assert.ok(blog);
    assert.equal(blog!.impressions, 1098);
    assert.equal(blog!.clicks, 2);
    assert.ok(w.low_ctr_pages.every((p) => p.impressions >= 400 && (p.ctr ?? 100) < 1));
  });

  test("3) GSC queries: money terms off page 1 and branded pos-1 with 0 clicks", () => {
    const { campaigns, ga, queries } = lockUpload();
    const w = buildWebInsights({ campaigns, ga, queries });
    assert.equal(w.windows.gsc_queries?.label, "Last-7 undated");
    assert.equal(w.windows.gsc_chart?.label, "2025-10-12..2026-08-29");
    const deo = w.money_queries.find((q) => q.query === "tallow deodorant");
    const balm = w.money_queries.find((q) => q.query === "tallow balm");
    const branded = w.money_queries.find((q) => q.query === "tallowbourn grass-fed tallow balm");
    assert.equal(deo?.kind, "off_page_1");
    assert.equal(deo?.position, 14.7);
    assert.equal(balm?.kind, "off_page_1");
    assert.equal(balm?.position, 17.1);
    assert.equal(branded?.kind, "branded_pos1_zero_clicks");
    assert.equal(branded?.clicks, 0);
    assert.equal(branded?.impressions, 73);
    assert.equal(isMoneyQuery("tallow deodorant"), true);
    assert.equal(isBrandQuery("tallowbourn grass-fed tallow balm"), true);
    assert.equal(pagePath("https://tallowbourn.com/products/tallow-balm"), "/products/tallow-balm");
  });

  test("4) Channel gap: Meta spend vs GA4 Paid Social from channel_group", () => {
    const { campaigns, ga, queries } = lockUpload();
    const w = buildWebInsights({ campaigns, ga, queries });
    const meta = w.channel_gaps.find((g) => g.platform === "meta");
    assert.ok(meta);
    assert.equal(meta!.spend, 363);
    assert.equal(meta!.ga_channel, "Paid Social");
    assert.equal(meta!.sessions, 5);
    const google = w.channel_gaps.find((g) => g.platform === "google");
    assert.ok(google);
    assert.equal(google!.ga_channel, "Paid Search");
    assert.equal(google!.sessions, 203);
  });

  test("5) one-line site fix vs ad fix — does not mix them or 404 live URLs", () => {
    const { campaigns, ga, queries } = lockUpload();
    const w = buildWebInsights({ campaigns, ga, queries });
    assert.match(w.site_vs_ad, /^Site fix:/);
    assert.match(w.site_vs_ad, /Ad fix:/);
    assert.match(w.site_vs_ad, /tracking\/UTMs/);
    assert.match(w.site_vs_ad, /Meta \$363\.00 vs Paid Social 5 sess/);
    assert.match(w.site_vs_ad, /do not 404, unpublish, or retarget the live tallowbourn.com handle/);
    assert.doesNotMatch(w.site_vs_ad, /unpublish this|404 this|retarget the handle to|take down/);
    assert.match(w.site_vs_ad, /tallow deodorant/);
    assert.match(w.site_vs_ad, /tallow balm/);
  });

  test("missing source is a one-line gap, not fake rows", () => {
    const { campaigns } = lockUpload();
    const w = buildWebInsights({ campaigns, ga: [], queries: [] });
    assert.equal(w.converting_landings.length, 0);
    assert.equal(w.ad_landings.length, 0);
    assert.equal(w.low_ctr_pages.length, 0);
    assert.equal(w.money_queries.length, 0);
    assert.ok(w.gaps.some((g) => /GA4 Explore not uploaded/.test(g)));
    assert.ok(w.gaps.some((g) => /Pages\.csv not uploaded/.test(g)));
    assert.ok(w.gaps.some((g) => /Queries\.csv not uploaded/.test(g)));
    assert.ok(!w.gaps.some((g) => /campaign days not uploaded/.test(g)));
    const meta = w.channel_gaps.find((g) => g.platform === "meta");
    assert.equal(meta?.sessions, null, "do not invent a 0-session GA4 row when GA4 is missing");
  });

  test("undated GSC-only upload still presents the card without inventing dates", () => {
    const { queries } = lockUpload();
    const snaps = queries.filter((r) => r.kind === "page" || r.kind === "query");
    const intel = buildIntel({ campaigns: [], queries: snaps, ga: [], range: 7, filter: "all" });
    assert.equal(intel.as_of, null);
    assert.equal(intel.web_insights.present, true);
    assert.equal(intel.web_insights.windows.gsc_pages?.label, "Last-7 undated");
    assert.equal(intel.web_insights.windows.ga4, null);
    assert.ok(intel.cards.every((c) => c.owner === "ads" || c.owner === "site"));
    assert.ok(!intel.cards.some((c) => c.id === "web-insights"), "Web insights is not an Ads Ops card");
  });

  test("buildIntel attaches web insights on a dated upload and leaves Ads Ops ranking alone", () => {
    const { campaigns, ga, queries } = lockUpload();
    const intel = buildIntel({ campaigns, ga, queries, range: 7, filter: "all" });
    assert.equal(intel.as_of, "2026-08-31");
    assert.equal(intel.web_insights.present, true);
    assert.equal(intel.web_insights.converting_landings[0].sessions, 503);
    assert.ok(!intel.cards.some((c) => c.id.startsWith("web-insight")));
  });
});

describe("web insights lives on /paid-ads only", () => {
  test("card is mounted on the intel page, not /ppc or /inventory", () => {
    assert.match(INTEL_UI, /WebInsightsCard/);
    assert.match(INTEL_UI, /web-insights/);
    assert.match(CARD, /Web insights/);
    assert.match(CARD, /Site half of this upload/);
    assert.doesNotMatch(PPC, /WebInsightsCard|Web insights/);
    assert.doesNotMatch(INV, /WebInsightsCard|Web insights/);
  });

  test("paid-ads user copy says Dashboard, never warehouse", () => {
    assert.doesNotMatch(PAGE, /warehouse/i);
    assert.match(PAGE, /Dashboard/);
    const error = readFileSync(path.join(process.cwd(), "src/app/paid-ads/error.tsx"), "utf8");
    assert.doesNotMatch(error, /warehouse/i);
    assert.match(error, /Dashboard/);
  });
});
