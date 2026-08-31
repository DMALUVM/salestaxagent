import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateEntries } from "./generate-filings";

const PERIODIC = new Set(["monthly", "quarterly", "semi_annual", "annual"]);

describe("generate-filings", () => {
  it("frequency casual inserts 0 periodic rows", () => {
    const rows = generateEntries("UT", "casual", 20, "2024-01-01");
    assert.equal(rows.length, 0);
    assert.equal(rows.filter((r) => PERIODIC.has(r.period_type)).length, 0);
  });

  it("unknown frequency is also a no-op", () => {
    assert.equal(generateEntries("UT", "not_a_real_freq", 20, null).length, 0);
  });

  it("quarterly still generates current and next year quarters", () => {
    const rows = generateEntries("UT", "quarterly", 20, null);
    const year = new Date().getFullYear();
    assert.ok(rows.length >= 8);
    assert.ok(rows.every((r) => r.period_type === "quarterly"));
    assert.ok(rows.some((r) => r.period_label === `${year}-Q1`));
    assert.ok(rows.some((r) => r.period_label === `${year + 1}-Q4`));
  });

  it("monthly / semi_annual / annual behavior is unchanged", () => {
    const monthly = generateEntries("NV", "monthly", 20, null);
    assert.equal(monthly.length, 24);
    assert.ok(monthly.every((r) => r.period_type === "monthly"));

    const semi = generateEntries("HI", "semi_annual", 20, null);
    assert.equal(semi.length, 4);
    assert.ok(semi.every((r) => r.period_type === "semi_annual"));

    const annual = generateEntries("WY", "annual", 20, null);
    assert.equal(annual.length, 2);
    assert.ok(annual.every((r) => r.period_type === "annual"));
  });
});
