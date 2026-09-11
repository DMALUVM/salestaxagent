/**
 * Sales-tax registration plan — TypeScript port of
 * `src/exports/registration_plan.py`.
 *
 * The decision is a pure function over already-gathered facts (`decide`), so
 * Vercel can rank the plan from warehouse tables without shelling out to
 * Python. Keep this file in lockstep with the Python module: contested FBA
 * nexus never becomes a silent register_now, a no-sales-tax state can never
 * be a target, and entity taxes never drive the action.
 *
 * The per-state cards on /registrations still use `buildRecommendations` in
 * registration-model.ts (a coarser triage). This module is the auditable
 * ranked plan the Nexus card displays.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { isQuarantinedSource } from "@/lib/channels";
import { isRegistered } from "@/lib/compliance-status";
import bundledRules from "./state-sales-tax-rules.json";
import { fetchAllRows } from "@/lib/warehouse-snapshot";

/** Recommended actions, in the order the UI should present them. */
export const ACTIONS = [
  "register_now",
  "review_contested",
  "monitor",
  "already_registered",
  "no_sales_tax",
] as const;

export type PlanAction = (typeof ACTIONS)[number];

export const DEFAULT_WARN_PCT = 80;

const FBA_CREATES_NEXUS = new Set(["true", "unknown_default_true", "True"]);
const FBA_NEEDS_REVIEW = new Set(["contested", "conditional"]);
const FBA_NO_NEXUS = new Set(["false", "False"]);

export interface StateFacts {
  state_code: string;
  has_sales_tax: boolean;
  is_registered: boolean;
  fba_rule: string;
  inventory_events: number;
  inventory_first: string | null;
  inventory_last: string | null;
  economic_exceeded: boolean;
  economic_pct: number;
  shopify_sales: number;
  amazon_sales: number;
  /** Footnote only — never an input to `decide`. */
  entity_exposure: boolean;
}

export interface Decision {
  action: PlanAction;
  reason: string;
  confidence: "high" | "medium" | "low";
  physical_nexus: "Y" | "N" | "contested";
  economic_nexus: string;
}

export interface PlanRow {
  facts: StateFacts;
  decision: Decision;
  entity_note: string;
  residual_risk: string;
}

export interface PlanApiRow {
  state: string;
  sales_tax: string;
  already_registered: string;
  physical_nexus: string;
  first_inventory_date: string;
  economic_nexus: string;
  shopify_sales: string;
  amazon_sales: string;
  total_relevant_sales: string;
  recommended_action: string;
  short_reason: string;
  confidence: string;
  entity_note: string;
}

export interface PlanResult {
  rows: PlanApiRow[];
  counts: Record<PlanAction, number>;
  residual_risk: string;
  source: "warehouse";
  warehouse_empty: boolean;
}

export interface RuleFact {
  has_sales_tax: boolean;
  fba_inventory_creates_nexus: string;
}

export interface InventoryPresence {
  events: number;
  min_date: string | null;
  max_date: string | null;
}

export interface ChannelSales {
  shopify: number;
  amazon: number;
}

export interface NexusFact {
  is_registered?: unknown;
  has_economic_nexus?: unknown;
  economic_progress_percent?: unknown;
}

export interface PlanInputs {
  rules: Record<string, RuleFact>;
  nexus: Record<string, NexusFact>;
  inventory: Record<string, InventoryPresence>;
  sales: Record<string, ChannelSales>;
  entityStates: Iterable<string>;
  warnPct?: number;
  unmappedInventoryEvents?: number;
}

export function totalRelevantSales(f: Pick<StateFacts, "shopify_sales" | "amazon_sales">): number {
  return Math.round((Number(f.shopify_sales) + Number(f.amazon_sales)) * 100) / 100;
}

export function hasInventory(f: Pick<StateFacts, "inventory_events">): boolean {
  return (f.inventory_events ?? 0) > 0;
}

export function normalizeFbaRule(raw: unknown): string {
  if (raw === true || raw === 1 || raw === "1") return "true";
  if (raw === false || raw === 0 || raw === "0") return "false";
  if (raw == null || raw === "") return "unknown_default_true";
  return String(raw);
}

