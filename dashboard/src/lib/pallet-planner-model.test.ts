import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTUAL_2025_SOURCE,
  AMAZON_IN_BY,
  ASSORTED_SKU,
  DEMAND_METHOD,
  PALLET_MAX_UNITS,
  palletCardSizes,
  palletFill,
  palletPartialMinUnits,
  PEAK_END_DEFAULT,
  applyAssortedCorrectionDisplay,
  earlyJanFbaShipBy,
  familyTulsaFloor,
  familyYoyMayJul,
  fbaCoverUnits,
  holidayDemandFromSales,
  plannerPolicy,
  productionHorizonMonths,
  sellableDate,
  shipByForMonth,
  shipTooLateForEarlyJan,
  skuProductionBuild,
  inAmazonDate,
  inboundInTransit,
  latestRowPerSku,
  monthCanMakeGate,
  monthlyAmazonUnits,
  productionMonthsBeforeGate,
  skuYoyMayJul,
  tulsaAfterChristmasOutbound,
  workbookWindowUnits,
} from "./pallet-planner-model";

const LIP = ["DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"];
const DEO = "DDPE00019Shop";
const TALLOW = "DDPE00020Shop";

const ROWS = [
  { sku: "DDPE0001Shop", period_start: "2025-05-01", units: 1558, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0001Shop", period_start: "2025-06-01", units: 1106, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0001Shop", period_start: "2025-07-01", units: 1511, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0001Shop", period_start: "2025-10-01", units: 1670, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0001Shop", period_start: "2025-11-01", units: 2155, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0001Shop", period_start: "2025-12-01", units: 4104, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0001Shop", period_start: "2025-01-01", units: 1386, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0001Shop", period_start: "2026-01-01", units: 2904, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0001Shop", period_start: "2026-05-01", units: 1848, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0001Shop", period_start: "2026-06-01", units: 2002, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0001Shop", period_start: "2026-07-01", units: 1775, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0002Shop", period_start: "2025-05-01", units: 865, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0002Shop", period_start: "2025-06-01", units: 693, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0002Shop", period_start: "2025-07-01", units: 1074, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0002Shop", period_start: "2025-10-01", units: 1056, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0002Shop", period_start: "2025-11-01", units: 1454, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0002Shop", period_start: "2025-12-01", units: 2850, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0002Shop", period_start: "2025-01-01", units: 804, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0002Shop", period_start: "2026-01-01", units: 1685, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0002Shop", period_start: "2026-05-01", units: 1219, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0002Shop", period_start: "2026-06-01", units: 1224, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0002Shop", period_start: "2026-07-01", units: 996, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0003Shop", period_start: "2025-05-01", units: 1677, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0003Shop", period_start: "2025-06-01", units: 1230, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0003Shop", period_start: "2025-07-01", units: 1942, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0003Shop", period_start: "2025-10-01", units: 2439, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0003Shop", period_start: "2025-11-01", units: 2791, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0003Shop", period_start: "2025-12-01", units: 5009, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0003Shop", period_start: "2025-01-01", units: 1585, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0003Shop", period_start: "2026-01-01", units: 3321, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0003Shop", period_start: "2026-05-01", units: 2633, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0003Shop", period_start: "2026-06-01", units: 2712, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0003Shop", period_start: "2026-07-01", units: 2083, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0004Shop", period_start: "2025-05-01", units: 1458, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0004Shop", period_start: "2025-06-01", units: 1075, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0004Shop", period_start: "2025-07-01", units: 967, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0004Shop", period_start: "2025-10-01", units: 1452, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0004Shop", period_start: "2025-11-01", units: 2627, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0004Shop", period_start: "2025-12-01", units: 6861, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0004Shop", period_start: "2025-01-01", units: 1641, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0004Shop", period_start: "2026-01-01", units: 3435, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0004Shop", period_start: "2026-05-01", units: 1955, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0004Shop", period_start: "2026-06-01", units: 1698, channel: "amazon", source: "amazon_spapi" },
  { sku: "DDPE0004Shop", period_start: "2026-07-01", units: 1406, channel: "amazon", source: "amazon_spapi" },
  { sku: DEO, period_start: "2025-05-01", units: 400, channel: "amazon", source: "amazon_spapi" },
  { sku: DEO, period_start: "2025-06-01", units: 350, channel: "amazon", source: "amazon_spapi" },
  { sku: DEO, period_start: "2025-07-01", units: 400, channel: "amazon", source: "amazon_spapi" },
  { sku: DEO, period_start: "2025-11-01", units: 280, channel: "amazon", source: "amazon_spapi" },
  { sku: DEO, period_start: "2025-12-01", units: 333, channel: "amazon", source: "amazon_spapi" },
  { sku: DEO, period_start: "2026-05-01", units: 380, channel: "amazon", source: "amazon_spapi" },
  { sku: DEO, period_start: "2026-06-01", units: 340, channel: "amazon", source: "amazon_spapi" },
  { sku: DEO, period_start: "2026-07-01", units: 350, channel: "amazon", source: "amazon_spapi" },
  { sku: TALLOW, period_start: "2025-11-01", units: 180, channel: "amazon", source: "amazon_spapi" },
  { sku: TALLOW, period_start: "2025-12-01", units: 200, channel: "amazon", source: "amazon_spapi" },
];

