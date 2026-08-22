import test from "node:test";
import assert from "node:assert/strict";
import { buildLast30Series, SERIES_DAYS, type SalesDailyRow } from "./overview-series";
import { amazonAsOf, shiftDays } from "./as-of";

/**
 * Regression guard for the Overview "Last 30 Days" chart series.
 *
 * The chart has broken twice in the same ways: a day rendering as an
 * abnormally short bar, and days going missing or doubling at the edges. These
 * assertions pin the properties that were wrong, so an edit that re-breaks the
 * series fails here instead of on the dashboard.
 *
 * Run: npm test   (from dashboard/)
 */

// 14:30 PDT on 2026-08-20 — afternoon in Amazon TZ, so as-of is 2026-08-19.
const NOW = new Date("2026-08-20T21:30:00.000Z");
const YESTERDAY = amazonAsOf(NOW);
const THIRTY_AGO = shiftDays(YESTERDAY, -(SERIES_DAYS - 1));

function rowsFor(dates: string[], amazon = 3000, shopify = 300): SalesDailyRow[] {
  return dates.flatMap((d) => [
    { sale_date: d, channel: "amazon", gross_sales: amazon },
    { sale_date: d, channel: "shopify", gross_sales: shopify },
  ]);
}

function allDates(now: Date, days = SERIES_DAYS): string[] {
  const asOf = amazonAsOf(now);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(shiftDays(asOf, -i));
  }
  return out;
}

test("series is exactly 30 points", () => {
  const s = buildLast30Series(rowsFor(allDates(NOW)), NOW);
  assert.equal(s.length, 30);
});

test("series ends yesterday and never includes today", () => {
  const s = buildLast30Series(rowsFor(allDates(NOW)), NOW);
  assert.equal(s[s.length - 1].date, YESTERDAY);
  assert.equal(s[0].date, THIRTY_AGO);
  assert.ok(!s.some((p) => p.date === "2026-08-20"), "today must be excluded");
});

test("dates are unique", () => {
  const s = buildLast30Series(rowsFor(allDates(NOW)), NOW);
  assert.equal(new Set(s.map((p) => p.date)).size, s.length);
});

test("dates are contiguous, one calendar day apart", () => {
  const s = buildLast30Series(rowsFor(allDates(NOW)), NOW);
  for (let i = 1; i < s.length; i++) {
    const prev = new Date(`${s[i - 1].date}T12:00:00Z`).getTime();
    const cur = new Date(`${s[i].date}T12:00:00Z`).getTime();
    assert.equal(cur - prev, 86_400_000, `gap between ${s[i - 1].date} and ${s[i].date}`);
  }
});

test("tooltip payload fields are present on every point", () => {
  const s = buildLast30Series(rowsFor(allDates(NOW)), NOW);
  for (const p of s) {
    assert.equal(typeof p.date, "string");
    assert.equal(typeof p.shopify, "number");
    assert.equal(typeof p.amazon, "number");
    assert.equal(typeof p.total, "number");
    assert.equal(typeof p.hasData, "boolean");
    assert.ok(Number.isFinite(p.shopify) && Number.isFinite(p.amazon));
    assert.equal(p.total, p.shopify + p.amazon);
  }
});

test("channels are bucketed to the right series", () => {
  const s = buildLast30Series(rowsFor([YESTERDAY], 1234, 567), NOW);
  const last = s[s.length - 1];
  assert.equal(last.amazon, 1234);
  assert.equal(last.shopify, 567);
  assert.equal(last.total, 1801);
});

test("multiple rows for one day and channel are summed, not overwritten", () => {
  const rows: SalesDailyRow[] = [
    { sale_date: YESTERDAY, channel: "amazon", gross_sales: 1000 },
    { sale_date: YESTERDAY, channel: "amazon", gross_sales: 500 },
    { sale_date: YESTERDAY, channel: "shopify", gross_sales: 100 },
  ];
  const last = buildLast30Series(rows, NOW).at(-1)!;
  assert.equal(last.amazon, 1500);
  assert.equal(last.shopify, 100);
});

