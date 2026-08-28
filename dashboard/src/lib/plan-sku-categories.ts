/**
 * Plan SKU category buckets — live sku_velocity only.
 * Do not invent SKUs that are not in velocity. Sun Balm + junk stay Other.
 */

import { LIP_BALM_SKUS } from "./pallet-planner-model";
import {
  EXAMPLE_FORMUNOVA_SKU,
  planProduction,
  type ProductionOnHand,
  type ProductionPlanInput,
  type ProductionPlanResult,
  type ProductionWeekDemand,
} from "./production-planner-model";
import { findBySku, skusMatch, velocityDaily } from "./plan-sku-run";

export const PLAN_CATEGORY_IDS = [
  "lip_balm",
  "deodorant",
  "tallow_balm",
  "tallow_soap",
] as const;

export type PlanCategoryId = (typeof PLAN_CATEGORY_IDS)[number];

/** Verified against live sku_velocity (2026-08-28). No extras. */
export const PLAN_CATEGORY_SEEDS: Record<PlanCategoryId, readonly string[]> = {
  lip_balm: [...LIP_BALM_SKUS],
  deodorant: ["DDPE00019Shop", "DDPE0020Shop", "DDPE0021Shop", "DDPE0022Shop"],
  tallow_balm: [
    "DDPE0013Shop",
    "DDPE0014Shop",
    "DDPE0015Shop",
    "DDPE0016Shop",
    "DDPE0017Shop",
    "DDPE0018Shop",
    "DDPE0029Shop",
    "DDPE0030Shop",
    "DDPE0031Shop",
  ],
  tallow_soap: [
    "DDPE0005Shop",
    "DDPE0006Shop",
    "DDPE0007Shop",
    "DDPE0008Shop",
    "DDPE0009Shop",
    "DDPE0010Shop",
    "DDPE0011Shop",
    "DDPE0012Shop",
    "DDPE0023Shop",
    "DDPE0025Shop",
    "DDPE0027Shop",
    "DDPE0032Shop",
    "DDPE0035Shop",
  ],
};

export const PLAN_CATEGORY_LABELS: Record<PlanCategoryId, string> = {
  lip_balm: "Lip balm",
  deodorant: "Deodorant",
  tallow_balm: "Tallow Balm",
  tallow_soap: "Tallow Soap",
};

/** SKU-only — not a category bucket. */
export const PLAN_SKU_ONLY_SKUS = ["DDPE0033Shop"] as const;

export function isPlanCategoryId(value: string): value is PlanCategoryId {
  return (PLAN_CATEGORY_IDS as readonly string[]).includes(value);
}

export function planCategoryOfSku(sku: string): PlanCategoryId | "other" {
  for (const id of PLAN_CATEGORY_IDS) {
    if (PLAN_CATEGORY_SEEDS[id].some((s) => skusMatch(s, sku))) return id;
  }
  return "other";
}

/** Intersect seed with live velocity SKUs. Never invent a missing SKU. */
export function liveCategorySkus(
  category: PlanCategoryId,
  velocitySkus: string[] | null | undefined,
): string[] {
  const live = velocitySkus ?? [];
  return PLAN_CATEGORY_SEEDS[category].filter((seed) =>
    live.some((v) => skusMatch(v, seed)),
  );
}

export function sumOptional(values: Array<number | null | undefined>): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v == null || Number.isNaN(Number(v))) continue;
    sum += Number(v);
    any = true;
  }
  return any ? sum : null;
}

export function snapshotFba(snap: {
  fulfillable?: number | null;
  reserved?: number | null;
  researching?: number | null;
  unfulfillable?: number | null;
} | null | undefined): number | null {
  if (!snap) return null;
  return (
    Number(snap.fulfillable ?? 0) +
    Number(snap.reserved ?? 0) +
    Number(snap.researching ?? 0) +
    Number(snap.unfulfillable ?? 0)
  );
}

