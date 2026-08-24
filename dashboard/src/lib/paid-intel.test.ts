import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "path";

import {
  buildIntel,
  detectKind,
  parseGa4Csv,
  parseGoogleCsv,
  parseGscChart,
  parseGscPages,
  parseGscQueries,
  parseMetaCsv,
  parseNamedFile,
  rangeStart,
  isBrandCampaign,
  campaignTypeOf,
  productOf,
} from "./paid-intel";

const UP = "/home/ubuntu/.cursor/projects/workspace/uploads";
const GOOGLE = path.join(UP, "Google_Ads_Daily__3__be1e.csv");
const META = path.join(UP, "Tallow-ourn-Ad-Account-Campaigns-Jan-1-2026-Aug-24-2026_8d75.csv");
const GA4 = path.join(UP, "download_3974.csv");
const CHART = path.join(UP, "Chart_e5a6.csv");
const PAGES = path.join(UP, "Pages_ee6b.csv");
const QUERIES = path.join(UP, "Queries_4c60.csv");

const haveUploads = [GOOGLE, META, GA4, CHART, PAGES, QUERIES].every((p) => existsSync(p));

describe("classify", () => {
  test("brand search is brand; PMax is not", () => {
    assert.equal(isBrandCampaign("BRANDED - Search - Campaign V1"), true);
    assert.equal(isBrandCampaign("TALLOWBOURN- PMAX - Max Conversions - Campaign V4"), false);
    assert.equal(campaignTypeOf("TALLOWBOURN- PMAX - Max Conversions - Campaign V4"), "PMax");
    assert.equal(campaignTypeOf("AI MAX - Search - Campaign V1"), "Search");
    assert.equal(productOf("UGC | Tallow Balm | CBO"), "balm");
    assert.equal(productOf("SALES | Tallow Balm + Deo"), "deodorant");
    assert.equal(productOf("LIP BALM - Testing"), "lip");
    assert.equal(productOf("TALLOW SOAP - Testing"), "soap");
  });
});

describe("range is relative to max date in the files", () => {
  test("7 days back from file as-of, not today", () => {
    assert.equal(rangeStart("2026-08-24", 7), "2026-08-18");
    assert.equal(rangeStart("2026-08-24", 30), "2026-07-26");
    assert.equal(rangeStart("2026-08-24", 0), "0001-01-01");
  });
});

