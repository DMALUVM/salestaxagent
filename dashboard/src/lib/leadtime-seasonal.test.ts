import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  applyFactor,
  buildLeadtimeSeasonal,
  calendarPrior,
  lookaheadFactor,
  monthFactor,
  percentileInclusive,
  windowLabel,
} from "./leadtime-seasonal";

describe("calendar priors", () => {
  test("late Q3 / Q4 are elevated, mid-January drops", () => {
    assert.equal(calendarPrior(new Date(2026, 5, 15)), 1.0);
    assert.equal(calendarPrior(new Date(2026, 7, 26)), 1.1);
    assert.equal(calendarPrior(new Date(2026, 8, 1)), 1.25);
    assert.equal(calendarPrior(new Date(2026, 10, 15)), 1.5);
    assert.equal(calendarPrior(new Date(2026, 11, 20)), 1.55);
    assert.equal(calendarPrior(new Date(2027, 0, 10)), 1.15);
    assert.equal(calendarPrior(new Date(2027, 0, 16)), 1.0);
  });

  test("late August look-ahead picks up September", () => {
    assert.equal(lookaheadFactor(new Date(2026, 7, 26), [], null), 1.25); // Sep in 30-day window
  });

  test("November look-ahead is peak", () => {
    const f = lookaheadFactor(new Date(2026, 10, 1), [], null);
    assert.equal(f, 1.55);
    assert.equal(windowLabel(f), "peak");
  });
});

describe("lead math", () => {
  test("percentile drops 1-3d noise and 230d stale", () => {
    assert.equal(percentileInclusive([1, 2, 3, 230], 0.75), null);
    assert.equal(percentileInclusive([4, 5, 6, 11, 12], 0.75), 11);
  });

  test("applyFactor caps at peak setting", () => {
    assert.equal(applyFactor(20, 1.25, 35), 25);
    assert.equal(applyFactor(20, 1.55, 35), 31);
    assert.equal(applyFactor(20, 2.0, 35), 35);
  });

  test("last-year November blends above the calendar prior", () => {
    const monthly = [
      { year_month: "2025-11", inbound_p50: null, inbound_p75: 18, inbound_n: 4,
        replenish_p50: null, replenish_p75: 12, replenish_n: 4, recv_p75: 30 },
      { year_month: "2026-04", inbound_p50: null, inbound_p75: 6, inbound_n: 4,
        replenish_p50: null, replenish_p75: 10, replenish_n: 4, recv_p75: 16 },
    ];
    const factor = monthFactor(new Date(2026, 10, 1), monthly, 16);
    assert.ok(factor > 1.5 && factor < 1.8);
  });

  test("planning is never shorter than observed", () => {
    const snap = buildLeadtimeSeasonal({
      today: new Date(2026, 7, 26),
      peakCap: 35,
      inboundRows: [
        { shipment_status: "CLOSED", created_at: "2026-04-01T00:00:00Z", closed_at: "2026-04-06T00:00:00Z" },
        { shipment_status: "CLOSED", created_at: "2026-08-01T00:00:00Z", closed_at: "2026-08-12T00:00:00Z" },
      ],
      replenRows: [
        { order_status: "SUCCESS", created_at: "2026-04-01T00:00:00Z", completed_at: "2026-04-11T00:00:00Z" },
        { order_status: "SUCCESS", created_at: "2026-08-01T00:00:00Z", completed_at: "2026-08-13T00:00:00Z" },
      ],
    });
    assert.ok(snap.observed_receive_days != null);
    assert.ok((snap.planning_receive_days ?? 0) >= snap.observed_receive_days);
    assert.equal(snap.factor, 1.25);
    assert.equal(snap.yoy_available, false);
  });
});
