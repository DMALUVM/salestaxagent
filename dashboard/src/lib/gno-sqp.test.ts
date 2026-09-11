import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  findSqpHeaderRowIndex,
  isAmazonSqpPreamble,
  parseSelectWeekPreamble,
  parseSqpCsv,
} from "./gno-sqp";

test("SQP parser uses rank when present", () => {
  const csv = "Search Query,ASIN,Organic Rank\ntallow lip balm,B0CLHVCPL5,2\n";
  const r = parseSqpCsv(csv, "", "2026-09-01");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].organic_rank, 2);
  assert.equal(r.rows[0].keyword_normalized, "tallow lip balm");
});

test("SQP parser derives a band from click share and never invents a share", () => {
  const csv = "Search Query,Click Share\nchapstick,55%\nunknown,\n";
  const r = parseSqpCsv(csv);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].organic_rank, 1);
  assert.equal(r.skipped, 1);
  assert.equal(r.rows[0].impression_share_organic, 0.55);
});

test("empty / no-query file does not fake numbers", () => {
  const r = parseSqpCsv("Impressions,Purchases\n10,2\n");
  assert.equal(r.rows.length, 0);
  assert.equal(r.weekly.length, 0);
  assert.ok(r.warnings[0]?.includes("no search-query"));
});

const BRAND_ANALYTICS_CSV = [
  'Brand=["Tallowbourn"],Reporting Range=["Weekly"],Select week=["Week 35 | 2026-08-23 - 2026-08-29 2026"]',
  [
    "Search Query",
    "Search Query Score",
    "Search Query Volume",
    "Impressions: Total Count",
    "Impressions: Brand Count",
    "Impressions: Brand Share %",
    "Clicks: Total Count",
    "Clicks: Brand Count",
    "Clicks: Brand Share %",
    "Cart Adds: Total Count",
    "Cart Adds: Brand Count",
    "Cart Adds: Brand Share %",
    "Purchases: Total Count",
    "Purchases: Brand Count",
    "Purchases: Brand Share %",
    "Reporting Date",
  ].join(","),
  [
    "tallowbourn lip balm",
    "90",
    "1200",
    "10000",
    "4000",
    "40.0%",
    "500",
    "250",
    "50%",
    "80",
    "40",
    "50%",
    "40",
    "20",
    "50%",
    "2026-08-29",
  ].join(","),
  [
    "beef tallow balm",
    "40",
    "800",
    "5000",
    "500",
    "10%",
    "200",
    "20",
    "10%",
    "30",
    "3",
    "10%",
    "20",
    "2",
    "10%",
    "2026-08-29",
  ].join(","),
  [
    "mystery query",
    "10",
    "100",
    "1000",
    "",
    "",
    "50",
    "",
    "",
    "5",
    "",
    "",
    "2",
    "",
    "",
    "2026-08-29",
  ].join(","),
].join("\n");

test("preamble helpers detect Brand Analytics metadata and Select week", () => {
  const pre = BRAND_ANALYTICS_CSV.split("\n")[0];
  assert.equal(isAmazonSqpPreamble(pre), true);
  const w = parseSelectWeekPreamble(pre);
  assert.equal(w.weekStart, "2026-08-23");
  assert.equal(w.weekEnd, "2026-08-29");
  const lines = BRAND_ANALYTICS_CSV.split("\n");
  assert.equal(findSqpHeaderRowIndex(lines), 1);
});

