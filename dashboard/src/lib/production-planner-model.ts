/**
 * Production Planner — recommend-only PO date/qty for one SKU.
 *
 * Reuses the pallet-planner holiday demand / cover / peak-receive helpers
 * and the existing Formunova production lead. Does not invent a forecast.
 */

import { PRODUCTION_LEAD_DAYS } from "./inventory-four-numbers";
import {
  LIP_BALM_SKUS,
  coverUnitsFromDaily,
  decemberDailyRate,
  holidayDemandFromSales,
  januaryDailyRate,
  monthlyAmazonUnits,
  plannerPolicy,
  skuProductionBuild,
  type AmazonMonthlySale,
  type HolidayDemandRow,
  type PlannerLeadtime,
  type PlannerSettings,
} from "./pallet-planner-model";

/**
 * Formunova PO-to-ship lead: 70 days (10 weeks).
 * Existing PRODUCTION_LEAD_DAYS.balm / deodorant pick — conservative
 * end of the 8–10 week range. Applied consistently; not a new model.
 */
export const FORMUNOVA_PO_LEAD_DAYS = PRODUCTION_LEAD_DAYS.balm;

export const EXAMPLE_FORMUNOVA_SKU = "DDPE00019Shop";

export type ProductionFamily = "lip_balm" | "formunova";

export type OptionalUnits = number | null | undefined;

export type ProductionOnHand = {
  fba?: OptionalUnits;
  inbound?: OptionalUnits;
  awd?: OptionalUnits;
  tpl?: OptionalUnits;
};

export type ProductionPlanInput = {
  sku: string;
  productName?: string;
  plannedQty: number | null;
  availableDate: string | null;
  asOf: string;
  onHand: ProductionOnHand;
  /** V30 daily units. null/undefined = sales source missing (omit, do not zero). */
  dailyVelocity?: OptionalUnits;
  monthlySales?: AmazonMonthlySale[] | null;
  settings?: PlannerSettings | null;
  leadtime?: PlannerLeadtime | null;
};

export type ProductionPlanResult = {
  sku: string;
  family: ProductionFamily;
  currentOosDate: string | null;
  newOosDate: string | null;
  recommendedPoDate: string | null;
  recommendedPoQty: number | null;
  leadDays: number;
  coverDays: number;
  dailyDemand: number | null;
  stock: number | null;
  omitted: string[];
  omittedLine: string | null;
  leadNote: string;
};

const LIP_SET = new Set(LIP_BALM_SKUS);

export function isLipBalmSku(sku: string): boolean {
  return LIP_SET.has(sku);
}

export function productionFamily(sku: string): ProductionFamily {
  return isLipBalmSku(sku) ? "lip_balm" : "formunova";
}

export function presentOnHand(parts: ProductionOnHand): {
  stock: number | null;
  used: string[];
  omitted: string[];
} {
  const used: string[] = [];
  const omitted: string[] = [];
  let stock = 0;
  let any = false;

  const take = (label: string, qty: OptionalUnits) => {
    if (qty == null || Number.isNaN(Number(qty))) {
      omitted.push(label);
      return;
    }
    stock += Number(qty);
    used.push(label);
    any = true;
  };

  const fbaMissing = parts.fba == null || Number.isNaN(Number(parts.fba));
  const inboundMissing = parts.inbound == null || Number.isNaN(Number(parts.inbound));
  if (fbaMissing && inboundMissing) {
    omitted.push("FBA");
  } else {
    take("FBA", parts.fba);
    take("FBA inbound", parts.inbound);
  }
  take("AWD", parts.awd);
  take("3PL", parts.tpl);

  return { stock: any ? stock : null, used, omitted };
}

export function omittedLine(omitted: string[]): string | null {
  if (!omitted.length) return null;
  return `${omitted.join(", ")} omitted (missing).`;
}

export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(iso: string, days: number): string {
  const d = parseIso(iso);
  d.setDate(d.getDate() + days);
  return toIso(d);
}

export function daysBetween(start: string, end: string): number {
  return Math.round((parseIso(end).getTime() - parseIso(start).getTime()) / 86_400_000);
}

function skuHasPositiveSales(rows: AmazonMonthlySale[] | null | undefined, sku: string): boolean {
  if (!rows?.length) return false;
  const key = sku.trim().toLowerCase();
  return rows.some(
    (r) => String(r.sku ?? "").trim().toLowerCase() === key && Number(r.units ?? 0) > 0,
  );
}

