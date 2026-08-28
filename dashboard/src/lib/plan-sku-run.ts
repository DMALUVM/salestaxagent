/**
 * Plan SKU (/inventory/plan) run-state helpers.
 * Production landing cards must not depend on the weekly `plan` object.
 */

export const PLAN_ERR_NO_SKU = "Select a SKU or a category. Run Plan cannot run without one.";
export const PLAN_ERR_NO_VELOCITY =
  "No velocity for this SKU (V30 missing or 0). Weekly plan needs velocity. New OOS / next PO still show when qty and available date are set.";
export const PLAN_ERR_NO_CATEGORY_VELOCITY =
  "No velocity for this category (V30 missing or 0). Weekly plan needs velocity. New OOS / next PO still show when qty and available date are set.";

/** Exact, case-fold, and Shop-suffix keys so DDPE00019 matches DDPE00019Shop. */
export function skuMatchKeys(sku: string | null | undefined): string[] {
  const raw = String(sku ?? "").trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const noShop = lower.replace(/shop$/i, "");
  return [...new Set([raw, lower, noShop].filter(Boolean))];
}

export function skusMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const kb = new Set(skuMatchKeys(b));
  return skuMatchKeys(a).some((k) => kb.has(k));
}

export function findBySku<T extends { sku?: string | null }>(
  rows: T[] | null | undefined,
  sku: string,
): T | undefined {
  if (!sku || !rows?.length) return undefined;
  const exact = rows.find((r) => r.sku === sku);
  if (exact) return exact;
  return rows.find((r) => skusMatch(r.sku, sku));
}

/** Prefer total_u_30; fall back to planning_u_30. Missing → null (omit, not 0). */
export function velocityDaily(
  vel:
    | { total_u_30?: number | null; planning_u_30?: number | null }
    | null
    | undefined,
): number | null {
  if (!vel) return null;
  const take = (n: number | null | undefined): number | null => {
    if (n == null || Number.isNaN(Number(n))) return null;
    return Number(n);
  };
  const v30 = take(vel.total_u_30);
  if (v30 != null && v30 > 0) return v30;
  const planning = take(vel.planning_u_30);
  if (planning != null && planning > 0) return planning;
  if (v30 != null) return v30;
  return planning;
}

export function showProductionStrip(opts: {
  plannedQty: number | null;
  availableDate: string | null;
}): boolean {
  const qty = opts.plannedQty;
  return qty != null && Number.isFinite(qty) && qty > 0 && !!opts.availableDate;
}

export function planRunError(opts: {
  selectedSku: string;
  selectedCategory?: string;
  velocityDaily: number | null;
}): string | null {
  const sku = opts.selectedSku.trim();
  const cat = (opts.selectedCategory ?? "").trim();
  if (!sku && !cat) return PLAN_ERR_NO_SKU;
  if (opts.velocityDaily == null || opts.velocityDaily <= 0) {
    return sku ? PLAN_ERR_NO_VELOCITY : PLAN_ERR_NO_CATEGORY_VELOCITY;
  }
  return null;
}

/** What the page must show — weekly plan null must not hide landing cards. */
export function planSkuOutput(opts: {
  selectedSku: string;
  selectedCategory?: string;
  plannedQty: number | null;
  availableDate: string | null;
  ran: boolean;
  weeklyPlan: unknown | null;
  velocityDaily: number | null;
}): {
  productionCards: boolean;
  weeklyPlanVisible: boolean;
  error: string | null;
} {
  return {
    productionCards: showProductionStrip({
      plannedQty: opts.plannedQty,
      availableDate: opts.availableDate,
    }),
    weeklyPlanVisible: opts.weeklyPlan != null,
    error: opts.ran
      ? planRunError({
          selectedSku: opts.selectedSku,
          selectedCategory: opts.selectedCategory,
          velocityDaily: opts.velocityDaily,
        })
      : null,
  };
}
