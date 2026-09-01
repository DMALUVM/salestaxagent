import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  PLAN_ERR_NO_SKU,
  PLAN_ERR_NO_VELOCITY,
  findBySku,
  planRunError,
  planSkuOutput,
  showProductionStrip,
  skuMatchKeys,
  skusMatch,
  velocityDaily,
} from "./plan-sku-run";
import {
  EXAMPLE_FORMUNOVA_SKU,
  planProduction,
} from "./production-planner-model";

function src(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

const DEO = EXAMPLE_FORMUNOVA_SKU;

describe("plan SKU run — never silent", () => {
  test("qty+date+SKU shows production cards when weekly plan is null", () => {
    const view = planSkuOutput({
      selectedSku: DEO,
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      ran: true,
      weeklyPlan: null,
      velocityDaily: 17.23,
    });
    assert.equal(view.productionCards, true);
    assert.equal(view.weeklyPlanVisible, false);
    assert.equal(view.error, null);
  });

  test("no SKU / no velocity shows an error string", () => {
    assert.equal(planRunError({ selectedSku: "", velocityDaily: 17.23 }), PLAN_ERR_NO_SKU);
    assert.equal(
      planRunError({ selectedSku: DEO, velocityDaily: null }),
      PLAN_ERR_NO_VELOCITY,
    );
    assert.equal(
      planRunError({ selectedSku: DEO, velocityDaily: 0 }),
      PLAN_ERR_NO_VELOCITY,
    );
    const noSku = planSkuOutput({
      selectedSku: "",
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      ran: true,
      weeklyPlan: null,
      velocityDaily: null,
    });
    assert.equal(noSku.error, PLAN_ERR_NO_SKU);
    assert.equal(noSku.productionCards, true);
    const noVel = planSkuOutput({
      selectedSku: DEO,
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      ran: true,
      weeklyPlan: null,
      velocityDaily: null,
    });
    assert.equal(noVel.error, PLAN_ERR_NO_VELOCITY);
    assert.equal(noVel.productionCards, true);
  });

  test("DDPE00019Shop + 2800 + date yields newOos/nextPo", () => {
    const plan = planProduction({
      sku: DEO,
      productName: "Extra Strength Vanilla Sandalwood",
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      asOf: "2026-08-28",
      onHand: { fba: 1_400, inbound: 0, awd: 0, tpl: 0 },
      dailyVelocity: 17.23,
    });
    assert.equal(plan.sku, "DDPE00019Shop");
    assert.ok(plan.newOosDate);
    assert.ok(plan.recommendedPoDate);
    assert.ok(plan.recommendedPoQty != null && plan.recommendedPoQty > 0);
    const view = planSkuOutput({
      selectedSku: DEO,
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      ran: true,
      weeklyPlan: null,
      velocityDaily: 17.23,
    });
    assert.equal(view.productionCards, true);
    assert.equal(view.error, null);
  });

  test("ran=false after SKU change still shows production cards if qty+date set", () => {
    const afterSkuChange = planSkuOutput({
      selectedSku: DEO,
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      ran: false,
      weeklyPlan: null,
      velocityDaily: 17.23,
    });
    assert.equal(afterSkuChange.productionCards, true);
    assert.equal(afterSkuChange.weeklyPlanVisible, false);
    assert.equal(afterSkuChange.error, null);
    assert.equal(showProductionStrip({ plannedQty: 2_800, availableDate: "2026-10-15" }), true);
    assert.equal(showProductionStrip({ plannedQty: null, availableDate: "2026-10-15" }), false);
    assert.equal(showProductionStrip({ plannedQty: 2_800, availableDate: null }), false);
  });

  test("DDPE00019 matches DDPE00019Shop and Extra Strength V30 17.23 is usable", () => {
    assert.ok(skusMatch("DDPE00019", "DDPE00019Shop"));
    assert.ok(skusMatch("DDPE00019Shop", "DDPE00019"));
    assert.ok(skuMatchKeys("DDPE00019Shop").includes("ddpe00019"));
    assert.equal(skusMatch("DDPE0001", "DDPE00019"), false);
    const vel = findBySku(
      [{ sku: "DDPE00019", total_u_30: 17.23, product_name: "Extra Strength Vanilla Sandalwood" }],
      "DDPE00019Shop",
    );
    assert.ok(vel);
    assert.equal(velocityDaily(vel), 17.23);
    assert.equal(velocityDaily({ total_u_30: 0, planning_u_30: 17.23 }), 17.23);
    const weeklyBase = velocityDaily(vel);
    assert.ok(weeklyBase != null && weeklyBase > 0);
  });
});

describe("plan SKU page wiring", () => {
  test("production strip is not nested in {plan &&} and Run is never silent", () => {
    const page = src("src/app/inventory/plan/page.tsx");
    assert.match(page, /showProductionStrip/);
    assert.match(page, /planRunError/);
    assert.match(page, /findBySku/);
    assert.match(page, /velocityDaily/);
    assert.match(page, /plan-production-strip/);
    assert.match(page, /plan-run-status/);
    assert.match(page, /onRunPlan/);
    assert.match(page, /scrollIntoView/);
    assert.match(page, /Must not setRan\(false\)/);
    assert.doesNotMatch(page, /disabled=\{!selectedSku\}/);
    const stripIdx = page.indexOf('id="plan-production-strip"');
    const planBlock = page.indexOf("{plan && (");
    assert.ok(stripIdx > 0);
    assert.ok(planBlock > 0);
    assert.ok(
      stripIdx < planBlock,
      "production strip must render before / outside {plan &&}",
    );
    assert.doesNotMatch(page, /setUntilDate\(next\);\s*setRan\(false\)/);
    assert.match(
      page,
      /include3pl \? tplOh/,
      "3PL in FBA supply checkbox must change fbaSupply",
    );
  });

  test("inventory table files unchanged and no /production-planner", () => {
    const page = src("src/app/inventory/page.tsx");
    const cols = src("src/lib/inventory-sku-columns.ts");
    for (const text of [page, cols]) {
      assert.doesNotMatch(text, /plan-sku-run|planSkuOutput|plan-production-strip/);
    }
    assert.equal(existsSync(path.join(process.cwd(), "src/app/production-planner/page.tsx")), false);
  });
});