/** Missing / null defaults to true — a state with no rule must not vanish as no-tax. */
export function coerceHasSalesTax(raw: unknown): boolean {
  if (raw === false || raw === "false" || raw === "False" || raw === 0 || raw === "0" || raw === "N") {
    return false;
  }
  return true;
}

function pyGroupedInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function physicalLabel(f: StateFacts): Decision["physical_nexus"] {
  if (!hasInventory(f)) return "N";
  if (FBA_CREATES_NEXUS.has(f.fba_rule)) return "Y";
  return "contested";
}

function economicLabel(f: StateFacts, warnPct: number): string {
  if (f.economic_exceeded) return "Y";
  if (f.economic_pct >= warnPct) return `approaching ${Math.round(f.economic_pct)}%`;
  return "N";
}

/**
 * Recommend an action for one state. Pure — no DB, no clock.
 *
 * Order encodes the rules: no sales tax exits before any trigger, and
 * registration is checked before triggers so an already-registered state
 * never shows up as work to do.
 */
export function decide(f: StateFacts, warnPct: number = DEFAULT_WARN_PCT): Decision {
  const phys = physicalLabel(f);
  const econ = economicLabel(f, warnPct);
  const total = totalRelevantSales(f);

  if (!f.has_sales_tax) {
    const note = "no state sales tax"
      + (f.entity_exposure
        ? " (entity/gross-receipts exposure may still exist — see /entity)"
        : "");
    return { action: "no_sales_tax", reason: note, confidence: "high", physical_nexus: phys, economic_nexus: econ };
  }

  if (f.is_registered) {
    return {
      action: "already_registered",
      reason: "already registered to collect",
      confidence: "high",
      physical_nexus: phys,
      economic_nexus: econ,
    };
  }

  if (f.economic_exceeded) {
    return {
      action: "register_now",
      reason:
        `economic threshold exceeded (${Math.round(f.economic_pct)}% of threshold, `
        + `$${pyGroupedInt(total)} relevant sales)`,
      confidence: "high",
      physical_nexus: phys,
      economic_nexus: econ,
    };
  }

  if (hasInventory(f) && FBA_CREATES_NEXUS.has(f.fba_rule)) {
    const researched = f.fba_rule === "true" || f.fba_rule === "True";
    const confidence = researched ? "high" : "medium";
    const basis = researched
      ? "state rule: FBA inventory creates nexus"
      : "state rule unresearched — repo default assumes FBA inventory "
        + "creates nexus (conservative)";
    return {
      action: "register_now",
      reason:
        `FBA inventory since ${f.inventory_first} `
        + `(${pyGroupedInt(f.inventory_events)} events); ${basis}`,
      confidence,
      physical_nexus: phys,
      economic_nexus: econ,
    };
  }

  if (hasInventory(f) && (FBA_NEEDS_REVIEW.has(f.fba_rule) || FBA_NO_NEXUS.has(f.fba_rule))) {
    const why = FBA_NO_NEXUS.has(f.fba_rule)
      ? "state rule says FBA inventory does NOT create nexus"
      : `state rule is ${f.fba_rule} — depends on facts not held here`;
    return {
      action: "review_contested",
      reason:
        `FBA inventory since ${f.inventory_first} `
        + `(${pyGroupedInt(f.inventory_events)} events), but ${why}. Confirm with a CPA `
        + `before registering.`,
      confidence: FBA_NEEDS_REVIEW.has(f.fba_rule) ? "medium" : "high",
      physical_nexus: phys,
      economic_nexus: econ,
    };
  }

  if (f.economic_pct >= warnPct) {
    return {
      action: "monitor",
      reason:
        `${Math.round(f.economic_pct)}% of economic threshold `
        + `($${pyGroupedInt(total)}) — no nexus trigger yet`,
      confidence: "high",
      physical_nexus: phys,
      economic_nexus: econ,
    };
  }

  return {
    action: "monitor",
    reason:
      `no nexus trigger ($${pyGroupedInt(total)} relevant sales, `
      + `${Math.round(f.economic_pct)}% of threshold)`,
    confidence: "high",
    physical_nexus: phys,
    economic_nexus: econ,
  };
}