test("Brand Analytics preamble CSV: week parse + Brand Share % + no invented shares", () => {
  const r = parseSqpCsv(BRAND_ANALYTICS_CSV);
  assert.equal(r.weekStart, "2026-08-23");
  assert.equal(r.weekEnd, "2026-08-29");

  // Rank rows: only where click share was reported (not invented for mystery).
  assert.equal(r.rows.length, 2);
  const byRank = Object.fromEntries(r.rows.map((x) => [x.keyword_normalized, x]));
  assert.equal(byRank["tallowbourn lip balm"].organic_rank, 1); // 50% click share
  assert.equal(byRank["tallowbourn lip balm"].impression_share_organic, 0.5);
  assert.equal(byRank["beef tallow balm"].organic_rank, 99); // 10%
  assert.equal(byRank["beef tallow balm"].impression_share_organic, 0.1);
  assert.ok(!byRank["mystery query"]);

  // sqp_weekly: all three queries, brand view (empty asin), reported shares only.
  assert.equal(r.weekly.length, 3);
  const byW = Object.fromEntries(r.weekly.map((x) => [x.query_normalized, x]));
  assert.equal(byW["tallowbourn lip balm"].asin, "");
  assert.equal(byW["tallowbourn lip balm"].source, "sqp_brand_csv");
  assert.equal(byW["tallowbourn lip balm"].week_start, "2026-08-23");
  assert.equal(byW["tallowbourn lip balm"].week_end, "2026-08-29");
  assert.equal(byW["tallowbourn lip balm"].click_share, 0.5);
  assert.equal(byW["tallowbourn lip balm"].impression_share, 0.4);
  assert.equal(byW["tallowbourn lip balm"].purchase_share, 0.5);
  assert.equal(byW["tallowbourn lip balm"].total_impressions, 10000);
  assert.equal(byW["tallowbourn lip balm"].asin_impressions, 4000);
  assert.equal(byW["tallowbourn lip balm"].total_clicks, 500);
  assert.equal(byW["tallowbourn lip balm"].asin_clicks, 250);
  assert.equal(byW["tallowbourn lip balm"].search_query_volume, 1200);
  assert.equal(byW["tallowbourn lip balm"].is_branded, true);

  assert.equal(byW["mystery query"].click_share, null);
  assert.equal(byW["mystery query"].impression_share, null);
  assert.equal(byW["mystery query"].purchase_share, null);
  assert.equal(byW["mystery query"].total_impressions, 1000);
  assert.equal(byW["mystery query"].asin_impressions, null);
});

test("Reporting Date alone derives week_start = week_end − 6 when preamble missing", () => {
  const csv = [
    "Search Query,Clicks: Brand Share %,Reporting Date",
    "chapstick,55%,2026-08-29",
  ].join("\n");
  const r = parseSqpCsv(csv);
  assert.equal(r.weekEnd, "2026-08-29");
  assert.equal(r.weekStart, "2026-08-23");
  assert.equal(r.weekly[0].week_start, "2026-08-23");
  assert.equal(r.weekly[0].week_end, "2026-08-29");
});

test("GNO + SQP status copy: SP-API weekly auto, CSV fallback — not Ads API / not manual-only", () => {
  const root = process.cwd();
  const gno = readFileSync(path.join(root, "src/components/ppc-gno-watch.tsx"), "utf8");
  const status = readFileSync(path.join(root, "src/components/sqp-status.tsx"), "utf8");
  const route = readFileSync(path.join(root, "src/app/api/ppc/gno/route.ts"), "utf8");

  for (const src of [gno, status, route]) {
    assert.match(src, /not in the Ads API/i);
    assert.match(src, /SP-API/);
    assert.match(src, /CSV/);
    assert.match(src, /fallback/);
    assert.doesNotMatch(src, /manual upload/);
    assert.doesNotMatch(src, /Drop the official SQP CSV/);
    assert.doesNotMatch(src, /stays a manual CSV upload/);
  }

  assert.match(gno, /GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT/);
  assert.match(gno, /complete Sun–Sat weeks only/);
  assert.match(gno, /Newest stored week/);
  assert.match(gno, /rankTrackerCopy/);
  assert.match(gno, /Impression \/ purchase share is never invented/);
  assert.match(gno, /CSV fallback/);

  assert.match(status, /GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT/);
  assert.match(status, /SoldScope Rank Tracker/);

  assert.match(route, /Shares are never invented/);
});
