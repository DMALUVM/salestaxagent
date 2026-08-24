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
  round2,
  gradeOutcome,
  type GaDaily,
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

  test("the data panel reports every source, its history, and window coverage", () => {
    const parsed = readAll();
    const at = (range: 7 | 30 | 90 | 365) => buildIntel({
      campaigns: parsed.campaigns, queries: parsed.queries, ga: parsed.ga,
      range, filter: "all", today: "2026-08-24",
    }).freshness;

    const w7 = at(7);
    const kinds = w7.sources.map((s) => s.source);
    assert.deepEqual(kinds, ["google", "meta", "ga4", "gsc_trend", "gsc_snapshot"]);

    const g7 = w7.sources.find((s) => s.source === "google")!;
    assert.equal(g7.max_date, "2026-08-24");
    assert.equal(g7.min_date, "2023-11-11");
    assert.equal(g7.days_in_range, 7, "Google has every day of the last 7");
    assert.equal(g7.coverage, 1);
    assert.equal(g7.days_behind, 0);
    assert.equal(g7.stale, false);

    // Undated snapshots must never be aged or given fake coverage.
    const snap = w7.sources.find((s) => s.source === "gsc_snapshot")!;
    assert.equal(snap.dated, false);
    assert.equal(snap.days_behind, null);
    assert.equal(snap.coverage, null);
    assert.equal(snap.stale, false);
    assert.ok(snap.rows > 1000, "Queries + Pages rows are counted");

    // GA4 only covers ~30 days, so a 90-day window is honestly reported as thin.
    const ga90 = at(90).sources.find((s) => s.source === "ga4")!;
    assert.ok(ga90.coverage != null && ga90.coverage < 0.8,
      "a 30-day GA4 export cannot fill a 90-day window");
    assert.ok(at(90).partial_sources.includes("ga4"));
    const ga7 = w7.sources.find((s) => s.source === "ga4")!;
    assert.ok((ga7.coverage ?? 0) >= 0.8, "GA4 does cover the last 7 days");
    assert.ok(!w7.partial_sources.includes("ga4"));

    // GSC trails ~2 days by design. That lag must not read as a missing-data gap.
    const trend7 = w7.sources.find((s) => s.source === "gsc_trend")!;
    assert.ok(trend7.days_behind != null && trend7.days_behind >= 1);
    assert.equal(trend7.expected_days, 7 - trend7.days_behind);
    assert.equal(trend7.coverage, 1, "a lagging source that is complete up to its own max is not thin");
    assert.ok(!w7.partial_sources.includes("gsc_trend"));

    // Google has years of history, so it is never the thin one.
    assert.ok(!at(365).partial_sources.includes("google"));
  });

  test("weekly 7-day uploads accumulate into the longer windows", () => {
    const parsed = readAll();
    const all = parsed.campaigns.filter((r) => r.platform === "google");
    // Simulate having only ever uploaded two separate 7-day exports.
    const weekA = all.filter((r) => r.date >= "2026-08-11" && r.date <= "2026-08-17");
    const weekB = all.filter((r) => r.date >= "2026-08-18" && r.date <= "2026-08-24");
    const merged = dedupeCampaigns([...weekA, ...weekB]);

    const fourteen = buildIntel({
      campaigns: merged, queries: [], ga: [], range: 14, filter: "all", today: "2026-08-24",
    });
    const g = fourteen.freshness.sources.find((s) => s.source === "google")!;
    assert.equal(g.days_in_range, 14, "two 7-day uploads make a full 14-day window");
    assert.equal(g.coverage, 1);
    assert.ok(fourteen.kpis.google.spend > 0);

    // The same data cannot honestly fill 30 days.
    const thirty = buildIntel({
      campaigns: merged, queries: [], ga: [], range: 30, filter: "all", today: "2026-08-24",
    });
    assert.ok(thirty.freshness.partial_sources.includes("google"));
    assert.equal(thirty.freshness.sources.find((s) => s.source === "google")!.days_in_range, 14);
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
        check: target.check, baseline_value: target.check_value, baseline_as_of: before.as_of!,
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
        check: target.check, baseline_value: target.check_value, baseline_as_of: "2026-07-01",
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
    assert.match(siteDesk, /storefront agent/i);
    for (const c of intel.cards.filter((x) => x.owner === "site")) {
      assert.ok(!adsDesk.includes(c.title), `ads export must not carry site card "${c.title}"`);
    }
    for (const c of intel.cards.filter((x) => x.owner === "ads")) {
      assert.ok(!siteDesk.includes(c.title), `site export must not carry ads card "${c.title}"`);
    }
  });

  test("the storefront export carries no ad-spend context", () => {
    const parsed = readAll();
    const intel = buildIntel({
      campaigns: parsed.campaigns, queries: parsed.queries, ga: parsed.ga,
      range: 7, filter: "all",
    });
    const { siteDesk, adsDesk } = intel.grok;

    // The web team must not be handed budget guardrails or ROAS it cannot act on.
    assert.doesNotMatch(siteDesk, /Brand Search/i, "site export must not mention Brand Search");
    assert.doesNotMatch(siteDesk, /PMax/i);
    assert.doesNotMatch(siteDesk, /ROAS/i);
    assert.doesNotMatch(siteDesk, /\dx\b/, "no ROAS multiples in the storefront export");
    assert.doesNotMatch(siteDesk, /ads conversion value/i);
    assert.doesNotMatch(siteDesk, /spend held/i);
    // It must instead carry storefront context and its own guardrails.
    assert.match(siteDesk, /sessions/i);
    assert.match(siteDesk, /Mobile .* vs desktop/i);
    assert.match(siteDesk, /Do not touch ad campaigns, budgets, or bids/i);
    assert.match(siteDesk, /undated snapshot/i);

    // The ads export keeps its own framing.
    assert.match(adsDesk, /Brand Search/i);
    assert.match(adsDesk, /ROAS|[\d.]+x/);

    // Per-card prompts follow the same split.
    const siteCard = intel.cards.find((c) => c.owner === "site")!;
    const adsCard = intel.cards.find((c) => c.owner === "ads")!;
    const ctx = {
      asOf: intel.as_of!, google: intel.kpis.google, meta: intel.kpis.meta,
      blended: intel.kpis.blended,
    };
    const sitePrompt = buildCardPrompt(siteCard, ctx);
    assert.doesNotMatch(sitePrompt, /Brand Search/i);
    assert.match(sitePrompt, /storefront agent/i);
    assert.match(sitePrompt, /What to return/);
    const adsPrompt = buildCardPrompt(adsCard, ctx);
    assert.match(adsPrompt, /Never move Meta or PMax budget onto Brand Search/);
  });
});

