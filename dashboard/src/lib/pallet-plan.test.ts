import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  allocateMonthlyUnits,
  manufactureNeed,
  monthPalletFillPct,
  monthShortfall,
  packPallets,
  PALLET_MAX_UNITS,
  skuPackPriority,
} from "./pallet-plan";

describe("pallet monthly allocation", () => {
  test("month 1 ships the inventory reorder instead of a 25% holiday slice", () => {
    const mixes = allocateMonthlyUnits(
      ["DDPE0001Shop"],
      { DDPE0001Shop: 4252 },
      { DDPE0001Shop: 6696 },
      3,
      [0.25, 0.35, 0.40],
    );
    const month1 = mixes[0].DDPE0001Shop ?? 0;
    assert.equal(Math.round(6696 * 0.25), 1674);
    assert.ok(month1 >= 4252, `month 1 ${month1} should cover inventory reorder`);
    assert.ok(month1 > 1674);
    assert.equal(
      mixes.reduce((s, m) => s + (m.DDPE0001Shop ?? 0), 0),
      6696,
    );
    assert.deepEqual(monthShortfall(mixes[0], { DDPE0001Shop: 4252 }, ["DDPE0001Shop"]), {});
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
