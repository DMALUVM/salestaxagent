import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ATTRIBUTION_FIELD,
  aggregateTerms,
  closedLookbackWindow,
  filterClosedWindow,
  resolveZeroOrderLever,
  scoreSearchTermActions,
  siblingExactConverters,
  termsEqual,
  warehouseFreshness,
  type SearchTermRow,
} from "./ppc-actions-generate";

const AS_OF = "2026-09-14";
const CAMP = "Orange Lip Balm - SP - Tallow Chapstick - KWs - Exact";
const AG = "Ad Group - 9/7/2026 12:19:32.657";
const TERM = "tallow chapstick";

function row(partial: Partial<SearchTermRow> = {}): SearchTermRow {
  return {
    date: "2026-09-10",
    search_term: TERM,
    campaign_id: "camp-orange",
    campaign_name: CAMP,
    ad_group_id: "ag-1",
    ad_group_name: AG,
    keyword: TERM,
    match_type: "EXACT",
    spend: 0,
    sales_14d: 0,
    orders_14d: 0,
    clicks: 0,
    ...partial,
  };
}

function daveStaleRows(): SearchTermRow[] {
  const days: Array<[string, number, number]> = [
    ["2026-09-08", 8, 12.16],
    ["2026-09-09", 6, 9.00],
    ["2026-09-10", 7, 11.00],
    ["2026-09-11", 5, 8.00],
    ["2026-09-12", 5, 8.00],
    ["2026-09-13", 4, 8.00],
  ];
  return days.map(([date, clicks, spend]) => row({ date, clicks, spend }));
}

describe("closed-day window math", () => {
  test("seven closed days end on as-of, not today", () => {
    const w = closedLookbackWindow(AS_OF, 7);
    assert.equal(w.start, "2026-09-08");
    assert.equal(w.end, "2026-09-14");
    assert.equal(w.days, 7);
    assert.equal(w.timezone, "America/Los_Angeles");
    assert.equal(w.closed_days_only, true);
    assert.equal(w.attribution, ATTRIBUTION_FIELD);
  });

  test("open today and pre-window days are dropped from the rollup", () => {
    const rows = [
      row({ date: "2026-09-07", clicks: 99, spend: 99 }),
      row({ date: "2026-09-08", clicks: 1, spend: 1 }),
      row({ date: "2026-09-14", clicks: 1, spend: 1 }),
      row({ date: "2026-09-15", clicks: 50, spend: 50 }),
    ];
    const w = closedLookbackWindow(AS_OF, 7);
    const kept = filterClosedWindow(rows, w.start, w.end);
    assert.deepEqual(kept.map((r) => r.date), ["2026-09-08", "2026-09-14"]);
    const agg = aggregateTerms(kept);
    const e = [...agg.values()][0];
    assert.equal(e.clicks, 2);
    assert.equal(e.spend, 2);
  });

  test("daily bleed is summed before the $5 threshold", () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      row({
        date: `2026-09-${String(8 + i).padStart(2, "0")}`,
        clicks: 2,
        spend: 0.8,
        keyword: "other term",
        match_type: "BROAD",
        search_term: "cheap chapstick",
      }));
    const recs = scoreSearchTermActions({
      rows, targetAcos: 30, lookbackDays: 7, asOf: AS_OF, stFreshThrough: AS_OF,
    });
    const waste = recs.filter((r) => r.type === "NEGATE_SEARCH_TERM");
    assert.equal(waste.length, 1);
    assert.equal(waste[0].evidence.spend, 5.6);
    assert.equal(waste[0].evidence.clicks, 14);
    assert.equal(waste[0].evidence.orders, 0);
    const win = waste[0].evidence.window as { start: string; end: string };
    assert.equal(win.start, "2026-09-08");
    assert.equal(win.end, "2026-09-14");
    assert.doesNotMatch(String(waste[0].evidence.why), /last 7 days/);
    assert.match(String(waste[0].evidence.why), /2026-09-08 → 2026-09-14/);
    assert.match(String(waste[0].evidence.why), /orders_14d/);
  });
});

