import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateEntries, staleOpenFrequencyRows } from "./generate-filings";

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

  it("includes the mid-period month after last_filed_through even if registration is later", () => {
    const year = new Date().getFullYear();
    const rows = generateEntries("VT", "monthly", 25, `${year}-09-01`, `${year}-08-17`);
    assert.ok(rows.some((r) => r.period_label === `${year}-08` && r.period_end === `${year}-08-31`));
  });

  it("registration mid-August still generates that month", () => {
    const year = new Date().getFullYear();
    const rows = generateEntries("VT", "monthly", 25, `${year}-08-17`, `${year}-08-17`);
    assert.ok(rows.some((r) => r.period_label === `${year}-08`));
  });

  it("staleOpenFrequencyRows drops leftover WY monthly and keeps annual", () => {
    const stale = staleOpenFrequencyRows(
      [
        { id: "1", state_code: "WY", period_type: "monthly", period_label: "2026-08", status: "pending" },
        { id: "2", state_code: "WY", period_type: "annual", period_label: "2026", status: "pending" },
        { id: "3", state_code: "WY", period_type: "monthly", period_label: "2026-07", status: "filed" },
        { id: "4", state_code: "HI", period_type: "annual", period_label: "2026", status: "pending" },
      ],
      { WY: "annual", HI: "semi_annual" },
    );
    assert.deepEqual(stale.map((r) => r.id), ["1"]);
  });
});