function holidayDailyOn(
  iso: string,
  row: HolidayDemandRow,
  fallback: number | null,
): number | null {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (m === 12) {
    const units = Number(row.months2026?.[12] ?? 0);
    if (units > 0) return decemberDailyRate(units);
  }
  if (m === 1) {
    const units = Number(row.janDemand ?? 0);
    if (units > 0) return januaryDailyRate(units);
  }
  const units = Number(row.months2026?.[m] ?? 0);
  if (units > 0) {
    const dim = new Date(y, m, 0).getDate();
    return units / dim;
  }
  if (fallback != null && fallback > 0) return fallback;
  return null;
}

export function walkOosDate(opts: {
  start: string;
  stock: number;
  dailyOn: (iso: string) => number | null;
  inject?: { date: string; qty: number } | null;
  maxDays?: number;
}): string | null {
  const maxDays = opts.maxDays ?? 800;
  let remaining = opts.stock;
  let cursor = opts.start;
  for (let i = 0; i <= maxDays; i++) {
    if (opts.inject && cursor === opts.inject.date) {
      remaining += opts.inject.qty;
    }
    const daily = opts.dailyOn(cursor);
    if (daily != null && daily > 0) {
      if (remaining < daily) return cursor;
      remaining -= daily;
    }
    cursor = addDays(cursor, 1);
  }
  return null;
}

export function subtractDays(iso: string, days: number): string {
  return addDays(iso, -Math.max(0, days));
}

export function planProduction(input: ProductionPlanInput): ProductionPlanResult {
  const family = productionFamily(input.sku);
  const policy = plannerPolicy(input.settings, input.leadtime);
  const coverDays = policy.targetCoverDays;
  const leadDays = family === "lip_balm" ? policy.receivingDaysPeak : FORMUNOVA_PO_LEAD_DAYS;
  const leadNote =
    family === "lip_balm"
      ? `Lip balm: Dec peak cover ${coverDays}d + peak receive ${leadDays}d (pallet planner).`
      : `Formunova: cover ${coverDays}d + PO-to-ship ${leadDays}d (10 weeks; existing 8–10 week pick).`;

  const onHand = presentOnHand(input.onHand);
  const omitted = [...onHand.omitted];

  const v30 =
    input.dailyVelocity == null || Number.isNaN(Number(input.dailyVelocity))
      ? null
      : Number(input.dailyVelocity);

  let dailyDemand: number | null = null;
  let holidayRow: HolidayDemandRow | undefined;
  let dailyOn: ((iso: string) => number | null) | null = null;

  if (family === "lip_balm") {
    const sales = input.monthlySales ?? [];
    if (!skuHasPositiveSales(sales, input.sku)) {
      omitted.push("sales");
    } else {
      const monthly = monthlyAmazonUnits(sales, [input.sku]);
      const demand = holidayDemandFromSales(monthly, [input.sku]);
      holidayRow = demand[input.sku];
      const build = skuProductionBuild(holidayRow, {
        coverDays,
        receiveDays: leadDays,
      });
      dailyDemand = build.decDaily > 0 ? build.decDaily : null;
      dailyOn = (iso) => holidayDailyOn(iso, holidayRow!, v30);
    }
  } else if (v30 == null) {
    omitted.push("sales");
  } else {
    dailyDemand = v30;
    dailyOn = () => (v30 > 0 ? v30 : null);
  }

  const currentOosDate =
    onHand.stock != null && dailyOn
      ? walkOosDate({ start: input.asOf, stock: onHand.stock, dailyOn })
      : null;

  const planned =
    input.plannedQty != null && Number(input.plannedQty) > 0 && input.availableDate
      ? { date: input.availableDate, qty: Number(input.plannedQty) }
      : null;

  const newOosDate =
    onHand.stock != null && dailyOn && planned
      ? walkOosDate({
          start: input.asOf,
          stock: onHand.stock,
          dailyOn,
          inject: planned,
        })
      : null;

  const recommendedPoDate =
    newOosDate != null ? subtractDays(newOosDate, leadDays + coverDays) : null;

  let recommendedPoQty: number | null = null;
  if (family === "lip_balm" && holidayRow) {
    const build = skuProductionBuild(holidayRow, {
      coverDays,
      receiveDays: leadDays,
    });
    recommendedPoQty = coverUnitsFromDaily(build.decDaily, leadDays + coverDays);
  } else if (family === "formunova" && v30 != null && v30 > 0) {
    recommendedPoQty = coverUnitsFromDaily(v30, leadDays + coverDays);
  }

  return {
    sku: input.sku,
    family,
    currentOosDate,
    newOosDate,
    recommendedPoDate,
    recommendedPoQty,
    leadDays,
    coverDays,
    dailyDemand,
    stock: onHand.stock,
    omitted,
    omittedLine: omittedLine(omitted),
    leadNote,
  };
}
