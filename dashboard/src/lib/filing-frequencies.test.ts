import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FILING_FREQUENCIES,
  formatFilingFrequency,
} from "./filing-frequencies";
import { obligationStatus } from "./filing-eligibility";

describe("filing-frequencies", () => {
  it("includes casual", () => {
    assert.ok(FILING_FREQUENCIES.includes("casual"));
    assert.equal(formatFilingFrequency("casual"), "Casual");
  });
});

describe("filing-eligibility casual", () => {
  it("supersedes monthly rows when state files casual", () => {
    const why = obligationStatus(
      {
        state_code: "IA",
        period_type: "monthly",
        period_label: "2026-08",
        period_end: "2026-08-31",
        due_date: "2026-09-20",
        status: "pending",
      },
      {
        state_code: "IA",
        is_registered: true,
        assigned_frequency: "casual",
      },
    );
    assert.equal(why?.reason, "superseded_frequency");
  });
});
