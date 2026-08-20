import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFilings, isOpenObligation, obligationStatus,
  type FilingRow, type NexusRow,
} from "./filing-eligibility";

const TODAY = "2026-08-20";

function filing(over: Partial<FilingRow> = {}): FilingRow {
  return {
    state_code: "NV", period_type: "quarterly", period_label: "2026-Q1",
    period_end: "2026-03-31", due_date: "2026-04-20", status: "pending",
    ...over,
  };
}

function nexus(over: Partial<NexusRow> = {}): NexusRow {
  return {
    state_code: "NV", is_registered: true, registration_date: "2024-01-01",
    assigned_frequency: "quarterly", last_filed_through: null,
    ...over,
  };
}

describe("registration gate", () => {
  test("unregistered state never produces an overdue return", () => {
    const why = obligationStatus(filing(), nexus({ is_registered: false }));
    assert.equal(why?.reason, "not_registered");
  });

  test("null is_registered is treated as not registered", () => {
    assert.equal(isOpenObligation(filing(), nexus({ is_registered: null })), false);
  });

  test("a state with no nexus row is not registered", () => {
    assert.equal(obligationStatus(filing(), undefined)?.reason, "not_registered");
  });

  test("registered + past due + open is overdue", () => {
    const r = classifyFilings([filing()], [nexus()], TODAY);
    assert.equal(r.overdue.length, 1);
    assert.equal(r.overdue[0].days_overdue, 122);
  });
});

describe("settled periods", () => {
  for (const status of ["filed", "not_required"]) {
    test(`${status} is never overdue`, () => {
      assert.equal(obligationStatus(filing({ status }), nexus())?.reason, "settled");
    });
  }

  test("filed stays filed after reclassification", () => {
    const r = classifyFilings([filing({ status: "filed" })], [nexus()], TODAY);
    assert.equal(r.overdue.length, 0);
    assert.equal(r.upcoming.length, 0);
    assert.equal(r.excluded[0].excluded_reason, "settled");
  });

  test("late is still an open obligation", () => {
    assert.equal(isOpenObligation(filing({ status: "late" }), nexus()), true);
  });
});

describe("last_filed_through", () => {
  test("the live NV case: Q1 and Q2 2026 are covered", () => {
    const n = nexus({ last_filed_through: "2026-06-30" });
    const cases: Array<[string, string, string]> = [
      ["2026-Q1", "2026-03-31", "2026-04-20"],
      ["2026-Q2", "2026-06-30", "2026-07-20"],
    ];
    for (const [period_label, period_end, due_date] of cases) {
      const why = obligationStatus(filing({ period_label, period_end, due_date }), n);
      assert.equal(why?.reason, "filed_through", period_label);
    }
  });

  test("a period after the high-water mark is still owed", () => {
    const n = nexus({ last_filed_through: "2026-06-30" });
    const f = filing({ period_label: "2026-Q3", period_end: "2026-09-30", due_date: "2026-10-20" });
    assert.equal(isOpenObligation(f, n), true);
  });
});

describe("frequency mismatch", () => {
  test("a stale cadence is superseded", () => {
    const f = filing({ period_type: "semi_annual", period_label: "2026-H2", period_end: "2026-12-31", due_date: "2027-01-20" });
    assert.equal(obligationStatus(f, nexus())?.reason, "superseded_frequency");
  });

  test("no assigned frequency keeps every period", () => {
    const f = filing({ period_type: "semi_annual", period_label: "2026-H2", period_end: "2026-12-31", due_date: "2027-01-20" });
    assert.equal(isOpenObligation(f, nexus({ assigned_frequency: null })), true);
  });
});

describe("pre-registration", () => {
  test("a period that closed before registration is excluded", () => {
    const f = filing({ period_label: "2023-Q1", period_end: "2023-03-31", due_date: "2023-04-20" });
    assert.equal(obligationStatus(f, nexus())?.reason, "pre_registration");
  });
});

describe("classify", () => {
  test("upcoming and overdue are separated and sorted", () => {
    const rows = [
      filing({ period_label: "2026-Q3", period_end: "2026-09-30", due_date: "2026-10-20" }),
      filing({ period_label: "2026-Q1", due_date: "2026-04-20" }),
    ];
    const r = classifyFilings(rows, [nexus()], TODAY);
    assert.deepEqual(r.overdue.map((f) => f.period_label), ["2026-Q1"]);
    assert.deepEqual(r.upcoming.map((f) => f.period_label), ["2026-Q3"]);
  });

  test("every excluded row carries a reason", () => {
    const r = classifyFilings([filing(), filing({ period_label: "X" })],
                              [nexus({ is_registered: false })], TODAY);
    assert.equal(r.excluded.length, 2);
    assert.ok(r.excluded.every((x) => x.excluded_reason));
  });

  test("due today counts as upcoming, not overdue", () => {
    const f = filing({ period_label: "2026-Q2", period_end: "2026-06-30", due_date: TODAY });
    const r = classifyFilings([f], [nexus()], TODAY);
    assert.equal(r.overdue.length, 0);
    assert.equal(r.upcoming[0].days_until_due, 0);
  });
});
