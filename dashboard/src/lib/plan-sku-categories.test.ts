import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  PLAN_CATEGORY_IDS,
  PLAN_CATEGORY_SEEDS,
  PLAN_SKU_ONLY_SKUS,
  categoryOnHand,
  categoryVelocity,
  liveCategorySkus,
  planCategoryOfSku,
  planCategoryProduction,
} from "./plan-sku-categories";
import {
  FORMUNOVA_PO_LEAD_DAYS,
  isLipBalmSku,
  planProduction,
} from "./production-planner-model";
import { PLAN_ERR_NO_CATEGORY_VELOCITY, planRunError } from "./plan-sku-run";
import { LIP_BALM_SKUS, plannerPolicy } from "./pallet-planner-model";
import { PRODUCTION_LEAD_DAYS } from "./inventory-four-numbers";

function src(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

const DEO = ["DDPE00019Shop", "DDPE0020Shop", "DDPE0021Shop", "DDPE0022Shop"] as const;

const LIVE_VELOCITY = [
  ...PLAN_CATEGORY_SEEDS.lip_balm,
  ...PLAN_CATEGORY_SEEDS.deodorant,
  ...PLAN_CATEGORY_SEEDS.tallow_balm,
  ...PLAN_CATEGORY_SEEDS.tallow_soap,
  "DDPE0033Shop",
  "SHOPIFY-NONE",
  "UNKNOW",
];

describe("plan SKU categories", () => {
  test("deodorant category sums the four SKUs", () => {
    assert.deepEqual([...PLAN_CATEGORY_SEEDS.deodorant], [...DEO]);
    const live = liveCategorySkus("deodorant", [...LIVE_VELOCITY]);
    assert.deepEqual(live, [...DEO]);
    assert.equal(live.length, 4);

    const vels = [
      { sku: "DDPE00019Shop", total_u_30: 17.23 },
      { sku: "DDPE0020Shop", total_u_30: 8.13 },
      { sku: "DDPE0021Shop", total_u_30: 6.73 },
      { sku: "DDPE0022Shop", total_u_30: 3.7 },
    ];
    const vel = categoryVelocity([...DEO], vels);
    assert.equal(Number(vel.daily?.toFixed(2)), 35.79);
    assert.deepEqual(vel.omittedSkus, []);

    const snaps = [
      {
        sku: "DDPE00019Shop",
        fulfillable: 400,
        reserved: 0,
        researching: 0,
        unfulfillable: 0,
        inbound_working: 10,
        inbound_shipped: 0,
        inbound_receiving: 0,
      },
      {
        sku: "DDPE0020Shop",
        fulfillable: 200,
        reserved: 0,
        researching: 0,
        unfulfillable: 0,
        inbound_working: 5,
        inbound_shipped: 0,
        inbound_receiving: 0,
      },
      {
        sku: "DDPE0021Shop",
        fulfillable: 150,
        reserved: 0,
        researching: 0,
        unfulfillable: 0,
        inbound_working: 0,
        inbound_shipped: 0,
        inbound_receiving: 0,
      },
      {
        sku: "DDPE0022Shop",
        fulfillable: 100,
        reserved: 0,
        researching: 0,
        unfulfillable: 0,
        inbound_working: 0,
        inbound_shipped: 0,
        inbound_receiving: 0,
      },
    ];
    const onHand = categoryOnHand([...DEO], snaps, [], []);
    assert.equal(onHand.fba, 850);
    assert.equal(onHand.inbound, 15);
    assert.equal(onHand.awd, null);
    assert.equal(onHand.tpl, null);

    const plan = planCategoryProduction({
      category: "deodorant",
      skus: [...DEO],
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      asOf: "2026-08-28",
      onHand,
      dailyVelocity: vel.daily,
    });
    assert.equal(plan.family, "formunova");
    assert.equal(plan.leadDays, FORMUNOVA_PO_LEAD_DAYS);
    assert.equal(plan.leadDays, 70);
    assert.equal(plan.coverDays, 60);
    assert.ok(plan.newOosDate);
    assert.ok(plan.recommendedPoDate);
    assert.ok(plan.recommendedPoQty != null && plan.recommendedPoQty > 0);
    assert.equal(Number(plan.dailyDemand?.toFixed(2)), 35.79);
    assert.equal(plan.stock, 865);
  });

  test("missing SKU source omitted, never faked as 0", () => {
    const vels = [
      { sku: "DDPE00019Shop", total_u_30: 17.23 },
      { sku: "DDPE0020Shop", total_u_30: 8.13 },
    ];
    const vel = categoryVelocity([...DEO], vels);
    assert.equal(vel.daily, 25.36);
    assert.ok(vel.omittedSkus.includes("DDPE0021Shop"));
    assert.ok(vel.omittedSkus.includes("DDPE0022Shop"));

    const snaps = [
      {
        sku: "DDPE00019Shop",
        fulfillable: 100,
        reserved: 0,
        researching: 0,
        unfulfillable: 0,
        inbound_working: 0,
        inbound_shipped: 0,
        inbound_receiving: 0,
      },
    ];
    const onHand = categoryOnHand(
      [...DEO],
      snaps,
      [{ sku: "DDPE0020Shop", awd_on_hand: 40 }],
      [],
    );
    assert.equal(onHand.fba, 100);
    assert.equal(onHand.inbound, 0);
    assert.equal(onHand.awd, 40);
    assert.equal(onHand.tpl, null);
    assert.ok(onHand.omittedSkus.includes("DDPE0021Shop"));
    assert.ok(onHand.omittedSkus.includes("DDPE0022Shop"));
    assert.equal(onHand.fba, 100, "missing SKU FBA is omitted, not added as 0");

    const live = liveCategorySkus("deodorant", ["DDPE00019Shop", "DDPE0020Shop"]);
    assert.deepEqual(live, ["DDPE00019Shop", "DDPE0020Shop"]);
    assert.equal(live.includes("DDPE0021Shop"), false);
  });

  test("lip balm / formunova lead rules unchanged", () => {
    const policy = plannerPolicy();
    assert.equal(policy.receivingDaysPeak, 35);
    assert.equal(policy.targetCoverDays, 60);
    assert.equal(FORMUNOVA_PO_LEAD_DAYS, PRODUCTION_LEAD_DAYS.balm);
    assert.equal(FORMUNOVA_PO_LEAD_DAYS, 70);
    assert.deepEqual([...PLAN_CATEGORY_SEEDS.lip_balm], [...LIP_BALM_SKUS]);
    for (const sku of LIP_BALM_SKUS) assert.equal(isLipBalmSku(sku), true);
    assert.equal(isLipBalmSku("DDPE00019Shop"), false);

    const lip = planProduction({
      sku: "DDPE0001Shop",
      plannedQty: 5_400,
      availableDate: "2026-10-01",
      asOf: "2026-08-28",
      onHand: { fba: 12_000, inbound: 0, awd: 0, tpl: 0 },
      dailyVelocity: 40,
      monthlySales: [
        { sku: "DDPE0001Shop", period_start: "2025-12-01", units: 4104, channel: "amazon", source: "amazon_spapi" },
        { sku: "DDPE0001Shop", period_start: "2026-05-01", units: 1848, channel: "amazon", source: "amazon_spapi" },
        { sku: "DDPE0001Shop", period_start: "2026-06-01", units: 2002, channel: "amazon", source: "amazon_spapi" },
        { sku: "DDPE0001Shop", period_start: "2026-07-01", units: 1775, channel: "amazon", source: "amazon_spapi" },
      ],
    });
    assert.equal(lip.family, "lip_balm");
    assert.equal(lip.leadDays, 35);
    assert.equal(lip.coverDays, 60);

    const deo = planCategoryProduction({
      category: "deodorant",
      skus: [...DEO],
      plannedQty: 2_800,
      availableDate: "2026-10-15",
      asOf: "2026-08-28",
      onHand: { fba: 850, inbound: 0, awd: 0, tpl: 0 },
      dailyVelocity: 35.79,
    });
    assert.equal(deo.family, "formunova");
    assert.equal(deo.leadDays, 70);

    const lipCat = planCategoryProduction({
      category: "lip_balm",
      skus: [...LIP_BALM_SKUS],
      plannedQty: 5_400,
      availableDate: "2026-10-01",
      asOf: "2026-08-28",
      onHand: { fba: 12_000, inbound: 0, awd: 0, tpl: 0 },
      dailyVelocity: 242,
    });
    assert.equal(lipCat.family, "lip_balm");
    assert.equal(lipCat.leadDays, 35);
    assert.equal(lipCat.coverDays, 60);
  });

  test("does not invent SKUs and leaves Sun Balm as Other", () => {
    const allSeeds = Object.values(PLAN_CATEGORY_SEEDS).flat();
    assert.equal(allSeeds.includes("DDPE0024Shop"), false);
    assert.equal(allSeeds.includes("DDPE0026Shop"), false);
    assert.equal(allSeeds.includes("DDPE0028Shop"), false);
    assert.equal(allSeeds.includes("DDPE0034Shop"), false);
    assert.equal(allSeeds.includes("DDPE0033Shop"), false);
    assert.ok(PLAN_SKU_ONLY_SKUS.includes("DDPE0033Shop"));
    assert.equal(planCategoryOfSku("DDPE0033Shop"), "other");
    assert.equal(planCategoryOfSku("SHOPIFY-NONE"), "other");
    assert.equal(planCategoryOfSku("DDPE00019Shop"), "deodorant");
    const invented = liveCategorySkus("deodorant", [...DEO, "DDPE0099Shop"]);
    assert.equal(invented.includes("DDPE0099Shop"), false);
    assert.equal(PLAN_CATEGORY_IDS.length, 4);
  });

  test("category Run with no velocity is a visible error", () => {
    assert.equal(
      planRunError({
        selectedSku: "",
        selectedCategory: "deodorant",
        velocityDaily: null,
      }),
      PLAN_ERR_NO_CATEGORY_VELOCITY,
    );
  });
});

describe("plan SKU category page wiring", () => {
  test("category control lives on /inventory/plan; production strip stays un-nested", () => {
    const page = src("src/app/inventory/plan/page.tsx");
    assert.match(page, /Category/);
    assert.match(page, /selectedCategory/);
    assert.match(page, /categoryMode/);
    assert.match(page, /All in category/);
    assert.match(page, /optgroup/);
    assert.match(page, /plan-production-strip/);
    const stripIdx = page.indexOf('id="plan-production-strip"');
    const planBlock = page.indexOf("{plan && (");
    assert.ok(stripIdx > 0 && planBlock > stripIdx);
    assert.equal(existsSync(path.join(process.cwd(), "src/app/production-planner/page.tsx")), false);
  });

  test("inventory table files unchanged and no /production-planner", () => {
    const inv = src("src/app/inventory/page.tsx");
    const cols = src("src/lib/inventory-sku-columns.ts");
    for (const text of [inv, cols]) {
      assert.doesNotMatch(text, /plan-sku-categories|PLAN_CATEGORY_SEEDS|categoryMode/);
    }
    assert.doesNotMatch(src("src/components/nav.tsx"), /production-planner|Production Planner/);
  });
});
