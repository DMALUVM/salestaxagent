import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInboundWavePlan,
  holidayDemandUnits,
  DEFAULT_RECEIVING_DAYS,
} from "./inventory-inbound-waves";

describe("inventory-inbound-waves", () => {
  it("holiday demand uses planning_u_30 when surge > 1", () => {
    const units = holidayDemandUnits({
      sku: "X",
      planning_u_30: 100,
      holiday_surge_mult: 1.5,
    });
    assert.equal(units, 100 * 92); // 61 + 31 days
  });

  it("buildInboundWavePlan schedules from 3PL when FBA cover low", () => {
    const plan = buildInboundWavePlan({
      skus: ["SKU1"],
      snapshots: [
        {
          sku: "SKU1",
          fulfillable: 500,
          reserved: 0,
          inbound_working: 0,
          inbound_shipped: 0,
          inbound_receiving: 0,
        },
      ],
      velocities: [{ sku: "SKU1", total_u_30: 50, product_name: "Test" }],
      tpl: [{ sku: "SKU1", available: 5000 }],
      awd: [{ sku: "SKU1", awd_on_hand: 0 }],
      seasonality: [{ week: 44, multiplier: 2.0 }],
      forecast: [],
      untilDate: "2027-01-15",
      coverTargetDays: 60,
      receivingDays: DEFAULT_RECEIVING_DAYS,
    });
    assert.ok(plan.skuPlans.length === 1);
    const p = plan.skuPlans[0];
    assert.ok(p.holidayDemand > 0);
    assert.ok(p.tpl === 5000);
  });

  it("receiving days default in 2-3 week range", () => {
    assert.ok(DEFAULT_RECEIVING_DAYS >= 14 && DEFAULT_RECEIVING_DAYS <= 21);
  });
});
