import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildPnlPeriods,
  coverageLabel,
  filterLookback,
  inclusiveDays,
  monthEnd,
  periodBounds,
  periodKey,
  periodLabel,
  summarizePeriods,
  weekStartSunday,
  type PnlRow,
} from "./pnl-periods";

function row(date: string, contrib: number, extra: Partial<PnlRow> = {}): PnlRow {
  return {
    date,
    gross_sales: extra.gross_sales ?? contrib + 20,
    units: extra.units ?? 10,
    ad_spend: extra.ad_spend ?? 5,
    est_referral_fees: extra.est_referral_fees ?? 8,
    est_fba_fees: extra.est_fba_fees ?? 4,
    est_cogs: extra.est_cogs ?? 3,
    est_contribution: contrib,
    amazon_net_proceeds: null,
    net_after_ads: contrib,
    status: "preliminary",
    fees_basis: extra.fees_basis ?? "estimated",
    ads_basis: extra.ads_basis,
    source: extra.source,
    period_end: extra.period_end,
    closed_days: extra.closed_days,
    reimbursements: extra.reimbursements,
  };
}

describe("Amazon week / month bounds", () => {
  test("weeks start Sunday, not ISO Monday", () => {
    // 2026-08-24 is a Monday.
    assert.equal(weekStartSunday("2026-08-24"), "2026-08-23");
    assert.equal(weekStartSunday("2026-08-23"), "2026-08-23");
    assert.equal(weekStartSunday("2026-08-29"), "2026-08-23");
  });

  test("DST spring-forward does not shift the Sunday", () => {
    // US springs forward 2026-03-08. Midday UTC stays on the intended date.
    assert.equal(weekStartSunday("2026-03-11"), "2026-03-08");
    assert.equal(periodBounds("2026-03-11", "week").end, "2026-03-14");
  });

  test("monthEnd handles February", () => {
    assert.equal(monthEnd("2026-02-10"), "2026-02-28");
    assert.equal(monthEnd("2028-02-10"), "2028-02-29");
    assert.equal(monthEnd("2026-08-24"), "2026-08-31");
  });

  test("periodKey is stable for every day in the period", () => {
    // 2026-08-24 is Monday, so the week is Sun 23 – Sat 29.
    assert.equal(periodKey("2026-08-23", "week"), periodKey("2026-08-29", "week"));
    assert.equal(periodKey("2026-08-01", "month"), periodKey("2026-08-31", "month"));
    assert.equal(periodKey("2026-01-01", "year"), periodKey("2026-12-31", "year"));
  });

  test("week label is Sunday–Saturday", () => {
    assert.equal(periodLabel("2026-08-17", "2026-08-23", "week"), "Aug 17–23, 2026");
    assert.match(periodLabel("2026-12-28", "2027-01-03", "week"), /Dec 28, 2026/);
    assert.equal(periodLabel("2026-08-01", "2026-08-31", "month"), "August 2026");
  });
});

describe("lookback and inclusive days", () => {
  test("30d lookback is inclusive of as-of and drops older rows", () => {
    // windowStart(asOf, 30) is asOf minus 29 days = 2026-07-25.
    const rows = [row("2026-08-23", 1), row("2026-07-25", 2), row("2026-07-24", 3)];
    const kept = filterLookback(rows, "2026-08-23", 30).map((r) => r.date);
    assert.deepEqual(kept, ["2026-08-23", "2026-07-25"]);
    assert.equal(inclusiveDays("2026-07-25", "2026-08-23"), 30);
  });

  test("all lookback keeps every stored day", () => {
    const rows = [row("2026-08-23", 1), row("2025-07-10", 2)];
    assert.equal(filterLookback(rows, "2026-08-23", "all").length, 2);
  });
});

