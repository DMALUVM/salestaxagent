import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { live3plSnapshots } from "./inventory-3pl";

const LATEST = "2026-08-26 10:35:01.859839+00";
const STALE = "2026-08-17 13:13:32.784154+00";

describe("live3plSnapshots", () => {
  test("keeps leftover in-stock SKU when latest cohort omits it", () => {
    const live = live3plSnapshots([
      { sku: "DDPE0002Shop", available: 6448, pulled_at: LATEST },
      { sku: "DDPE00019Shop", available: 831, pulled_at: LATEST },
      { sku: "DDPE0001Shop", available: 1594, pulled_at: STALE },
      { sku: "DDPE0012Shop", available: 60, pulled_at: STALE },
    ]);
    const skus = live.map((r) => r.sku).sort();
    assert.deepEqual(skus, [
      "DDPE00019Shop",
      "DDPE0001Shop",
      "DDPE0002Shop",
      "DDPE0012Shop",
    ]);
    assert.equal(live.find((r) => r.sku === "DDPE0001Shop")?.available, 1594);
  });

  test("does not invent stock or smash 0001 into 00019", () => {
    const live = live3plSnapshots([
      { sku: "DDPE00019Shop", available: 831, pulled_at: LATEST },
      { sku: "DDPE0001Shop", available: 1594, pulled_at: STALE },
    ]);
    assert.equal(live.length, 2);
    assert.equal(live.find((r) => r.sku === "DDPE0001Shop")?.available, 1594);
    assert.equal(live.find((r) => r.sku === "DDPE00019Shop")?.available, 831);
    assert.equal(
      live.some((r) => r.sku === "DDPE0001Shop" && Number(r.available) === 831),
      false,
    );
  });

  test("preserves real zero-quantity SKUs in the latest cohort", () => {
    const live = live3plSnapshots([
      { sku: "DDPE0009Shop", available: 0, pulled_at: LATEST },
      { sku: "DDPE0002Shop", available: 10, pulled_at: LATEST },
    ]);
    assert.equal(live.find((r) => r.sku === "DDPE0009Shop")?.available, 0);
    assert.equal(live.length, 2);
  });

  test("drops stale zero leftovers and does not invent qty", () => {
    const live = live3plSnapshots([
      { sku: "DDPE0002Shop", available: 10, pulled_at: LATEST },
      { sku: "GONEShop", available: 0, pulled_at: STALE },
    ]);
    assert.deepEqual(live.map((r) => r.sku), ["DDPE0002Shop"]);
  });
});
