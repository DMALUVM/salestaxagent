import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildIntel } from "./intel";
import {
  adaptGa4LandingDaily,
  adaptGoogleAdsDaily,
  adaptGscPageDaily,
  adaptGscQueryDaily,
  adaptMetaAdsDaily,
  bounceFromEngaged,
  gscCtrToPct,
  pickOriginStats,
  preferApiWhenPresent,
  synthesizeGscChart,
} from "./api-adapt";

describe("preferApiWhenPresent", () => {
  test("uses API when the official table has rows", () => {
    assert.equal(preferApiWhenPresent({
      rows: 32, min_date: "2026-09-13", max_date: "2026-09-20",
      fetched_at: "2026-09-21T11:30:00Z", missing: false,
    }), "api");
  });

  test("falls back to CSV when API is empty (Meta pending)", () => {
    assert.equal(preferApiWhenPresent({
      rows: 0, min_date: null, max_date: null, fetched_at: null, missing: false,
    }), "csv");
  });

  test("falls back to CSV when the API table is missing", () => {
    assert.equal(preferApiWhenPresent({
      rows: 0, min_date: null, max_date: null, fetched_at: null, missing: true,
    }), "csv");
  });
});

describe("pickOriginStats", () => {
  test("API origin reports fetched_at and metric_date span", () => {
    const picked = pickOriginStats("api", {
      rows: 32, min_date: "2026-09-13", max_date: "2026-09-20",
      fetched_at: "2026-09-21T11:30:00.565Z", missing: false,
    }, { rows: 900, min_date: "2023-11-11", max_date: "2026-09-12" });
    assert.equal(picked.origin, "api");
    assert.equal(picked.max_date, "2026-09-20");
    assert.equal(picked.min_date, "2026-09-13");
    assert.equal(picked.fetched_at, "2026-09-21T11:30:00.565Z");
    assert.equal(picked.rows, 32);
  });

  test("CSV origin keeps ingest dates and no fetched_at", () => {
    const picked = pickOriginStats("csv", {
      rows: 0, min_date: null, max_date: null, fetched_at: null, missing: false,
    }, { rows: 400, min_date: "2026-01-01", max_date: "2026-09-12" });
    assert.equal(picked.origin, "csv");
    assert.equal(picked.max_date, "2026-09-12");
    assert.equal(picked.fetched_at, null);
  });
});

describe("adaptGoogleAdsDaily", () => {
  test("maps metric_date + conversion_value and classifies the campaign name", () => {
    const row = adaptGoogleAdsDaily({
      metric_date: "2026-09-20",
      campaign_id: "24106947077",
      campaign_name: "TALLOWBOURN- PMAX - Max Conversions - Campaign V4",
      spend: "37.65",
      clicks: 32,
      impressions: 5074,
      conversions: "3.0000",
      conversion_value: "100.94",
      fetched_at: "2026-09-21T11:30:00Z",
      source: "google_ads_api",
    });
    assert.ok(row);
    assert.equal(row!.platform, "google");
    assert.equal(row!.date, "2026-09-20");
    assert.equal(row!.campaign_type, "PMax");
    assert.equal(row!.is_brand, false);
    assert.equal(row!.spend, 37.65);
    assert.equal(row!.conv_value, 100.94);
    assert.equal(row!.conversions, 3);
    assert.equal(row!.lost_is_budget, null);
    assert.equal(row!.search_impr_share, null);
  });

  test("brand search stays brand; skips blank names", () => {
    const brand = adaptGoogleAdsDaily({
      metric_date: "2026-09-20",
      campaign_name: "BRANDED - Search - Campaign V1",
      spend: 10, clicks: 4, impressions: 40, conversions: 1, conversion_value: 26,
    });
    assert.equal(brand!.is_brand, true);
    assert.equal(brand!.campaign_type, "Search");
    assert.equal(adaptGoogleAdsDaily({ metric_date: "2026-09-20", campaign_name: "" }), null);
  });
});