test("a missing day is flagged hasData:false, not silently zeroed", () => {
  // This is the short-bar failure mode: a day with no row must be
  // distinguishable from a real $0 day so the chart can draw a gap.
  const dates = allDates(NOW).filter((d) => d !== "2026-08-12");
  const s = buildLast30Series(rowsFor(dates), NOW);
  const hole = s.find((p) => p.date === "2026-08-12")!;
  assert.equal(hole.hasData, false);
  assert.equal(hole.total, 0);
  assert.ok(s.filter((p) => p.hasData).length === 29);
});

test("a genuine zero-sales day is hasData:true", () => {
  const dates = allDates(NOW);
  const rows = rowsFor(dates).map((r) =>
    r.sale_date === "2026-08-12" ? { ...r, gross_sales: 0 } : r);
  const zero = buildLast30Series(rows, NOW).find((p) => p.date === "2026-08-12")!;
  assert.equal(zero.hasData, true);
  assert.equal(zero.total, 0);
});

test("non Shopify/Amazon channels are ignored", () => {
  const rows: SalesDailyRow[] = [
    { sale_date: YESTERDAY, channel: "amazon", gross_sales: 100 },
    { sale_date: YESTERDAY, channel: "other", gross_sales: 999 },
  ];
  const last = buildLast30Series(rows, NOW).at(-1)!;
  assert.equal(last.total, 100);
});

test("empty input still yields 30 contiguous points", () => {
  const s = buildLast30Series([], NOW);
  assert.equal(s.length, 30);
  assert.ok(s.every((p) => p.hasData === false && p.total === 0));
  assert.equal(s[s.length - 1].date, YESTERDAY);
});

test("spans a month boundary without gaps or repeats", () => {
  const now = new Date("2026-09-02T16:00:00.000Z"); // 09:00 PDT
  const s = buildLast30Series([], now);
  assert.equal(s[s.length - 1].date, amazonAsOf(now));
  assert.equal(s[0].date, shiftDays(amazonAsOf(now), -(SERIES_DAYS - 1)));
  assert.equal(new Set(s.map((p) => p.date)).size, 30);
});

test("UTC evening still ends on LA yesterday, not UTC yesterday", () => {
  // 06:00 UTC on the 22nd is 23:00 PDT on the 21st — Amazon as-of is the 20th.
  const utcEvening = new Date("2026-08-22T06:00:00.000Z");
  const s = buildLast30Series([], utcEvening);
  assert.equal(amazonAsOf(utcEvening), "2026-08-20");
  assert.equal(s[s.length - 1].date, "2026-08-20");
  assert.ok(!s.some((p) => p.date === "2026-08-21"), "must not include LA's still-open today");
});

test("string gross_sales values are coerced, not concatenated", () => {
  const rows: SalesDailyRow[] = [
    { sale_date: YESTERDAY, channel: "amazon", gross_sales: "100.50" },
    { sale_date: YESTERDAY, channel: "amazon", gross_sales: "200.25" },
  ];
  assert.equal(buildLast30Series(rows, NOW).at(-1)!.amazon, 300.75);
});

test("completeness: a day is complete by default", () => {
    const rows = [{ sale_date: "2026-08-13", channel: "amazon", gross_sales: 100 }];
    const s = buildLast30Series(rows, new Date(2026, 7, 21));
    assert.equal(s.find((p) => p.date === "2026-08-13")?.isComplete, true);
  });

test("completeness: a partial row marks the whole day incomplete", () => {
    const rows = [
      { sale_date: "2026-08-13", channel: "amazon", gross_sales: 100, is_complete: false },
    ];
    const s = buildLast30Series(rows, new Date(2026, 7, 21));
    assert.equal(s.find((p) => p.date === "2026-08-13")?.isComplete, false);
  });

test("completeness: one partial channel makes the day incomplete", () => {
    const rows = [
      { sale_date: "2026-08-13", channel: "amazon", gross_sales: 3073, is_complete: true },
      { sale_date: "2026-08-13", channel: "shopify", gross_sales: 80, is_complete: false },
    ];
    const s = buildLast30Series(rows, new Date(2026, 7, 21));
    assert.equal(s.find((p) => p.date === "2026-08-13")?.isComplete, false);
  });

test("completeness: a missing day is absent, not incomplete", () => {
    const s = buildLast30Series([], new Date(2026, 7, 21));
    const p = s.find((x) => x.date === "2026-08-13");
    assert.equal(p?.hasData, false);
    assert.equal(p?.isComplete, true);
  });
