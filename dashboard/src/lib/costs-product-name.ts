/**
 * COGS product names: sku_costs.product_name first, then sku_velocity.
 * Never invent a name. Shop-suffix variants (DDPE0001Shop ↔ DDPE0001).
 */
import { findBySku } from "./plan-sku-run";

export type CostNameRow = {
  sku: string;
  product_name?: string | null;
};

export type VelocityNameRow = {
  sku?: string | null;
  product_name?: string | null;
};

export function nonemptyName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Prefer the cost-table name; otherwise join sku_velocity by SKU / Shop suffix. */
export function attachCostProductNames<T extends CostNameRow>(
  costs: T[],
  velocity: VelocityNameRow[] | null | undefined,
): Array<T & { product_name: string | null }> {
  return costs.map((row) => {
    const owned = nonemptyName(row.product_name);
    if (owned) return { ...row, product_name: owned };
    const vel = findBySku(velocity, row.sku);
    return { ...row, product_name: nonemptyName(vel?.product_name) };
  });
}

/** sku_costs write payload. Includes product_name only when the client sent it. */
export function skuCostWriteRow(input: {
  sku: string;
  cogs_per_unit: number;
  product_name?: string | null;
  notes?: string | null;
  source: string;
  includeProductName: boolean;
}): {
  sku: string;
  cogs_per_unit: number;
  product_name?: string | null;
  notes: string | null;
  source: string;
} {
  const row: {
    sku: string;
    cogs_per_unit: number;
    product_name?: string | null;
    notes: string | null;
    source: string;
  } = {
    sku: input.sku,
    cogs_per_unit: input.cogs_per_unit,
    notes: nonemptyName(input.notes),
    source: input.source,
  };
  if (input.includeProductName) {
    row.product_name = nonemptyName(input.product_name);
  }
  return row;
}
