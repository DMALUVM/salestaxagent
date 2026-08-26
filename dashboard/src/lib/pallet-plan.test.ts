import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { allocateMonthlyUnits, manufactureNeed, monthShortfall } from "./pallet-plan";

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
});
