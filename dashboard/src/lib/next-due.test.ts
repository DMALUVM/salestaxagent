import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeNextDue, mergeImpliedObligations } from "./next-due";
import { classifyFilings, type FilingRow, type NexusRow } from "./filing-eligibility";

const TODAY = "2026-09-16";
const NOW = new Date("2026-09-16T12:00:00-04:00");

describe("computeNextDue live cases", () => {
  test("VT monthly after mid-August last_filed_through is August due Sept 25", () => {
    const next = computeNextDue("2026-08-17", "monthly", 25, NOW);
    assert.ok(next);
    assert.equal(next.periodType, "monthly");
    assert.equal(next.periodLabel, "2026-08");
    assert.equal(next.periodEnd, "2026-08-31");
    assert.equal(next.due, "2026-09-25");
  });

  test("WY annual after mid-August last_filed_through is 2026 due Jan 20", () => {
    const next = computeNextDue("2026-08-17", "annual", 20, NOW);
    assert.ok(next);
    assert.equal(next.periodType, "annual");
    assert.equal(next.periodLabel, "2026");
    assert.equal(next.periodEnd, "2026-12-31");
    assert.equal(next.due, "2027-01-20");
  });
});

describe("mergeImpliedObligations", () => {
  test("backfills missing VT August when calendar starts at September", () => {
    const filings: FilingRow[] = [
      {
        state_code: "VT", period_type: "monthly", period_label: "2026-09",
        period_end: "2026-09-30", due_date: "2026-10-25", status: "pending",
      },
    ];
    const nexus: NexusRow[] = [{
      state_code: "VT", is_registered: true, assigned_frequency: "monthly",
      last_filed_through: "2026-08-17", registration_date: "2026-08-17",
    }];
    const merged = mergeImpliedObligations(filings, nexus, { VT: 25 });
    const cls = classifyFilings(merged, nexus, TODAY);
    assert.deepEqual(cls.overdue.map((f) => f.period_label), []);
    assert.ok(cls.upcoming.some((f) => f.period_label === "2026-08" && f.due_date === "2026-09-25"));
    assert.ok(cls.upcoming.some((f) => f.period_label === "2026-09"));
  });

  test("does not duplicate WY annual when the row already exists", () => {
    const filings: FilingRow[] = [
      {
        state_code: "WY", period_type: "annual", period_label: "2026",
        period_end: "2026-12-31", due_date: "2027-01-20", status: "pending",
      },
      {
        state_code: "WY", period_type: "monthly", period_label: "2026-08",
        period_end: "2026-08-31", due_date: "2026-09-20", status: "pending",
      },
    ];
    const nexus: NexusRow[] = [{
      state_code: "WY", is_registered: true, assigned_frequency: "annual",
      last_filed_through: "2026-08-17", registration_date: "2026-08-21",
    }];
    const merged = mergeImpliedObligations(filings, nexus, { WY: 20 });
    const cls = classifyFilings(merged, nexus, TODAY);
    assert.deepEqual(cls.upcoming.map((f) => `${f.period_type}:${f.period_label}`), ["annual:2026"]);
    assert.ok(cls.excluded.some((f) => f.period_type === "monthly" && f.excluded_reason === "superseded_frequency"));
  });
});
