import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";

import { buildAmazonMonthlyPnl, dailyCoversMonth, isOpenMonth, mergeSalesDaily, monthOverlapsWindow, ADS_SKU_ECONOMICS_MIN_DATE, PNL_FBA_PER_UNIT, PNL_REFERRAL_PCT } from "./sku-monthly-pnl";

describe("SKU monthly contribution", () => {
  test("constants match business_rules.json", () => {
    const cfg = JSON.parse(
      readFileSync(path.join(process.cwd(), "..", "config", "business_rules.json"), "utf8"),
    );
    assert.equal(PNL_REFERRAL_PCT, cfg.pnl.default_referral_pct);
    assert.equal(PNL_FBA_PER_UNIT, cfg.pnl.default_fba_fee_per_unit);
    assert.equal(ADS_SKU_ECONOMICS_MIN_DATE, cfg.ads.sku_economics_min_date);
  });

  test("Amazon-only, Shopify dropped, formula matches Python fixture", () => {
    const result = buildAmazonMonthlyPnl({
      skuRows: [
        { channel: "amazon", sku: "AA", period_start: "2025-12-01", units: 10, gross_sales: 100 },
        { channel: "amazon", sku: "BB", period_start: "2025-12-01", units: 4, gross_sales: 40 },
        { channel: "shopify", sku: "AA", period_start: "2025-12-01", units: 99, gross_sales: 999 },
      ],
      costs: [{ sku: "AA", cogs_per_unit: 3 }, { sku: "BB", cogs_per_unit: 5 }],
      adsByDay: [],
    });
    assert.equal(result.months.length, 1);
    const m = result.months[0];
    assert.equal(m.gross_sales, 140);
    assert.equal(m.units, 14);
    assert.equal(m.est_referral_fees, 21);
    assert.equal(m.est_fba_fees, 49);
    assert.equal(m.est_cogs, 50);
    assert.equal(m.ad_spend, 0);
    assert.equal(m.net_after_ads, 20);
    assert.equal(m.ads_basis, "unknown");
    assert.equal(m.source, "sku_monthly");
    assert.equal(result.skusByMonth["2025-12"].length, 2);
  });

  test("ads subtract only when the month has campaign days", () => {
    const known = buildAmazonMonthlyPnl({
      skuRows: [{ channel: "amazon", sku: "AA", period_start: "2026-07-01", units: 10, gross_sales: 200 }],
      costs: [{ sku: "AA", cogs_per_unit: 2 }],
      adsByDay: [
        { date: "2026-07-01", spend: 10 },
        { date: "2026-07-02", spend: 15 },
      ],
    });
    assert.equal(known.months[0].ad_spend, 25);
    assert.equal(known.months[0].net_after_ads, 90);
    assert.equal(known.months[0].ads_basis, "known");

    const unknown = buildAmazonMonthlyPnl({
      skuRows: [{ channel: "amazon", sku: "AA", period_start: "2025-01-01", units: 1, gross_sales: 20 }],
      costs: [{ sku: "AA", cogs_per_unit: 1 }],
      adsByDay: [],
    });
    assert.equal(unknown.months[0].ads_basis, "unknown");
    assert.equal(unknown.months[0].ad_spend, 0);
  });

  test("imported monthly spend wins over partial API days", () => {
    const result = buildAmazonMonthlyPnl({
      skuRows: [{ channel: "amazon", sku: "AA", period_start: "2026-05-01", units: 10, gross_sales: 200 }],
      costs: [{ sku: "AA", cogs_per_unit: 2 }],
      adsByDay: [{ date: "2026-05-21", spend: 5450.96 }],
      adsByMonth: [{ period_start: "2026-05-01", spend: 18000 }],
    });
    assert.equal(result.months[0].ad_spend, 18000);
    assert.equal(result.months[0].ads_basis, "known");
  });

  test("missing cost uses average of priced SKUs", () => {
    const result = buildAmazonMonthlyPnl({
      skuRows: [
        { channel: "amazon", sku: "priced", period_start: "2024-08-01", units: 1, gross_sales: 10 },
        { channel: "amazon", sku: "new", period_start: "2024-08-01", units: 2, gross_sales: 20 },
      ],
      costs: [{ sku: "PRICED", cogs_per_unit: 4 }],
      adsByDay: [],
    });
    const neu = result.skusByMonth["2024-08"].find((s) => s.sku === "NEW");
    assert.equal(neu?.est_cogs, 8);
    assert.deepEqual(result.missingCostSkus, ["NEW"]);
  });

  test("state rows collapse; SKU case folds", () => {
    const result = buildAmazonMonthlyPnl({
      skuRows: [
        { channel: "amazon", sku: "aa", period_start: "2025-06-01", units: 3, gross_sales: 30 },
        { channel: "amazon", sku: "AA", period_start: "2025-06-01", units: 2, gross_sales: 20 },
      ],
      costs: [{ sku: "AA", cogs_per_unit: 1 }],
      adsByDay: [],
    });
    assert.equal(result.skusByMonth["2025-06"].length, 1);
    assert.equal(result.skusByMonth["2025-06"][0].units, 5);
  });

  test("month overlap includes a month that only touches the window", () => {
    assert.equal(monthOverlapsWindow({ date: "2026-07-01" }, "2026-07-25", "2026-08-23"), true);
    assert.equal(monthOverlapsWindow({ date: "2026-06-01" }, "2026-07-25", "2026-08-23"), false);
    assert.equal(monthOverlapsWindow({ date: "2024-08-01" }, "2024-01-01", "2026-08-23"), true);
  });

  test("stale sales_by_sku August yields to more complete daily Amazon totals", () => {
    const dailyAccount = [
      { date: "2026-08-01", gross_sales: 50000, units: 3000, est_cogs: 9000, channel: "amazon" },
      { date: "2026-08-15", gross_sales: 44863.43, units: 3475, est_cogs: 9464.39, channel: "amazon" },
    ];
    // Pad to a covered month (30 closed days through as-of). Extra $0 days
    // keep the coverage check honest without changing the total.
    for (let d = 2; d <= 31; d++) {
      if (d === 15) continue;
      dailyAccount.push({
        date: `2026-08-${String(d).padStart(2, "0")}`,
        gross_sales: 0, units: 0, est_cogs: 0, channel: "amazon",
      });
    }
    const result = buildAmazonMonthlyPnl({
      skuRows: [
        { channel: "amazon", sku: "AA", period_start: "2026-08-01", units: 4329, gross_sales: 62274.11 },
        { channel: "amazon", sku: "AA", period_start: "2024-08-01", units: 100, gross_sales: 12000 },
        { channel: "shopify", sku: "AA", period_start: "2026-08-01", units: 400, gross_sales: 10000 },
      ],
      costs: [{ sku: "AA", cogs_per_unit: 2.72 }],
      adsByDay: [{ date: "2026-08-01", spend: 400 }],
      dailyAccount: [
        ...dailyAccount,
        { date: "2026-08-10", gross_sales: 10000, units: 321, channel: "shopify" },
      ],
      dailySkus: [
        { date: "2026-08-01", sku: "AA", units: 3000, gross_sales: 50000 },
        { date: "2026-08-15", sku: "AA", units: 3475, gross_sales: 44863.43 },
        { date: "2026-08-01", sku: "__unallocated__", units: 0, gross_sales: 0 },
      ],
      asOf: "2026-08-30",
    });
    const aug = result.months.find((m) => m.date.startsWith("2026-08"));
    const hist = result.months.find((m) => m.date.startsWith("2024-08"));
    assert.ok(aug);
    assert.equal(aug.gross_sales, 94863.43);
    assert.equal(aug.units, 6475);
    assert.equal(aug.source, "daily");
    assert.equal(aug.sales_basis, "daily");
    assert.equal(aug.closed_days, 30);
    assert.equal(aug.ad_spend, 400);
    assert.equal(aug.est_referral_fees, 14229.51);
    assert.equal(aug.est_fba_fees, 22662.5);
    assert.equal(aug.est_cogs, 17612);
    // 94863.43 - 14229.51 - 22662.50 - 400 - 17612 = 39959.42
    assert.equal(aug.net_after_ads, 39959.42);
    assert.ok(hist);
    assert.equal(hist.gross_sales, 12000);
    assert.equal(hist.units, 100);
    assert.equal(hist.source, "sku_monthly");
    assert.equal(hist.sales_basis, "sales_by_sku");
    assert.equal(result.skusByMonth["2026-08"][0].units, 6475);
    assert.equal(result.skusByMonth["2024-08"][0].gross_sales, 12000);
  });

  test("2024 month with only sales_by_sku is unchanged when daily is empty", () => {
    const result = buildAmazonMonthlyPnl({
      skuRows: [
        { channel: "amazon", sku: "AA", period_start: "2024-08-01", units: 80, gross_sales: 9000 },
      ],
      costs: [{ sku: "AA", cogs_per_unit: 3 }],
      adsByDay: [],
      dailyAccount: [],
      asOf: "2026-08-30",
    });
    assert.equal(result.months.length, 1);
    assert.equal(result.months[0].date, "2024-08-01");
    assert.equal(result.months[0].gross_sales, 9000);
    assert.equal(result.months[0].units, 80);
    assert.equal(result.months[0].source, "sku_monthly");
    assert.equal(result.months[0].closed_days, undefined);
  });

  test("May incomplete pnl_daily stays on sales_by_sku even when daily is lower", () => {
    const result = buildAmazonMonthlyPnl({
      skuRows: [
        { channel: "amazon", sku: "AA", period_start: "2026-05-01", units: 8200, gross_sales: 124280 },
      ],
      costs: [{ sku: "AA", cogs_per_unit: 3 }],
      adsByDay: [],
      dailyAccount: amazonDays("2026-05", 4, 15304, 980),
      asOf: "2026-08-31",
    });
    assert.equal(result.months[0].gross_sales, 124280);
    assert.equal(result.months[0].source, "sku_monthly");
    assert.equal(result.months[0].sales_basis, "sales_by_sku");
  });

  test("daily coverage helper requires a complete closed month", () => {
    assert.equal(dailyCoversMonth(4, "2026-05", "2026-08-31"), false);
    assert.equal(dailyCoversMonth(31, "2026-07", "2026-08-31"), true);
    assert.equal(dailyCoversMonth(29, "2026-07", "2026-08-31"), false);
    assert.equal(dailyCoversMonth(30, "2026-08", "2026-08-30"), true);
    assert.equal(dailyCoversMonth(28, "2026-08", "2026-08-30"), true);
    assert.equal(dailyCoversMonth(27, "2026-08", "2026-08-30"), false);
    assert.equal(isOpenMonth("2026-08", "2026-08-30"), true);
    assert.equal(isOpenMonth("2026-07", "2026-08-30"), false);
  });

  test("Dana $92,324.84 sales_by_sku refresh still yields to daily Amazon", () => {
    const dailyAccount = amazonDays("2026-08", 30, 94807.47, 6466);
    const result = buildAmazonMonthlyPnl({
      skuRows: [
        { channel: "amazon", sku: "AA", period_start: "2026-08-01", units: 6400, gross_sales: 92324.84 },
        { channel: "amazon", sku: "AA", period_start: "2024-08-01", units: 80, gross_sales: 9000 },
        { channel: "shopify", sku: "AA", period_start: "2026-08-01", units: 444, gross_sales: 6144.39 },
      ],
      costs: [{ sku: "AA", cogs_per_unit: 2.85 }],
      adsByDay: [{ date: "2026-08-10", spend: 500 }],
      dailyAccount,
      salesDaily: [
        ...dailyAccount.map((d) => ({ sale_date: d.date, gross_sales: d.gross_sales, channel: "amazon" })),
        { sale_date: "2026-08-10", gross_sales: 10020.35, channel: "shopify" },
      ],
      dailySkus: dailyAccount.map((d) => ({ date: d.date, sku: "AA", units: d.units, gross_sales: d.gross_sales })),
      asOf: "2026-08-30",
    });
    const aug = result.months.find((m) => m.date.startsWith("2026-08"));
    const hist = result.months.find((m) => m.date.startsWith("2024-08"));
    assert.ok(aug);
    assert.equal(aug.gross_sales, 94807.47);
    assert.equal(aug.units, 6466);
    assert.equal(aug.source, "daily");
    assert.equal(aug.closed_days, 30);
    assert.equal(aug.ad_spend, 500);
    assert.ok(hist);
    assert.equal(hist.gross_sales, 9000);
    assert.equal(hist.source, "sku_monthly");
  });

  test("complete closed July overlays daily Amazon totals, not stale sales_by_sku", () => {
    // SKU Economics Jul 1–31 is ground truth for "do not stay on $81k":
    // sales $105,402.85 / NP $25,561.96. Headline still comes from
    // pnl_daily account ($103,140.12 / 7,405 / $21,757.74), not the
    // file and not settlement amazon_net_proceeds ($128k).
    const julyDaily = amazonDays("2026-07", 31, 103140.12, 7405, {
      ads: 18782.09,
      contrib: 21757.74,
      referral: 15471.02,
      fba: 25917.5,
      cogs: 20211.77,
      proceeds: 128000,
    });
    const result = buildAmazonMonthlyPnl({
      skuRows: [
        { channel: "amazon", sku: "AA", period_start: "2026-07-01", units: 5548, gross_sales: 81332.82 },
        { channel: "amazon", sku: "AA", period_start: "2026-08-01", units: 6400, gross_sales: 92324.84 },
      ],
      costs: [{ sku: "AA", cogs_per_unit: 2.85 }],
      adsByDay: [{ date: "2026-07-15", spend: 18782.09 }],
      dailyAccount: [
        ...julyDaily,
        ...amazonDays("2026-08", 30, 94807.47, 6466),
      ],
      dailySkus: julyDaily.map((d) => ({
        date: d.date, sku: "AA", units: d.units, gross_sales: d.gross_sales,
      })),
      asOf: "2026-08-30",
    });
    const jul = result.months.find((m) => m.date.startsWith("2026-07"));
    const aug = result.months.find((m) => m.date.startsWith("2026-08"));
    assert.ok(jul);
    assert.equal(jul.gross_sales, 103140.12);
    assert.equal(jul.units, 7405);
    assert.equal(jul.source, "daily");
    assert.equal(jul.sales_basis, "daily");
    assert.equal(jul.closed_days, 31);
    assert.equal(jul.ad_spend, 18782.09);
    assert.equal(jul.net_after_ads, 21757.74);
    assert.notEqual(jul.net_after_ads, 14649.39);
    assert.notEqual(jul.net_after_ads, 25561.96);
    assert.equal(jul.amazon_net_proceeds, null);
    assert.equal(result.skusByMonth["2026-07"][0].units, 7405);
    assert.notEqual(result.skusByMonth["2026-07"][0].units, 5548);
    assert.equal(aug?.gross_sales, 94807.47);
    assert.equal(aug?.source, "daily");
  });

  test("June sku≈daily stays on sales_by_sku", () => {
    const result = buildAmazonMonthlyPnl({
      skuRows: [
        { channel: "amazon", sku: "AA", period_start: "2026-06-01", units: 8000, gross_sales: 119374 },
      ],
      costs: [{ sku: "AA", cogs_per_unit: 2.85 }],
      adsByDay: [],
      dailyAccount: amazonDays("2026-06", 30, 119088, 7980),
      asOf: "2026-08-31",
    });
    const jun = result.months.find((m) => m.date.startsWith("2026-06"));
    assert.ok(jun);
    assert.equal(jun.gross_sales, 119374);
    assert.equal(jun.units, 8000);
    assert.equal(jun.source, "sku_monthly");
    assert.equal(jun.sales_basis, "sales_by_sku");
  });

  test("sales_daily Amazon sales win when they beat pnl_daily; Shopify is ignored", () => {
    const merged = mergeSalesDaily(
      [{ date: "2026-08-01", gross_sales: 3000, units: 200, channel: "amazon" }],
      [
        { sale_date: "2026-08-01", gross_sales: 3480.49, channel: "amazon" },
        { sale_date: "2026-08-02", gross_sales: 3623.65, channel: "amazon" },
        { sale_date: "2026-08-01", gross_sales: 9999, channel: "shopify" },
      ],
      "2026-08-30",
    );
    const d1 = merged.find((r) => r.date === "2026-08-01");
    const d2 = merged.find((r) => r.date === "2026-08-02");
    assert.equal(d1?.gross_sales, 3480.49);
    assert.equal(d1?.units, 200);
    assert.equal(d2?.gross_sales, 3623.65);
    assert.equal(merged.every((r) => r.channel === "amazon"), true);
    assert.equal(merged.reduce((s, r) => s + r.gross_sales, 0) < 10000, true);
  });
});

