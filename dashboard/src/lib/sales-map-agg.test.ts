import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  UNMAPPED_STATE,
  aggregateSalesMap,
  destStateKey,
  type SalesMapRow,
} from "./sales-map-agg";
import { isShopifyFamily } from "./channels";

function row(
  partial: Partial<SalesMapRow> &
    Pick<SalesMapRow, "state_code" | "channel" | "period_start" | "gross_sales">,
): SalesMapRow {
  return {
    order_count: 1,
    source: partial.channel.startsWith("amazon") ? "amazon_spapi" : "shopify_api",
    ...partial,
  };
}

/** Live CA Jan–Aug 2026 / full 2025 from sales_by_state (quarantine skipped). */
const CA_FIXTURE: SalesMapRow[] = [
  row({ state_code: "CA", channel: "amazon", period_start: "2026-01-01", gross_sales: 112902.23, source: "amazon_spapi" }),
  row({ state_code: "CA", channel: "shopify", period_start: "2026-01-01", gross_sales: 6175.21, source: "shopify_api" }),
  row({ state_code: "CA", channel: "shopify_sub", period_start: "2026-01-01", gross_sales: 814.6, source: "shopify_api" }),
  row({ state_code: "CA", channel: "shopify_shop", period_start: "2026-01-01", gross_sales: 201.89, source: "shopify_api" }),
  row({ state_code: "CA", channel: "amazon", period_start: "2025-01-01", gross_sales: 160980.46, source: "amazon_spapi" }),
  row({ state_code: "CA", channel: "shopify", period_start: "2025-01-01", gross_sales: 9373.02, source: "shopify_api" }),
  row({ state_code: "CA", channel: "shopify_shop", period_start: "2025-01-01", gross_sales: 652.71, source: "shopify_api" }),
  row({ state_code: "CA", channel: "shopify_sub", period_start: "2025-01-01", gross_sales: 181.86, source: "shopify_api" }),
  row({
    state_code: "CA",
    channel: "amazon",
    period_start: "2026-01-01",
    gross_sales: 99999,
    source: "amazon_custom_combined_tax",
  }),
];

describe("sales-map destination aggregation", () => {
  test("2026 YTD CA matches known Amazon + additive Shopify", () => {
    const { byState, skippedQuarantine } = aggregateSalesMap(
      CA_FIXTURE,
      "2026",
      "all",
      null,
      [],
    );
    const ca = byState.CA;
    assert.ok(ca);
    assert.equal(ca.amazon, 112902.23);
    assert.equal(ca.shopifySeller, 6175.21);
    assert.equal(ca.shopifyShop, 201.89);
    assert.equal(ca.shopifySub, 814.6);
    assert.equal(Number(ca.shopify.toFixed(2)), 7191.7);
    assert.equal(Number(ca.total.toFixed(2)), 120093.93);
    assert.equal(Number((ca.amazon + ca.shopify).toFixed(2)), Number(ca.total.toFixed(2)));
    assert.equal(skippedQuarantine, 99999);
  });

  test("2025 CA matches known Amazon + additive Shopify", () => {
    const { byState } = aggregateSalesMap(CA_FIXTURE, "2025", "all", null, []);
    const ca = byState.CA;
    assert.ok(ca);
    assert.equal(ca.amazon, 160980.46);
    assert.equal(Number(ca.shopify.toFixed(2)), 10207.59);
    assert.equal(Number(ca.total.toFixed(2)), 171188.05);
  });

  test("Shopify filter includes Shop + subscription", () => {
    const { byState } = aggregateSalesMap(CA_FIXTURE, "2026", "shopify", null, []);
    const ca = byState.CA;
    assert.ok(ca);
    assert.equal(ca.amazon, 0);
    assert.equal(Number(ca.shopify.toFixed(2)), 7191.7);
    assert.equal(ca.total, ca.shopify);
  });

  test("blank and non-US ship-to are holes, not a map state", () => {
    const { byState, unmapped } = aggregateSalesMap(
      [
        row({ state_code: "", channel: "amazon", period_start: "2026-03-01", gross_sales: 40 }),
        row({ state_code: "  ", channel: "shopify", period_start: "2026-03-01", gross_sales: 10 }),
        row({ state_code: "ON", channel: "shopify", period_start: "2026-03-01", gross_sales: 5 }),
        row({ state_code: "CA", channel: "amazon", period_start: "2026-03-01", gross_sales: 100 }),
      ],
      "2026",
      "all",
      null,
      [],
    );
    assert.equal(byState.CA?.total, 100);
    assert.equal(byState[UNMAPPED_STATE], undefined);
    assert.equal(unmapped.total, 55);
    assert.equal(unmapped.amazon, 40);
    assert.equal(unmapped.shopify, 15);
  });

  test("destStateKey treats blank as XX", () => {
    assert.equal(destStateKey(""), UNMAPPED_STATE);
    assert.equal(destStateKey(null), UNMAPPED_STATE);
    assert.equal(destStateKey("ca"), "CA");
    assert.equal(destStateKey("PR"), UNMAPPED_STATE);
  });

  test("isShopifyFamily is additive, isSellerResponsible is not", () => {
    assert.equal(isShopifyFamily("shopify"), true);
    assert.equal(isShopifyFamily("shopify_shop"), true);
    assert.equal(isShopifyFamily("shopify_sub"), true);
    assert.equal(isShopifyFamily("amazon"), false);
  });
});
