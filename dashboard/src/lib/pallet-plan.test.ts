import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  allocateMonthlyUnits,
  forecastByHolidayMonth,
  holidayDemandCoveringProjections,
  holidayDemandWithPlanning,
  holidayInboundMonths,
  holidayMonthPlan,
  manufactureNeed,
  monthPalletFillPct,
  monthShortfall,
  packPallets,
  PALLET_MAX_UNITS,
  shipByForAmazonDeadline,
  skuPackPriority,
} from "./pallet-plan";
import { holidayDemandUnits } from "./inventory-inbound-waves";

const MONTHS = ["2026-08", "2026-09", "2026-10"];

describe("pallet monthly allocation", () => {
  test("August keeps reorder and takes a balanced holiday share", () => {
    const mixes = allocateMonthlyUnits(
      ["DDPE0001Shop"],
      { DDPE0001Shop: 4252 },
      { DDPE0001Shop: 6696 },
      MONTHS,
    );
    assert.ok((mixes[0].DDPE0001Shop ?? 0) >= 4252);
    assert.notEqual(Math.round(6696 * 0.25), mixes[0].DDPE0001Shop);
    assert.equal(mixes[0].DDPE0001Shop, 4252 + 815);
    assert.equal(
      mixes.reduce((s, m) => s + (m.DDPE0001Shop ?? 0), 0),
      6696,
    );
    assert.deepEqual(monthShortfall(mixes[0], { DDPE0001Shop: 4252 }, ["DDPE0001Shop"]), {});
  });

  test("OK SKU leftover is split across Aug/Sep/Oct", () => {
    const mixes = allocateMonthlyUnits(
      ["DDPE0002Shop"],
      { DDPE0002Shop: 0 },
      { DDPE0002Shop: 3832 },
      MONTHS,
    );
    const qty = [0, 1, 2].map((i) => mixes[i].DDPE0002Shop ?? 0);
    assert.equal(qty.reduce((s, n) => s + n, 0), 3832);
    assert.ok(Math.max(...qty) - Math.min(...qty) <= 2);
  });

  test("old 25% split would show a shortfall vs inventory", () => {
    const gap = monthShortfall(
      { DDPE0001Shop: 1674 },
      { DDPE0001Shop: 4252 },
      ["DDPE0001Shop"],
    );
    assert.equal(gap.DDPE0001Shop, 4252 - 1674);
  });

  test("manufacture is the max of reorder and holiday gap", () => {
    assert.equal(manufactureNeed(4252, 6696), 6696);
    assert.equal(manufactureNeed(8000, 6696), 8000);
  });

  test("October ship-by is pulled forward so 19d recv still hits Oct 31", () => {
    assert.equal(shipByForAmazonDeadline("2026-10", "2026-10-31", 19), "2026-10-12");
    assert.equal(shipByForAmazonDeadline("2026-09", "2026-10-31", 19), "2026-09-20");
  });

  test("35d lead drops October from the holiday window", () => {
    assert.deepEqual(
      holidayInboundMonths(MONTHS, "2026-10-31", 35),
      ["2026-08", "2026-09"],
    );
    const mixes = allocateMonthlyUnits(
      ["DDPE0001Shop"],
      { DDPE0001Shop: 0 },
      { DDPE0001Shop: 4000 },
      MONTHS,
      { leadDays: 35 },
    );
    assert.equal(mixes[2].DDPE0001Shop, undefined);
    assert.equal((mixes[0].DDPE0001Shop ?? 0) + (mixes[1].DDPE0001Shop ?? 0), 4000);
  });

  test("months over 19k pack into multiple pallets with CRITICAL first", () => {
    const mix = { DDPE0001Shop: 8000, DDPE0002Shop: 8000, DDPE0004Shop: 9000 };
    const priority = skuPackPriority(
      Object.keys(mix),
      { DDPE0001Shop: "CRITICAL", DDPE0002Shop: "OK", DDPE0004Shop: "OK" },
      { DDPE0001Shop: 8000, DDPE0002Shop: 0, DDPE0004Shop: 0 },
    );
    const packed = packPallets(mix, priority, PALLET_MAX_UNITS);
    assert.equal(packed.length, 2);
    assert.equal(packed[0].units, PALLET_MAX_UNITS);
    assert.equal(packed[0].mix.DDPE0001Shop, 8000);
    assert.equal(packed.reduce((s, p) => s + p.units, 0), 25000);
    assert.equal(monthPalletFillPct(25000, 2), Math.round(100 * 25000 / 38000));
  });

  test("holiday demand splits Nov/Dec/Jan and floors the 92-day total", () => {
    const forecasts = [
      { sku: "DDPE0001Shop", week_start: "2026-11-02", scenario: "correction_factor", units: 1000 },
      { sku: "DDPE0001Shop", week_start: "2026-11-09", scenario: "correction_factor", units: 1100 },
      { sku: "DDPE0001Shop", week_start: "2026-12-07", scenario: "correction_factor", units: 2000 },
      { sku: "DDPE0001Shop", week_start: "2027-01-04", scenario: "correction_factor", units: 800 },
      { sku: "DDPE0001Shop", week_start: "2026-10-05", scenario: "correction_factor", units: 999 },
    ];
    const byMonth = forecastByHolidayMonth(forecasts, "DDPE0001Shop", "correction_factor");
    assert.equal(byMonth["2026-11"], 2100);
    assert.equal(byMonth["2026-12"], 2000);
    assert.equal(byMonth["2027-01"], 800);
    const plan = holidayMonthPlan(byMonth, 100);
    assert.equal(plan.forecastTotal, 4900);
    assert.equal(plan.floorTotal, 9200);
    assert.equal(plan.plannedTotal, holidayDemandWithPlanning(4900, 100, true));
    assert.equal(plan.plannedTotal, 9200);
    assert.equal(plan.months[0].forecast, 2100);
    assert.equal(plan.months[0].planned, 2100);
    assert.equal(plan.months.reduce((s, m) => s + m.planned, 0), 9200);
  });

  test("January 2026 is a proxy only when 2027-01 is missing", () => {
    const withProxy = forecastByHolidayMonth([
      { sku: "DDPE0001Shop", week_start: "2026-11-02", scenario: "correction_factor", units: 100 },
      { sku: "DDPE0001Shop", week_start: "2026-01-03", scenario: "correction_factor", units: 500 },
    ], "DDPE0001Shop", "correction_factor");
    assert.equal(withProxy["2027-01"], 500);
    const withRealJan = forecastByHolidayMonth([
      { sku: "DDPE0001Shop", week_start: "2026-01-03", scenario: "correction_factor", units: 500 },
      { sku: "DDPE0001Shop", week_start: "2027-01-04", scenario: "correction_factor", units: 80 },
    ], "DDPE0001Shop", "correction_factor");
    assert.equal(withRealJan["2027-01"], 80);
  });

  test("covering projections take the highest scenario so we do not under-build", () => {
    const forecasts = [
      { sku: "DDPE0001Shop", week_start: "2026-11-15", scenario: "correction_factor", units: 3135 },
      { sku: "DDPE0001Shop", week_start: "2026-12-06", scenario: "correction_factor", units: 6146 },
      { sku: "DDPE0001Shop", week_start: "2026-01-03", scenario: "correction_factor", units: 3190 },
      { sku: "DDPE0001Shop", week_start: "2026-11-15", scenario: "optimistic", units: 5830 },
      { sku: "DDPE0001Shop", week_start: "2026-12-06", scenario: "optimistic", units: 7363 },
      { sku: "DDPE0001Shop", week_start: "2026-01-03", scenario: "optimistic", units: 4610 },
      { sku: "DDPE0001Shop", week_start: "2026-11-15", scenario: "actual_2025", units: 1649 },
      { sku: "DDPE0001Shop", week_start: "2026-12-06", scenario: "actual_2025", units: 3866 },
      { sku: "DDPE0001Shop", week_start: "2026-01-03", scenario: "actual_2025", units: 2463 },
    ];
    const cover = holidayDemandCoveringProjections(forecasts, "DDPE0001Shop", 146.04);
    assert.equal(cover.months[0].planned, 5830);
    assert.equal(cover.months[1].planned, 7363);
    assert.equal(cover.months[2].planned, 4610);
    assert.equal(cover.plannedTotal, 17803);
    const mixes = allocateMonthlyUnits(
      ["DDPE0001Shop"],
      { DDPE0001Shop: 4355 },
      { DDPE0001Shop: 17803 - 5774 },
      MONTHS,
    );
    const august = mixes[0].DDPE0001Shop ?? 0;
    const total = mixes.reduce((s, m) => s + (m.DDPE0001Shop ?? 0), 0);
    assert.ok(august >= 4355, "August must still cover inventory reorder");
    assert.ok(total >= 4355, "three-month plan must cover inventory reorder");
    assert.equal(total, 12029);
  });

  test("holiday leftover balances across Aug/Sep/Oct without forcing 19k", () => {
    const mixes = allocateMonthlyUnits(
      ["DDPE0001Shop", "DDPE0002Shop", "DDPE0003Shop", "DDPE0004Shop"],
      { DDPE0001Shop: 4249, DDPE0002Shop: 0, DDPE0003Shop: 0, DDPE0004Shop: 0 },
      {
        DDPE0001Shop: 4249 + 3890 + 3890,
        DDPE0002Shop: 3569 + 3568,
        DDPE0003Shop: 7978 + 7978,
        DDPE0004Shop: 11592 + 11591,
      },
      MONTHS,
    );
    const totals = mixes.map((m) => Object.values(m).reduce((s, q) => s + q, 0));
    assert.ok((mixes[0].DDPE0001Shop ?? 0) >= 4249);
    assert.notEqual(totals[0], PALLET_MAX_UNITS);
    assert.ok(totals[0] > 15000 && totals[0] < 25000);
    assert.ok(Math.abs(totals[1] - totals[2]) <= 5);
  });

  test("inbound holidayDemandUnits matches covering projections", () => {
    const forecasts = [
      { sku: "DDPE0001Shop", week_start: "2026-11-15", scenario: "optimistic", units: 5830 },
      { sku: "DDPE0001Shop", week_start: "2026-12-06", scenario: "optimistic", units: 7363 },
      { sku: "DDPE0001Shop", week_start: "2026-01-03", scenario: "optimistic", units: 4610 },
    ];
    const vel = { sku: "DDPE0001Shop", total_u_30: 106.57, planning_u_30: 146.04, holiday_surge_mult: 2.4 };
    const units = holidayDemandUnits(vel, forecasts, "DDPE0001Shop");
    assert.equal(units, holidayDemandCoveringProjections(forecasts, "DDPE0001Shop", 146.04).plannedTotal);
  });

  test("a 12k month is one pallet", () => {
    const packed = packPallets({ DDPE0001Shop: 12164 }, ["DDPE0001Shop"]);
    assert.equal(packed.length, 1);
    assert.equal(packed[0].units, 12164);
  });
});
