import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  OVERVIEW_HEALTHY_COVER_DAYS,
  buildInventoryActions,
  inventoryActionSummary,
} from "./inventory-actions";
import type {
  InventorySnapshot,
  InventorySkuSignals,
  SkuVelocity,
} from "./types";

function snap(
  sku: string,
  fulfillable: number,
  extra: Partial<InventorySnapshot> = {},
): InventorySnapshot {
  return {
    sku,
    asin: null,
    fnsku: null,
    product_name: sku,
    fulfillable,
    inbound_working: 0,
    inbound_shipped: 0,
    inbound_receiving: 0,
    reserved: 0,
    researching: 0,
    unfulfillable: 0,
    total_quantity: fulfillable,
    ...extra,
  };
}

function vel(
  sku: string,
  opts: { amazon?: number; shopify?: number },
): SkuVelocity {
  const amazon = opts.amazon ?? 0;
  const shopify = opts.shopify ?? 0;
  const total = amazon + shopify;
  return {
    sku,
    asin: null,
    product_name: sku,
    amazon_u_7: amazon,
    amazon_u_14: amazon,
    amazon_u_30: amazon,
    amazon_u_90: amazon,
    shopify_u_7: shopify,
    shopify_u_14: shopify,
    shopify_u_30: shopify,
    shopify_u_90: shopify,
    total_u_7: total,
    total_u_14: total,
    total_u_30: total,
    total_u_90: total,
    seasonality_mult: 1,
    seasonal_total_u_30: total,
  };
}

function signal(sku: string, extra: Partial<InventorySkuSignals> = {}): InventorySkuSignals {
  return {
    sku,
    as_of_date: "2026-08-31",
    orders_u_7: 1,
    orders_u_30: 1,
    inventory_u_7: 1,
    inventory_u_30: 1,
    rate_divergence_pct: null,
    rate_agreement: null,
    measured_receive_days: 14,
    receive_sample_n: 4,
    configured_lead_days: 14,
    measured_replenish_days: null,
    replenish_sample_n: 0,
    configured_awd_to_fba_days: 14,
    ...extra,
  };
}

/** Live overview screenshot: 46–52d FBA labeled CRITICAL, some with reorder 0. */
function screenshotLikeRaw() {
  return {
    snapshots: [
      snap("DDPE0020Shop", 46),
      snap("DDPE0015Shop", 46),
      snap("DDPE00019Shop", 50),
      snap("DDPE0001Shop", 52 * 205),
    ],
    velocity: [
      vel("DDPE0020Shop", { amazon: 1 }),
      vel("DDPE0015Shop", { amazon: 1 }),
      vel("DDPE00019Shop", { amazon: 1 }),
      vel("DDPE0001Shop", { amazon: 205 }),
      vel("DDPE0012Shop", { shopify: 1 }),
      vel("DDPE0011Shop", { shopify: 1 }),
      vel("DDPE0025Shop", { shopify: 1 }),
      vel("DDPE0032Shop", { shopify: 1 }),
    ],
    awd: [{ sku: "DDPE0020Shop", awd_on_hand: 40 }, { sku: "DDPE0015Shop", awd_on_hand: 40 }],
    tpl: [
      { sku: "DDPE0012Shop", available: 58, pulled_at: "2026-08-31T00:00:00Z" },
      { sku: "DDPE0011Shop", available: 58, pulled_at: "2026-08-31T00:00:00Z" },
      { sku: "DDPE0025Shop", available: 58, pulled_at: "2026-08-31T00:00:00Z" },
      { sku: "DDPE0032Shop", available: 58, pulled_at: "2026-08-31T00:00:00Z" },
    ],
    signals: [
      signal("DDPE0020Shop"),
      signal("DDPE0015Shop"),
      signal("DDPE00019Shop"),
      signal("DDPE0001Shop"),
    ],
  };
}

