import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildFourNumbersPlan,
  skuProductLine,
  productionLeadDays,
  PRODUCTION_LEAD_DAYS,
} from "./inventory-four-numbers";

describe("inventory-four-numbers", () => {
  it("classifies lip balm SKUs", () => {
    assert.equal(skuProductLine("DDPE0004Shop", "Lip Balm"), "lip");
    assert.equal(productionLeadDays("lip"), PRODUCTION_LEAD_DAYS.lip);
  });

  it("buildFourNumbersPlan returns four metrics", () => {
    const plan = buildFourNumbersPlan({
      skus: ["SKU1"],
      snapshots: [
        {
          sku: "SKU1",
          fulfillable: 1000,
          inbound_working: 200,
        },
      ],
      velocities: [{ sku: "SKU1", total_u_30: 30, product_name: "Tallow Balm" }],
      tpl: [{ sku: "SKU1", available: 3000 }],
      awd: [{ sku: "SKU1", awd_on_hand: 500 }],
      seasonality: [{ week: 44, multiplier: 1.5 }],
      forecast: [],
      untilDate: "2027-01-15",
    });
    assert.ok(plan.skuRows.length === 1);
    const row = plan.skuRows[0];
    assert.equal(row.productLine, "balm");
    assert.ok(row.fbaDosPhased !== null || row.fba === 1000);
    assert.ok(row.networkOosDate !== null || row.networkSupply > 0);
  });
});
