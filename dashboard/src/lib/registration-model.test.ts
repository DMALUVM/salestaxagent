import test from "node:test";
import assert from "node:assert/strict";
import { buildRecommendations } from "./registration-model";
import type { NexusStatus, SalesByState, StateRule } from "./types";

function rule(state_code: string, extras: Partial<StateRule> = {}): StateRule {
  return {
    state_code,
    state_name: state_code,
    has_sales_tax: true,
    economic_threshold_amount: 100000,
    economic_threshold_transactions: null,
    threshold_test_type: "OR",
    fba_inventory_creates_nexus: "yes",
    marketplace_sales_count_toward_threshold: true,
    filing_frequency_default: "monthly",
    typical_due_day: 20,
    franchise_tax_notes: null,
    notes: null,
    last_reviewed: null,
    ...extras,
  };
}

function nexus(state_code: string, extras: Partial<NexusStatus> = {}): NexusStatus {
  return {
    state_code,
    has_physical_nexus: false,
    physical_nexus_since: null,
    physical_nexus_source: null,
    has_economic_nexus: false,
    economic_nexus_since: null,
    economic_progress_amount: 0,
    economic_progress_transactions: 0,
    economic_progress_percent: 0,
    is_registered: false,
    registration_date: null,
    assigned_frequency: null,
    last_filed_through: null,
    requires_action: false,
    action_notes: null,
    confidence: "medium",
    account_number: null,
    updated_at: "2026-08-01T00:00:00Z",
    ...extras,
  };
}

function sale(partial: Partial<SalesByState> & Pick<SalesByState, "state_code" | "channel" | "gross_sales">): SalesByState {
  return {
    id: "1",
    period_start: "2026-07-01",
    period_end: "2026-07-31",
    order_count: 1,
    net_sales: partial.gross_sales,
    tax_collected: 0,
    source: "amazon_spapi",
    ingested_at: "2026-08-01T00:00:00Z",
    ...partial,
  };
}

test("quarantined Amazon tax-report sales do not inflate Shopify or Amazon totals", () => {
  const recs = buildRecommendations(
    [rule("CA")],
    [nexus("CA", { has_physical_nexus: true })],
    [
      sale({
        state_code: "CA",
        channel: "amazon",
        gross_sales: 999999,
        source: "amazon_custom_combined_tax",
      }),
      sale({
        state_code: "CA",
        channel: "shopify",
        gross_sales: 50,
        source: "shopify_api",
      }),
    ],
    [],
    "2026-08-21",
  );
  const ca = recs.find((r) => r.state_code === "CA")!;
  assert.equal(ca.shopify_sales, 50);
});

test("sales older than trailing 12 months are ignored", () => {
  const recs = buildRecommendations(
    [rule("AL")],
    [nexus("AL")],
    [
      sale({
        state_code: "AL",
        channel: "shopify",
        gross_sales: 5000,
        period_start: "2024-01-01",
        period_end: "2024-01-31",
        source: "shopify_api",
      }),
    ],
    [],
    "2026-08-21",
  );
  const al = recs.find((r) => r.state_code === "AL")!;
  assert.equal(al.shopify_sales, 0);
  assert.equal(al.recommendation, "MONITOR");
});
