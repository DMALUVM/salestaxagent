/**
 * Shared inventory supply inputs — single source for four-number plan across pages.
 */

import {
  buildFourNumbersPlan,
  type FourNumbersPlan,
  type SkuFourNumbers,
} from "./inventory-four-numbers";
import { live3plSnapshots } from "./inventory-3pl";
import type { ForecastWeekRow } from "./inventory-phased-demand";
import type { InventorySnapshot, SeasonalityWeekly, SkuVelocity } from "./types";

export type InventoryRawLike = {
  snapshots?: InventorySnapshot[];
  velocity?: SkuVelocity[];
  tpl?: Array<{ sku: string; available: number; pulled_at?: string | null }>;
  awd?: Array<{ sku: string; awd_on_hand: number }>;
  seasonality?: SeasonalityWeekly[];
  forecast?: ForecastWeekRow[];
  signals?: Array<{ measured_receive_days?: number | null }>;
  leadtime?: {
    fba_optimized_receive_median?: number | null;
    fba_receive_median?: number | null;
  } | null;
};

export const DEFAULT_UNTIL_DATE = "2027-01-15";
export const DEFAULT_RECEIVING_DAYS = 18;

export function measuredReceivingDays(raw: InventoryRawLike): number {
  const sigs = raw.signals ?? [];
  const measured = sigs
    .map((s) => s.measured_receive_days)
    .filter((d): d is number => d != null && d > 0);
  if (measured.length) {
    measured.sort((a, b) => a - b);
    return measured[Math.floor(measured.length / 2)];
  }
  return (
    raw.leadtime?.fba_optimized_receive_median ??
    raw.leadtime?.fba_receive_median ??
    DEFAULT_RECEIVING_DAYS
  );
}

export function extractActiveSkus(raw: InventoryRawLike): string[] {
  const set = new Set<string>();
  for (const s of raw.snapshots ?? []) {
    const sku = String(s.sku ?? "");
    if (sku) set.add(sku);
  }
  for (const a of raw.awd ?? []) if (a.sku) set.add(a.sku);
  for (const t of live3plSnapshots(raw.tpl ?? [])) if (t.sku) set.add(t.sku);
  for (const v of raw.velocity ?? []) {
    const sku = String(v.sku ?? "");
    if (sku && Number(v.total_u_30 ?? 0) > 0) set.add(sku);
  }
  return [...set]
    .filter((s) => s !== "UNKNOW" && s !== "UNKNOWN")
    .sort();
}

export function buildFourNumbersPlanFromRaw(
  raw: InventoryRawLike,
  opts?: {
    skus?: string[];
    untilDate?: string;
    bufferDays?: number;
    receivingDays?: number;
    coverTargetDays?: number;
  },
): FourNumbersPlan | null {
  const skus = opts?.skus ?? extractActiveSkus(raw);
  if (!skus.length) return null;

  const snapshots = (raw.snapshots ?? []).map((s) => ({
    sku: String(s.sku),
    fulfillable: Number(s.fulfillable ?? 0),
    reserved: Number(s.reserved ?? 0),
    researching: Number(s.researching ?? 0),
    unfulfillable: Number(s.unfulfillable ?? 0),
    inbound_working: Number(s.inbound_working ?? 0),
    inbound_shipped: Number(s.inbound_shipped ?? 0),
    inbound_receiving: Number(s.inbound_receiving ?? 0),
  }));

  const velocities = (raw.velocity ?? []).map((v) => ({
    sku: String(v.sku),
    product_name: String(v.product_name ?? ""),
    total_u_30: Number(v.total_u_30 ?? 0),
    planning_u_30: Number(v.planning_u_30 ?? 0),
    holiday_prior_daily: Number(v.holiday_prior_daily ?? 0),
    yoy_growth_mult: Number(v.yoy_growth_mult ?? 1),
    holiday_surge_mult: Number(v.holiday_surge_mult ?? 1),
  }));

  return buildFourNumbersPlan({
    skus,
    snapshots,
    velocities,
    tpl: live3plSnapshots(raw.tpl ?? []),
    awd: raw.awd ?? [],
    seasonality: raw.seasonality ?? [],
    forecast: raw.forecast ?? [],
    untilDate: opts?.untilDate ?? DEFAULT_UNTIL_DATE,
    bufferDays: opts?.bufferDays ?? 14,
    receivingDays: opts?.receivingDays ?? measuredReceivingDays(raw),
    coverTargetDays: opts?.coverTargetDays,
  });
}

export function skuFourNumbersMap(plan: FourNumbersPlan | null): Map<string, SkuFourNumbers> {
  const map = new Map<string, SkuFourNumbers>();
  if (!plan) return map;
  for (const row of plan.skuRows) map.set(row.sku, row);
  return map;
}