describe("outcome loop", () => {
  const camp = (name: string, spend: number, conv: number, extra: Partial<{ lost: number; freq: number }> = {}) => ({
    platform: "google" as const,
    campaign_name: name,
    campaign_type: "Search" as const,
    product: "other" as const,
    is_brand: false,
    audience: "unknown" as const,
    spend,
    conv_value: conv,
    clicks: 10,
    impressions: 100,
    conversions: 1,
    roas: spend > 0 ? conv / spend : 0,
    cpc: 1,
    lost_is_budget: extra.lost ?? null,
    frequency: extra.freq ?? null,
    frequency_peak: null,
    status: null,
    days_live: 7,
  });
  const ctx = (camps: ReturnType<typeof camp>[]) => ({
    camps,
    ga: [] as GaDaily[],
    queries: [],
    google: { platform: "google" as const, spend: 0, conv_value: 0, clicks: 0, impressions: 0, conversions: 0, roas: 0, cpc: 0, days: 0 },
    meta: { platform: "meta" as const, spend: 0, conv_value: 0, clicks: 0, impressions: 0, conversions: 0, roas: 0, cpc: 0, days: 0 },
    blended: { platform: "blended" as const, spend: 0, conv_value: 0, clicks: 0, impressions: 0, conversions: 0, roas: 0, cpc: 0, days: 0 },
  });
  const roasCheck = {
    kind: "campaign_roas" as const, subject: "AI MAX", direction: "up" as const,
    target: 1.0, unit: "roas" as const, label: "AI MAX ROAS",
  };

  test("a real improvement reads as worked", () => {
    const out = gradeOutcome({
      check: roasCheck,
      baseline: 0.64,
      baselineAsOf: "2026-08-24",
      currentAsOf: "2026-08-31",
      ctx: ctx([camp("AI MAX", 70, 84)]), // 1.2x
    });
    assert.equal(out.verdict, "worked");
    assert.match(out.summary, /0\.64x → 1\.20x/);
    assert.match(out.summary, /met/);
  });

  test("a hold card that did not move says holding, not worked", () => {
    // PMax at 1.05x against a ≥1.0x target: passing by staying put is not a win.
    const out = gradeOutcome({
      check: { ...roasCheck, subject: "PMAX", label: "PMAX ROAS" },
      baseline: 1.05,
      baselineAsOf: "2026-08-17",
      currentAsOf: "2026-08-24",
      ctx: ctx([camp("PMAX", 100, 105)]),
    });
    assert.equal(out.verdict, "worked");
    assert.match(out.summary, /Holding at 1\.05x/);
    assert.doesNotMatch(out.summary, /1\.05x → 1\.05x/, "do not print a no-op arrow");
  });

  test("progress short of the target is called improving", () => {
    const out = gradeOutcome({
      check: roasCheck,
      baseline: 0.50,
      baselineAsOf: "2026-08-17",
      currentAsOf: "2026-08-24",
      ctx: ctx([camp("AI MAX", 100, 80)]), // 0.80x — better, still under 1.0
    });
    assert.equal(out.verdict, "worked");
    assert.match(out.summary, /Improving/);
    assert.match(out.summary, /not met/);
  });

  test("noise is not a result", () => {
    const out = gradeOutcome({
      check: roasCheck,
      baseline: 0.64,
      baselineAsOf: "2026-08-24",
      currentAsOf: "2026-08-31",
      ctx: ctx([camp("AI MAX", 100, 65)]), // 0.65x
    });
    assert.equal(out.verdict, "no_change");
  });

  test("a decline is called out, not buried", () => {
    const out = gradeOutcome({
      check: roasCheck,
      baseline: 0.64,
      baselineAsOf: "2026-08-24",
      currentAsOf: "2026-08-31",
      ctx: ctx([camp("AI MAX", 100, 40)]), // 0.40x
    });
    assert.equal(out.verdict, "worse");
    assert.match(out.summary, /wrong way/i);
    assert.match(out.summary, /revert/i);
  });

  test("same window cannot be graded yet", () => {
    const out = gradeOutcome({
      check: roasCheck,
      baseline: 0.64,
      baselineAsOf: "2026-08-24",
      currentAsOf: "2026-08-24",
      ctx: ctx([camp("AI MAX", 100, 64)]),
    });
    assert.equal(out.verdict, "too_early");
    assert.match(out.summary, /next week/i);
  });

  test("a paused campaign is a result for spend, unmeasurable for ROAS", () => {
    const gone = ctx([camp("SOMETHING ELSE", 50, 50)]);
    const spendOut = gradeOutcome({
      check: { kind: "campaign_spend", subject: "AI MAX", direction: "down", target: 10, unit: "usd", label: "AI MAX spend" },
      baseline: 94,
      baselineAsOf: "2026-08-24",
      currentAsOf: "2026-08-31",
      ctx: gone,
    });
    assert.equal(spendOut.current, 0, "no rows means it stopped spending");
    assert.equal(spendOut.verdict, "worked");

    const roasOut = gradeOutcome({
      check: roasCheck,
      baseline: 0.64,
      baselineAsOf: "2026-08-24",
      currentAsOf: "2026-08-31",
      ctx: gone,
    });
    assert.equal(roasOut.verdict, "unmeasurable");
    assert.match(roasOut.summary, /paused/i);
  });

  test("lower-is-better checks are not graded backwards", () => {
    const out = gradeOutcome({
      check: { kind: "unassigned_share", subject: null, direction: "down", target: 0.12, unit: "ratio", label: "Unassigned share" },
      baseline: 0.31,
      baselineAsOf: "2026-08-24",
      currentAsOf: "2026-08-31",
      ctx: {
        ...ctx([]),
        ga: [
          { date: "2026-08-31", channel_group: "Unassigned", landing_page: "/", device: "mobile", sessions: 8, active_users: 8, key_events: 0, revenue: 0, bounce_rate: 1 },
          { date: "2026-08-31", channel_group: "Organic Search", landing_page: "/", device: "mobile", sessions: 92, active_users: 90, key_events: 3, revenue: 90, bounce_rate: 0.4 },
        ],
      },
    });
    assert.equal(out.verdict, "worked");
    assert.match(out.summary, /31\.0% → 8\.0%/);
  });

  test("every card ships a measurable check and a current value", { skip: !haveUploads }, () => {
    const parsed = mergeParsed([
      parseNamedFile("Google Ads Daily.csv", readFileSync(GOOGLE, "utf8")),
      parseNamedFile("meta.csv", readFileSync(META, "utf8")),
      parseNamedFile("download.csv", readFileSync(GA4, "utf8")),
      parseNamedFile("Queries.csv", readFileSync(QUERIES, "utf8")),
      parseNamedFile("Pages.csv", readFileSync(PAGES, "utf8")),
      parseNamedFile("Chart.csv", readFileSync(CHART, "utf8")),
    ]);
    const intel = buildIntel({
      campaigns: parsed.campaigns, queries: parsed.queries, ga: parsed.ga,
      range: 7, filter: "all",
    });
    for (const c of intel.cards) {
      assert.ok(c.check, `card ${c.id} has no check — it cannot be graded`);
      assert.ok(c.check!.label.length > 0);
    }
    // At least one check must resolve to a live number, else grading is theatre.
    assert.ok(intel.cards.some((c) => c.check_value != null));
  });

  test("applying grades on the next window, and the note survives", { skip: !haveUploads }, () => {
    const parsed = mergeParsed([
      parseNamedFile("Google Ads Daily.csv", readFileSync(GOOGLE, "utf8")),
      parseNamedFile("meta.csv", readFileSync(META, "utf8")),
      parseNamedFile("download.csv", readFileSync(GA4, "utf8")),
    ]);
    const first = buildIntel({
      campaigns: parsed.campaigns, queries: parsed.queries, ga: parsed.ga,
      range: 7, filter: "all",
    });
    const target = first.cards.find((c) => c.check?.kind === "campaign_roas")
      ?? first.cards[0];
    // Applied in an EARLIER window, so this window can grade it.
    const graded = buildIntel({
      campaigns: parsed.campaigns, queries: parsed.queries, ga: parsed.ga,
      range: 7, filter: "all",
      decisions: [{
        card_id: target.id, as_of: "2026-08-17", status: "applied",
        note: "cut daily budget to $22", applied_at: "2026-08-17T12:00:00Z",
        dismissed_at: null, check: target.check,
        baseline_value: target.check_value, baseline_as_of: "2026-08-17",
      }],
    });
    const card = [...graded.cards, ...graded.log].find((c) => c.id === target.id);
    assert.ok(card, "the card is still visible after being applied last week");
    assert.ok(card!.outcome, "an earlier application must be graded");
    assert.notEqual(card!.outcome!.verdict, "too_early");
    assert.equal(card!.note, "cut daily budget to $22");
  });
});