describe("pallet planner model", () => {
  test("family May–Jul YoY is context only (~1.42), not a SKU multiplier", () => {
    const monthly = monthlyAmazonUnits(ROWS, LIP);
    const info = familyYoyMayJul(monthly, LIP);
    assert.equal(info.priorUnits, 15156);
    assert.equal(info.currentUnits, 21551);
    assert.ok(info.yoy > 1.41 && info.yoy < 1.43);
    assert.equal(info.method, "family_may_jul_context_only");
    assert.equal(info.appliedToSkus, false);
    assert.equal(DEMAND_METHOD, "sku_2025_same_month_x_sku_may_jul_yoy");
  });

  test("each lip SKU uses its own May–Jul YoY, not family 1.42×", () => {
    const monthly = monthlyAmazonUnits(ROWS, LIP);
    const demand = holidayDemandFromSales(monthly, LIP, { includeJan: false });
    assert.equal(demand.DDPE0001Shop.novDecPrior, 6259);
    assert.equal(demand.DDPE0002Shop.novDecPrior, 4304);
    assert.ok(demand.DDPE0001Shop.yoy > 1.34 && demand.DDPE0001Shop.yoy < 1.35);
    assert.ok(demand.DDPE0002Shop.yoy > 1.30 && demand.DDPE0002Shop.yoy < 1.31);
    assert.ok(demand.DDPE0001Shop.novDecDemand >= 8400 && demand.DDPE0001Shop.novDecDemand <= 8460);
    assert.ok(demand.DDPE0002Shop.novDecDemand >= 5590 && demand.DDPE0002Shop.novDecDemand <= 5660);
    const family = familyYoyMayJul(monthly, LIP).yoy;
    assert.notEqual(demand.DDPE0001Shop.novDecDemand, Math.round(6259 * family));
    assert.notEqual(demand.DDPE0002Shop.novDecDemand, Math.round(4304 * family));
    assert.ok(demand.DDPE0001Shop.novDecDemand > 2593 * 2);
    assert.ok(demand.DDPE0002Shop.novDecDemand > 2205 * 2);
  });

  test("each SKU keeps its own 2025 MoM shape", () => {
    const monthly = monthlyAmazonUnits(ROWS, LIP);
    const demand = holidayDemandFromSales(monthly, LIP, { includeJan: false });
    for (const sku of LIP) {
      const m = demand[sku].months2026;
      assert.ok(m[10] < m[11] && m[11] < m[12]);
      const key = sku.toLowerCase();
      const nov = monthly.get(`${key}|2025|11`) ?? 0;
      const dec = monthly.get(`${key}|2025|12`) ?? 0;
      assert.ok(Math.abs(m[12] / m[11] - dec / nov) < 0.01);
    }
  });

  test("deodorant and tallow do not inherit lip YoY or Dec spike", () => {
    const monthly = monthlyAmazonUnits(ROWS, [...LIP, DEO, TALLOW]);
    const demand = holidayDemandFromSales(monthly, [...LIP, DEO, TALLOW], { includeJan: false });
    const lipYoy = skuYoyMayJul(monthly, "DDPE0001Shop").yoy;
    const family = familyYoyMayJul(monthly, LIP).yoy;
    const deo = demand[DEO];
    assert.ok(deo.yoy > 0.92 && deo.yoy < 0.94);
    assert.notEqual(deo.yoy, lipYoy);
    assert.notEqual(deo.yoy, family);
    assert.equal(deo.novDecPrior, 613);
    assert.ok(deo.novDecDemand >= 560 && deo.novDecDemand <= 580);
    assert.ok(deo.months2026[12] < 340);
    assert.notEqual(deo.months2026[12], Math.round(333 * family));
    assert.ok(deo.months2026[12] / deo.months2026[11] < 1.25);
    assert.ok(
      demand.DDPE0001Shop.months2026[12] / demand.DDPE0001Shop.months2026[11] > 1.85,
    );
    assert.equal(skuYoyMayJul(monthly, TALLOW).yoy, 1);
    assert.equal(demand[TALLOW].novDecDemand, 380);
    assert.equal(demand[TALLOW].months2026[12], 200);
  });

  test("peak 60d FBA uses December daily; Jan is 2026 × May–Jul YoY not 2.1×", () => {
    const monthly = monthlyAmazonUnits(ROWS, LIP);
    const demand = holidayDemandFromSales(monthly, LIP, { includeJan: true });
    const policy = plannerPolicy(
      { target_cover_days: 60, receiving_days_peak: 35, receiving_days_normal: 28, awd_to_fba_days: 14, peak_start_date: "2026-10-01", peak_end_date: "2027-01-15" },
      { fba_receive_median: 20, fba_receive_n: 14, awd_replenish_median: 12, awd_replenish_n: 51 },
    );
    assert.equal(policy.gateReceiveDays, 35);
    assert.equal(policy.refillReceiveDays, 35);
    assert.equal(policy.fbaReceiveMedian, 20);
    assert.equal(policy.earlyJanFbaShipBy, "2026-12-11");
    assert.equal(policy.tulsaFloorUnits, 5000);
    let familyPeak = 0;
    const leftoverYoy = 11345 / 5416;
    for (const sku of LIP) {
      const build = skuProductionBuild(demand[sku], { coverDays: 60, receiveDays: policy.gateReceiveDays });
      familyPeak += build.peakCover;
      assert.ok(build.skuBuild > demand[sku].holidayDemand);
      assert.notEqual(demand[sku].janDemand, Math.round(demand[sku].janPrior * leftoverYoy));
    }
    assert.ok(familyPeak >= 51000 && familyPeak <= 53000);
    const uns = skuProductionBuild(demand.DDPE0001Shop, { coverDays: 60, receiveDays: 20 });
    assert.ok(Math.abs(uns.peakCover - 10700) <= 200);
    const floor = familyTulsaFloor({ a: 2000, b: 2000, c: 3000, d: 1000 });
    assert.equal(floor.transferable, 3000);
    assert.equal(floor.splitPerSku, false);
  });

  test("horizon: Aug/Sep gate at 35d; Oct/Nov/Dec post-Christmas ammo", () => {
    const horizon = productionHorizonMonths(new Date(2026, 7, 26), AMAZON_IN_BY, 35);
    const months = horizon.map((h) => h.month);
    assert.equal(months.includes("2026-08"), true);
    assert.equal(months.includes("2026-09"), true);
    assert.equal(months.includes("2026-10"), true);
    assert.equal(months.includes("2026-11"), true);
    assert.equal(months.includes("2026-12"), true);
    assert.equal(horizon.find((h) => h.month === "2026-08")?.role, "gate");
    assert.equal(horizon.find((h) => h.month === "2026-09")?.role, "gate");
    assert.equal(horizon.find((h) => h.month === "2026-10")?.role, "refill");
    assert.equal(horizon.find((h) => h.month === "2026-11")?.role, "refill");
    assert.equal(horizon.find((h) => h.month === "2026-12")?.role, "refill");
    assert.equal(horizon.find((h) => h.month === "2026-10")?.label, "post_christmas_ammo");
    assert.equal(monthCanMakeGate("2026-10", AMAZON_IN_BY, 35), false);
    assert.equal(monthCanMakeGate("2026-09", AMAZON_IN_BY, 35), true);
    assert.equal(inAmazonDate("2026-11-20", 35, AMAZON_IN_BY, { clamp: false }) > AMAZON_IN_BY, true);
  });

  test("Dec 26 3PL→FBA is too late; early-Jan ship-by is before Christmas", () => {
    assert.equal(sellableDate("2026-12-26", 35), "2027-01-30");
    assert.equal(shipTooLateForEarlyJan("2026-12-26", 35, PEAK_END_DEFAULT), true);
    assert.equal(earlyJanFbaShipBy(PEAK_END_DEFAULT, 35), "2026-12-11");
    assert.equal(
      shipByForMonth("2026-12", AMAZON_IN_BY, 35, { role: "refill", needInFba: PEAK_END_DEFAULT }),
      "2026-12-11",
    );
  });

  test("Tulsa keeps 5k after Christmas outbound", () => {
    const kept = tulsaAfterChristmasOutbound({ a: 2000, b: 2000, c: 3000, d: 1000 }, 2000);
    assert.equal(kept.outbound, 2000);
    assert.equal(kept.afterOutbound, 6000);
    assert.equal(kept.neededBeforeOutbound, 7000);
    assert.equal(kept.meetsFloorAfterOutbound, true);
    const capped = tulsaAfterChristmasOutbound({ a: 2000, b: 2000, c: 3000, d: 1000 }, 4000);
    assert.equal(capped.outbound, 3000);
    assert.equal(capped.afterOutbound, 5000);
    assert.equal(capped.doNotDrainToZero, true);
  });

  test("Assorted display uses correction-factor, not YoY or optimistic", () => {
    const monthly = monthlyAmazonUnits(ROWS, LIP);
    const yoy = holidayDemandFromSales(monthly, LIP, { includeJan: true });
    const fc = [
      { sku: ASSORTED_SKU, scenario: "correction_factor", week_start: "2026-11-16", units: 7000 },
      { sku: ASSORTED_SKU, scenario: "correction_factor", week_start: "2026-12-07", units: 10000 },
      { sku: ASSORTED_SKU, scenario: "correction_factor", week_start: "2027-01-11", units: 5633 },
      { sku: "DDPE0001Shop", scenario: "correction_factor", week_start: "2026-11-16", units: 99999 },
      { sku: "DDPE0001Shop", scenario: "optimistic", week_start: "2026-11-16", units: 17803 },
      { sku: "DDPE0002Shop", scenario: "optimistic", week_start: "2026-11-16", units: 10590 },
      { sku: "DDPE0003Shop", scenario: "optimistic", week_start: "2026-11-16", units: 22827 },
      { sku: ASSORTED_SKU, scenario: "optimistic", week_start: "2026-11-16", units: 24991 },
    ];
    const displayed = applyAssortedCorrectionDisplay(yoy, fc);
    assert.equal(workbookWindowUnits(fc, ASSORTED_SKU, "correction_factor"), 22633);
    assert.equal(displayed[ASSORTED_SKU].holidayDemand, 22633);
    assert.notEqual(displayed[ASSORTED_SKU].holidayDemand, yoy[ASSORTED_SKU].holidayDemand);
    assert.notEqual(displayed[ASSORTED_SKU].holidayDemand, 24991);
    assert.equal(displayed.DDPE0001Shop.holidayDemand, yoy.DDPE0001Shop.holidayDemand);
    const opt = workbookWindowUnits(fc, ASSORTED_SKU, "optimistic");
    const build = skuProductionBuild(displayed[ASSORTED_SKU], {
      coverDays: 60, receiveDays: 35, optimisticUnits: opt,
    });
    assert.equal(build.displayDemand, 22633);
    assert.equal(build.coverFulfill, 24991);
    assert.equal(build.stockToCover, 24991 - 22633);
    assert.equal(
      workbookWindowUnits(fc, "DDPE0001Shop", "optimistic")
        + workbookWindowUnits(fc, "DDPE0002Shop", "optimistic")
        + workbookWindowUnits(fc, "DDPE0003Shop", "optimistic")
        + opt,
      76211,
    );
  });

  test("leftover 4276 is held, not a 1-pallet card", () => {
    const fill = palletFill(4276, PALLET_MAX_UNITS);
    assert.equal(fill.fullPallets, 0);
    assert.equal(fill.leftoverUnits, 4276);
    assert.equal(fill.heldUnits, 4276);
    assert.equal(fill.hasPartial, false);
    assert.equal(fill.mergeOrHold, true);
    assert.equal(fill.isPalletCard, false);
    assert.deepEqual(palletCardSizes(fill), []);
  });

  test("half-pallet leftover is a partial card; two full + one partial is fine", () => {
    assert.equal(palletPartialMinUnits(), 9_500);
    const half = palletFill(9_500, PALLET_MAX_UNITS);
    assert.equal(half.hasPartial, true);
    assert.equal(half.palletCards, 1);
    assert.equal(half.heldUnits, 0);
    assert.deepEqual(palletCardSizes(half), [9_500]);
    const under = palletFill(9_499, PALLET_MAX_UNITS);
    assert.equal(under.mergeOrHold, true);
    assert.equal(under.isPalletCard, false);
    const twoPlus = palletFill(2 * PALLET_MAX_UNITS + 9_500, PALLET_MAX_UNITS);
    assert.equal(twoPlus.fullPallets, 2);
    assert.equal(twoPlus.hasPartial, true);
    assert.equal(twoPlus.palletCards, 3);
    assert.deepEqual(palletCardSizes(twoPlus), [19_000, 19_000, 9_500]);
  });

  test("November inbound misses the 2026-10-31 gate", () => {
    assert.equal(monthCanMakeGate("2026-11", AMAZON_IN_BY, 18), false);
    assert.equal(monthCanMakeGate("2026-10", AMAZON_IN_BY, 18), true);
    const months = productionMonthsBeforeGate(new Date(2026, 7, 26), AMAZON_IN_BY, 18, 4);
    assert.equal(months.includes("2026-11"), false);
    assert.equal(inAmazonDate("2026-11-07", 18, AMAZON_IN_BY), AMAZON_IN_BY);
  });

  test("actual_2025 label is workbook weekly, not monthly sales", () => {
    assert.match(ACTUAL_2025_SOURCE, /forecast_weekly/);
    assert.match(ACTUAL_2025_SOURCE, /not Amazon monthly/);
  });

  test("cover is fulfillable only; inbound is already in transit", () => {
    assert.equal(fbaCoverUnits({ fulfillable: 2978, reserved: 2466, researching: 28, unfulfillable: 5 }), 2978);
    assert.equal(inboundInTransit({ inbound_working: 0, inbound_shipped: 270, inbound_receiving: 0 }), 270);
  });

  test("3PL uses latest row per SKU, not latest pull batch", () => {
    const rows = latestRowPerSku([
      { sku: "DDPE0001Shop", pulled_at: "2026-08-26T10:00:00Z" },
      { sku: "DDPE0002Shop", pulled_at: "2026-08-17T10:00:00Z" },
      { sku: "DDPE0001Shop", pulled_at: "2026-08-26T23:35:59Z" },
    ]);
    assert.equal(rows.find((r) => r.sku === "DDPE0001Shop")?.pulled_at, "2026-08-26T23:35:59Z");
    assert.equal(rows.find((r) => r.sku === "DDPE0002Shop")?.pulled_at, "2026-08-17T10:00:00Z");
  });
});