describe("buildPnlPeriods", () => {
  test("week sums stored contribution and averages by days with a row", () => {
    // Sun 16, Mon 17, Tue 18. Missing the rest of the week on purpose.
    const rows = [
      row("2026-08-18", 100, { gross_sales: 300, units: 20 }),
      row("2026-08-17", 200, { gross_sales: 400, units: 30 }),
      row("2026-08-16", 50, { gross_sales: 100, units: 10 }),
    ];
    const periods = buildPnlPeriods({ rows, grain: "week", lookback: "all", asOf: "2026-08-23" });
    assert.equal(periods.length, 1);
    const w = periods[0];
    assert.equal(w.key, "2026-08-16");
    assert.equal(w.contribution, 350);
    assert.equal(w.sales, 800);
    assert.equal(w.units, 60);
    assert.equal(w.days, 3);
    assert.equal(w.calendarDays, 7);
    assert.equal(w.avgDaily, 116.67);
    assert.equal(w.partial, true);
    assert.equal(coverageLabel(w), "partial · 3 of 7d");
  });

  test("does not invent $0 days for gaps", () => {
    const rows = [row("2026-08-16", 10), row("2026-08-22", 20)];
    const [w] = buildPnlPeriods({ rows, grain: "week", lookback: "all", asOf: "2026-08-23" });
    assert.equal(w.days, 2);
    assert.equal(w.contribution, 30);
    assert.equal(w.avgDaily, 15);
  });

  test("a day after as-of never enters a week / month / year average", () => {
    const rows = [
      row("2026-08-20", 999), // after as-of — preliminary
      row("2026-08-19", 100),
      row("2026-08-18", 50),
    ];
    const weeks = buildPnlPeriods({ rows, grain: "week", lookback: "all", asOf: "2026-08-19" });
    // All three dates sit in Sun 16 – Sat 22; only the two closed days count.
    assert.equal(weeks.length, 1);
    assert.equal(weeks[0].key, "2026-08-16");
    assert.equal(weeks[0].contribution, 150);
    assert.equal(weeks[0].avgDaily, 75);
    assert.deepEqual(weeks[0].openRows.map((r) => r.date), ["2026-08-20"]);

    const days = buildPnlPeriods({ rows, grain: "day", lookback: "all", asOf: "2026-08-19" });
    assert.equal(days[0].open, true);
    assert.equal(days[0].start, "2026-08-20");
    assert.equal(days[0].contribution, 999);
    assert.equal(days[0].avgDaily, null);
    const summary = summarizePeriods(days);
    assert.equal(summary.contribution, 150);
    assert.equal(summary.days, 2);
    assert.equal(summary.avgDaily, 75);
  });

  test("month and year group across the stored span", () => {
    const rows = [
      row("2026-08-02", 10),
      row("2026-07-20", 30),
      row("2025-12-31", 40),
    ];
    const months = buildPnlPeriods({ rows, grain: "month", lookback: "all", asOf: "2026-08-23" });
    assert.deepEqual(months.map((p) => p.key), ["2026-08", "2026-07", "2025-12"]);
    assert.equal(months[0].avgDaily, 10);
    assert.equal(months[1].avgDaily, 30);

    const years = buildPnlPeriods({ rows, grain: "year", lookback: "all", asOf: "2026-08-23" });
    assert.equal(years.length, 2);
    assert.equal(years[0].key, "2026");
    assert.equal(years[0].contribution, 40);
    assert.equal(years[0].avgDaily, 20);
    assert.equal(years[1].key, "2025");
    assert.equal(years[1].avgDaily, 40);
  });

  test("lookback 30 drops a week that sits entirely outside the window", () => {
    const rows = [
      row("2026-08-23", 10),
      row("2026-07-01", 999),
    ];
    const weeks = buildPnlPeriods({ rows, grain: "week", lookback: 30, asOf: "2026-08-23" });
    assert.equal(weeks.length, 1);
    assert.equal(weeks[0].contribution, 10);
  });

  test("empty input stays empty", () => {
    assert.deepEqual(buildPnlPeriods({ rows: [], grain: "week", lookback: "all", asOf: "2026-08-23" }), []);
    assert.equal(summarizePeriods([]).avgDaily, null);
  });

  test("averages use stored net_after_ads, not a re-derived formula", () => {
    // sales/fees/ads/cogs deliberately do not add up to contribution.
    const rows = [row("2026-08-20", 77, {
      gross_sales: 1, ad_spend: 1, est_referral_fees: 1, est_fba_fees: 1, est_cogs: 1,
    })];
    const [d] = buildPnlPeriods({ rows, grain: "day", lookback: "all", asOf: "2026-08-23" });
    assert.equal(d.contribution, 77);
    assert.equal(d.avgDaily, 77);
  });

  test("mixed fee bases roll up as mixed", () => {
    const rows = [
      row("2026-08-20", 10, { fees_basis: "settled" }),
      row("2026-08-21", 10, { fees_basis: "estimated" }),
    ];
    const [w] = buildPnlPeriods({ rows, grain: "week", lookback: "all", asOf: "2026-08-23" });
    assert.equal(w.feesBasis, "mixed");
  });

  test("month/year prefer SKU monthly rows and average by calendar days", () => {
    const monthly: PnlRow[] = [
      row("2026-08-01", 2300, { source: "sku_monthly", ads_basis: "known", gross_sales: 60000 }),
      row("2026-07-01", 3100, { source: "sku_monthly", ads_basis: "known" }),
      row("2025-12-01", 4000, { source: "sku_monthly", ads_basis: "unknown" }),
    ];
    const months = buildPnlPeriods({
      rows: [row("2026-08-20", 1)],
      monthly,
      grain: "month",
      lookback: "all",
      asOf: "2026-08-23",
    });
    assert.deepEqual(months.map((p) => p.key), ["2026-08", "2026-07", "2025-12"]);
    assert.equal(months[0].source, "sku_monthly");
    assert.equal(months[0].days, 23); // MTD through as-of
    assert.equal(months[0].calendarDays, 31);
    assert.equal(months[0].avgDaily, 100);
    assert.equal(months[0].partial, true);
    assert.equal(coverageLabel(months[0]), "partial · 23 of 31d");
    assert.equal(months[1].days, 31);
    assert.equal(months[1].partial, false);
    assert.equal(months[1].avgDaily, 100);

    const years = buildPnlPeriods({
      rows: [],
      monthly,
      grain: "year",
      lookback: "all",
      asOf: "2026-08-23",
    });
    assert.equal(years.length, 2);
    assert.equal(years[0].key, "2026");
    assert.equal(years[0].contribution, 5400);
    assert.equal(years[0].days, 23 + 31);
    assert.equal(years[0].source, "sku_monthly");
    assert.equal(years[1].contribution, 4000);
    assert.equal(years[1].days, 31);
    assert.equal(years[1].partial, true); // 2025 only has December in this fixture
  });

  test("30d lookback on monthly keeps a month that only overlaps the window", () => {
    const monthly = [
      row("2026-08-01", 10, { source: "sku_monthly" }),
      row("2026-07-01", 20, { source: "sku_monthly" }),
      row("2026-06-01", 999, { source: "sku_monthly" }),
    ];
    const months = buildPnlPeriods({
      rows: [],
      monthly,
      grain: "month",
      lookback: 30,
      asOf: "2026-08-23",
    });
    assert.deepEqual(months.map((p) => p.key), ["2026-08", "2026-07"]);
  });

  test("daily-overlaid closed July uses 31 calendar days and daily contribution", () => {
    const monthly = [
      row("2026-07-01", 21757.74, {
        source: "daily",
        ads_basis: "known",
        gross_sales: 103140.12,
        units: 7405,
        closed_days: 31,
      }),
      row("2026-08-01", 20000, {
        source: "daily",
        ads_basis: "known",
        gross_sales: 94807.47,
        closed_days: 30,
      }),
    ];
    const months = buildPnlPeriods({
      rows: [],
      monthly,
      grain: "month",
      lookback: "all",
      asOf: "2026-08-31",
    });
    const jul = months.find((p) => p.key === "2026-07");
    const aug = months.find((p) => p.key === "2026-08");
    assert.ok(jul);
    assert.equal(jul.sales, 103140.12);
    assert.equal(jul.contribution, 21757.74);
    assert.equal(jul.source, "daily");
    assert.equal(jul.days, 31);
    assert.equal(jul.calendarDays, 31);
    assert.equal(jul.partial, false);
    assert.equal(jul.avgDaily, 701.86);
    assert.equal(jul.reimbursements, 0);
    assert.equal(aug?.source, "daily");
    assert.equal(aug?.sales, 94807.47);

    const [year] = buildPnlPeriods({
      rows: [],
      monthly,
      grain: "year",
      lookback: "all",
      asOf: "2026-08-31",
    });
    assert.equal(year.key, "2026");
    assert.equal(year.sales, 197947.59);
    assert.equal(year.contribution, 41757.74);
  });

  test("reimbursements sit beside contribution and never enter it or avg/day", () => {
    const rows = [
      row("2026-07-02", 200, { reimbursements: 100 }),
      row("2026-07-28", 150, { reimbursements: -3373.53 }),
    ];
    const days = buildPnlPeriods({ rows, grain: "day", lookback: "all", asOf: "2026-07-31" });
    assert.equal(days[0].contribution, 150);
    assert.equal(days[0].reimbursements, -3373.53);
    assert.equal(days[0].avgDaily, 150);
    assert.equal(days[1].contribution, 200);
    assert.equal(days[1].reimbursements, 100);
    assert.equal(days[1].avgDaily, 200);

    const summary = summarizePeriods(days);
    assert.equal(summary.contribution, 350);
    assert.equal(summary.reimbursements, -3273.53);
    assert.equal(summary.avgDaily, 175);

    const monthly = [
      row("2026-07-01", 21757.74, {
        source: "daily",
        reimbursements: -3273.53,
        ads_basis: "known",
        gross_sales: 103140.12,
        closed_days: 31,
      }),
    ];
    const [jul] = buildPnlPeriods({
      rows,
      monthly,
      grain: "month",
      lookback: "all",
      asOf: "2026-07-31",
    });
    assert.equal(jul.contribution, 21757.74);
    assert.equal(jul.sales, 103140.12);
    assert.equal(jul.source, "daily");
    assert.equal(jul.reimbursements, -3273.53);
    assert.equal(jul.avgDaily, Math.round((21757.74 / 31) * 100) / 100);
  });

  test("daily-overlaid current month uses real closed days in the label", () => {
    const monthly = [
      row("2026-08-01", 20000, {
        source: "daily",
        ads_basis: "known",
        gross_sales: 94863.43,
        closed_days: 30,
      }),
    ];
    const [aug] = buildPnlPeriods({
      rows: [],
      monthly,
      grain: "month",
      lookback: "all",
      asOf: "2026-08-30",
    });
    assert.equal(aug.sales, 94863.43);
    assert.equal(aug.source, "daily");
    assert.equal(aug.days, 30);
    assert.equal(aug.calendarDays, 31);
    assert.equal(aug.partial, true);
    assert.equal(coverageLabel(aug), "partial · 30 of 31d");
  });
});