describe("pause vs negate", () => {
  test("Exact KW equals the search term → pause, not negate", () => {
    const recs = scoreSearchTermActions({
      rows: [...daveStaleRows(), row({ date: "2026-09-14", clicks: 1, spend: 1 })],
      targetAcos: 30, lookbackDays: 7, asOf: AS_OF, stFreshThrough: AS_OF,
    });
    const waste = recs.filter((r) =>
      r.type === "PAUSE_KEYWORD" || r.type === "NEGATE_SEARCH_TERM" || r.type === "REVIEW_SEARCH_TERM");
    assert.equal(waste.length, 1);
    assert.equal(waste[0].type, "PAUSE_KEYWORD");
    assert.equal(waste[0].evidence.action_type, "pause_keyword");
    assert.equal(waste[0].priority, "P0");
    assert.match(waste[0].suggested_action, /pause/i);
    assert.match(waste[0].suggested_action, /Do not add a Negative exact/);
    assert.equal(waste[0].entity_name, TERM);
    assert.match(String(waste[0].evidence.why), /Orange Lip Balm/);
    assert.match(String(waste[0].evidence.why), /Ad Group - 9\/7\/2026/);
  });

  test("a Broad query still negates", () => {
    const recs = scoreSearchTermActions({
      rows: [row({
        clicks: 20, spend: 20, keyword: "tallow", match_type: "BROAD",
        search_term: "tallow chapstick cheap",
      })],
      targetAcos: 30, lookbackDays: 7, asOf: AS_OF, stFreshThrough: AS_OF,
    });
    const waste = recs.filter((r) => r.type === "NEGATE_SEARCH_TERM");
    assert.equal(waste.length, 1);
    assert.equal(waste[0].evidence.action_type, "negate_exact");
    assert.match(waste[0].suggested_action, /Negative exact/);
    assert.doesNotMatch(waste[0].suggested_action, /pause/i);
  });

  test("in-window orders_14d suppress pause and negate", () => {
    const recs = scoreSearchTermActions({
      rows: [...daveStaleRows(), row({
        date: "2026-09-14", clicks: 2, spend: 3, orders_14d: 1, sales_14d: 14,
      })],
      targetAcos: 30, lookbackDays: 7, asOf: AS_OF, stFreshThrough: AS_OF,
    });
    const types = new Set(recs.map((r) => r.type));
    assert.equal(types.has("PAUSE_KEYWORD"), false);
    assert.equal(types.has("NEGATE_SEARCH_TERM"), false);
    assert.equal(types.has("REVIEW_SEARCH_TERM"), false);
  });

  test("lever helper matches bleeders Exact KW = term", () => {
    assert.equal(resolveZeroOrderLever(TERM, TERM, ["exact"]), "pause_keyword");
    assert.equal(resolveZeroOrderLever("Tallow  Chapstick", TERM, ["EXACT"]), "pause_keyword");
    assert.equal(resolveZeroOrderLever("tallow", TERM, ["broad"]), "negate_exact");
    assert.equal(termsEqual(" Tallow   Chapstick ", "tallow chapstick"), true);
  });
});

