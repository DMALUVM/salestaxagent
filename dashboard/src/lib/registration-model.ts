/**
 * Unified registration recommendation model.
 *
 * Single source of truth for state-level recommendations used by:
 *   - /registrations (tabs)
 *   - / (overview action count)
 *   - /filings, /liability (registered filter)
 *
 * Recommendations:
 *   REGISTER_NOW — register for direct-channel obligations
 *   REVIEW       — contested/uncertain, confirm with CPA
 *   MONITOR      — FBA carve-out or below threshold, no action yet
 *   REGISTERED   — already registered
 */

import type { NexusStatus, StateRule, SalesByState, FranchiseTaxFlag } from "./types";
import { normalizeChannel, SHOPIFY } from "./channels";

export type Recommendation = "REGISTER_NOW" | "REVIEW" | "MONITOR" | "REGISTERED";

// Tier classification
const TIER2 = new Set(["AZ","AR","IL","IA","NV","NY","ND","OK","TX"]);
const TIER3 = new Set(["CO","MO","AL","HI","ID","LA","MS","NM","DC"]);
const HOME = "MD";
const TPL = new Set(["OK"]);

export function getTier(sc: string): number {
  if (TIER2.has(sc)) return 2;
  if (TIER3.has(sc)) return 3;
  return 1; // default Tier 1 for sales-tax states not in T2/T3
}

export interface StateRecommendation {
  state_code: string;
  state_name: string;
  recommendation: Recommendation;
  tier: number;
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

export function buildRecommendations(
  rules: StateRule[],
  nexus: NexusStatus[],
  sales: SalesByState[],
  flags: FranchiseTaxFlag[],
): StateRecommendation[] {
  if (!rules?.length) return [];
  const nexusMap = new Map((nexus ?? []).map(n => [n.state_code, n]));
  const flagSet = new Set((flags ?? []).map(f => f.state_code));

  // Shopify direct sales by state
  const shopifySales: Record<string, number> = {};
  for (const s of (sales ?? [])) {
    if (normalizeChannel(s.channel) === SHOPIFY) {
      shopifySales[s.state_code] = (shopifySales[s.state_code] ?? 0) + Number(s.gross_sales);
    }
  }

  const result: StateRecommendation[] = [];

  for (const r of rules) {
    if (!r.has_sales_tax) continue;
    const n = nexusMap.get(r.state_code);
    const rawReg: unknown = n?.is_registered;
    const isReg = rawReg === true || rawReg === "true" || rawReg === 1;
    const tier = getTier(r.state_code);
    const hasPhysical = !!n?.has_physical_nexus;
    const hasEconomic = !!n?.has_economic_nexus;
    const econPct = Number(n?.economic_progress_percent ?? 0);
    const fbaPresent = hasPhysical;
    const shopify = shopifySales[r.state_code] ?? 0;

    let rec: Recommendation;
    let priority: number;
    let reason: string;

    if (isReg) {
      rec = "REGISTERED";
      priority = 0;
      reason = "registered";
    } else if (r.state_code === HOME || TPL.has(r.state_code)) {
      rec = "REGISTER_NOW";
      priority = 1;
      reason = r.state_code === HOME ? "home state" : "3PL warehouse";
    } else if (hasEconomic) {
      rec = "REGISTER_NOW";
      priority = 10;
      reason = "economic threshold crossed";
    } else if (tier === 1 && fbaPresent && shopify > 0) {
      rec = "REGISTER_NOW";
      priority = 20 - Math.min(shopify / 10000, 10);
      reason = "T1 · FBA + direct sales";
    } else if (r.state_code === "PA" || r.state_code === "FL") {
      rec = fbaPresent ? "REVIEW" : "MONITOR";
      priority = fbaPresent ? 50 : 200;
      reason = fbaPresent
        ? `T1 contested · FBA present · confirm with CPA`
        : `T1 · no FBA inventory`;
    } else if (tier === 3 && (fbaPresent || econPct >= 50)) {
      rec = "REVIEW";
      priority = 60;
      reason = `T3 · ${fbaPresent ? "FBA present" : `econ ${Math.round(econPct)}%`} · unsettled`;
    } else if (tier === 1 && fbaPresent && shopify === 0) {
      rec = "MONITOR";
      priority = 150;
      reason = "T1 · FBA present · no Shopify sales yet";
    } else if (tier === 1 && !fbaPresent) {
      rec = "MONITOR";
      priority = 200;
      reason = "T1 · no FBA inventory";
    } else if (tier === 2) {
      rec = "MONITOR";
      priority = 100;
      reason = "T2 · FBA marketplace carve-out";
    } else {
      rec = "MONITOR";
      priority = 200;
      reason = tier === 3 ? "T3 · below threshold" : "below threshold";
    }

    // CA/WA always top of register-now
    if (rec === "REGISTER_NOW" && (r.state_code === "CA" || r.state_code === "WA")) {
      priority = Math.min(priority, 5);
    }

    result.push({
      state_code: r.state_code,
      state_name: r.state_name,
      recommendation: rec,
      tier,
      is_registered: isReg,
      has_physical_nexus: hasPhysical,
      has_economic_nexus: hasEconomic,
      economic_pct: econPct,
      fba_present: fbaPresent,
      shopify_sales: shopify,
      has_franchise_flag: flagSet.has(r.state_code),
      registration_date: n?.registration_date ?? null,
      registration_number: n?.registration_number ?? null,
      registration_source: n?.registration_source ?? null,
      assigned_frequency: n?.assigned_frequency ?? null,
      last_filed_through: n?.last_filed_through ?? null,
      typical_due_day: r.typical_due_day ?? null,
      filing_frequency_default: r.filing_frequency_default ?? null,
      updated_at: n?.updated_at ?? null,
      notes: r.notes ?? null,
      priority,
      reason,
    });
  }

  return result.sort((a, b) => a.priority - b.priority);
}
