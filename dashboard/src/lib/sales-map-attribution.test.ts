/**
 * Sales-map page must show destination attribution, not just compute it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";

const root = process.cwd();

describe("sales-map page attribution", () => {
  const page = readFileSync(path.join(root, "src/app/sales-map/page.tsx"), "utf8");
  const channels = readFileSync(path.join(root, "src/lib/channels.ts"), "utf8");
  const agg = readFileSync(path.join(root, "src/lib/sales-map-agg.ts"), "utf8");

  test("reads sales_by_state via aggregateSalesMap", () => {
    assert.match(page, /useSupabaseQuery<SalesByState>/);
    assert.match(page, /"sales_by_state"/);
    assert.match(page, /aggregateSalesMap/);
    assert.match(agg, /isQuarantinedSource\(s\.source\)/);
    assert.match(agg, /gross_sales/);
  });

  test("quarantine set is the two Amazon tax dumps", () => {
    assert.match(channels, /amazon_custom_combined_tax/);
    assert.match(channels, /amazon_tax_report/);
  });

  test("Shopify filter is additive (seller + Shop + sub)", () => {
    assert.match(agg, /isShopifyFamily/);
    assert.match(channels, /export function isShopifyFamily/);
    assert.match(page, /seller \+ Shop \+ sub/);
  });

  test("page copy states destination ship-to and feed", () => {
    assert.match(page, /destination \(ship-to\)/);
    assert.match(page, /sales_by_state\.gross_sales/);
    assert.match(page, /amazon_spapi/);
    assert.match(page, /Blank \/ unmapped ship-to/);
    assert.match(page, /Quarantined/);
    assert.match(page, /CA \{year\}/);
  });

  test("does not use ship-from / inventory_events", () => {
    assert.doesNotMatch(page, /inventory_events|ship_from|fc_to_state/);
    assert.doesNotMatch(agg, /inventory_events|ship_from|fc_to_state/);
  });
});
