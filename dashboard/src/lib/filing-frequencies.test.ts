import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";
import {
  FILING_FREQUENCIES,
  FILING_FREQUENCY_LABELS,
  formatFilingFrequency,
  generatesPeriodicCalendar,
} from "./filing-frequencies";
import { obligationStatus } from "./filing-eligibility";

function src(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("filing-frequencies", () => {
  it("dropdown options include casual", () => {
    assert.ok(FILING_FREQUENCIES.includes("casual"));
    assert.equal(FILING_FREQUENCY_LABELS.casual, "Casual");
    const page = src("src/app/registrations/page.tsx");
    assert.match(page, /FILING_FREQUENCIES/);
    assert.match(page, /FILING_FREQUENCY_LABELS/);
    assert.doesNotMatch(page, /const FREQUENCIES = \["monthly"/);
  });

  it("FrequencyBadge label is Casual", () => {
    assert.equal(formatFilingFrequency("casual"), "Casual");
    assert.notEqual(formatFilingFrequency("casual"), "casual");
    const badge = src("src/components/status-badge.tsx");
    assert.match(badge, /formatFilingFrequency/);
    assert.match(badge, /casual:/);
  });

  it("keeps the existing periodic labels", () => {
    assert.deepEqual([...FILING_FREQUENCIES], [
      "monthly", "quarterly", "semi_annual", "annual", "casual",
    ]);
    assert.equal(formatFilingFrequency("monthly"), "Monthly");
    assert.equal(formatFilingFrequency("quarterly"), "Quarterly");
    assert.equal(formatFilingFrequency("semi_annual"), "Semi-Annual");
    assert.equal(formatFilingFrequency("annual"), "Annual");
  });

  it("casual does not generate a periodic calendar", () => {
    assert.equal(generatesPeriodicCalendar("casual"), false);
    assert.equal(generatesPeriodicCalendar("quarterly"), true);
    assert.equal(generatesPeriodicCalendar("annual"), true);
  });
});

describe("filing-eligibility casual", () => {
  it("supersedes leftover monthly rows when the state files casual", () => {
    const why = obligationStatus(
      {
        state_code: "UT",
        period_type: "monthly",
        period_label: "2026-08",
        period_end: "2026-08-31",
        due_date: "2026-09-20",
        status: "pending",
      },
      {
        state_code: "UT",
        is_registered: true,
        assigned_frequency: "casual",
      },
    );
    assert.equal(why?.reason, "superseded_frequency");
  });

  it("does not treat annual as a leftover periodic when the state files quarterly", () => {
    const why = obligationStatus(
      {
        state_code: "HI",
        period_type: "annual",
        period_label: "2026",
        period_end: "2026-12-31",
        due_date: "2027-01-20",
        status: "pending",
      },
      {
        state_code: "HI",
        is_registered: true,
        assigned_frequency: "quarterly",
      },
    );
    assert.equal(why, null);
  });
});