const ACTION_ORDER = Object.fromEntries(ACTIONS.map((a, i) => [a, i])) as Record<PlanAction, number>;

export function sortRows(rows: PlanRow[]): PlanRow[] {
  return [...rows].sort((a, b) => {
    const ao = ACTION_ORDER[a.decision.action] ?? 99;
    const bo = ACTION_ORDER[b.decision.action] ?? 99;
    if (ao !== bo) return ao - bo;
    const sales = totalRelevantSales(b.facts) - totalRelevantSales(a.facts);
    if (sales !== 0) return sales;
    return a.facts.state_code.localeCompare(b.facts.state_code);
  });
}

export function emptyCounts(): Record<PlanAction, number> {
  return {
    register_now: 0,
    review_contested: 0,
    monitor: 0,
    already_registered: 0,
    no_sales_tax: 0,
  };
}

export function countsByAction(rows: PlanRow[]): Record<PlanAction, number> {
  const out = emptyCounts();
  for (const r of rows) out[r.decision.action] += 1;
  return out;
}

function residualRiskMessage(n: number): string {
  if (!n) return "";
  return (
    `${pyGroupedInt(n)} inventory event(s) have an unmapped FC code and no state — `
    + `a state with stock could be missing from this plan. `
    + `Run \`inventory-health\`.`
  );
}

export function buildPlan(inputs: PlanInputs): PlanRow[] {
  const entity = new Set(inputs.entityStates);
  const warnPct = inputs.warnPct ?? DEFAULT_WARN_PCT;
  const residual = residualRiskMessage(inputs.unmappedInventoryEvents ?? 0);

  const states = new Set<string>([
    ...Object.keys(inputs.rules),
    ...Object.keys(inputs.inventory),
    ...Object.keys(inputs.sales),
    ...Object.keys(inputs.nexus),
  ]);

  const rows: PlanRow[] = [];
  for (const sc of [...states].sort()) {
    const rule = inputs.rules[sc];
    const inv = inputs.inventory[sc];
    const sale = inputs.sales[sc];
    const nx = inputs.nexus[sc] ?? {};

    const facts: StateFacts = {
      state_code: sc,
      has_sales_tax: coerceHasSalesTax(rule?.has_sales_tax ?? true),
      is_registered: isRegistered(nx.is_registered),
      fba_rule: normalizeFbaRule(rule?.fba_inventory_creates_nexus),
      inventory_events: Number(inv?.events ?? 0) || 0,
      inventory_first: inv?.min_date ?? null,
      inventory_last: inv?.max_date ?? null,
      economic_exceeded: !!nx.has_economic_nexus,
      economic_pct: Number(nx.economic_progress_percent) || 0,
      shopify_sales: Number(sale?.shopify ?? 0) || 0,
      amazon_sales: Number(sale?.amazon ?? 0) || 0,
      entity_exposure: entity.has(sc),
    };
    const decision = decide(facts, warnPct);
    const entity_note = facts.entity_exposure && decision.action !== "no_sales_tax"
      ? "entity/business-activity exposure also exists — see /entity"
      : "";
    rows.push({ facts, decision, entity_note, residual_risk: residual });
  }
  return sortRows(rows);
}

export function toApiRows(rows: PlanRow[]): PlanApiRow[] {
  return rows.map((r) => {
    const f = r.facts;
    const d = r.decision;
    return {
      state: f.state_code,
      sales_tax: f.has_sales_tax ? "Y" : "N",
      already_registered: f.is_registered ? "Y" : "N",
      physical_nexus: d.physical_nexus,
      first_inventory_date: f.inventory_first ?? "",
      economic_nexus: d.economic_nexus,
      shopify_sales: f.shopify_sales.toFixed(2),
      amazon_sales: f.amazon_sales.toFixed(2),
      total_relevant_sales: totalRelevantSales(f).toFixed(2),
      recommended_action: d.action,
      short_reason: d.reason,
      confidence: d.confidence,
      entity_note: r.entity_note,
    };
  });
}

