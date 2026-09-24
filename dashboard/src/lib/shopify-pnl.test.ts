import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";
import {
  applyShopifyProfitAdjustments,
  estimateShopifyOutbound,
  SHOPIFY_OUTBOUND_FIXED_PER_ORDER,
  SHOPIFY_OUTBOUND_FLAT_FALLBACK,
  SHOPIFY_OUTBOUND_PER_UNIT,
  summarizeShopifyWindow,
  type ShopifyPnlRow,
} from "./shopify-pnl";

function row(date: string, extra: Partial<ShopifyPnlRow> = {}): ShopifyPnlRow {
  return {
    date,
    gross_sales: extra.gross_sales ?? 40,
    units: extra.units ?? 2,
    est_fba_fees: extra.est_fba_fees ?? 5.5,
    est_cogs: extra.est_cogs ?? 10,
    est_contribution: extra.est_contribution ?? 24.5,
    net_after_ads: extra.net_after_ads ?? 24.5,
    merchandise: extra.merchandise ?? 35,
    shipping_charged: extra.shipping_charged ?? 5,
    est_outbound_ship: extra.est_outbound_ship ?? 5.5,
    order_count: extra.order_count ?? 1,
    subscription_orders: extra.subscription_orders ?? 0,
    one_time_orders: extra.one_time_orders ?? 1,
    provisional_shipping_orders: extra.provisional_shipping_orders ?? 0,
    outbound_basis: extra.outbound_basis,
    cogs_basis: extra.cogs_basis,
    units_known: extra.units_known,
    ad_spend: extra.ad_spend,
    google_ad_spend: extra.google_ad_spend,
    meta_ad_spend: extra.meta_ad_spend,
  };
}

describe("summarizeShopifyWindow", () => {
  test("sums closed days in the window and ignores days after as-of", () => {
    const rows = [
      row("2026-09-01"),
      row("2026-09-05", { est_contribution: 10, order_count: 2, subscription_orders: 1, one_time_orders: 1 }),
      row("2026-09-06"),
    ];
    const w = summarizeShopifyWindow(rows, "2026-09-05", 7);
    assert.equal(w.days, 2);
    assert.equal(w.contribution, 34.5);
    assert.equal(w.orders, 3);
    assert.equal(w.subOrders, 1);
  });

  test("does not fold Amazon-only fields into a zero window when empty", () => {
    const w = summarizeShopifyWindow([], "2026-09-05", 30);
    assert.equal(w.days, 0);
    assert.equal(w.contribution, 0);
    assert.equal(w.sales, 0);
    assert.equal(w.adSpend, 0);
  });
});

describe("Shopify outbound and Google/Meta ads", () => {
  test("constants match the Apr–Jun 2026 3PL fit in business_rules.json", () => {
    const cfg = JSON.parse(
      readFileSync(path.join(process.cwd(), "..", "config", "business_rules.json"), "utf8"),
    );
    assert.equal(SHOPIFY_OUTBOUND_FIXED_PER_ORDER, cfg.shopify.outbound_fixed_per_order);
    assert.equal(SHOPIFY_OUTBOUND_PER_UNIT, cfg.shopify.outbound_per_unit);
    assert.equal(SHOPIFY_OUTBOUND_FLAT_FALLBACK, cfg.shopify.outbound_flat_fallback_per_order);
  });

  test("known units use 8.30 + 0.50×units; unknown units use 9.90", () => {
    // Apr 2026 shape: 337 orders, 1,040 sales_by_sku units.
    const apr = estimateShopifyOutbound(337, 1040, true);
    assert.equal(apr.basis, "tpl_apr_jun_2026");
    assert.equal(apr.amount, 3317.1);
    const one = estimateShopifyOutbound(1, 1, true);
    assert.equal(one.amount, 8.8);
    const unknown = estimateShopifyOutbound(10, 0, false);
    assert.equal(unknown.basis, "tpl_flat_fallback");
    assert.equal(unknown.amount, 99);
  });

  test("subtracts that day's Google + Meta and does not borrow a missing day", () => {
    // Stored row is still on the old $5.50 × 2 orders path.
    const stored = row("2026-09-14", {
      gross_sales: 65,
      units: 6,
      units_known: true,
      order_count: 2,
      est_outbound_ship: 11,
      est_fba_fees: 11,
      est_cogs: 30,
      est_contribution: 24,
      net_after_ads: 24,
      ad_spend: 0,
      merchandise: 60,
      shipping_charged: 5,
    });
    const quiet = row("2026-08-01", {
      units: 4,
      units_known: true,
      order_count: 1,
      est_outbound_ship: 5.5,
      est_fba_fees: 5.5,
      est_cogs: 0,
      est_contribution: 34.5,
      net_after_ads: 34.5,
      gross_sales: 40,
      ad_spend: 0,
    });
    const adjusted = applyShopifyProfitAdjustments(
      [stored, quiet],
      [
        { date: "2026-09-14", spend: 10 },
        { date: "2026-09-15", spend: 4 },
      ],
      [
        { date: "2026-09-14", spend: 1.5 },
        { date: "2026-09-14", spend: 0 },
      ],
    );
    const sep = adjusted.find((r) => r.date === "2026-09-14");
    const aug = adjusted.find((r) => r.date === "2026-08-01");
    const adOnly = adjusted.find((r) => r.date === "2026-09-15");
    assert.ok(sep);
    // 2×8.30 + 0.50×6 = 19.60; ads 11.50; 24 − (19.60−11) − 11.50 = 3.90
    assert.equal(sep.est_outbound_ship, 19.6);
    assert.equal(sep.ad_spend, 11.5);
    assert.equal(sep.google_ad_spend, 10);
    assert.equal(sep.meta_ad_spend, 1.5);
    assert.equal(sep.est_contribution, 3.9);
    assert.equal(sep.net_after_ads, 3.9);
    assert.ok(aug);
    assert.equal(aug.ad_spend, 0);
    assert.equal(aug.est_outbound_ship, 10.3);
    assert.ok(adOnly);
    assert.equal(adOnly.gross_sales, 0);
    assert.equal(adOnly.units, 0);
    assert.equal(adOnly.ad_spend, 4);
    assert.equal(adOnly.est_contribution, -4);
    const window = summarizeShopifyWindow(adjusted, "2026-09-15", 3);
    assert.equal(window.adSpend, 15.5);
    assert.equal(window.googleAdSpend, 14);
    assert.equal(window.metaAdSpend, 1.5);
  });

  test("applying the same Google and Meta spend twice does not double subtract", () => {
    const once = applyShopifyProfitAdjustments(
      [row("2026-09-14", { order_count: 1, units: 2, units_known: true, est_outbound_ship: 9.3, est_fba_fees: 9.3, est_contribution: 20, ad_spend: 5 })],
      [{ date: "2026-09-14", spend: 2 }],
      [{ date: "2026-09-14", spend: 3 }],
    );
    const twice = applyShopifyProfitAdjustments(
      once,
      [{ date: "2026-09-14", spend: 2 }],
      [{ date: "2026-09-14", spend: 3 }],
    );
    assert.equal(once[0].ad_spend, 5);
    assert.equal(once[0].est_contribution, twice[0].est_contribution);
    assert.equal(once[0].est_outbound_ship, twice[0].est_outbound_ship);
  });
});