describe("adaptMetaAdsDaily", () => {
  test("uses the same ads shape when API rows exist", () => {
    const row = adaptMetaAdsDaily({
      metric_date: "2026-09-20",
      campaign_name: "UGC | Tallow Balm | CBO",
      spend: 12, clicks: 8, impressions: 200, conversions: 0, conversion_value: 0,
    });
    assert.ok(row);
    assert.equal(row!.platform, "meta");
    assert.equal(row!.product, "balm");
    assert.equal(row!.audience, "prospect");
  });
});

describe("adaptGa4LandingDaily", () => {
  test("maps purchase to key_events and does not invent channel or revenue", () => {
    const row = adaptGa4LandingDaily({
      metric_date: "2026-09-20",
      landing_page: "/products/grass-fed-tallow-lip-balm",
      device: "mobile",
      sessions: 8,
      engaged_sessions: 1,
      landings: 7,
      view_item: 5,
      add_to_cart: 0,
      begin_checkout: 0,
      purchase: 1,
      source: "ga4_data_api",
    });
    assert.ok(row);
    assert.equal(row!.date, "2026-09-20");
    assert.equal(row!.channel_group, "(not set)");
    assert.equal(row!.key_events, 1);
    assert.equal(row!.revenue, 0);
    assert.equal(row!.sessions, 8);
    assert.ok(row!.bounce_rate != null && row!.bounce_rate > 80);
  });

  test("null purchase stays 0 — never inferred from view_item", () => {
    const row = adaptGa4LandingDaily({
      metric_date: "2026-09-20",
      landing_page: "/products/tallow-balm",
      device: "mobile",
      sessions: 17,
      engaged_sessions: 0,
      view_item: 8,
      add_to_cart: 8,
      purchase: null,
    });
    assert.equal(row!.key_events, 0);
    assert.equal(row!.bounce_rate, 100);
  });
});

describe("gsc adapters", () => {
  test("converts API 0–1 CTR to the 0–100 intel scale", () => {
    assert.equal(gscCtrToPct("0.045455"), 4.5455);
    assert.equal(gscCtrToPct(1), 100);
    assert.equal(gscCtrToPct(null), null);
    assert.equal(bounceFromEngaged(8, 1), 87.5);
  });

  test("query + page map metric_date; page URL lives in query", () => {
    const q = adaptGscQueryDaily({
      metric_date: "2026-09-19",
      query: "tallow soap",
      clicks: 1,
      impressions: 22,
      ctr: "0.045455",
      position: "8.200",
    });
    assert.ok(q);
    assert.equal(q!.kind, "query");
    assert.equal(q!.date, "2026-09-19");
    assert.ok(q!.ctr != null && q!.ctr > 4 && q!.ctr < 5);
    const p = adaptGscPageDaily({
      metric_date: "2026-09-19",
      page: "https://tallowbourn.com/products/tallow-balm",
      clicks: 2,
      impressions: 80,
      ctr: 0.025,
      position: 12,
    });
    assert.equal(p!.kind, "page");
    assert.equal(p!.query, "https://tallowbourn.com/products/tallow-balm");
    assert.equal(p!.ctr, 2.5);
  });

  test("synthesizes Chart.csv-shaped daily totals from dated queries", () => {
    const chart = synthesizeGscChart([
      {
        kind: "query", date: "2026-09-19", query: "tallow soap",
        clicks: 1, impressions: 22, ctr: 4.5, position: 8,
      },
      {
        kind: "query", date: "2026-09-19", query: "tallow balm",
        clicks: 3, impressions: 10, ctr: 30, position: 4,
      },
      {
        kind: "page", date: "2026-09-19", query: "/products/tallow-balm",
        clicks: 9, impressions: 90, ctr: 10, position: 5,
      },
    ]);
    assert.equal(chart.length, 1);
    assert.equal(chart[0].kind, "chart");
    assert.equal(chart[0].query, "(site)");
    assert.equal(chart[0].clicks, 4);
    assert.equal(chart[0].impressions, 32);
  });
});

