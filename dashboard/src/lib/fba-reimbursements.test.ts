import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  approvalLaDay,
  attachDayReimbursements,
  attachMonthReimbursements,
  dayReimbursements,
  monthReimbursements,
  sumReimbursementsByDay,
} from "./fba-reimbursements";

describe("approvalLaDay", () => {
  test("noon Pacific stays on the same Amazon day", () => {
    // 2026-07-15T12:00:00-07:00 = 19:00 UTC the same calendar day.
    assert.equal(approvalLaDay("2026-07-15T12:00:00-07:00"), "2026-07-15");
    assert.equal(approvalLaDay("2026-07-15T19:00:00.000Z"), "2026-07-15");
  });

  test("UTC midnight is the previous LA day (the date-only trap)", () => {
    assert.equal(approvalLaDay("2026-07-15T00:00:00.000Z"), "2026-07-14");
  });

  test("date-only is already an Amazon calendar day", () => {
    assert.equal(approvalLaDay("2026-07-15"), "2026-07-15");
  });
});

describe("sum and attach", () => {
  const july = sumReimbursementsByDay([
    { approval_date: "2026-07-02T12:00:00-07:00", amount_total: 100 },
    { approval_date: "2026-07-18T12:00:00-07:00", amount_total: 50.25 },
    { approval_date: "2026-07-28T12:00:00-07:00", amount_total: -3423.78 },
    { approval_date: "2026-08-01T12:00:00-07:00", amount_total: 10 },
  ]);

  test("credits and reversals net on the approval day", () => {
    assert.equal(july["2026-07-02"], 100);
    assert.equal(july["2026-07-28"], -3423.78);
    assert.equal(dayReimbursements(july, "2026-07-15"), 0);
  });

  test("July month sum is the SKU Economics cash figure shape (net negative)", () => {
    // 100 + 50.25 - 3423.78 = -3273.53
    assert.equal(monthReimbursements(july, "2026-07"), -3273.53);
    assert.equal(monthReimbursements(july, "2026-08"), 10);
    assert.equal(monthReimbursements(july, "2026-06"), 0);
  });

  test("daily attach does not invent a day and shows $0 when none", () => {
    const rows = attachDayReimbursements(
      [{ date: "2026-07-02" }, { date: "2026-07-15" }],
      july,
    );
    assert.equal(rows[0].reimbursements, 100);
    assert.equal(rows[1].reimbursements, 0);
  });

  test("monthly attach uses every approval day in the month, not just P&L days", () => {
    const months = attachMonthReimbursements(
      [{ date: "2026-07-01" }, { date: "2026-08-01" }],
      july,
    );
    assert.equal(months[0].reimbursements, -3273.53);
    assert.equal(months[1].reimbursements, 10);
  });
});
