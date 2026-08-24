import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";

import { buildAmazonMonthlyPnl, monthOverlapsWindow, PNL_FBA_PER_UNIT, PNL_REFERRAL_PCT } from "./sku-monthly-pnl";

describe("SKU monthly contribution", () => {
  test("constants match business_rules.json", () => {
    const cfg = JSON.parse(
      readFileSync(path.join(process.cwd(), "..", "config", "business_rules.json"), "utf8"),
    );
    assert.equal(PNL_REFERRAL_PCT, cfg.pnl.default_referral_pct);
    assert.equal(PNL_FBA_PER_UNIT, cfg.pnl.default_fba_fee_per_unit);
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
});
