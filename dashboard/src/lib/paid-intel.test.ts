import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "path";

import {
  buildIntel,
  buildCardPrompt,
  dedupeCampaigns,
  detectKind,
  parseGa4Csv,
  parseGoogleCsv,
  parseGscChart,
  parseGscPages,
  parseGscQueries,
  parseMetaCsv,
  parseNamedFile,
  mergeParsed,
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

describe("multi-file upload, receipts, freshness, and decisions", { skip: !haveUploads }, () => {
  function readAll() {
    return mergeParsed([
      parseNamedFile("Google Ads Daily.csv", readFileSync(GOOGLE, "utf8")),
      parseNamedFile("meta-campaigns.csv", readFileSync(META, "utf8")),
      parseNamedFile("download.csv", readFileSync(GA4, "utf8")),
      parseNamedFile("Queries.csv", readFileSync(QUERIES, "utf8")),
      parseNamedFile("Pages.csv", readFileSync(PAGES, "utf8")),
      parseNamedFile("Chart.csv", readFileSync(CHART, "utf8")),
    ]);
  }

  test("all six files in one upload are each recognised with a receipt", () => {
    const parsed = readAll();
    assert.equal(parsed.skipped.length, 0, `nothing should be skipped: ${parsed.warnings.join("; ")}`);
    assert.equal(parsed.accepted.length, 6, "one receipt line per file");
    const kinds = parsed.accepted.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["ga4", "google", "gsc_chart", "gsc_pages", "gsc_queries", "meta"]);
    for (const a of parsed.accepted) assert.ok(a.rows > 0, `${a.name} parsed 0 rows`);
    const google = parsed.accepted.find((a) => a.kind === "google")!;
    assert.equal(google.max_date, "2026-08-24");
    // Queries/Pages are undated snapshots — the receipt must not invent a date.
    const q = parsed.accepted.find((a) => a.kind === "gsc_queries")!;
    assert.equal(q.min_date, null);
    assert.equal(q.max_date, null);
  });

  test("an unrecognised file is reported, not silently dropped", () => {
    const parsed = mergeParsed([
      parseNamedFile("random.csv", "foo,bar\n1,2"),
      parseNamedFile("Chart.csv", readFileSync(CHART, "utf8")),
    ]);
    assert.deepEqual(parsed.skipped, ["random.csv"]);
    assert.equal(parsed.accepted.length, 1);
    assert.match(parsed.warnings.join(" "), /random\.csv/);
  });

  test("freshness counts days behind the real calendar, not the file as-of", () => {
    const parsed = readAll();
    const fresh = buildIntel({
      campaigns: parsed.campaigns, queries: parsed.queries, ga: parsed.ga,
      range: 7, filter: "all", today: "2026-08-25",
    });
    assert.equal(fresh.freshness.days_behind, 1);
    assert.equal(fresh.freshness.stale, false);

    const stale = buildIntel({
      campaigns: parsed.campaigns, queries: parsed.queries, ga: parsed.ga,
      range: 7, filter: "all", today: "2026-09-02",
    });
    assert.equal(stale.freshness.days_behind, 9);
    assert.equal(stale.freshness.stale, true, "9 days behind must nag for a fresh upload");
    // Windows still key off the file as-of, not today.
    assert.equal(stale.as_of, "2026-08-24");
    assert.ok(stale.kpis.google.spend > 0);
  });

  test("applying a card moves it out of the open stack into the log", () => {
    const parsed = readAll();
    const before = buildIntel({
      campaigns: parsed.campaigns, queries: parsed.queries, ga: parsed.ga,
      range: 7, filter: "all",
    });
    const target = before.cards[0];
    assert.ok(target);
    const after = buildIntel({
      campaigns: parsed.campaigns, queries: parsed.queries, ga: parsed.ga,
      range: 7, filter: "all",
      decisions: [{
        card_id: target.id, as_of: before.as_of!, status: "applied",
        note: null, applied_at: "2026-08-25T00:00:00Z", dismissed_at: null,
      }],
    });
    assert.ok(!after.cards.some((c) => c.id === target.id), "applied card leaves the open stack");
    const logged = after.log.find((c) => c.id === target.id);
    assert.ok(logged, "applied card is kept as a log entry");
    assert.equal(logged!.status, "applied");
    // A decision for a different week must not hide this week's card.
    const otherWeek = buildIntel({
      campaigns: parsed.campaigns, queries: parsed.queries, ga: parsed.ga,
      range: 7, filter: "all",
      decisions: [{
        card_id: target.id, as_of: "2026-07-01", status: "applied",
        note: null, applied_at: "2026-07-01T00:00:00Z", dismissed_at: null,
      }],
    });
    assert.ok(otherWeek.cards.some((c) => c.id === target.id));
  });

  test("each desk exports on its own", () => {
    const parsed = readAll();
    const intel = buildIntel({
      campaigns: parsed.campaigns, queries: parsed.queries, ga: parsed.ga,
      range: 7, filter: "all",
    });
    const { adsDesk, siteDesk } = intel.grok;
    assert.match(adsDesk, /paid-media agent/i);
    assert.match(siteDesk, /site\/conversion agent/i);
    assert.doesNotMatch(adsDesk, /site & conversion/i);
    for (const c of intel.cards.filter((x) => x.owner === "site")) {
      assert.ok(!adsDesk.includes(c.title), `ads export must not carry site card "${c.title}"`);
    }
    for (const c of intel.cards.filter((x) => x.owner === "ads")) {
      assert.ok(!siteDesk.includes(c.title), `site export must not carry ads card "${c.title}"`);
    }
    const card = intel.cards[0];
    const prompt = buildCardPrompt(card, {
      asOf: intel.as_of!, google: intel.kpis.google, meta: intel.kpis.meta, blended: intel.kpis.blended,
    });
    assert.match(prompt, /Never move Meta or PMax budget onto Brand Search/);
    assert.match(prompt, /What to return/);
  });
});

