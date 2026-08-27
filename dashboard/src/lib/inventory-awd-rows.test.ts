import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { awdRowOnHand, isAwdHighWaterCard, keepAwdInventoryRows } from "./inventory-awd-rows";
import { awdOnHandUnits } from "./inventory-owned-total";

const PULLED = "2026-08-27T10:30:00.000Z";

describe("keep AWD 0-qty rows", () => {
  test("a present row with awd_on_hand=0 is kept as 0", () => {
    const rows = keepAwdInventoryRows([
      { sku: "DDPE0001Shop", awd_on_hand: 0, pulled_at: PULLED },
      { sku: "DDPE0002Shop", awd_on_hand: 0, pulled_at: PULLED },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(awdRowOnHand(rows[0]), 0);
    assert.equal(awdOnHandUnits(rows[0]), 0);
    assert.equal(isAwdHighWaterCard(awdRowOnHand(rows[0])), false);
  });

  test("no row stays missing — never a fake 0 or the 76,211 high-water card", () => {
    const rows = keepAwdInventoryRows([
      { sku: "DDPE0001Shop", awd_on_hand: 0, pulled_at: PULLED },
    ]);
    const orange = rows.find((r) => r.sku === "DDPE0003Shop");
    assert.equal(orange, undefined);
    assert.equal(awdOnHandUnits(undefined), null);
    assert.equal(awdRowOnHand(undefined), null);
    assert.equal(isAwdHighWaterCard(76_211), true);
    assert.equal(
      rows.some((r) => Number(r.awd_on_hand) === 76_211),
      false,
    );
  });
});
