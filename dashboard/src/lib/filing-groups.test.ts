import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { filterByDueWindow, groupByDueMonth, monthLabel } from "./filing-groups";

describe("monthLabel", () => {
  test("formats YYYY-MM as a long month name", () => {
    assert.equal(monthLabel("2026-09"), "September 2026");
    assert.equal(monthLabel("2026-01"), "January 2026");
  });
});

describe("filterByDueWindow", () => {
  const rows = [
    { due_date: "2026-08-10" }, // overdue vs 2026-08-22
    { due_date: "2026-09-15" }, // 24d
    { due_date: "2026-11-20" }, // 90d+
    { due_date: "2027-01-20" },
  ];

  test("30d keeps overdue + due within 30 days", () => {
    const got = filterByDueWindow(rows, "2026-08-22", "30d").map((r) => r.due_date);
    assert.deepEqual(got, ["2026-08-10", "2026-09-15"]);
  });

  test("90d includes the November filing", () => {
    const got = filterByDueWindow(rows, "2026-08-22", "90d").map((r) => r.due_date);
    assert.deepEqual(got, ["2026-08-10", "2026-09-15", "2026-11-20"]);
  });

  test("all is a no-op", () => {
    assert.equal(filterByDueWindow(rows, "2026-08-22", "all").length, 4);
  });
});

describe("groupByDueMonth", () => {
  test("preserves due-date order and splits months", () => {
    const groups = groupByDueMonth([
      { due_date: "2026-09-20", id: "a" },
      { due_date: "2026-09-20", id: "b" },
      { due_date: "2026-10-20", id: "c" },
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].key, "2026-09");
    assert.equal(groups[0].label, "September 2026");
    assert.equal(groups[0].rows.length, 2);
    assert.equal(groups[1].key, "2026-10");
    assert.equal(groups[1].rows[0].id, "c");
  });
});
