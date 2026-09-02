/**
 * Shared recommendation model for registration triage.
 *
 * Provides a deterministic recommendation (REGISTER_NOW / REVIEW / MONITOR /
 * REGISTERED) for each state based on nexus status, sales data, and
 * business context (home state, 3PL, tier, FBA presence).
 */

import type { NexusStatus, StateRule, SalesByState } from "@/lib/types";
import { normalizeChannel, SHOPIFY, AMAZON, isQuarantinedSource } from "@/lib/channels";

// ── Types ─────────────────────────────────────────────────

export type Recommendation =
  | "REGISTER_NOW"
  | "REVIEW"
  | "MONITOR"
  | "REGISTERED";

export interface StateRecommendation {
  state_code: string;
  state_name: string;
  recommendation: Recommendation;
  tier: 1 | 2 | 3;
  is_registered: boolean;
  has_physical_nexus: boolean;
  has_economic_nexus: boolean;
  economic_pct: number;
  fba_present: boolean;
  shopify_sales: number;
  has_franchise_flag: boolean;
  registration_date: string | null;
  registration_number: string | null;
  registration_source: string | null;
  assigned_frequency: string | null;
  last_filed_through: string | null;
  typical_due_day: number | null;
  filing_frequency_default: string | null;
  updated_at: string | null;
  notes: string | null;
  priority: number;
  reason: string;
}

// ── Constants ─────────────────────────────────────────────

const HOME_STATE = "MD";
const TPL_STATE = "OK";

const TIER_2: Set<string> = new Set([
  "AZ", "AR", "IL", "IA", "NV", "NY", "ND", "OK", "TX",
]);
const TIER_3: Set<string> = new Set([
  "CO", "MO", "AL", "HI", "ID", "LA", "MS", "NM", "DC",
]);

// PA and FL have contested FBA nexus positions
const CONTESTED_STATES: Set<string> = new Set(["PA", "FL"]);

// ── Helpers ───────────────────────────────────────────────

export function getTier(stateCode: string): 1 | 2 | 3 {
  if (TIER_2.has(stateCode)) return 2;
  if (TIER_3.has(stateCode)) return 3;
  return 1;
}

function coerceRegistered(val: unknown): boolean {
  return val === true || val === "true" || val === 1 || val === "1";
}

// ── Builder ───────────────────────────────────────────────

export function buildRecommendations(
  rules: StateRule[],
  nexus: NexusStatus[],
  sales: SalesByState[],
  flags: Array<{ state_code: string; [key: string]: unknown }>,
): StateRecommendation[] {
  if (!rules || rules.length === 0) return [];

  const nexusMap = new Map(nexus.map((n) => [n.state_code, n]));

  // Aggregate trailing-12m sales by state + channel
  const salesMap: Record<string, { shopify: number; amazon: number }> = {};
  for (const s of sales) {
    const sc = s.state_code;
    if (!sc) continue;
    if (isQuarantinedSource(s.source)) continue;
    if (!salesMap[sc]) salesMap[sc] = { shopify: 0, amazon: 0 };
    const ch = normalizeChannel(s.channel ?? "");
    const amt = Number(s.gross_sales) || 0;
    if (ch === SHOPIFY) salesMap[sc].shopify += amt;
    else if (ch === AMAZON) salesMap[sc].amazon += amt;
  }

  // Franchise flags by state
  const flagSet = new Set<string>();
  for (const f of flags ?? []) {
    if (f.state_code) flagSet.add(f.state_code);
  }

  const results: StateRecommendation[] = [];

  for (const rule of rules) {
    if (!rule.has_sales_tax) continue;
    const sc = rule.state_code;
    const n = nexusMap.get(sc);
    const tier = getTier(sc);
    const isReg = coerceRegistered(n?.is_registered);
    const hasPhysical = !!n?.has_physical_nexus;
    const hasEconomic = !!n?.has_economic_nexus;
    const econPct = Number(n?.economic_progress_percent) || 0;
    const sale = salesMap[sc] ?? { shopify: 0, amazon: 0 };
    const fbaPresent = hasPhysical; // physical nexus implies FBA presence
    const hasFranchise = flagSet.has(sc);

    let recommendation: Recommendation;
    let reason: string;
    let priority: number;

    if (isReg) {
      recommendation = "REGISTERED";
      reason = "Already registered for sales tax";
      priority = 40;
    } else if (sc === HOME_STATE) {
      recommendation = "REGISTER_NOW";
      reason = "Home state -- registration required";
      priority = 1;
    } else if (sc === TPL_STATE) {
      recommendation = "REGISTER_NOW";
      reason = "3PL location -- physical nexus via fulfillment center";
      priority = 2;
    } else if (hasEconomic) {
      recommendation = "REGISTER_NOW";
      reason = `Economic nexus threshold crossed (${econPct.toFixed(0)}%)`;
      priority = 3;
    } else if (tier === 1 && fbaPresent && sale.shopify > 0) {
      recommendation = "REGISTER_NOW";
      reason = "Tier 1 state with FBA presence and active Shopify sales";
      priority = 5;
    } else if (CONTESTED_STATES.has(sc) && (hasPhysical || sale.shopify > 0)) {
      recommendation = "REVIEW";
      reason = `${sc} has contested FBA nexus position -- CPA review recommended`;
      priority = 10;
    } else if (tier === 3 && (sale.shopify > 1000 || hasFranchise)) {
      recommendation = "REVIEW";
      reason = "Tier 3 state with material exposure or franchise tax flag";
      priority = 15;
    } else {
      recommendation = "MONITOR";
      reason = econPct > 0
        ? `Below threshold (${econPct.toFixed(0)}%)`
        : "No nexus indicators detected";
      priority = 30;
    }

    results.push({
      state_code: sc,
      state_name: rule.state_name,
      recommendation,
      tier,
      is_registered: isReg,
      has_physical_nexus: hasPhysical,
      has_economic_nexus: hasEconomic,
      economic_pct: Math.round(econPct * 10) / 10,
      fba_present: fbaPresent,
      shopify_sales: Math.round(sale.shopify * 100) / 100,
      has_franchise_flag: hasFranchise,
      registration_date: n?.registration_date ?? null,
      registration_number: n?.account_number ?? null,
      registration_source: null,
      assigned_frequency: n?.assigned_frequency ?? null,
      last_filed_through: n?.last_filed_through ?? null,
      typical_due_day: rule.typical_due_day ?? null,
      filing_frequency_default: rule.filing_frequency_default ?? null,
      updated_at: n?.updated_at ?? null,
      notes: rule.notes ?? null,
      priority,
      reason,
    });
  }

  // Sort by priority ascending (highest urgency first)
  results.sort((a, b) => a.priority - b.priority || a.state_code.localeCompare(b.state_code));

  return results;
}

/**
 * Sidebar badge count. Must stay equal to the Register Now card on
 * /registrations — never a raw unregistered-nexus row count.
 */
export function countRegisterNow(
  rules: StateRule[],
  nexus: NexusStatus[],
  sales: SalesByState[],
  flags: Array<{ state_code: string; [key: string]: unknown }> = [],
): number {
  return buildRecommendations(rules, nexus, sales, flags)
    .filter((r) => r.recommendation === "REGISTER_NOW").length;
}