function amazonDays(
  ym: string,
  count: number,
  sales: number,
  units: number,
  econ?: {
    ads?: number;
    contrib?: number;
    referral?: number;
    fba?: number;
    cogs?: number;
    proceeds?: number;
  },
) {
  const days = [];
  const salesEach = Math.round((sales / count) * 100) / 100;
  const unitsEach = Math.floor(units / count);
  for (let d = 1; d <= count; d++) {
    days.push({
      date: `${ym}-${String(d).padStart(2, "0")}`,
      gross_sales: salesEach,
      units: unitsEach,
      est_cogs: 0,
      channel: "amazon",
      ...(econ
        ? {
            ad_spend: 0,
            est_referral_fees: 0,
            est_fba_fees: 0,
            est_contribution: 0,
            net_after_ads: 0,
            amazon_net_proceeds: 0,
          }
        : {}),
    });
  }
  const salesSum = days.reduce((s, r) => s + r.gross_sales, 0);
  const unitsSum = days.reduce((s, r) => s + r.units, 0);
  days[days.length - 1].gross_sales = Math.round((days[days.length - 1].gross_sales + sales - salesSum) * 100) / 100;
  days[days.length - 1].units += units - unitsSum;
  if (econ) {
    const last = days[days.length - 1];
    last.ad_spend = econ.ads ?? 0;
    last.est_referral_fees = econ.referral ?? 0;
    last.est_fba_fees = econ.fba ?? 0;
    last.est_cogs = econ.cogs ?? 0;
    last.est_contribution = econ.contrib ?? 0;
    last.net_after_ads = econ.contrib ?? 0;
    last.amazon_net_proceeds = econ.proceeds ?? 0;
  }
  return days;
}
