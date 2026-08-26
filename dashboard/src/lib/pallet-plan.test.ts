import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  allocateMonthlyUnits,
  holidayInboundMonths,
  manufactureNeed,
  monthPalletFillPct,
  monthShortfall,
  packPallets,
  PALLET_MAX_UNITS,
  shipByForAmazonDeadline,
  skuPackPriority,
} from "./pallet-plan";

const MONTHS = ["2026-08", "2026-09", "2026-10"];

describe("pallet monthly allocation", () => {
  test("August is inventory reorder only; holiday surplus goes to Sep/Oct", () => {
    const mixes = allocateMonthlyUnits(
      ["DDPE0001Shop"],
      { DDPE0001Shop: 4252 },
      { DDPE0001Shop: 6696 },
      MONTHS,
    );
    assert.equal(mixes[0].DDPE0001Shop, 4252);
    assert.notEqual(Math.round(6696 * 0.25), mixes[0].DDPE0001Shop);
    const later = (mixes[1].DDPE0001Shop ?? 0) + (mixes[2].DDPE0001Shop ?? 0);
    assert.equal(later, 2444);
    assert.equal(
      mixes.reduce((s, m) => s + (m.DDPE0001Shop ?? 0), 0),
      6696,
    );
    assert.deepEqual(monthShortfall(mixes[0], { DDPE0001Shop: 4252 }, ["DDPE0001Shop"]), {});
  });

  test("OK SKU with no reorder has zero August and all units in Sep/Oct", () => {
    const mixes = allocateMonthlyUnits(
      ["DDPE0002Shop"],
      { DDPE0002Shop: 0 },
      { DDPE0002Shop: 3832 },
      MONTHS,
    );
    assert.equal(mixes[0].DDPE0002Shop, undefined);
    assert.equal((mixes[1].DDPE0002Shop ?? 0) + (mixes[2].DDPE0002Shop ?? 0), 3832);
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
      ["2026-09"],
    );
    const mixes = allocateMonthlyUnits(
      ["DDPE0001Shop"],
      { DDPE0001Shop: 0 },
      { DDPE0001Shop: 4000 },
      MONTHS,
      { leadDays: 35 },
    );
    assert.equal(mixes[2].DDPE0001Shop, undefined);
    assert.equal(mixes[1].DDPE0001Shop, 4000);
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

  test("a 12k month is one pallet", () => {
    const packed = packPallets({ DDPE0001Shop: 12164 }, ["DDPE0001Shop"]);
    assert.equal(packed.length, 1);
    assert.equal(packed[0].units, 12164);
  });
});
