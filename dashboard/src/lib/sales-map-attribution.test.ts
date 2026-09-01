/**
 * Sales-map QA: destination / ship-to, quarantine, additive Shopify.
 * Hypothesis: already correct. This locks the feed; do not rebuild the map.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";

const root = process.cwd();

describe("sales-map attribution", () => {
  const page = readFileSync(path.join(root, "src/app/sales-map/page.tsx"), "utf8");
  const channels = readFileSync(path.join(root, "src/lib/channels.ts"), "utf8");

  test("reads sales_by_state and skips quarantined sources", () => {
    assert.match(page, /useSupabaseQuery<SalesByState>/);
    assert.match(page, /"sales_by_state"/);
    assert.match(page, /isQuarantinedSource\(s\.source\)/);
    assert.match(page, /m\[sc\]\.total \+= s\.gross_sales/);
  });

  test("quarantine set is the two Amazon tax dumps", () => {
    assert.match(channels, /amazon_custom_combined_tax/);
    assert.match(channels, /amazon_tax_report/);
  });

  test("all-channel total includes shopify_shop and shopify_sub", () => {
    // normalizeChannel maps those to distinct channels; they still add to total
    // when the filter is "all" because the skip is only quarantine + year/channel.
    assert.match(page, /if \(channel !== "all" && ch !== channel\) continue/);
    assert.match(page, /normalizeChannel\(s\.channel\)/);
    const shop = readFileSync(path.join(root, "src/lib/channels.ts"), "utf8");
    assert.match(shop, /SHOPIFY_SHOP = "shopify_shop"/);
    assert.match(shop, /SHOPIFY_SUB = "shopify_sub"/);
  });

  test("does not use ship-from / inventory_events", () => {
    assert.doesNotMatch(page, /inventory_events|ship_from|ship-from|fc_to_state/);
  });
});
