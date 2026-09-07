import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { summarizeShopifyWindow, type ShopifyPnlRow } from "./shopify-pnl";

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
  });
});
