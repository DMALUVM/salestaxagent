import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildRecommendations, countRegisterNow } from "./registration-model";
import { countNeedsRegistration } from "./compliance-status";
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

function nexusRow(
  state_code: string,
  extras: Partial<NexusStatus> = {},
): NexusStatus {
  return {
    state_code,
    has_physical_nexus: true,
    physical_nexus_since: null,
    physical_nexus_source: "fba",
    has_economic_nexus: false,
    economic_nexus_since: null,
    economic_progress_amount: null,
    economic_progress_transactions: null,
    economic_progress_percent: 0,
    // Live PostgREST rows leave this NULL; JS/PostgREST treat that as unregistered.
    is_registered: null as unknown as boolean,
    registration_date: null,
    assigned_frequency: null,
    last_filed_through: null,
    requires_action: false,
    action_notes: null,
    confidence: null,
    account_number: null,
    updated_at: "2026-01-01T00:00:00Z",
    ...extras,
  };
}

test("badge counts REGISTER_NOW, not raw unregistered physical-nexus rows", () => {
  // Live snapshot: 8 physical-nexus states with is_registered NULL.
  // Only CA + GA match REGISTER_NOW (tier 1 + FBA + Shopify sales).
  // AL/ID/LA/MO/MS/NM are tier 3 FBA flags and stay off Register Now.
  const physical = ["AL", "CA", "GA", "ID", "LA", "MO", "MS", "NM"] as const;
  const names: Record<(typeof physical)[number], string> = {
    AL: "Alabama",
    CA: "California",
    GA: "Georgia",
    ID: "Idaho",
    LA: "Louisiana",
    MO: "Missouri",
    MS: "Mississippi",
    NM: "New Mexico",
  };
  const rules = physical.map((sc) => rule(sc, names[sc]));
  const nexus = physical.map((sc) => nexusRow(sc));
  const sales = [
    sale({ state_code: "CA", channel: "shopify", gross_sales: 4200, source: "shopify_api" }),
    sale({ state_code: "GA", channel: "shopify", gross_sales: 1800, source: "shopify_api" }),
  ];

  const recs = buildRecommendations(rules, nexus, sales, []);
  const registerNow = recs.filter((r) => r.recommendation === "REGISTER_NOW");
  assert.deepEqual(
    registerNow.map((r) => r.state_code),
    ["CA", "GA"],
  );
  assert.equal(countRegisterNow(rules, nexus, sales, []), 2);
  // The old nav filter counted all 8 unregistered physical-nexus rows.
  assert.equal(countNeedsRegistration(nexus), 8);
});

test("sidebar badge uses Register Now count on /registrations", () => {
  const nav = readFileSync(path.join(process.cwd(), "src/components/nav.tsx"), "utf8");
  assert.match(nav, /countRegisterNow/);
  assert.match(nav, /item\.href === "\/registrations"/);
  assert.doesNotMatch(
    nav,
    /item\.href === "\/compliance"/,
    "badge belongs on Nexus & Registrations, not Compliance Guides",
  );
  assert.doesNotMatch(
    nav,
    /is_registered["'], false|eq\("is_registered"/,
    "do not recount raw unregistered nexus_status rows",
  );
});
