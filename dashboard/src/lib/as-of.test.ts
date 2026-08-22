import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { agentToday, AGENT_TZ } from "./as-of";

describe("agentToday", () => {
  test("uses America/New_York, not UTC", () => {
    assert.equal(AGENT_TZ, "America/New_York");
    // 00:30 UTC on the 21st is still the 20th in Eastern (EDT, UTC-4).
    const utc = new Date("2026-08-21T00:30:00.000Z");
    assert.equal(agentToday(utc), "2026-08-20");
  });
});
