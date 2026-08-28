import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  EXAMPLE_FORMUNOVA_SKU,
  FORMUNOVA_PO_LEAD_DAYS,
  PLAN_THROUGH_LANDING_PAD_MONTHS,
  addDays,
  addMonths,
  autoPlanThrough,
  isLipBalmSku,
  omittedLine,
  planProduction,
  presentOnHand,
  productionFamily,
  subtractDays,
} from "./production-planner-model";
import {
  LIP_BALM_SKUS,
  coverUnitsFromDaily,
  holidayDemandFromSales,
  monthlyAmazonUnits,
  plannerPolicy,
  skuProductionBuild,
} from "./pallet-planner-model";
import { PRODUCTION_LEAD_DAYS } from "./inventory-four-numbers";

const DEO = EXAMPLE_FORMUNOVA_SKU;
const LIP = "DDPE0001Shop";

const LIP_SALES = [
  { sku: LIP, period_start: "2025-05-01", units: 1558, channel: "amazon", source: "amazon_spapi" },
  { sku: LIP, period_start: "2025-06-01", units: 1106, channel: "amazon", source: "amazon_spapi" },
  { sku: LIP, period_start: "2025-07-01", units: 1511, channel: "amazon", source: "amazon_spapi" },
  { sku: LIP, period_start: "2025-10-01", units: 1670, channel: "amazon", source: "amazon_spapi" },
  { sku: LIP, period_start: "2025-11-01", units: 2155, channel: "amazon", source: "amazon_spapi" },
  { sku: LIP, period_start: "2025-12-01", units: 4104, channel: "amazon", source: "amazon_spapi" },
  { sku: LIP, period_start: "2025-01-01", units: 1386, channel: "amazon", source: "amazon_spapi" },
  { sku: LIP, period_start: "2026-01-01", units: 2904, channel: "amazon", source: "amazon_spapi" },
  { sku: LIP, period_start: "2026-05-01", units: 1848, channel: "amazon", source: "amazon_spapi" },
  { sku: LIP, period_start: "2026-06-01", units: 2002, channel: "amazon", source: "amazon_spapi" },
  { sku: LIP, period_start: "2026-07-01", units: 1775, channel: "amazon", source: "amazon_spapi" },
];

