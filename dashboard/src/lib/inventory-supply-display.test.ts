import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeManufactureTiming,
  formatManufactureAction,
  formatShipBy,
} from "./inventory-supply-display";

describe("inventory-supply-display", () => {
  it("shows Order now when manufacture deadline passed", () => {
    const today = new Date("2026-08-25T12:00:00");
    const t = computeManufactureTiming({
      manufactureQty: 5000,
      tplShipWaves: [{ ship_by: "2026-08-10", urgent: true }],
      productionLeadDays: 42,
      receivingDays: 18,
      today,
    });
    assert.equal(t.orderUrgent, true);
    assert.equal(formatManufactureAction(5000, t.orderBy, t.orderUrgent), "Order now");
  });

  it("shows future ship by date when not urgent", () => {
    const today = new Date("2026-08-25T12:00:00");
    const t = computeManufactureTiming({
      manufactureQty: 0,
      tplShipWaves: [{ ship_by: "2026-09-15", urgent: false }],
      productionLeadDays: 42,
      receivingDays: 18,
      today,
    });
    assert.equal(t.nextShipBy, "2026-09-15");
    assert.equal(formatShipBy(1000, t.nextShipBy, false), "2026-09-15");
  });
});