describe("upsert key: a 7-day upload only touches its own days", () => {
  const key = (r: { platform: string; date: string; campaign_name: string }) =>
    `${r.platform}|${r.date}|${r.campaign_name}`;

  test("re-uploading 7 days replaces only matching platform|date|campaign keys", () => {
    const older = {
      platform: "google" as const, date: "2026-07-01", campaign_name: "BRANDED - Search - Campaign V1",
      campaign_type: "Search" as const, product: "other" as const, is_brand: true,
      audience: "unknown" as const, spend: 10, conv_value: 30, clicks: 5, impressions: 50,
      conversions: 1, lost_is_budget: null, lost_is_rank: null, frequency: null, status: null,
    };
    const staleToday = { ...older, date: "2026-08-24", spend: 999, conv_value: 0 };
    const freshToday = { ...older, date: "2026-08-24", spend: 8.85, conv_value: 47.9 };

    // One upload containing the same key twice: last wins, older day untouched.
    const merged = dedupeCampaigns([older, staleToday, freshToday]);
    assert.equal(merged.length, 2, "two distinct keys survive");
    const byKey = new Map(merged.map((r) => [key(r), r]));
    assert.equal(byKey.get("google|2026-07-01|BRANDED - Search - Campaign V1")!.spend, 10);
    assert.equal(byKey.get("google|2026-08-24|BRANDED - Search - Campaign V1")!.spend, 8.85);
  });

  test("a campaign present on an older day is not deleted by a newer upload", () => {
    const week1 = { platform: "meta" as const, date: "2026-08-01", campaign_name: "RETARGETING | CBO | Campaign V3" };
    const week2 = { platform: "meta" as const, date: "2026-08-20", campaign_name: "RETARGETING | CBO | Campaign V3" };
    assert.notEqual(key(week1), key(week2), "different dates are different rows, so neither overwrites the other");
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
    assert.ok(intel.cards.length <= 12, "max 12 open recommendations");
    assert.ok(intel.cards.length >= 1);
    assert.ok(intel.cards.every((c) => c.status === "open"));
    assert.ok(intel.cards.every((c) => c.prompt.includes(c.doThis)),
      "every card carries a self-contained copy prompt");
    const ads = intel.cards.filter((c) => c.owner === "ads");
    const site = intel.cards.filter((c) => c.owner === "site");
    assert.ok(ads.length >= 1, "ads desk must have keep/kill work");
    assert.ok(site.length >= 1, "site desk must have conversion work");
    for (let i = 1; i < ads.length; i++) {
      assert.ok(ads[i - 1].stake >= ads[i].stake);
    }
    for (let i = 1; i < site.length; i++) {
      assert.ok(site[i - 1].stake >= site[i].stake);
    }
    const copy = intel.cards.map((c) => `${c.doThis} ${c.body}`).join("\n").toLowerCase();
    assert.match(copy, /brand search/);
    assert.doesNotMatch(copy, /move .* onto brand search/);
    assert.ok(intel.wins.every((w) => w.spend >= 1));
    assert.ok(intel.losses.every((w) => w.spend >= 1));
    assert.match(intel.grok.markdown, /keep \/ kill/i);
    assert.match(intel.grok.markdown, /paid media/i);
    assert.match(intel.grok.markdown, /site & conversion/i);
    assert.ok(intel.grok.snapshot.campaigns.length <= 24);
    assert.ok(intel.kpis.google.spend > 0);
    assert.ok(intel.kpis.meta.spend > 0);
    const brand = intel.cards.find((c) => c.id === "brand-split");
    assert.ok(brand, "Brand Search is a hold — card must fire when brand ROAS is high");
    assert.match(brand!.doThis, /do not raise Brand Search/i);
    assert.ok(intel.wow.last.spend > 0);
    assert.match(intel.brief.headline, /2026-08-24/);
    assert.ok(ads.some((c) => c.id === "lost-is-trap" || c.id === "worst-google" || c.id === "mix-cut"));
    assert.ok(site.some((c) => c.id === "bounce-sink" || c.id === "gsc-title-trap" || c.id === "unassigned"));
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