export function todayLosAngeles(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** Exclusive cutoff: period_end < this date is dropped. Matches Python's 365-day window. */
export function trailing12mCutoff(refYmd: string = todayLosAngeles()): string {
  const [y, m, d] = refYmd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 365);
  return dt.toISOString().slice(0, 10);
}

export function aggregateSales12m(
  rows: Array<{
    state_code?: string | null;
    channel?: string | null;
    source?: string | null;
    gross_sales?: unknown;
    period_end?: string | null;
  }>,
  cutoffYmd: string,
): Record<string, ChannelSales> {
  const byState: Record<string, ChannelSales> = {};
  for (const r of rows) {
    if (isQuarantinedSource(r.source)) continue;
    const pe = r.period_end ?? "";
    if (pe && pe < cutoffYmd) continue;
    const sc = r.state_code;
    if (!sc) continue;
    if (!byState[sc]) byState[sc] = { shopify: 0, amazon: 0 };
    const ch = (r.channel ?? "").toLowerCase();
    const amt = Number(r.gross_sales) || 0;
    // Same split as Python `_gather_sales_12m`: shopify substring, else Amazon.
    if (ch.includes("shopify")) byState[sc].shopify += amt;
    else byState[sc].amazon += amt;
  }
  return byState;
}

export function bundledStateRules(): Record<string, RuleFact> {
  const states = (bundledRules as { states?: Record<string, RuleFact> }).states ?? {};
  const out: Record<string, RuleFact> = {};
  for (const [sc, r] of Object.entries(states)) {
    out[sc] = {
      has_sales_tax: coerceHasSalesTax(r.has_sales_tax),
      fba_inventory_creates_nexus: normalizeFbaRule(r.fba_inventory_creates_nexus),
    };
  }
  return out;
}

async function overlayRulesFromDisk(rules: Record<string, RuleFact>): Promise<void> {
  const candidates = [
    path.join(process.cwd(), "..", "config", "state_rules.json"),
    path.join(process.cwd(), "config", "state_rules.json"),
  ];
  for (const p of candidates) {
    try {
      const doc = JSON.parse(await readFile(p, "utf8")) as {
        states?: Record<string, { has_sales_tax?: unknown; fba_inventory_creates_nexus?: unknown }>;
      };
      for (const [sc, r] of Object.entries(doc.states ?? {})) {
        rules[sc] = {
          has_sales_tax: coerceHasSalesTax(r.has_sales_tax),
          fba_inventory_creates_nexus: normalizeFbaRule(r.fba_inventory_creates_nexus),
        };
      }
      return;
    } catch {
      /* try the next path */
    }
  }
}

async function entityStatesFromDisk(): Promise<Set<string>> {
  const candidates = [
    path.join(process.cwd(), "..", "config", "state_entity_matrix.json"),
    path.join(process.cwd(), "config", "state_entity_matrix.json"),
  ];
  for (const p of candidates) {
    try {
      const doc = JSON.parse(await readFile(p, "utf8")) as {
        jurisdictions?: Record<string, { obligations?: unknown[] }>;
      };
      const out = new Set<string>();
      for (const [sc, row] of Object.entries(doc.jurisdictions ?? {})) {
        if (Array.isArray(row.obligations) && row.obligations.length > 0) out.add(sc);
      }
      return out;
    } catch {
      /* try the next path */
    }
  }
  return new Set();
}

function mergeWarehouseRules(
  bundled: Record<string, RuleFact>,
  rows: Array<Record<string, unknown>>,
): Record<string, RuleFact> {
  const out = { ...bundled };
  for (const r of rows) {
    const sc = String(r.state_code ?? "").toUpperCase();
    if (!sc) continue;
    // Bundled JSON is the CLI source of truth for FBA / no-tax. Warehouse
    // rows only add jurisdictions the bundle does not know about.
    if (out[sc]) continue;
    out[sc] = {
      has_sales_tax: coerceHasSalesTax(r.has_sales_tax),
      fba_inventory_creates_nexus: normalizeFbaRule(r.fba_inventory_creates_nexus),
    };
  }
  return out;
}