describe("buildIntel from API-shaped rows after the CSV cutoff", () => {
  test("renders Google / GA4 / GSC intel past 2026-09-12 without a CSV row", () => {
    const campaigns = [
      adaptGoogleAdsDaily({
        metric_date: "2026-09-20",
        campaign_name: "TALLOWBOURN- PMAX - Max Conversions - Campaign V4",
        spend: 37.65, clicks: 32, impressions: 5074, conversions: 3, conversion_value: 100.94,
      })!,
    ];
    const ga = [
      adaptGa4LandingDaily({
        metric_date: "2026-09-20",
        landing_page: "/products/natural-tallow-deodorant-extra-strength",
        device: "mobile",
        sessions: 54,
        engaged_sessions: 0,
        purchase: 0,
      })!,
    ];
    const queries = [
      adaptGscQueryDaily({
        metric_date: "2026-09-19",
        query: "best tallow soap",
        clicks: 1, impressions: 1, ctr: 1, position: 1,
      })!,
    ];
    const intel = buildIntel({
      campaigns,
      queries: [...queries, ...synthesizeGscChart(queries)],
      ga,
      range: 7,
      filter: "all",
      today: "2026-09-21",
      stats: {
        google: {
          rows: 32, min_date: "2026-09-13", max_date: "2026-09-20",
          origin: "api", fetched_at: "2026-09-21T11:30:00Z",
        },
        meta: { rows: 0, min_date: null, max_date: null, origin: "csv", fetched_at: null },
        ga4: {
          rows: 275, min_date: "2026-09-13", max_date: "2026-09-20",
          origin: "api", fetched_at: "2026-09-21T11:20:00Z",
        },
        gsc_trend: {
          rows: 743, min_date: "2026-09-13", max_date: "2026-09-19",
          origin: "api", fetched_at: "2026-09-21T11:25:00Z",
        },
        gsc_snapshot: {
          rows: 1168, min_date: "2026-09-13", max_date: "2026-09-19",
          origin: "api", fetched_at: "2026-09-21T11:25:00Z",
        },
      },
    });

    assert.equal(intel.as_of, "2026-09-20");
    assert.ok(intel.kpis.google.spend > 0);
    assert.equal(intel.kpis.meta.spend, 0);
    assert.equal(intel.ga4.landings[0]?.page, "/products/natural-tallow-deodorant-extra-strength");
    assert.equal(intel.gsc.queries[0]?.query, "best tallow soap");
    assert.ok(intel.gsc.chart.length >= 1);

    const google = intel.freshness.sources.find((s) => s.source === "google")!;
    assert.equal(google.origin, "api");
    assert.equal(google.file, "google_ads_daily");
    assert.equal(google.max_date, "2026-09-20");
    assert.equal(google.fetched_at, "2026-09-21T11:30:00Z");
    assert.equal(google.days_behind, 1);
    assert.equal(google.stale, false);

    const meta = intel.freshness.sources.find((s) => s.source === "meta")!;
    assert.equal(meta.origin, "csv");
    assert.equal(meta.stale, true);

    const gsc = intel.freshness.sources.find((s) => s.source === "gsc_snapshot")!;
    assert.equal(gsc.origin, "api");
    assert.equal(gsc.dated, true);
    assert.equal(gsc.max_date, "2026-09-19");
  });

  test("Meta CSV rows still score when meta_ads_daily is empty", () => {
    const intel = buildIntel({
      campaigns: [{
        platform: "meta",
        date: "2026-09-12",
        campaign_name: "UGC | Tallow Balm | CBO",
        campaign_type: "Other",
        product: "balm",
        is_brand: false,
        audience: "prospect",
        spend: 40,
        conv_value: 80,
        clicks: 20,
        impressions: 400,
        conversions: 2,
        lost_is_budget: null,
        lost_is_rank: null,
        frequency: null,
        frequency_peak: null,
        status: null,
      }],
      queries: [],
      ga: [],
      range: 7,
      filter: "all",
      today: "2026-09-21",
      stats: {
        google: {
          rows: 32, min_date: "2026-09-13", max_date: "2026-09-20",
          origin: "api", fetched_at: "2026-09-21T11:30:00Z",
        },
        meta: { rows: 80, min_date: "2026-01-01", max_date: "2026-09-12", origin: "csv" },
      },
    });
    assert.equal(intel.kpis.meta.spend, 40);
    assert.equal(intel.freshness.sources.find((s) => s.source === "meta")!.origin, "csv");
  });
});
