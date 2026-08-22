import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { agentToday, AGENT_TZ, amazonAsOf, amazonToday, AMAZON_TZ, formatLocalYmd, shiftDays, windowStart } from "./as-of";

describe("agentToday", () => {
  test("uses America/New_York, not UTC", () => {
    assert.equal(AGENT_TZ, "America/New_York");
    // 00:30 UTC on the 21st is still the 20th in Eastern (EDT, UTC-4).
    const utc = new Date("2026-08-21T00:30:00.000Z");
    assert.equal(agentToday(utc), "2026-08-20");
  });
});

describe("amazonAsOf", () => {
  test("uses America/Los_Angeles, not UTC", () => {
    assert.equal(AMAZON_TZ, "America/Los_Angeles");
    // 06:00 UTC on the 22nd is 23:00 PDT on the 21st — today is the 21st, as-of the 20th.
    const utc = new Date("2026-08-22T06:00:00.000Z");
    assert.equal(amazonToday(utc), "2026-08-21");
    assert.equal(amazonAsOf(utc), "2026-08-20");
  });

  test("windowStart of 7 days is inclusive", () => {
    assert.equal(windowStart("2026-08-20", 7), "2026-08-14");
    assert.equal(shiftDays("2026-08-20", -364), "2025-08-21");
  });
});

describe("formatLocalYmd", () => {
  test("does not shift via UTC the way toISOString does", () => {
    const localMidnight = new Date(2026, 1, 28, 0, 0, 0);
    assert.equal(formatLocalYmd(localMidnight), "2026-02-28");
  });
});