async function gatherInventory(
  sb: SupabaseClient,
): Promise<{ byState: Record<string, InventoryPresence>; unmapped: number }> {
  const byState: Record<string, InventoryPresence> = {};

  const { data: invAgg, error: rpcErr } = await sb.rpc("inventory_state_summary");
  if (!rpcErr && Array.isArray(invAgg)) {
    for (const row of invAgg as Array<{
      state_code?: string;
      event_count?: number;
      events?: number;
      min_date?: string | null;
      max_date?: string | null;
    }>) {
      const sc = row.state_code;
      if (!sc) continue;
      byState[sc] = {
        events: Number(row.event_count ?? row.events ?? 0) || 0,
        min_date: row.min_date ?? null,
        max_date: row.max_date ?? null,
      };
    }
  } else {
    const PAGE = 1000;
    let offset = 0;
    while (true) {
      const { data: batch, error } = await sb
        .from("inventory_events")
        .select("id,state_code,event_date")
        .order("id")
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`inventory_events: ${error.message}`);
      if (!batch || batch.length === 0) break;
      for (const e of batch) {
        const sc = e.state_code as string | null;
        if (!sc) continue;
        if (!byState[sc]) {
          byState[sc] = { events: 0, min_date: null, max_date: null };
        }
        const m = byState[sc];
        m.events += 1;
        const d = (e.event_date as string | null) ?? "";
        if (d && (!m.min_date || d < m.min_date)) m.min_date = d;
        if (d && (!m.max_date || d > m.max_date)) m.max_date = d;
      }
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
  }

  let unmapped = 0;
  try {
    const { count, error } = await sb
      .from("inventory_events")
      .select("id", { count: "exact", head: true })
      .is("state_code", null);
    if (!error) unmapped = count ?? 0;
  } catch {
    unmapped = 0;
  }

  return { byState, unmapped };
}

/**
 * Gather live warehouse facts and decide for every jurisdiction.
 * Never shells out. Works on Vercel with SUPABASE_SERVICE_KEY.
 */
export async function loadRegistrationPlanFromWarehouse(
  sb: SupabaseClient,
  opts?: { referenceDate?: string },
): Promise<PlanResult> {
  const rules = bundledStateRules();
  await overlayRulesFromDisk(rules);

  const [
    warehouseRules,
    nexusRows,
    salesRows,
    flags,
    inventory,
    entityDisk,
  ] = await Promise.all([
    fetchAllRows(sb, "state_rules"),
    fetchAllRows(sb, "nexus_status"),
    fetchAllRows(sb, "sales_by_state"),
    sb.from("franchise_tax_flags").select("state_code").eq("status", "open"),
    gatherInventory(sb),
    entityStatesFromDisk(),
  ]);

  const mergedRules = mergeWarehouseRules(rules, warehouseRules);

  const nexus: Record<string, NexusFact> = {};
  for (const n of nexusRows) {
    const sc = String(n.state_code ?? "");
    if (sc) nexus[sc] = n;
  }

  const sales = aggregateSales12m(salesRows, trailing12mCutoff(opts?.referenceDate));

  const entityStates = new Set(entityDisk);
  for (const f of flags.data ?? []) {
    if (f.state_code) entityStates.add(String(f.state_code));
  }

  const planRows = buildPlan({
    rules: mergedRules,
    nexus,
    inventory: inventory.byState,
    sales,
    entityStates,
    unmappedInventoryEvents: inventory.unmapped,
  });

  const warehouse_empty =
    warehouseRules.length === 0
    && nexusRows.length === 0
    && salesRows.length === 0
    && Object.keys(inventory.byState).length === 0;

  return {
    rows: warehouse_empty ? [] : toApiRows(planRows),
    counts: warehouse_empty ? emptyCounts() : countsByAction(planRows),
    residual_risk: warehouse_empty ? "" : (planRows[0]?.residual_risk ?? ""),
    source: "warehouse",
    warehouse_empty,
  };
}

export function warehouseLooksEmpty(result: PlanResult): boolean {
  return result.warehouse_empty || result.rows.length === 0;
}
