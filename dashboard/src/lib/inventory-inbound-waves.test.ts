import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInboundWavePlan,
  holidayDemandUnits,
  DEFAULT_RECEIVING_DAYS,
} from "./inventory-inbound-waves";
import { nextWarehouseShip } from "./inventory-supply-display";

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

  it("inbound pipeline covers gap — no urgent 3PL ship", () => {
    const plan = buildInboundWavePlan({
      skus: ["DDPE00019Shop"],
      snapshots: [
        {
          sku: "DDPE00019Shop",
          fulfillable: 730,
          reserved: 0,
          inbound_working: 0,
          inbound_shipped: 270,
          inbound_receiving: 0,
        },
      ],
      velocities: [
        { sku: "DDPE00019Shop", total_u_30: 18.2, product_name: "Test" },
      ],
      tpl: [{ sku: "DDPE00019Shop", available: 1104 }],
      awd: [{ sku: "DDPE00019Shop", awd_on_hand: 0 }],
      seasonality: [{ week: 35, multiplier: 1.0 }],
      forecast: [],
      untilDate: "2027-01-15",
      coverTargetDays: 60,
      receivingDays: 18,
    });
    const p = plan.skuPlans[0];
    const tplWaves = p.waves.filter((w) => w.source === "3PL");
    const urgentTpl = tplWaves.filter((w) => w.urgent);
    const next = nextWarehouseShip(tplWaves);
    assert.equal(urgentTpl.length, 0, "inbound should prevent urgent ship");
    assert.ok(next.units < 400, "next wave should be incremental, not full 3PL");
    assert.equal(next.urgent, false);
  });

  it("August trough does not dump full 3PL for slow SKU", () => {
    const plan = buildInboundWavePlan({
      skus: ["DDPE0004Shop"],
      snapshots: [
        {
          sku: "DDPE0004Shop",
          fulfillable: 4024,
          reserved: 0,
          inbound_working: 0,
          inbound_shipped: 0,
          inbound_receiving: 0,
        },
      ],
      velocities: [
        { sku: "DDPE0004Shop", total_u_30: 42.5, product_name: "Assorted" },
      ],
      tpl: [{ sku: "DDPE0004Shop", available: 9582 }],
      awd: [{ sku: "DDPE0004Shop", awd_on_hand: 0 }],
      seasonality: [
        { week: 35, multiplier: 1.0 },
        { week: 49, multiplier: 3.0 },
      ],
      forecast: [],
      untilDate: "2027-01-15",
      coverTargetDays: 60,
      receivingDays: 18,
    });
    const p = plan.skuPlans[0];
    assert.ok(
      p.totalShipFromWarehouse < p.tpl,
      "August should not schedule shipping entire warehouse",
    );
  });

  it("higher velocity SKU ships less than full 3PL when inbound present", () => {
    const plan = buildInboundWavePlan({
      skus: ["DDPE0001Shop"],
      snapshots: [
        {
          sku: "DDPE0001Shop",
          fulfillable: 4724,
          reserved: 0,
          inbound_working: 0,
          inbound_shipped: 1081,
          inbound_receiving: 0,
        },
      ],
      velocities: [
        { sku: "DDPE0001Shop", total_u_30: 106.7, product_name: "Unscented" },
      ],
      tpl: [{ sku: "DDPE0001Shop", available: 1594 }],
      awd: [{ sku: "DDPE0001Shop", awd_on_hand: 0 }],
      seasonality: [{ week: 35, multiplier: 1.0 }],
      forecast: [],
      untilDate: "2027-01-15",
      coverTargetDays: 60,
      receivingDays: 18,
    });
    const p = plan.skuPlans[0];
    assert.ok(p.totalShipFromWarehouse <= p.tpl);
    const tplWaves = p.waves.filter((w) => w.source === "3PL");
    assert.equal(
      tplWaves.filter((w) => w.urgent).length,
      0,
      "1081 inbound should avoid urgent flag in August",
    );
  });
});
