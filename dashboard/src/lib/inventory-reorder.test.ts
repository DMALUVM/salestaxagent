import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  amazonInventoryReorder,
  coverTargetDays,
  DEFAULT_INVENTORY_SETTINGS,
  reorderQty,
} from "./inventory-reorder";

describe("inventory reorder (shared with pallet planner)", () => {
  test("holiday mode uses 90-day cover", () => {
    assert.equal(coverTargetDays({ holiday_mode: true, target_cover_days: 60 }), 90);
    assert.equal(coverTargetDays({ holiday_mode: false, target_cover_days: 60 }), 60);
  });

  test("DDPE0001Shop screenshot math is ~4.2K not 1.6K", () => {
    const rec = amazonInventoryReorder({
      settings: {
        ...DEFAULT_INVENTORY_SETTINGS,
        holiday_mode: true,
        receiving_days_normal: 19,
        awd_to_fba_days: 13,
      },
      leadtime: {
        as_of_date: "2026-08-26",
        fba_receive_median: 19,
        fba_receive_n: 8,
        fba_optimized_receive_median: 19,
        fba_optimized_receive_n: 8,
        fba_single_receive_median: null,
        fba_single_receive_n: 0,
        awd_replenish_median: 13,
        awd_replenish_n: 8,
        configured_awd_to_fba_days: 14,
      },
      fba: 5234,
      inbound: 540,
      awd: 0,
      tpl: 1594,
      dailyVelocity: 106.6,
    });
    assert.equal(rec.targetDays, 90);
    assert.equal(rec.leadDays, 19);
    assert.equal(rec.onHand, 7368);
    assert.equal(rec.reorderQty, 4252);
    assert.ok(rec.reorderQty > 4000);
  });

  test("displayed 4,249 is the same formula at stored V30", () => {
    assert.equal(reorderQty(90, 19, 106.57, 7368), 4249);
  });
});
