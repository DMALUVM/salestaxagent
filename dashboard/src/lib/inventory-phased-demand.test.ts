import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  phasedDemandUnits,
  phasedStockoutDate,
} from "./inventory-phased-demand";

const seasonality = [
  { week: 40, multiplier: 1.0 },
  { week: 44, multiplier: 1.5 },
  { week: 49, multiplier: 2.8 },
];

describe("inventory-phased-demand", () => {
  it("phased demand in August is near V30 × days (not peak holiday rate)", () => {
    const units = phasedDemandUnits(40, "SKU", 60, seasonality, []);
    // ~40 u/d × 60d with slight seasonality, not 200+ u/d
    assert.ok(units > 2000 && units < 3500);
  });

  it("stockout with high FBA and low V30 is not immediate", () => {
    const out = phasedStockoutDate(4000, 42, "SKU", seasonality, []);
    assert.ok(out);
    const daysOut =
      (new Date(out).getTime() - Date.now()) / 86400000;
    assert.ok(daysOut > 60, `expected stockout >60d out, got ${daysOut}`);
  });
});