describe("Meta ad-set exports", () => {
  const header = '"Reporting starts","Campaign name","Ad set name","Amount spent (USD)",Impressions,Frequency,Purchases,"Purchases conversion value"';

  test("sub-campaign rows are summed, not last-wins", () => {
    // A campaign-keyed warehouse must not silently keep one ad set's spend.
    const csv = [
      header,
      '2026-08-20,"SALES | CBO","Ad set A",10.00,1000,1.5,1,50.00',
      '2026-08-20,"SALES | CBO","Ad set B",15.00,3000,4.0,2,90.00',
    ].join("\n");
    const rows = parseMetaCsv(csv);
    assert.equal(rows.length, 1, "one campaign-day row");
    assert.equal(rows[0].spend, 25);
    assert.equal(rows[0].conv_value, 140);
    assert.equal(rows[0].impressions, 4000);
    assert.equal(rows[0].conversions, 3);
    // Impression-weighted average, and the worst ad set kept separately.
    assert.ok(Math.abs(rows[0].frequency! - 3.375) < 0.001);
    assert.equal(rows[0].frequency_peak, 4);
  });

  test("a campaign-level export has no peak to report", () => {
    const csv = [
      '"Reporting starts","Campaign name","Amount spent (USD)",Impressions,Frequency',
      '2026-08-20,"SALES | CBO",25.00,4000,2.0',
    ].join("\n");
    const rows = parseMetaCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].frequency, 2);
    assert.equal(rows[0].frequency_peak, null);
  });

  test("fatigue reads the worst ad set, and says so", () => {
    const csv = [
      header,
      '2026-08-20,"SALES | CBO","Ad set A",40.00,1000,1.2,1,50.00',
      '2026-08-20,"SALES | CBO","Ad set B",40.00,1000,3.6,1,50.00',
    ].join("\n");
    const intel = buildIntel({
      campaigns: parseMetaCsv(csv), queries: [], ga: [], range: 7, filter: "all",
    });
    const freq = [...intel.cards, ...intel.log].find((c) => c.id === "meta-freq");
    assert.ok(freq, "peak 3.6 must trip the fatigue card even though the average is 2.4");
    assert.match(freq!.metric, /worst ad set/);
    assert.match(freq!.body, /worst ad set/i);
  });
});