describe("overview inventory actions", () => {
  test("healthy ~45d+ FBA with reorder 0 is not CRITICAL", () => {
    const actions = buildInventoryActions(
      {
        snapshots: [snap("DDPE0020Shop", 46)],
        velocity: [vel("DDPE0020Shop", { amazon: 1 })],
        awd: [{ sku: "DDPE0020Shop", awd_on_hand: 40 }],
        signals: [signal("DDPE0020Shop")],
      },
      20,
    );
    assert.equal(
      actions.some((a) => a.sku === "DDPE0020Shop"),
      false,
      "46d FBA + pipeline covering target must drop off the action list",
    );
    const summary = inventoryActionSummary({
      snapshots: [snap("DDPE0020Shop", 46)],
      velocity: [vel("DDPE0020Shop", { amazon: 1 })],
      awd: [{ sku: "DDPE0020Shop", awd_on_hand: 40 }],
      signals: [signal("DDPE0020Shop")],
    });
    assert.equal(summary.critical, 0);
    assert.equal(summary.restock, 0);
  });

  test("healthy FBA cover with a real reorder is reorder, not CRITICAL", () => {
    const actions = buildInventoryActions(
      {
        snapshots: [snap("DDPE0001Shop", 52 * 205)],
        velocity: [vel("DDPE0001Shop", { amazon: 205 })],
        signals: [signal("DDPE0001Shop")],
      },
      20,
    );
    const row = actions.find((a) => a.sku === "DDPE0001Shop");
    assert.ok(row);
    assert.equal(row.severity, "restock");
    assert.match(row.label, /reorder/);
    assert.doesNotMatch(row.label, /CRITICAL/);
    assert.ok(row.dos >= OVERVIEW_HEALTHY_COVER_DAYS);
    assert.ok(row.reorderQty > 0);
    assert.match(row.detail, /52d cover/);
    assert.match(row.detail, /u/);
  });

  test("does not hide a real FBA stockout", () => {
    const actions = buildInventoryActions(
      {
        snapshots: [snap("DDPE-OOS", 0)],
        velocity: [vel("DDPE-OOS", { amazon: 2 })],
        signals: [signal("DDPE-OOS")],
      },
      20,
    );
    const row = actions.find((a) => a.sku === "DDPE-OOS");
    assert.ok(row);
    assert.equal(row.severity, "critical");
    assert.match(row.label, /CRITICAL/);
    assert.match(row.detail, /0d FBA cover/);
    assert.ok(row.reorderQty > 0);
    assert.match(row.detail, /reorder/);
  });

  test("shopify-only cover uses warehouse units, not 0d FBA", () => {
    const actions = buildInventoryActions(
      {
        velocity: [vel("DDPE0012Shop", { shopify: 1 })],
        tpl: [{ sku: "DDPE0012Shop", available: 58, pulled_at: "2026-08-31T00:00:00Z" }],
      },
      20,
    );
    const row = actions.find((a) => a.sku === "DDPE0012Shop");
    assert.ok(row);
    assert.equal(row.severity, "restock");
    assert.equal(Math.round(row.dos), 58);
    assert.match(row.detail, /58d cover/);
    assert.doesNotMatch(row.detail, /0d cover/);
    assert.equal(row.reorderQty, 37);
    assert.match(row.detail, /37 u/);
    assert.match(row.detail, /35d lead/);
  });

  test("shopify warehouse stockout stays CRITICAL", () => {
    const actions = buildInventoryActions(
      {
        velocity: [vel("DDPE0011Shop", { shopify: 1 })],
        tpl: [{ sku: "DDPE0011Shop", available: 0, pulled_at: "2026-08-31T00:00:00Z" }],
      },
      20,
    );
    const row = actions.find((a) => a.sku === "DDPE0011Shop");
    assert.ok(row);
    assert.equal(row.severity, "critical");
    assert.match(row.detail, /0d cover/);
    assert.ok(row.reorderQty > 0);
  });

  test("screenshot-like mix: chips match list and no healthy CRITICAL", () => {
    const raw = screenshotLikeRaw();
    const actions = buildInventoryActions(raw, 20);
    const summary = inventoryActionSummary(raw);

    assert.equal(
      actions.filter((a) => a.severity === "critical").length,
      summary.critical,
    );
    assert.equal(
      actions.filter((a) => a.severity === "restock").length,
      summary.restock,
    );

    for (const row of actions.filter((a) => a.severity === "critical")) {
      assert.ok(
        row.dos < OVERVIEW_HEALTHY_COVER_DAYS,
        `${row.sku} CRITICAL with ${row.dos}d cover`,
      );
      assert.ok(
        !(row.reorderQty === 0 && row.dos >= OVERVIEW_HEALTHY_COVER_DAYS),
      );
    }

    const healthyShop = actions.find((a) => a.sku === "DDPE0020Shop");
    assert.equal(healthyShop, undefined);

    const lip = actions.find((a) => a.sku === "DDPE0001Shop");
    assert.ok(lip);
    assert.equal(lip.severity, "restock");

    const shopReorder = actions.find((a) => a.sku === "DDPE0012Shop");
    assert.ok(shopReorder);
    assert.equal(shopReorder.severity, "restock");
    assert.doesNotMatch(shopReorder.detail, /0d cover/);
  });

  test("Shop / Amazon twins stay separate and do not smash 0001 vs 00019", () => {
    const raw = {
      snapshots: [snap("DDPE00019", 800), snap("DDPE0001Shop", 52 * 10)],
      velocity: [
        vel("DDPE00019Shop", { shopify: 2 }),
        vel("DDPE0001Shop", { amazon: 10 }),
      ],
      tpl: [{ sku: "DDPE00019Shop", available: 80, pulled_at: "2026-08-31T00:00:00Z" }],
      signals: [signal("DDPE0001Shop")],
    };
    const actions = buildInventoryActions(raw, 20);

    const shopTwin = actions.find((a) => a.sku === "DDPE00019Shop");
    assert.ok(shopTwin);
    // Warehouse cover 80 / 2 = 40d, not Amazon twin's 800 FBA units.
    assert.equal(Math.round(shopTwin.dos), 40);
    assert.equal(
      actions.some((a) => a.sku === "DDPE00019"),
      false,
      "Amazon twin with no velocity must not invent a shop row",
    );

    const lip = actions.find((a) => a.sku === "DDPE0001Shop");
    assert.ok(lip);
    assert.equal(Math.round(lip.dos), 52);
    assert.notEqual(lip.sku, "DDPE00019Shop");
  });

  test("FBA below receive lead with demand is CRITICAL even if pipeline reorder is 0", () => {
    const actions = buildInventoryActions(
      {
        snapshots: [snap("FAST-FBA", 10)],
        velocity: [vel("FAST-FBA", { amazon: 1 })],
        awd: [{ sku: "FAST-FBA", awd_on_hand: 200 }],
        signals: [signal("FAST-FBA")],
      },
      20,
    );
    const row = actions.find((a) => a.sku === "FAST-FBA");
    assert.ok(row);
    assert.equal(row.severity, "critical");
    assert.equal(row.reorderQty, 0);
    assert.match(row.detail, /10d FBA cover/);
    assert.doesNotMatch(row.detail, /reorder 0/);
    assert.match(row.detail, /14d lead/);
  });

  test("rate-check chips stay independent of cover status", () => {
    const raw = {
      snapshots: [snap("RATE", 80)],
      velocity: [vel("RATE", { amazon: 1 })],
      signals: [
        signal("RATE", {
          rate_agreement: "investigate",
          rate_divergence_pct: 42,
        }),
      ],
    };
    const actions = buildInventoryActions(raw, 20);
    const summary = inventoryActionSummary(raw);
    assert.equal(summary.investigate, 1);
    assert.equal(summary.critical, 0);
    assert.equal(actions.filter((a) => a.severity === "investigate").length, 1);
    assert.match(actions[0].detail, /42%/);
  });
});