describe("parsers on the attached Tallowbourn files", { skip: !haveUploads }, () => {
  test("detects each source from headers", () => {
    assert.equal(detectKind("Google Ads Daily.csv", readFileSync(GOOGLE, "utf8")), "google");
    assert.equal(detectKind("meta.csv", readFileSync(META, "utf8")), "meta");
    assert.equal(detectKind("download.csv", readFileSync(GA4, "utf8")), "ga4");
    assert.equal(detectKind("Queries.csv", readFileSync(QUERIES, "utf8")), "gsc_queries");
    assert.equal(detectKind("Pages.csv", readFileSync(PAGES, "utf8")), "gsc_pages");
    assert.equal(detectKind("Chart.csv", readFileSync(CHART, "utf8")), "gsc_chart");
  });

  test("Google: skips titles, unpivots type columns, keeps Brand + PMax + AI Max", () => {
    const rows = parseGoogleCsv(readFileSync(GOOGLE, "utf8"));
    assert.ok(rows.length > 200);
    assert.ok(rows.every((r) => r.platform === "google" && r.date));
    assert.ok(!rows.some((r) => /total/i.test(r.campaign_name)));
    const last = rows.filter((r) => r.date === "2026-08-23");
    const names = last.map((r) => r.campaign_name);
    assert.ok(names.some((n) => /BRANDED/i.test(n)));
    assert.ok(names.some((n) => /PMAX/i.test(n)));
    const pmax = last.find((r) => /PMAX/i.test(r.campaign_name) && /V4/i.test(r.campaign_name));
    assert.ok(pmax);
    assert.equal(pmax!.campaign_type, "PMax");
    assert.ok(pmax!.spend > 0);
    assert.ok((pmax!.lost_is_budget ?? 0) >= 0);
    const brand = last.find((r) => /BRANDED/i.test(r.campaign_name));
    assert.equal(brand!.is_brand, true);
    assert.equal(brand!.campaign_type, "Search");
  });

  test("7-day Google overwrite keeps older days in the parsed set", () => {
    const rows = parseGoogleCsv(readFileSync(GOOGLE, "utf8"));
    const old = rows.filter((r) => r.date === "2023-12-05");
    const neu = rows.filter((r) => r.date === "2026-08-24");
    assert.ok(old.length);
    assert.ok(neu.length);
  });

  test("Meta: skips $0/0-impr, does not use CPC as spend", () => {
    const rows = parseMetaCsv(readFileSync(META, "utf8"));
    assert.ok(rows.length > 50);
    assert.ok(rows.every((r) => r.platform === "meta"));
    assert.ok(rows.every((r) => r.spend > 0 || r.impressions > 0));
    const live = rows.filter((r) => r.date === "2026-08-23" && r.spend > 0);
    assert.ok(live.length >= 2);
    const sales = live.find((r) => /Tallow Balm \+ Deo/i.test(r.campaign_name));
    assert.ok(sales);
    assert.ok(sales!.spend > 20);
    assert.ok(sales!.conv_value > 50);
    assert.ok(sales!.spend < 200, "CPC/cost-per-purchase must not be mapped as spend");
    assert.equal(sales!.audience, "prospect");
    const rt = live.find((r) => /RETARGETING/i.test(r.campaign_name));
    if (rt) assert.equal(rt.audience, "retarget");
  });

  test("GSC: Queries/Pages have empty date; Chart is daily; no invented delta", () => {
    const q = parseGscQueries(readFileSync(QUERIES, "utf8"));
    const p = parseGscPages(readFileSync(PAGES, "utf8"));
    const c = parseGscChart(readFileSync(CHART, "utf8"));
    assert.ok(q.length > 10);
    assert.ok(q.every((r) => r.date === "" && r.kind === "query"));
    assert.ok(p.every((r) => r.date === "" && r.kind === "page"));
    assert.ok(c.every((r) => r.date && r.kind === "chart"));
    assert.ok(q.some((r) => /tallow deodorant/i.test(r.query) && (r.position ?? 0) > 4));
    assert.ok(p.some((r) => /tallow-balm/i.test(r.query) && (r.ctr ?? 99) < 1));
  });

  test("GA4: skips # comments and Grand total; parses compact dates", () => {
    const rows = parseGa4Csv(readFileSync(GA4, "utf8"));
    assert.ok(rows.length > 100);
    assert.ok(!rows.some((r) => /grand total/i.test(r.channel_group)));
    assert.ok(rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)));
    assert.ok(rows.some((r) => r.channel_group === "Cross-network"));
    assert.ok(rows.some((r) => r.channel_group === "Unassigned"));
    assert.ok(rows.some((r) => r.device === "mobile"));
  });

  test("empty source omits that channel and does not crash", () => {
    const onlyMeta = parseNamedFile("meta.csv", readFileSync(META, "utf8"));
    const intel = buildIntel({
      campaigns: onlyMeta.campaigns,
      queries: [],
      ga: [],
      range: 7,
      filter: "meta",
    });
    assert.ok(intel.as_of);
    assert.equal(intel.kpis.google.spend, 0);
    assert.ok(intel.kpis.meta.spend > 0);
    assert.equal(intel.gsc.hidden, true);
  });

  test("intel ranks cards by stake and never parks dollars on Brand Search", () => {
    const g = parseGoogleCsv(readFileSync(GOOGLE, "utf8"));
    const m = parseMetaCsv(readFileSync(META, "utf8"));
    const ga = parseGa4Csv(readFileSync(GA4, "utf8"));
    const q = [
      ...parseGscQueries(readFileSync(QUERIES, "utf8")),
      ...parseGscPages(readFileSync(PAGES, "utf8")),
      ...parseGscChart(readFileSync(CHART, "utf8")),
    ];
    const intel = buildIntel({
      campaigns: [...g, ...m],
      queries: q,
      ga,
      range: 7,
      filter: "all",
    });
    assert.equal(intel.as_of, "2026-08-24");
    assert.ok(intel.cards.length <= 12);
    assert.ok(intel.cards.length >= 1);
    for (let i = 1; i < intel.cards.length; i++) {
      assert.ok(intel.cards[i - 1].stake >= intel.cards[i].stake);
    }
    const copy = intel.cards.map((c) => `${c.doThis} ${c.body}`).join("\n").toLowerCase();
    assert.match(copy, /brand search/);
    assert.doesNotMatch(copy, /move .* onto brand search/);
    assert.ok(intel.wins.every((w) => w.spend >= 1));
    assert.ok(intel.losses.every((w) => w.spend >= 1));
    assert.match(intel.grok.markdown, /keep \/ kill/i);
    assert.ok(intel.grok.snapshot.campaigns.length <= 24);
    assert.ok(intel.kpis.google.spend > 0);
    assert.ok(intel.kpis.meta.spend > 0);
    const brand = intel.cards.find((c) => c.id === "brand-split");
    assert.ok(brand, "Brand Search is a hold — card must fire when brand ROAS is high");
    assert.match(brand!.doThis, /do not raise Brand Search/i);
    assert.ok(intel.wow.last.spend > 0);
  });

  test("win/lose hides $0 Meta; GA4 revenue is not ads conv value", () => {
    const g = parseGoogleCsv(readFileSync(GOOGLE, "utf8"));
    const m = parseMetaCsv(readFileSync(META, "utf8"));
    const ga = parseGa4Csv(readFileSync(GA4, "utf8"));
    const intel = buildIntel({ campaigns: [...g, ...m], queries: [], ga, range: 7, filter: "all" });
    assert.ok(!intel.losses.some((r) => r.spend === 0));
    const pmax = intel.campaigns.find((c) => /PMAX/i.test(c.campaign_name));
    assert.ok(pmax);
    const ga4Paid = intel.ga4.paid_revenue;
    assert.notEqual(pmax!.conv_value, ga4Paid);
  });
});