describe("stale warehouse and sibling Exact converters", () => {
  test("Dave's stale 0-order card cannot ship as P0 negate", () => {
    const recs = scoreSearchTermActions({
      rows: daveStaleRows(),
      targetAcos: 30, lookbackDays: 7, asOf: AS_OF, stFreshThrough: "2026-09-13",
    });
    const review = recs.filter((r) => r.type === "REVIEW_SEARCH_TERM");
    assert.equal(review.length, 1);
    assert.equal(review[0].priority, "P2");
    assert.equal(review[0].evidence.verified, false);
    assert.equal(review[0].evidence.stale, true);
    assert.equal(review[0].evidence.intended_lever, "pause_keyword");
    assert.match(String(review[0].evidence.why), /UNVERIFIED/);
    assert.match(String(review[0].evidence.why), /2026-09-08 → 2026-09-14/);
    assert.match(review[0].suggested_action, /Do not/);
    assert.equal(review[0].evidence.spend, 56.16);
    assert.equal(review[0].evidence.clicks, 35);
    assert.equal(recs.some((r) => r.type === "NEGATE_SEARCH_TERM" && r.priority === "P0"), false);
    assert.equal(recs.some((r) => r.type === "PAUSE_KEYWORD"), false);
  });

  test("warehouse freshness flags ST lag vs closed as-of", () => {
    const stale = warehouseFreshness(daveStaleRows(), AS_OF);
    assert.equal(stale.st_fresh_through, "2026-09-13");
    assert.equal(stale.st_stale, true);
    const caught = warehouseFreshness([...daveStaleRows(), row({ date: AS_OF })], AS_OF);
    assert.equal(caught.st_stale, false);
  });

  test("sibling Exact converters downgrade and flag campaign scope", () => {
    const recs = scoreSearchTermActions({
      rows: [
        ...daveStaleRows(),
        row({ date: "2026-09-14", clicks: 1, spend: 1 }),
        row({
          date: "2026-09-10", campaign_id: "camp-peppermint",
          campaign_name: "Peppermint Lip Balm - SP - Tallow Chapstick - KWs - Exact",
          clicks: 10, spend: 12, orders_14d: 2, sales_14d: 28,
        }),
        row({
          date: "2026-09-11", campaign_id: "camp-assorted",
          campaign_name: "Assorted - SP - Tallow Chapstick - KWs - Exact",
          clicks: 8, spend: 9, orders_14d: 1, sales_14d: 14,
        }),
      ],
      targetAcos: 30, lookbackDays: 7, asOf: AS_OF, stFreshThrough: AS_OF,
    });
    const pause = recs.filter((r) => r.type === "PAUSE_KEYWORD");
    assert.equal(pause.length, 1);
    assert.equal(pause[0].priority, "P1");
    assert.equal(pause[0].evidence.converts_elsewhere, true);
    const siblings = pause[0].evidence.sibling_campaigns as string[];
    assert.ok(siblings.some((s) => s.includes("Peppermint")));
    assert.ok(siblings.some((s) => s.includes("Assorted")));
    assert.match(String(pause[0].evidence.why), /Converts elsewhere/);
    assert.match(String(pause[0].evidence.why), /campaign-scoped only/);
  });

  test("sibling helper ignores same campaign and non-Exact converters", () => {
    const agg = aggregateTerms([
      row({ clicks: 10, spend: 10, orders_14d: 0 }),
      row({
        campaign_id: "camp-broad", campaign_name: "Broad tallow",
        match_type: "BROAD", keyword: "tallow",
        clicks: 5, spend: 5, orders_14d: 3, sales_14d: 40,
      }),
    ]);
    assert.deepEqual(siblingExactConverters(agg, TERM, "camp-orange"), []);
  });
});

describe("generate path stays on the shared scorer", () => {
  test("dashboard generate no longer hardcodes last-N-days negate copy", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/ppc/route.ts"), "utf8");
    assert.match(route, /scoreSearchTermActions/);
    assert.match(route, /\.lte\("date", asOf\)/);
    assert.doesNotMatch(route, /over the last " \+ rangeDays \+ " days/);
    assert.doesNotMatch(route, /type: "NEGATE_SEARCH_TERM", priority: "P0"/);
  });

  test("python engine no longer uses date.today\(\) as the window", () => {
    const py = readFileSync(
      path.join(process.cwd(), "..", "src", "amazon_ads", "actions_engine.py"),
      "utf8",
    );
    assert.match(py, /amazon_as_of/);
    assert.match(py, /score_search_term_actions/);
    assert.doesNotMatch(py, /date\.today\(\) - timedelta/);
    assert.doesNotMatch(py, /over the last \{lookback_days\} days/);
  });
});
