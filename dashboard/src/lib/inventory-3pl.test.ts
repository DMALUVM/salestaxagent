import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { live3plSnapshots } from "./inventory-3pl";

const LATEST = "2026-08-26 10:35:01.859839+00";
const STALE = "2026-08-17 13:13:32.784154+00";

describe("live3plSnapshots", () => {
  test("keeps every leftover in-stock SKU when latest cohort omits it", () => {
    const live = live3plSnapshots([
      { sku: "SKU-KEEP", available: 40, pulled_at: LATEST },
      { sku: "SKU-A19", available: 50, pulled_at: LATEST },
      { sku: "SKU-ALPHA", available: 11, pulled_at: STALE },
      { sku: "SKU-BETA", available: 22, pulled_at: STALE },
      { sku: "SKU-GAMMA", available: 33, pulled_at: STALE },
    ]);
    const skus = live.map((r) => r.sku).sort();
    assert.deepEqual(skus, [
      "SKU-A19",
      "SKU-ALPHA",
      "SKU-BETA",
      "SKU-GAMMA",
      "SKU-KEEP",
    ]);
    assert.equal(live.find((r) => r.sku === "SKU-ALPHA")?.available, 11);
    assert.equal(live.find((r) => r.sku === "SKU-BETA")?.available, 22);
    assert.equal(live.find((r) => r.sku === "SKU-GAMMA")?.available, 33);
  });

  test("does not invent stock or smash similar SKU codes", () => {
    const live = live3plSnapshots([
      { sku: "SKU-A19", available: 50, pulled_at: LATEST },
      { sku: "SKU-A1", available: 100, pulled_at: STALE },
    ]);
    assert.equal(live.length, 2);
    assert.equal(live.find((r) => r.sku === "SKU-A1")?.available, 100);
    assert.equal(live.find((r) => r.sku === "SKU-A19")?.available, 50);
    assert.equal(
      live.some((r) => r.sku === "SKU-A1" && Number(r.available) === 50),
      false,
    );
  });

  test("preserves real zero-quantity SKUs in the latest cohort", () => {
    const live = live3plSnapshots([
      { sku: "SKU-ZERO", available: 0, pulled_at: LATEST },
      { sku: "SKU-KEEP", available: 10, pulled_at: LATEST },
    ]);
    assert.equal(live.find((r) => r.sku === "SKU-ZERO")?.available, 0);
    assert.equal(live.length, 2);
  });

  test("drops stale zero leftovers and does not invent qty", () => {
    const live = live3plSnapshots([
      { sku: "SKU-KEEP", available: 10, pulled_at: LATEST },
      { sku: "SKU-GONE", available: 0, pulled_at: STALE },
    ]);
    assert.deepEqual(live.map((r) => r.sku), ["SKU-KEEP"]);
  });
});