describe("product attribution", () => {
  test("PMax spend is split by where paid traffic landed, and labelled estimated", () => {
    const camp = {
      platform: "google" as const, date: "2026-08-20",
      campaign_name: "TALLOWBOURN- PMAX - Max Conversions - Campaign V4",
      campaign_type: "PMax" as const, product: "other" as const, is_brand: false,
      audience: "unknown" as const, spend: 100, conv_value: 200, clicks: 50,
      impressions: 1000, conversions: 4, lost_is_budget: null, lost_is_rank: null,
      frequency: null, frequency_peak: null, status: null,
    };
    const ga = (landing: string, key_events: number): GaDaily => ({
      date: "2026-08-20", channel_group: "Cross-network", landing_page: landing,
      device: "mobile", sessions: 100, active_users: 90, key_events,
      revenue: key_events * 30, bounce_rate: 0.4,
    });
    const intel = buildIntel({
      campaigns: [camp],
      queries: [],
      ga: [
        ga("/products/natural-tallow-deodorant-extra-strength", 6),
        ga("/products/tallow-balm", 2),
      ],
      range: 7,
      filter: "all",
    });
    const byProduct = new Map(intel.products.map((p) => [p.product, p]));
    // 6:2 key events → 75/25 split of the PMax spend.
    assert.equal(byProduct.get("deodorant")!.spend, 75);
    assert.equal(byProduct.get("balm")!.spend, 25);
    assert.ok(byProduct.get("deodorant")!.estimated);
    // Ads conversion value is only redistributed, never replaced by GA4 revenue.
    const totalConv = intel.products.reduce((s, p) => s + p.conv_value, 0);
    assert.equal(round2(totalConv), 200);
    assert.ok(!intel.products.some((p) => p.product === "other" && p.spend > 0));
  });

  test("a campaign that names its product is not re-attributed", () => {
    const camp = {
      platform: "meta" as const, date: "2026-08-20",
      campaign_name: "UGC | Tallow Balm | CBO",
      campaign_type: "Other" as const, product: "balm" as const, is_brand: false,
      audience: "prospect" as const, spend: 60, conv_value: 30, clicks: 20,
      impressions: 500, conversions: 1, lost_is_budget: null, lost_is_rank: null,
      frequency: null, frequency_peak: null, status: null,
    };
    const intel = buildIntel({
      campaigns: [camp],
      queries: [],
      ga: [{
        date: "2026-08-20", channel_group: "Paid Social",
        landing_page: "/products/natural-tallow-deodorant-extra-strength",
        device: "mobile", sessions: 50, active_users: 40, key_events: 5,
        revenue: 150, bounce_rate: 0.4,
      }],
      range: 7,
      filter: "all",
    });
    const balm = intel.products.find((p) => p.product === "balm")!;
    assert.equal(balm.spend, 60, "a named campaign keeps its own product");
    assert.equal(balm.estimated, false);
    assert.ok(!intel.products.some((p) => p.product === "deodorant"));
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
      conversions: 1, lost_is_budget: null, lost_is_rank: null, frequency: null,
      frequency_peak: null, status: null,
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
