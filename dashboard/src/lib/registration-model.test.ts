import test from "node:test";
import assert from "node:assert/strict";
import { buildRecommendations } from "./registration-model";
import type { NexusStatus, SalesByState, StateRule } from "./types";

function rule(state_code: string, state_name: string): StateRule {
  return {
    state_code,
    state_name,
    has_sales_tax: true,
    economic_threshold_amount: 100000,
    economic_threshold_transactions: null,
    threshold_test_type: "amount",
    fba_inventory_creates_nexus: "yes",
    marketplace_sales_count_toward_threshold: true,
    filing_frequency_default: "monthly",
    typical_due_day: 20,
    franchise_tax_notes: null,
    notes: null,
    last_reviewed: null,
  };
}

function sale(partial: Partial<SalesByState> & Pick<SalesByState, "state_code" | "channel" | "gross_sales" | "source">): SalesByState {
  return {
    id: "1",
    period_start: "2026-01-01",
    period_end: "2026-01-31",
    order_count: 1,
    net_sales: partial.gross_sales,
    tax_collected: 0,
    ingested_at: "2026-02-01T00:00:00Z",
    ...partial,
  };
}

test("quarantined Amazon tax sources do not inflate recommendation sales", () => {
  const recs = buildRecommendations(
    [rule("CA", "California")],
    [] as NexusStatus[],
    [
      sale({ state_code: "CA", channel: "amazon", gross_sales: 50000, source: "amazon_spapi" }),
      sale({ state_code: "CA", channel: "amazon", gross_sales: 999999, source: "amazon_custom_combined_tax" }),
      sale({ state_code: "CA", channel: "shopify", gross_sales: 1200, source: "shopify_api" }),
    ],
    [],
  );
  const ca = recs.find((r) => r.state_code === "CA");
  assert.ok(ca);
  assert.equal(ca!.shopify_sales, 1200);
});