export function snapshotInbound(snap: {
  inbound_working?: number | null;
  inbound_shipped?: number | null;
  inbound_receiving?: number | null;
} | null | undefined): number | null {
  if (!snap) return null;
  return (
    Number(snap.inbound_working ?? 0) +
    Number(snap.inbound_shipped ?? 0) +
    Number(snap.inbound_receiving ?? 0)
  );
}

export function categoryOnHand(
  skus: string[],
  snapshots: Array<{ sku?: string | null } & Parameters<typeof snapshotFba>[0] & Parameters<typeof snapshotInbound>[0]>,
  awdList: Array<{ sku?: string | null; awd_on_hand?: number | null }>,
  tplList: Array<{ sku?: string | null; available?: number | null }>,
): ProductionOnHand & { omittedSkus: string[] } {
  const fbas: Array<number | null> = [];
  const inbounds: Array<number | null> = [];
  const awds: Array<number | null> = [];
  const tpls: Array<number | null> = [];
  const omittedSkus: string[] = [];

  for (const sku of skus) {
    const snap = findBySku(snapshots, sku);
    const awd = findBySku(awdList, sku);
    const tpl = findBySku(tplList, sku);
    if (!snap && !awd && !tpl) omittedSkus.push(sku);
    fbas.push(snapshotFba(snap));
    inbounds.push(snapshotInbound(snap));
    awds.push(awd && awd.awd_on_hand != null ? Number(awd.awd_on_hand) : null);
    tpls.push(tpl && tpl.available != null ? Number(tpl.available) : null);
  }

  return {
    fba: sumOptional(fbas),
    inbound: sumOptional(inbounds),
    awd: sumOptional(awds),
    tpl: sumOptional(tpls),
    omittedSkus,
  };
}

export function categoryVelocity(
  skus: string[],
  velocities: Array<{
    sku?: string | null;
    total_u_30?: number | null;
    planning_u_30?: number | null;
  }>,
): { daily: number | null; omittedSkus: string[] } {
  const days: Array<number | null> = [];
  const omittedSkus: string[] = [];
  for (const sku of skus) {
    const vel = findBySku(velocities, sku);
    const daily = velocityDaily(vel);
    if (daily == null) omittedSkus.push(sku);
    days.push(daily);
  }
  return { daily: sumOptional(days), omittedSkus };
}

export function categoryFamilySku(category: PlanCategoryId, liveSkus: string[]): string {
  if (category === "lip_balm") return LIP_BALM_SKUS[0];
  return liveSkus[0] ?? EXAMPLE_FORMUNOVA_SKU;
}

export function planCategoryProduction(input: {
  category: PlanCategoryId;
  skus: string[];
  plannedQty: number | null;
  availableDate: string | null;
  asOf: string;
  onHand: ProductionOnHand;
  dailyVelocity: number | null;
  settings?: ProductionPlanInput["settings"];
  leadtime?: ProductionPlanInput["leadtime"];
  weekDemand?: ProductionWeekDemand[] | null;
}): ProductionPlanResult {
  return planProduction({
    sku: categoryFamilySku(input.category, input.skus),
    productName: PLAN_CATEGORY_LABELS[input.category],
    plannedQty: input.plannedQty,
    availableDate: input.availableDate,
    asOf: input.asOf,
    onHand: input.onHand,
    dailyVelocity: input.dailyVelocity,
    monthlySales: [],
    settings: input.settings,
    leadtime: input.leadtime,
    weekDemand: input.weekDemand,
    summedVelocity: true,
  });
}

export function groupSkusByCategory(skus: string[]): Record<PlanCategoryId | "other", string[]> {
  const out: Record<PlanCategoryId | "other", string[]> = {
    lip_balm: [],
    deodorant: [],
    tallow_balm: [],
    tallow_soap: [],
    other: [],
  };
  for (const sku of skus) {
    out[planCategoryOfSku(sku)].push(sku);
  }
  return out;
}
