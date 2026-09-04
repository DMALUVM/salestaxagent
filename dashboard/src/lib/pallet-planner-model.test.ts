import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTUAL_2025_SOURCE,
  AMAZON_IN_BY,
  ASSORTED_SKU,
  DEMAND_METHOD,
  PALLET_MAX_UNITS,
  AMAZON_CASES_PER_PALLET,
  AUGUST_HOP_DESTINATION,
  AUGUST_HOP_LABEL,
  LOCKED_AUGUST_MARPAC_TULSA_DATE,
  LOCKED_AUGUST_MARPAC_TULSA_SEND,
  LOCKED_AUGUST_MARPAC_TULSA_TOTAL,
  AWD_CARDS_PER_MONTH_MAX,
  FIRST_WAVE_AWD_SHIP_ORDER,
  FIRST_WAVE_AWD_TARGET_CAP,
  FIRST_WAVE_AWD_TARGETS,
  OPTIMISTIC_AWD_TARGET_CAP,
  assignAwdCardsToMonths,
  palletCardSizes,
  palletFill,
  palletPartialMinUnits,
  PEAK_END_DEFAULT,
  applyAssortedCorrectionDisplay,
  buildMonthViewEntries,
  earlyJanFbaShipBy,
  FAMILY_FBA_CAP_OCT_DEC,
  FAMILY_FBA_CAP_PEAK,
  familyFbaCapForMonth,
  mergeScFbaCapacityLimits,
  NEXT_3PL_FBA_AFTER_TULSA_UNITS,
  PRIOR_SC_FBA_CAP_FT3,
  PRIOR_SC_FBA_CAP_UNITS,
  SC_FBA_CAP_MONTHS,
  SC_FBA_CAP_NOV_FT3,
  SC_FBA_CAP_NOV_UNITS,
  SC_FBA_CAP_OCT_FT3,
  SC_FBA_CAP_OCT_UNITS,
  SC_FBA_CAP_SEP_FT3,
  SC_FBA_CAP_SEP_UNITS,
  SC_FBA_INBOUND_ROOM_FT3,
  SC_FBA_INBOUND_ROOM_UNITS,
  SC_FBA_USED_FT3,
  SC_FBA_USED_PCT,
  next3plFbaFitsSeptRoom,
  SEPT_FBA_ON_HAND_TARGETS,
  SEPT_FBA_TARGET_CAP,
  buildSeptemberPlan,
  applyLockedTonight3plFbaSend,
  lockedAugust3plFbaMix,
  lockedAugustMarpacTulsaMix,
  LOCKED_AUGUST_3PL_FBA_SEND,
  LOCKED_AUGUST_3PL_FBA_TOTAL,
  LOCKED_TONIGHT_3PL_AWD_SEND,
  LOCKED_TONIGHT_3PL_AWD_TOTAL,
  LOCKED_TONIGHT_3PL_FBA_SEND,
  LOCKED_TONIGHT_3PL_FBA_TOTAL,
  TONIGHT_AWD_HOP_DESTINATION,
  isLegalInboundQty,
  effectiveTulsaFloor,
  familyTulsaFloor,
  familyYoyMayJul,
  fbaManufactureGap,
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
      assert.equal(build.skuBuild, demand[sku].holidayDemand);
      assert.equal(build.unstacked, true);
      assert.ok(build.stackedBuild > demand[sku].holidayDemand);
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

  test("Amazon pallet is 17,550 (65×270), not 19,000; min partial is 8,775", () => {
    assert.equal(AMAZON_CASES_PER_PALLET, 65);
    assert.equal(PALLET_MAX_UNITS, 17_550);
    assert.equal(PALLET_MAX_UNITS, 65 * 270);
    assert.notEqual(PALLET_MAX_UNITS, 19_000);
    assert.equal(palletPartialMinUnits(), 8_775);
    const full = palletFill(17_550, PALLET_MAX_UNITS);
    assert.equal(full.fullPallets, 1);
    assert.equal(full.hasPartial, false);
    assert.deepEqual(palletCardSizes(full), [17_550]);
    const leftover1k = palletFill(1_000, PALLET_MAX_UNITS);
    assert.equal(leftover1k.mergeOrHold, true);
    assert.equal(leftover1k.isPalletCard, false);
    const fullPlus1k = palletFill(17_550 + 1_000, PALLET_MAX_UNITS);
    assert.equal(fullPlus1k.fullPallets, 1);
    assert.equal(fullPlus1k.heldUnits, 1_000);
    assert.deepEqual(palletCardSizes(fullPlus1k), [17_550]);
  });

  test("half-pallet leftover is a partial card; two full + one partial is fine", () => {
    assert.equal(palletPartialMinUnits(), 8_775);
    const half = palletFill(8_775, PALLET_MAX_UNITS);
    assert.equal(half.hasPartial, true);
    assert.equal(half.palletCards, 1);
    assert.equal(half.heldUnits, 0);
    assert.deepEqual(palletCardSizes(half), [8_775]);
    const under = palletFill(8_774, PALLET_MAX_UNITS);
    assert.equal(under.mergeOrHold, true);
    assert.equal(under.isPalletCard, false);
    const twoPlus = palletFill(2 * PALLET_MAX_UNITS + 8_775, PALLET_MAX_UNITS);
    assert.equal(twoPlus.fullPallets, 2);
    assert.equal(twoPlus.hasPartial, true);
    assert.equal(twoPlus.palletCards, 3);
    assert.deepEqual(palletCardSizes(twoPlus), [17_550, 17_550, 8_775]);
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

  test("cover is SC on-hand; inbound is already in transit; unfulfillable stays out", () => {
    assert.equal(fbaCoverUnits({ fulfillable: 2978, reserved: 2466, researching: 28, unfulfillable: 5 }), 2978);
    assert.equal(inboundInTransit({ inbound_working: 0, inbound_shipped: 270, inbound_receiving: 0 }), 270);
    assert.equal(
      fbaCoverUnits(
        { fulfillable: 3501, reserved: 1953, researching: 9, unfulfillable: 818 },
        { "FC transfer": 553 },
      ),
      4054,
    );
    assert.notEqual(
      fbaCoverUnits(
        { fulfillable: 3501, reserved: 1953, unfulfillable: 818 },
        { "FC transfer": 553 },
      ),
      3501,
    );
  });

  test("FBA cap is 55,600 in Sep/Jan and ~49,400 in Oct–Dec", () => {
    assert.equal(familyFbaCapForMonth("2026-09"), FAMILY_FBA_CAP_PEAK);
    assert.equal(familyFbaCapForMonth("2026-01"), FAMILY_FBA_CAP_PEAK);
    assert.equal(familyFbaCapForMonth("2026-10"), FAMILY_FBA_CAP_OCT_DEC);
    assert.equal(familyFbaCapForMonth("2026-11"), 49_400);
    assert.equal(familyFbaCapForMonth("2026-12"), 49_400);
    assert.equal(SEPT_FBA_TARGET_CAP, 55_600);
  });

  test("Seller Central FBA card is 128.93 / 51,500 Sept, not 139.08 / 55,600", () => {
    assert.equal(PRIOR_SC_FBA_CAP_FT3, 139.08);
    assert.equal(PRIOR_SC_FBA_CAP_UNITS, 55_600);
    assert.equal(SC_FBA_CAP_SEP_FT3, 128.93);
    assert.equal(SC_FBA_CAP_SEP_UNITS, 51_500);
    assert.equal(SC_FBA_CAP_OCT_FT3, 140.23);
    assert.equal(SC_FBA_CAP_OCT_UNITS, 56_000);
    assert.equal(SC_FBA_CAP_NOV_FT3, 184.57);
    assert.equal(SC_FBA_CAP_NOV_UNITS, 73_800);
    assert.equal(SC_FBA_USED_FT3, 114.21);
    assert.equal(SC_FBA_USED_PCT, 88.59);
    assert.equal(SC_FBA_INBOUND_ROOM_FT3, 14.72);
    assert.equal(SC_FBA_INBOUND_ROOM_UNITS, 5_900);
    assert.ok(Math.abs(SC_FBA_CAP_SEP_FT3 - SC_FBA_USED_FT3 - SC_FBA_INBOUND_ROOM_FT3) < 0.01);
    assert.ok(Math.abs(SC_FBA_USED_FT3 / SC_FBA_CAP_SEP_FT3 * 100 - SC_FBA_USED_PCT) < 0.05);
    assert.ok(
      Math.abs(SC_FBA_INBOUND_ROOM_FT3 * PRIOR_SC_FBA_CAP_UNITS / PRIOR_SC_FBA_CAP_FT3 - 5_900) < 50,
    );
    assert.ok(
      Math.abs(SC_FBA_CAP_SEP_FT3 * PRIOR_SC_FBA_CAP_UNITS / PRIOR_SC_FBA_CAP_FT3 - 51_500) < 50,
    );
    assert.notEqual(SC_FBA_CAP_SEP_UNITS, FAMILY_FBA_CAP_PEAK);
    assert.equal(NEXT_3PL_FBA_AFTER_TULSA_UNITS, 10_800);
    assert.equal(next3plFbaFitsSeptRoom(), false);
    assert.equal(next3plFbaFitsSeptRoom(5_900), true);
    assert.equal(next3plFbaFitsSeptRoom(5_901), false);
    assert.equal(SC_FBA_CAP_MONTHS.length, 3);
    assert.equal(SC_FBA_CAP_MONTHS[0].source, "confirmed");
    assert.equal(SC_FBA_CAP_MONTHS[1].source, "estimate");
    assert.equal(SC_FBA_CAP_MONTHS[2].source, "estimate");
    const merged = mergeScFbaCapacityLimits([
      { month: "2026-09", limit_ft3: 139.08, used_ft3: 90, source: "estimate" },
    ]);
    const sept = merged.find((r) => r.month === "2026-09");
    assert.equal(sept?.limit_ft3, 128.93);
    assert.equal(sept?.used_ft3, 114.21);
    assert.equal(sept?.source, "confirmed");
    assert.ok(merged.some((r) => r.month === "2026-10" && r.limit_ft3 === 140.23));
    assert.ok(merged.some((r) => r.month === "2026-11" && r.limit_ft3 === 184.57));
  });

  test("August Marpac→Tulsa lock is 6480 / 3240 / 3240, no peppermint", () => {
    assert.equal(LOCKED_AUGUST_MARPAC_TULSA_SEND.DDPE0001Shop, 6_480);
    assert.equal(LOCKED_AUGUST_MARPAC_TULSA_SEND.DDPE0004Shop, 3_240);
    assert.equal(LOCKED_AUGUST_MARPAC_TULSA_SEND.DDPE0003Shop, 3_240);
    assert.equal(LOCKED_AUGUST_MARPAC_TULSA_SEND.DDPE0002Shop, 0);
    assert.equal(LOCKED_AUGUST_MARPAC_TULSA_TOTAL, 12_960);
    assert.equal(LOCKED_AUGUST_MARPAC_TULSA_DATE, "2026-08-31");
    const mix = lockedAugustMarpacTulsaMix();
    assert.deepEqual(mix, {
      DDPE0001Shop: 6_480,
      DDPE0004Shop: 3_240,
      DDPE0003Shop: 3_240,
    });
    assert.equal("DDPE0002Shop" in mix, false);
  });

  test("historical August 3PL→FBA lock is 5400 + 4860 + 2700 peppermint", () => {
    assert.equal(LOCKED_AUGUST_3PL_FBA_SEND.DDPE0004Shop, 5_400);
    assert.equal(LOCKED_AUGUST_3PL_FBA_SEND.DDPE0003Shop, 4_860);
    assert.equal(LOCKED_AUGUST_3PL_FBA_SEND.DDPE0002Shop, 2_700);
    assert.equal(LOCKED_AUGUST_3PL_FBA_SEND.DDPE0001Shop, 0);
    assert.equal(LOCKED_AUGUST_3PL_FBA_TOTAL, 12_960);
    assert.equal(isLegalInboundQty(4_860, 270), true);
    assert.equal(isLegalInboundQty(2_700, 270), true);
    const mix = lockedAugust3plFbaMix();
    assert.deepEqual(mix, {
      DDPE0004Shop: 5_400,
      DDPE0003Shop: 4_860,
      DDPE0002Shop: 2_700,
    });
    assert.equal("DDPE0001Shop" in mix, false);
  });

  test("Sep 4 3PL lock is 5400 unscented + 2700 assorted FBA and 2700 orange AWD", () => {
    assert.equal(LOCKED_TONIGHT_3PL_FBA_SEND.DDPE0001Shop, 5_400);
    assert.equal(LOCKED_TONIGHT_3PL_FBA_SEND.DDPE0004Shop, 2_700);
    assert.equal(LOCKED_TONIGHT_3PL_FBA_SEND.DDPE0003Shop, 0);
    assert.equal(LOCKED_TONIGHT_3PL_FBA_SEND.DDPE0002Shop, 0);
    assert.equal(LOCKED_TONIGHT_3PL_FBA_TOTAL, 8_100);
    assert.equal(LOCKED_TONIGHT_3PL_AWD_SEND.DDPE0003Shop, 2_700);
    assert.equal(LOCKED_TONIGHT_3PL_AWD_SEND.DDPE0001Shop, 0);
    assert.equal(LOCKED_TONIGHT_3PL_AWD_SEND.DDPE0002Shop, 0);
    assert.equal(LOCKED_TONIGHT_3PL_AWD_SEND.DDPE0004Shop, 0);
    assert.equal(LOCKED_TONIGHT_3PL_AWD_TOTAL, 2_700);
    assert.equal(isLegalInboundQty(5_400, 270), true);
    assert.equal(isLegalInboundQty(2_700, 270), true);
    assert.equal(2_700, 10 * 270);
    const locked = applyLockedTonight3plFbaSend(
      { DDPE0001Shop: 1594, DDPE0002Shop: 6291, DDPE0003Shop: 6426, DDPE0004Shop: 9177 },
      { DDPE0001Shop: 9552, DDPE0002Shop: 5141, DDPE0003Shop: 12097, DDPE0004Shop: 13927 },
    );
    assert.equal(locked.tplToFba.DDPE0001Shop, 5400);
    assert.equal(locked.tplToFba.DDPE0004Shop, 2700);
    assert.equal(locked.tplToFba.DDPE0003Shop, 0);
    assert.equal(locked.tplToFba.DDPE0002Shop, 0);
    assert.equal(locked.sendTotal, 8100);
    assert.equal(locked.tplToAwd.DDPE0003Shop, 2700);
    assert.equal(locked.tplToAwd.DDPE0001Shop, 0);
    assert.equal(locked.tplToAwd.DDPE0002Shop, 0);
    assert.equal(locked.tplToAwd.DDPE0004Shop, 0);
    assert.equal(locked.hopTotal, 2700);
    assert.equal(locked.locked, true);
    assert.equal(locked.tulsaHold.DDPE0004Shop, 9177 - 2700);
    assert.equal(locked.tulsaHold.DDPE0003Shop, 6426 - 2700);
    assert.equal(locked.tulsaHold.DDPE0002Shop, 6291);
  });

  test("two piles: 3PL→FBA is locked tonight send; manufacture is AWD surge", () => {
    assert.equal(SEPT_FBA_TARGET_CAP, 55_600);
    assert.equal(SEPT_FBA_ON_HAND_TARGETS.DDPE0004Shop, 17_800);
    const fba = { DDPE0001Shop: 3248, DDPE0002Shop: 2079, DDPE0003Shop: 3966, DDPE0004Shop: 3603 };
    const inbound = { DDPE0001Shop: 0, DDPE0002Shop: 1080, DDPE0003Shop: 637, DDPE0004Shop: 270 };
    const tpl = { DDPE0001Shop: 1594, DDPE0002Shop: 6291, DDPE0003Shop: 6426, DDPE0004Shop: 9177 };
    const plan = buildSeptemberPlan(fba, inbound, tpl, {}, {}, { DDPE0002Shop: 540 });
    assert.equal(plan.augustTbd, true);
    assert.equal(plan.mixLocked, false);
    assert.equal(plan.twoTracks, true);
    assert.equal(plan.tplToFba.DDPE0001Shop, 5400);
    assert.equal(plan.tplToFba.DDPE0004Shop, 2700);
    assert.equal(plan.tplToFba.DDPE0003Shop, 0);
    assert.equal(plan.tplToFba.DDPE0002Shop, 0);
    assert.equal(plan.firstAction.tplToFbaTotal, 8100);
    assert.equal(plan.tplToAwd.DDPE0003Shop, 2700);
    assert.equal(plan.firstAction.tplToAwdTotal, 2700);
    assert.equal(plan.firstAction.augustHop, AUGUST_HOP_LABEL);
    assert.equal(plan.tplToAwd.DDPE0002Shop, 0);
    assert.equal(plan.awdLoaded, false);
    assert.ok(plan.awdPallets.length > 0);
    assert.ok(plan.awdPallets.every((c) => c.singleSku && c.destination === "awd"));
    assert.equal(plan.skuManufacture.DDPE0004Shop, 17_550);
    assert.equal(plan.skuManufacture.DDPE0003Shop, 17_550);
    assert.equal(plan.skuManufacture.DDPE0001Shop, 17_550);
    assert.equal(plan.skuManufacture.DDPE0002Shop, 8_775);
    assert.equal(plan.awdTargetCap, FIRST_WAVE_AWD_TARGET_CAP);
    assert.equal(plan.optimisticAwdTargetCap, OPTIMISTIC_AWD_TARGET_CAP);
    assert.notEqual(plan.skuManufacture.DDPE0004Shop, fbaManufactureGap(17_800, 3603, 270));
    assert.notEqual(
      Object.values(plan.skuManufacture).reduce((a, b) => a + b, 0),
      76_211,
    );
    const full = buildSeptemberPlan(
      { DDPE0001Shop: 12800, DDPE0002Shop: 8300, DDPE0003Shop: 16700, DDPE0004Shop: 17800 },
      { DDPE0001Shop: 0, DDPE0002Shop: 0, DDPE0003Shop: 0, DDPE0004Shop: 0 },
      { DDPE0001Shop: 0, DDPE0002Shop: 0, DDPE0003Shop: 0, DDPE0004Shop: 0 },
    );
    const withAug = buildSeptemberPlan(
      { DDPE0001Shop: 12800, DDPE0002Shop: 8300, DDPE0003Shop: 16700, DDPE0004Shop: 17800 },
      { DDPE0001Shop: 0, DDPE0002Shop: 0, DDPE0003Shop: 0, DDPE0004Shop: 0 },
      { DDPE0001Shop: 0, DDPE0002Shop: 0, DDPE0003Shop: 0, DDPE0004Shop: 0 },
      {},
      { DDPE0004Shop: 5000 },
    );
    assert.equal(withAug.augustTbd, false);
    assert.equal(withAug.skuManufacture.DDPE0004Shop, full.skuManufacture.DDPE0004Shop - 5000);

    const horizon = productionHorizonMonths(new Date(2026, 7, 26), AMAZON_IN_BY, 35);
    const entries = buildMonthViewEntries({
      productionMonths: horizon.map((h) => h.month),
      horizonByMonth: Object.fromEntries(horizon.map((h) => [h.month, h])),
      sept: plan,
    });
    const sept = entries.filter((e) => e.month === "2026-09");
    assert.ok(sept.length > 0, "September was skipped");
    assert.ok(sept.some((e) => e.units > 0));
    const dests = new Set(sept.filter((e) => e.units > 0).map((e) => e.destination));
    assert.equal(dests.has("3pl_fba"), true);
    assert.equal(dests.has(TONIGHT_AWD_HOP_DESTINATION), true);
    assert.equal(dests.has("awd"), true);
    const aug = entries.filter((e) => e.month.endsWith("-08"));
    const histFba = aug.find((e) => e.destination === "3pl_fba");
    assert.equal(histFba?.mix.DDPE0004Shop, 5400);
    assert.equal(histFba?.mix.DDPE0003Shop, 4860);
    assert.equal(histFba?.mix.DDPE0002Shop, 2700);
    assert.equal(histFba?.mix.DDPE0001Shop ?? 0, 0);
    assert.equal(histFba?.units, 12960);
    assert.equal(histFba?.nextHop, false);
    assert.equal(aug.some((e) => e.destination === TONIGHT_AWD_HOP_DESTINATION), false);
    const fbaCard = sept.find((e) => e.destination === "3pl_fba");
    assert.equal(fbaCard?.mix.DDPE0001Shop, 5400);
    assert.equal(fbaCard?.mix.DDPE0004Shop, 2700);
    assert.equal(fbaCard?.mix.DDPE0003Shop ?? 0, 0);
    assert.equal(fbaCard?.mix.DDPE0002Shop ?? 0, 0);
    assert.equal(fbaCard?.units, 8100);
    assert.equal(fbaCard?.nextHop, true);
    const awdHop = sept.find((e) => e.destination === TONIGHT_AWD_HOP_DESTINATION);
    assert.ok(awdHop, "September 3PL→AWD small-parcel card missing");
    assert.equal(awdHop?.mix.DDPE0003Shop, 2700);
    assert.equal(awdHop?.units, 2700);
    assert.equal(awdHop?.nextHop, true);
    assert.equal(awdHop?.hopLabel, "3PL→AWD");
    assert.ok(awdHop?.units < palletPartialMinUnits());
    assert.equal(awdHop?.isPalletCard, true);
    const marpac = aug.find((e) => e.destination === AUGUST_HOP_DESTINATION);
    assert.ok(marpac, "August Marpac→Tulsa lock missing");
    assert.equal(marpac?.awaitingAugustTotals, false);
    assert.equal(marpac?.units, 12_960);
    assert.equal(marpac?.mix.DDPE0001Shop, 6_480);
    assert.equal(marpac?.mix.DDPE0004Shop, 3_240);
    assert.equal(marpac?.mix.DDPE0003Shop, 3_240);
    assert.equal(marpac?.mix.DDPE0002Shop ?? 0, 0);
    assert.equal(marpac?.shipBy, "2026-08-31");
    assert.equal(marpac?.availableDate, "2026-08-31");
    assert.equal(marpac?.inTransit, true);
    assert.equal(marpac?.mixLocked, true);
    assert.ok(sept.some((e) => e.destination === "3pl_fba" && e.units === 8100));
    assert.ok(sept.every((e) => e.destination !== "3pl_fba" || e.units !== 12960));
    const septAwd = entries.filter((e) => e.month === "2026-09" && e.destination === "awd" && e.units > 0);
    const octAwd = entries.filter((e) => e.month === "2026-10" && e.destination === "awd" && e.units > 0);
    assert.deepEqual(new Set(septAwd.map((e) => Object.keys(e.mix)[0])), new Set(["DDPE0004Shop", "DDPE0003Shop"]));
    assert.deepEqual(new Set(octAwd.map((e) => Object.keys(e.mix)[0])), new Set(["DDPE0001Shop", "DDPE0002Shop"]));
    assert.ok(octAwd.length > 0, "2026-10 missing first-wave pair");
    assert.ok(octAwd.every((e) => e.destination === "awd" && e.singleSku && e.isPalletCard));
    for (const e of entries) {
      if (e.destination === "awd" && e.units > 0) {
        assert.ok(e.units >= 8_775);
        assert.equal(e.isPalletCard, true);
        if (!e.hasPartial) {
          assert.ok(e.units === 17_550 || (e.fullPallets ?? 0) >= 1);
        }
      }
    }
  });

  test("AWD loaded drops 5k Tulsa floor; never 0 AWD and 0 Tulsa", () => {
    const tpl = { DDPE0001Shop: 2000, DDPE0002Shop: 2000, DDPE0003Shop: 2000, DDPE0004Shop: 2000 };
    assert.equal(effectiveTulsaFloor({ DDPE0002Shop: 540 }), 5000);
    const token = familyTulsaFloor(tpl, 5000, { DDPE0002Shop: 540 });
    assert.equal(token.awdLoaded, false);
    assert.equal(token.floor, 5000);
    assert.equal(token.transferable, 3000);
    const awd = { DDPE0001Shop: 5000 };
    assert.equal(effectiveTulsaFloor(awd), 0);
    const loaded = familyTulsaFloor(tpl, 5000, awd);
    assert.equal(loaded.awdLoaded, true);
    assert.equal(loaded.floor, 0);
    assert.equal(loaded.topUp, 0);
    assert.equal(loaded.transferable, 8000);
    const empty = familyTulsaFloor({ DDPE0001Shop: 0 }, 5000, { DDPE0001Shop: 0 });
    assert.equal(empty.awdLoaded, false);
    assert.equal(empty.floor, 5000);
    assert.equal(empty.topUp, 5000);
    const plan = buildSeptemberPlan(
      { DDPE0001Shop: 3248, DDPE0002Shop: 3159, DDPE0003Shop: 4603, DDPE0004Shop: 3873 },
      { DDPE0001Shop: 0, DDPE0002Shop: 0, DDPE0003Shop: 0, DDPE0004Shop: 0 },
      tpl,
      { DDPE0001Shop: 20000, DDPE0002Shop: 20000, DDPE0003Shop: 20000, DDPE0004Shop: 20000 },
      {},
      awd,
    );
    assert.equal(plan.awdLoaded, true);
    assert.equal(plan.tulsaFloorUnits, 0);
    assert.equal(plan.tulsa.topUp, 0);
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

  test("August hop is Marpac→Tulsa lock, not 3PL→FBA", () => {
    const fba = { DDPE0001Shop: 3248, DDPE0002Shop: 2079, DDPE0003Shop: 3966, DDPE0004Shop: 3603 };
    const inbound = { DDPE0001Shop: 0, DDPE0002Shop: 1080, DDPE0003Shop: 637, DDPE0004Shop: 270 };
    const tpl = { DDPE0001Shop: 1594, DDPE0002Shop: 6291, DDPE0003Shop: 6426, DDPE0004Shop: 9177 };
    const plan = buildSeptemberPlan(fba, inbound, tpl, {}, {}, { DDPE0002Shop: 540 });
    assert.equal(plan.firstAction.augustHop, "Marpac→Tulsa");
    const horizon = productionHorizonMonths(new Date(2026, 7, 26), AMAZON_IN_BY, 35);
    const entries = buildMonthViewEntries({
      productionMonths: horizon.map((h) => h.month),
      horizonByMonth: Object.fromEntries(horizon.map((h) => [h.month, h])),
      sept: plan,
    });
    const aug = entries.filter((e) => e.month.endsWith("-08"));
    const marpac = aug.find((e) => e.destination === AUGUST_HOP_DESTINATION);
    assert.ok(marpac, "August card missing");
    assert.equal(marpac?.destination, AUGUST_HOP_DESTINATION);
    assert.equal(marpac?.hopLabel, AUGUST_HOP_LABEL);
    assert.equal(marpac?.awaitingAugustTotals, false);
    assert.equal(marpac?.units, 12_960);
    assert.deepEqual(marpac?.mix, lockedAugustMarpacTulsaMix());
    assert.notEqual(marpac?.destination, "3pl_fba");
    assert.notEqual(marpac?.hopLabel, "3PL→FBA");
    assert.match(marpac?.hopLabel ?? "", /Marpac→Tulsa/);
    const send = aug.find((e) => e.destination === "3pl_fba");
    assert.ok(send, "August 3PL→FBA card missing");
    assert.equal(send?.units, 12960);
    assert.equal(send?.nextHop, false);
    assert.equal(send?.mix.DDPE0004Shop, 5400);
    assert.equal(send?.mix.DDPE0003Shop, 4860);
    assert.equal(send?.mix.DDPE0002Shop, 2700);
    assert.equal(send?.mix.DDPE0001Shop ?? 0, 0);
    assert.equal(aug.some((e) => e.destination === TONIGHT_AWD_HOP_DESTINATION), false);
    const sept = entries.filter((e) => e.month.endsWith("-09"));
    const tonightFba = sept.find((e) => e.destination === "3pl_fba");
    assert.equal(tonightFba?.units, 8100);
    assert.equal(tonightFba?.nextHop, true);
    const awdHop = sept.find((e) => e.destination === TONIGHT_AWD_HOP_DESTINATION);
    assert.equal(awdHop?.units, 2700);
    assert.equal(awdHop?.mix.DDPE0003Shop, 2700);
  });

  test("first-wave AWD is 61,425 in ship order, not 76,211", () => {
    assert.equal(FIRST_WAVE_AWD_TARGETS.DDPE0004Shop, 17_550);
    assert.equal(FIRST_WAVE_AWD_TARGETS.DDPE0003Shop, 17_550);
    assert.equal(FIRST_WAVE_AWD_TARGETS.DDPE0001Shop, 17_550);
    assert.equal(FIRST_WAVE_AWD_TARGETS.DDPE0002Shop, 8_775);
    assert.equal(
      Object.values(FIRST_WAVE_AWD_TARGETS).reduce((a, b) => a + b, 0),
      FIRST_WAVE_AWD_TARGET_CAP,
    );
    assert.equal(FIRST_WAVE_AWD_TARGET_CAP, 61_425);
    assert.notEqual(FIRST_WAVE_AWD_TARGET_CAP, 76_211);
    assert.deepEqual([...FIRST_WAVE_AWD_SHIP_ORDER], [
      "DDPE0004Shop", "DDPE0003Shop", "DDPE0001Shop", "DDPE0002Shop",
    ]);
    const fba = { DDPE0001Shop: 3248, DDPE0002Shop: 2079, DDPE0003Shop: 3966, DDPE0004Shop: 3603 };
    const inbound = { DDPE0001Shop: 0, DDPE0002Shop: 1080, DDPE0003Shop: 637, DDPE0004Shop: 270 };
    const tpl = { DDPE0001Shop: 1594, DDPE0002Shop: 6291, DDPE0003Shop: 6426, DDPE0004Shop: 9177 };
    const plan = buildSeptemberPlan(fba, inbound, tpl, {}, {}, { DDPE0002Shop: 540 });
    assert.equal(plan.firstAction.tplToFbaTotal, 8100);
    assert.equal(plan.firstAction.tplToAwdTotal, 2700);
    assert.equal(plan.skuManufacture.DDPE0002Shop, 8_775);
    assert.equal(plan.skuManufacture.DDPE0003Shop, 17_550);
    assert.deepEqual(plan.awdPallets.map((c) => c.sku), [...FIRST_WAVE_AWD_SHIP_ORDER]);
    assert.deepEqual(plan.awdPallets.map((c) => c.totalUnits), [17_550, 17_550, 17_550, 8_775]);
    const horizon = productionHorizonMonths(new Date(2026, 7, 26), AMAZON_IN_BY, 35);
    const entries = buildMonthViewEntries({
      productionMonths: horizon.map((h) => h.month),
      horizonByMonth: Object.fromEntries(horizon.map((h) => [h.month, h])),
      sept: plan,
    });
    const aug = entries.filter((e) => e.month.endsWith("-08"));
    const marpac = aug.find((e) => e.destination === AUGUST_HOP_DESTINATION);
    assert.equal(marpac?.hopLabel, "Marpac→Tulsa");
    assert.equal(marpac?.awaitingAugustTotals, false);
    assert.equal(marpac?.units, 12_960);
    const send = aug.find((e) => e.destination === "3pl_fba");
    assert.equal(send?.units, 12960);
    assert.equal(send?.nextHop, false);
    assert.equal(aug.some((e) => e.destination === TONIGHT_AWD_HOP_DESTINATION), false);
    const sept = entries.filter((e) => e.month.endsWith("-09"));
    assert.equal(sept.find((e) => e.destination === "3pl_fba")?.units, 8100);
    assert.equal(sept.find((e) => e.destination === TONIGHT_AWD_HOP_DESTINATION)?.units, 2700);
    const awd = entries.filter((e) => e.destination === "awd" && e.units > 0);
    assert.deepEqual(awd.map((e) => Object.keys(e.mix)[0]), [...FIRST_WAVE_AWD_SHIP_ORDER]);
  });

  test("August card is locked Marpac→Tulsa, not first-wave AWD", () => {
    const fba = { DDPE0001Shop: 3248, DDPE0002Shop: 2079, DDPE0003Shop: 3966, DDPE0004Shop: 3603 };
    const inbound = { DDPE0001Shop: 0, DDPE0002Shop: 1080, DDPE0003Shop: 637, DDPE0004Shop: 270 };
    const tpl = { DDPE0001Shop: 1594, DDPE0002Shop: 6291, DDPE0003Shop: 6426, DDPE0004Shop: 9177 };
    const plan = buildSeptemberPlan(fba, inbound, tpl, {}, {}, { DDPE0002Shop: 540 });
    const horizon = productionHorizonMonths(new Date(2026, 7, 26), AMAZON_IN_BY, 35);
    const entries = buildMonthViewEntries({
      productionMonths: horizon.map((h) => h.month),
      horizonByMonth: Object.fromEntries(horizon.map((h) => [h.month, h])),
      sept: plan,
    });
    const aug = entries.filter((e) => e.month.endsWith("-08"));
    assert.ok(aug.length > 0);
    assert.ok(aug.every((e) => e.destination !== "awd"));
    const marpac = aug.filter((e) => e.destination === AUGUST_HOP_DESTINATION);
    assert.ok(marpac.length > 0);
    assert.ok(marpac.every((e) => e.hopLabel === "Marpac→Tulsa"));
    assert.ok(marpac.every((e) => e.awaitingAugustTotals === false));
    assert.ok(marpac.every((e) => e.units === 12_960));
    assert.ok(marpac.every((e) => (e.mix.DDPE0002Shop ?? 0) === 0));
    const septAwd = entries.filter((e) => e.month === "2026-09" && e.destination === "awd" && e.units > 0);
    assert.deepEqual(new Set(septAwd.map((e) => Object.keys(e.mix)[0])), new Set(["DDPE0004Shop", "DDPE0003Shop"]));
  });

  test("orange FBA in cap uses 4054 not 3501", () => {
    assert.equal(
      fbaCoverUnits(
        { fulfillable: 3501, reserved: 1953, researching: 9, unfulfillable: 818 },
        { "FC transfer": "553", "FC Processing": "1324", "Customer Order": "74" },
      ),
      4054,
    );
    const plan = buildSeptemberPlan(
      { DDPE0001Shop: 3248, DDPE0002Shop: 2079, DDPE0003Shop: 4054, DDPE0004Shop: 3603 },
      { DDPE0001Shop: 0, DDPE0002Shop: 1080, DDPE0003Shop: 540, DDPE0004Shop: 270 },
      { DDPE0001Shop: 1594, DDPE0002Shop: 6291, DDPE0003Shop: 6426, DDPE0004Shop: 9177 },
      {},
      {},
      { DDPE0002Shop: 540 },
    );
    assert.equal(plan.gaps.DDPE0003Shop.fba, 4054);
    assert.notEqual(plan.gaps.DDPE0003Shop.fba, 3501);
    assert.equal(plan.firstAction.tplToFbaTotal, 8100);
    assert.equal(plan.firstAction.tplToAwdTotal, 2700);
  });

  test("August lock stays visible when horizon starts in September", () => {
    const fba = { DDPE0001Shop: 3248, DDPE0002Shop: 2079, DDPE0003Shop: 3966, DDPE0004Shop: 3603 };
    const inbound = { DDPE0001Shop: 0, DDPE0002Shop: 1080, DDPE0003Shop: 637, DDPE0004Shop: 270 };
    const tpl = { DDPE0001Shop: 1594, DDPE0002Shop: 6291, DDPE0003Shop: 6426, DDPE0004Shop: 9177 };
    const plan = buildSeptemberPlan(fba, inbound, tpl, {}, {}, { DDPE0002Shop: 540 });
    const horizon = productionHorizonMonths(new Date(2026, 8, 1), AMAZON_IN_BY, 35);
    assert.equal(horizon.some((h) => h.month === "2026-08"), false);
    const entries = buildMonthViewEntries({
      productionMonths: horizon.map((h) => h.month),
      horizonByMonth: Object.fromEntries(horizon.map((h) => [h.month, h])),
      sept: plan,
    });
    const aug = entries.filter((e) => e.month === "2026-08");
    assert.ok(aug.length > 0, "August in-transit hop vanished after Sep 1");
    const marpac = aug.find((e) => e.destination === AUGUST_HOP_DESTINATION);
    assert.equal(marpac?.units, 12_960);
    assert.equal(marpac?.shipBy, "2026-08-31");
    const send = aug.find((e) => e.destination === "3pl_fba");
    assert.equal(send?.units, 12_960);
    assert.equal(send?.nextHop, false);
    assert.equal(aug.some((e) => e.destination === TONIGHT_AWD_HOP_DESTINATION), false);
    const sept = entries.filter((e) => e.month === "2026-09");
    assert.equal(sept.find((e) => e.destination === "3pl_fba")?.units, 8_100);
    assert.equal(sept.find((e) => e.destination === TONIGHT_AWD_HOP_DESTINATION)?.units, 2_700);
  });

  test("AWD months allow 2 cards, not capped at 1", () => {
    assert.equal(AWD_CARDS_PER_MONTH_MAX, 2);
    const cards = [
      { partial: false, totalUnits: 17_550 },
      { partial: false, totalUnits: 17_550 },
      { partial: false, totalUnits: 17_550 },
      { partial: true, totalUnits: 8_775 },
      { partial: true, totalUnits: 10_000 },
    ];
    const assigned = assignAwdCardsToMonths(cards, ["2026-09", "2026-10", "2026-11", "2026-12"]);
    const counts = ["2026-09", "2026-10", "2026-11", "2026-12"].map((m) => assigned[m].length);
    assert.equal(counts.reduce((a, b) => a + b, 0), 5);
    assert.equal(Math.max(...counts), 2);
    assert.equal(assigned["2026-09"].length, 2);
  });
});