function src(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("Formunova production plan", () => {
  test("DDPE00019 2800 + date → new OOS and next PO = new OOS − lead − cover", () => {
    const asOf = "2026-08-28";
    const available = "2026-10-15";
    const daily = 20;
    const stock = 1_400;
    const planned = 2_800;

    const plan = planProduction({
      sku: DEO,
      productName: "Extra Strength Vanilla Sandalwood",
      plannedQty: planned,
      availableDate: available,
      asOf,
      onHand: { fba: stock, inbound: 0, awd: 0, tpl: 0 },
      dailyVelocity: daily,
    });

    assert.equal(plan.family, "formunova");
    assert.equal(plan.leadDays, FORMUNOVA_PO_LEAD_DAYS);
    assert.equal(plan.leadDays, PRODUCTION_LEAD_DAYS.balm);
    assert.equal(plan.leadDays, 70);
    assert.equal(plan.coverDays, 60);
    assert.match(plan.leadNote, /10 weeks/);
    assert.equal(isLipBalmSku(DEO), false);

    const currentExpected = addDays(asOf, Math.floor(stock / daily));
    assert.equal(plan.currentOosDate, currentExpected);
    assert.equal(plan.currentOosDate, "2026-11-06");

    const consumedBeforeLand = 48 * daily;
    assert.equal(consumedBeforeLand, 960);
    const remainingAtLand = stock - consumedBeforeLand + planned;
    assert.equal(remainingAtLand, 3_240);
    const newExpected = addDays(available, Math.floor(remainingAtLand / daily));
    assert.equal(plan.newOosDate, newExpected);
    assert.equal(plan.newOosDate, "2027-03-26");

    const poExpected = subtractDays(plan.newOosDate!, plan.leadDays + plan.coverDays);
    assert.equal(plan.recommendedPoDate, poExpected);
    assert.equal(plan.recommendedPoDate, subtractDays(plan.newOosDate!, 70 + 60));
    assert.equal(plan.recommendedPoDate, "2026-11-16");

    assert.equal(
      plan.recommendedPoQty,
      coverUnitsFromDaily(daily, plan.leadDays + plan.coverDays),
    );
    assert.equal(plan.recommendedPoQty, 2_600);
    assert.equal(plan.omittedLine, null);
  });

  test("missing on-hand is omitted, not zeroed", () => {
    const asOf = "2026-08-28";
    const zeroedWouldOosToday = planProduction({
      sku: DEO,
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      asOf,
      onHand: { fba: 0, inbound: 0, awd: 0, tpl: 0 },
      dailyVelocity: 20,
    });
    assert.equal(zeroedWouldOosToday.stock, 0);
    assert.equal(zeroedWouldOosToday.currentOosDate, asOf);

    const missing = presentOnHand({
      fba: null,
      inbound: null,
      awd: undefined,
      tpl: null,
    });
    assert.equal(missing.stock, null);
    assert.ok(missing.omitted.includes("FBA"));
    assert.ok(missing.omitted.includes("AWD"));
    assert.ok(missing.omitted.includes("3PL"));
    assert.equal(omittedLine(missing.omitted), "FBA, AWD, 3PL omitted (missing).");

    const plan = planProduction({
      sku: DEO,
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      asOf,
      onHand: { fba: null, inbound: null, awd: null, tpl: null },
      dailyVelocity: 20,
    });
    assert.equal(plan.stock, null);
    assert.equal(plan.currentOosDate, null);
    assert.equal(plan.newOosDate, null);
    assert.notEqual(plan.currentOosDate, asOf);
    assert.match(plan.omittedLine ?? "", /omitted \(missing\)/);
    assert.ok(plan.omitted.includes("FBA"));
    assert.ok(plan.omitted.includes("AWD"));
    assert.ok(plan.omitted.includes("3PL"));

    const awdOnly = planProduction({
      sku: DEO,
      plannedQty: null,
      availableDate: null,
      asOf,
      onHand: { fba: null, inbound: null, awd: 100, tpl: null },
      dailyVelocity: 20,
    });
    assert.equal(awdOnly.stock, 100);
    assert.notEqual(awdOnly.stock, 0);
    assert.equal(awdOnly.currentOosDate, addDays(asOf, 5));
    assert.ok(awdOnly.omitted.includes("FBA"));
    assert.ok(awdOnly.omitted.includes("3PL"));
    assert.equal(awdOnly.omitted.includes("AWD"), false);
  });

  test("weekly Plan SKU demand + 2800 landing still sets next PO = new OOS − lead − cover", () => {
    const asOf = "2026-08-28";
    const weeks = [];
    let cursor = asOf;
    for (let i = 0; i < 40; i++) {
      const end = addDays(cursor, 6);
      weeks.push({ start: cursor, end, demand: 20 * 7 });
      cursor = addDays(end, 1);
    }
    const plan = planProduction({
      sku: DEO,
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      asOf,
      onHand: { fba: 1_400, inbound: 0, awd: 0, tpl: 0 },
      dailyVelocity: 20,
      weekDemand: weeks,
    });
    assert.ok(plan.newOosDate);
    assert.equal(plan.recommendedPoDate, subtractDays(plan.newOosDate!, 70 + 60));
    assert.equal(plan.recommendedPoQty, 2_600);
  });

  test("missing sales is omitted, not a fake 0 daily", () => {
    const plan = planProduction({
      sku: DEO,
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      asOf: "2026-08-28",
      onHand: { fba: 1_400, inbound: 0, awd: 0, tpl: 0 },
      dailyVelocity: null,
    });
    assert.equal(plan.dailyDemand, null);
    assert.equal(plan.currentOosDate, null);
    assert.equal(plan.recommendedPoQty, null);
    assert.ok(plan.omitted.includes("sales"));
    assert.match(plan.omittedLine ?? "", /sales omitted \(missing\)/);
  });
});

describe("lip balm production plan", () => {
  test("uses existing holiday helpers, not a new curve", () => {
    const monthly = monthlyAmazonUnits(LIP_SALES, [LIP]);
    const demand = holidayDemandFromSales(monthly, [LIP]);
    const policy = plannerPolicy();
    const build = skuProductionBuild(demand[LIP], {
      coverDays: policy.targetCoverDays,
      receiveDays: policy.receivingDaysPeak,
    });

    const plan = planProduction({
      sku: LIP,
      plannedQty: 5_400,
      availableDate: "2026-10-01",
      asOf: "2026-08-28",
      onHand: { fba: 12_000, inbound: 0, awd: 0, tpl: 0 },
      dailyVelocity: 40,
      monthlySales: LIP_SALES,
    });

    assert.equal(plan.family, "lip_balm");
    assert.equal(productionFamily(LIP), "lip_balm");
    assert.ok(LIP_BALM_SKUS.includes(LIP));
    assert.equal(plan.coverDays, policy.targetCoverDays);
    assert.equal(plan.coverDays, 60);
    assert.equal(plan.leadDays, policy.receivingDaysPeak);
    assert.equal(plan.leadDays, 35);
    assert.equal(plan.dailyDemand, build.decDaily);
    assert.equal(
      plan.recommendedPoQty,
      coverUnitsFromDaily(build.decDaily, policy.receivingDaysPeak + policy.targetCoverDays),
    );
    assert.equal(plan.recommendedPoQty, Math.round(build.decDaily * (35 + 60)));
    assert.match(plan.leadNote, /Dec peak cover 60d/);
    assert.match(plan.leadNote, /peak receive 35d/);
    assert.ok(plan.newOosDate);
    assert.equal(
      plan.recommendedPoDate,
      subtractDays(plan.newOosDate!, plan.leadDays + plan.coverDays),
    );
  });

  test("lip path without sales omits demand instead of a 0 holiday curve", () => {
    const plan = planProduction({
      sku: LIP,
      plannedQty: 1_000,
      availableDate: "2026-10-01",
      asOf: "2026-08-28",
      onHand: { fba: 12_000, inbound: 0, awd: 0, tpl: 0 },
      dailyVelocity: 40,
      monthlySales: [],
    });
    assert.ok(plan.omitted.includes("sales"));
    assert.equal(plan.dailyDemand, null);
    assert.equal(plan.recommendedPoQty, null);
    assert.equal(plan.currentOosDate, null);
  });
});

describe("auto Plan through for landing", () => {
  test("qty + available date extends plan-through past new OOS, or avail+18mo if later", () => {
    assert.equal(PLAN_THROUGH_LANDING_PAD_MONTHS, 18);
    const available = "2026-10-15";
    const pad = addMonths(available, 18);
    assert.equal(pad, "2028-04-15");

    const daily = planProduction({
      sku: DEO,
      plannedQty: 2_800,
      availableDate: available,
      asOf: "2026-08-28",
      onHand: { fba: 1_400, inbound: 0, awd: 0, tpl: 0 },
      dailyVelocity: 20,
    });
    assert.equal(daily.newOosDate, "2027-03-26");
    assert.ok(pad > daily.newOosDate!);

    const extended = autoPlanThrough({
      plannedQty: 2_800,
      availableDate: available,
      newOosDate: daily.newOosDate,
      currentUntil: "2027-01-15",
    });
    assert.equal(extended, pad);
    assert.ok(extended! > daily.newOosDate!);
    assert.ok(extended! >= addMonths(available, 18));

    const farOos = "2030-06-01";
    const whenOosLater = autoPlanThrough({
      plannedQty: 2_800,
      availableDate: available,
      newOosDate: farOos,
      currentUntil: "2027-01-15",
    });
    assert.equal(whenOosLater, farOos);
    assert.ok(whenOosLater! > pad);
  });

  test("empty qty or date does not stomp a user plan-through", () => {
    const userUntil = "2027-06-01";
    assert.equal(
      autoPlanThrough({
        plannedQty: null,
        availableDate: "2026-10-15",
        newOosDate: "2027-03-26",
        currentUntil: userUntil,
      }),
      null,
    );
    assert.equal(
      autoPlanThrough({
        plannedQty: 2_800,
        availableDate: null,
        newOosDate: "2027-03-26",
        currentUntil: userUntil,
      }),
      null,
    );
    assert.equal(
      autoPlanThrough({
        plannedQty: 0,
        availableDate: "2026-10-15",
        newOosDate: "2027-03-26",
        currentUntil: userUntil,
      }),
      null,
    );
    const keepLater = autoPlanThrough({
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      newOosDate: "2027-03-26",
      currentUntil: "2029-12-01",
    });
    assert.equal(keepLater, "2029-12-01");
  });
});

describe("production planner source lock", () => {
  test("model calls pallet-planner holiday helpers and documents the 10-week pick", () => {
    const model = src("src/lib/production-planner-model.ts");
    assert.match(model, /holidayDemandFromSales/);
    assert.match(model, /skuProductionBuild/);
    assert.match(model, /plannerPolicy/);
    assert.match(model, /coverUnitsFromDaily/);
    assert.match(model, /decemberDailyRate/);
    assert.match(model, /LIP_BALM_SKUS/);
    assert.match(model, /PRODUCTION_LEAD_DAYS/);
    assert.match(model, /70 days \(10 weeks\)/);
    assert.doesNotMatch(model, /YOY_WINDOW_MONTHS\s*=/);
    assert.doesNotMatch(model, /DEC_DAYS\s*=/);
    assert.doesNotMatch(model, /function holidayDemandFromSales/);
    assert.doesNotMatch(model, /place a PO|createPurchaseOrder|insert.*manufacturer/i);
  });

  test("inventory table files do not mention the production planner and stay column-locked", () => {
    const page = src("src/app/inventory/page.tsx");
    const cols = src("src/lib/inventory-sku-columns.ts");
    const pallets = src("src/app/inventory/pallets/page.tsx");
    const ship = src("src/components/inventory/HolidayShipPlan.tsx");
    for (const text of [page, cols, pallets, ship]) {
      assert.doesNotMatch(text, /production-planner|Production Planner|planProduction/);
    }
    assert.doesNotMatch(cols, /label: "Reserved"/);
    assert.doesNotMatch(cols, /label: "Unfulfillable"/);
    assert.doesNotMatch(cols, /fba_reserved/);
    assert.doesNotMatch(cols, /fba_unfulfillable/);
    const model = src("src/lib/pallet-planner-model.ts");
    assert.match(model, /LOCKED_TONIGHT_3PL_FBA_SEND/);
    assert.match(model, /DDPE0004Shop: 5_400/);
    assert.match(model, /DDPE0003Shop: 4_860/);
    assert.match(model, /FIRST_WAVE_AWD_TARGET_CAP = 61_425/);
  });

  test("lives on /inventory/plan only — no /production-planner route or nav link", () => {
    const nav = src("src/components/nav.tsx");
    const planPage = src("src/app/inventory/plan/page.tsx");
    assert.equal(existsSync(path.join(process.cwd(), "src/app/production-planner/page.tsx")), false);
    assert.doesNotMatch(nav, /production-planner|Production Planner/);
    assert.doesNotMatch(nav, /\/planning\/production|\/inventory\/production/);
    assert.match(planPage, /Planned production qty/);
    assert.match(planPage, /Available date/);
    assert.match(planPage, /New OOS after qty lands/);
    assert.match(planPage, /Recommended next PO date/);
    assert.match(planPage, /Recommended next PO qty/);
    assert.match(planPage, /planProduction/);
    assert.match(planPage, /autoPlanThrough/);
    assert.match(planPage, /Recommend-only/);
    assert.match(planPage, /Plan through/);
    assert.match(planPage, /seedProduction/);
    assert.match(planPage, /showProductionStrip/);
    assert.match(planPage, /plan-production-strip/);
    assert.match(planPage, /Buffer days/);
    assert.match(planPage, /AWD in FBA supply/);
    assert.match(planPage, /3PL in FBA supply/);
    assert.match(planPage, /Stress test/);
    assert.doesNotMatch(planPage, /place a PO|submitOrder|createPO/i);
  });
});