describe("table no longer hides history behind a 35-day slice", () => {
  test("profit page and API read every stored account day", () => {
    const page = readFileSync(path.join(process.cwd(), "src/app/profit/page.tsx"), "utf8");
    const api = readFileSync(path.join(process.cwd(), "src/app/api/pnl/route.ts"), "utf8");
    assert.doesNotMatch(page, /slice\(0,\s*35\)/, "the table used to drop everything past day 35");
    assert.match(page, /PnlTable|buildPnlPeriods/);
    assert.doesNotMatch(api, /\.limit\(400\)/, "400-row cap would hide a year of account days");
    assert.match(api, /\.range\(/);
    assert.match(api, /dailyAccount/);
    assert.match(api, /grain", "sku"/);
    assert.match(api, /salesDaily/);
    assert.match(api, /sales_daily/);
    assert.match(api, /fba_reimbursements/);
    assert.match(api, /attachMonthReimbursements|attachDayReimbursements/);
    assert.match(api, /gross_sales - referral - fba - ad_spend - cogs/);
    assert.ok(
      api.indexOf("await loadMonthly") < api.indexOf("attachMonthReimbursements(monthly.months"),
      "reimbursements attach after the daily overlay, not inside it",
    );
    const table = readFileSync(path.join(process.cwd(), "src/components/pnl-table.tsx"), "utf8");
    assert.match(table, />Reimburse</);
    assert.doesNotMatch(
      table,
      /contribution \+ .*reimburse|reimburse.*\+ .*contribution/i,
    );
  });
});
