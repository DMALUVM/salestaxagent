/**
 * Monthly Amazon contribution from sales_by_sku × sku_costs.
 *
 * Mirrors src/pnl_monthly.py. Constants must match
 * config/business_rules.json → pnl.default_referral_pct / default_fba_fee_per_unit.
 *
 * Ads: an imported ads_monthly_spend row wins for that month (full
 * SKU Economics / Ads Console month). Otherwise campaign days from
 * ads_campaigns_daily. A month with neither is ads-unknown — not
 * "after $0 ads".
 */

import { monthStart } from "./as-of";
import { monthEnd, type PnlRow } from "./pnl-periods";

export const PNL_REFERRAL_PCT = 0.15;
export const PNL_FBA_PER_UNIT = 3.5;

export interface SkuSalesRow {
  channel: string;
  sku: string;
  period_start: string;
  units: number;
  gross_sales: number;
  product_title?: string | null;
  source?: string | null;
}

export interface SkuCostRow {
  sku: string;
  cogs_per_unit: number;
}

export interface AdsDaySpend {
  date: string;
  spend: number;
}

export interface AdsMonthSpend {
  period_start: string;
  spend: number;
}

export interface MonthlySkuLine {
  sku: string;
  title: string | null;
  units: number;
  gross_sales: number;
  est_referral_fees: number;
  est_fba_fees: number;
  est_cogs: number;
  est_contribution: number;
}

export type AdsBasis = "known" | "unknown";

export interface MonthlyPnlRow extends PnlRow {
  ads_basis: AdsBasis;
  source: "sku_monthly";
  period_end: string;
}

export interface MonthlyPnlResult {
  months: MonthlyPnlRow[];
  skusByMonth: Record<string, MonthlySkuLine[]>;
  missingCostSkus: string[];
  coverageMin: string | null;
  coverageMax: string | null;
  referralPct: number;
  fbaPerUnit: number;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeSku(raw: string | null | undefined): string {
  const cleaned = (raw ?? "").trim().toUpperCase();
  return cleaned || "UNKNOWN";
}

function ymOf(periodStart: string): string {
  return (periodStart || "").slice(0, 7);
}

export function buildAmazonMonthlyPnl(opts: {
  skuRows: SkuSalesRow[];
  costs: SkuCostRow[];
  adsByDay: AdsDaySpend[];
  adsByMonth?: AdsMonthSpend[];
  referralPct?: number;
  fbaPerUnit?: number;
}): MonthlyPnlResult {
  const referralPct = opts.referralPct ?? PNL_REFERRAL_PCT;
  const fbaPerUnit = opts.fbaPerUnit ?? PNL_FBA_PER_UNIT;

  const costs: Record<string, number> = {};
  for (const c of opts.costs) {
    const sku = normalizeSku(c.sku);
    if (sku === "UNKNOWN") continue;
    costs[sku] = Number(c.cogs_per_unit) || 0;
  }
  const costValues = Object.values(costs);
  const avgCogs = costValues.length
    ? costValues.reduce((s, n) => s + n, 0) / costValues.length
    : 0;

  const adsSpend: Record<string, number> = {};
  const adsDays: Record<string, Set<string>> = {};
  for (const a of opts.adsByDay) {
    const ym = ymOf(a.date);
    if (ym.length !== 7) continue;
    adsSpend[ym] = (adsSpend[ym] ?? 0) + (Number(a.spend) || 0);
    const set = adsDays[ym] ?? new Set<string>();
    set.add(a.date);
    adsDays[ym] = set;
  }
  for (const a of opts.adsByMonth ?? []) {
    const ym = ymOf(a.period_start);
    if (ym.length !== 7) continue;
    adsSpend[ym] = Number(a.spend) || 0;
    adsDays[ym] = new Set([`${ym}-01`]);
  }

  const byMonthSku = new Map<string, {
    ym: string; sku: string; units: number; sales: number; title: string | null; periodStart: string;
  }>();
  const titles: Record<string, string> = {};

  for (const r of opts.skuRows) {
    if ((r.channel || "").toLowerCase() !== "amazon") continue;
    const ym = ymOf(r.period_start);
    const sku = normalizeSku(r.sku);
    if (ym.length !== 7 || sku === "UNKNOWN") continue;
    const key = `${ym}|${sku}`;
    const existing = byMonthSku.get(key);
    if (existing) {
      existing.units += Number(r.units) || 0;
      existing.sales += Number(r.gross_sales) || 0;
    } else {
      byMonthSku.set(key, {
        ym,
        sku,
        units: Number(r.units) || 0,
        sales: Number(r.gross_sales) || 0,
        title: r.product_title ?? null,
        periodStart: (r.period_start || `${ym}-01`).slice(0, 10),
      });
    }
    const title = r.product_title || "";
    if (title && (!titles[sku] || title.length > titles[sku].length)) titles[sku] = title;
  }

  const missing = new Set<string>();
  const skusByMonth: Record<string, MonthlySkuLine[]> = {};
  const monthAcc = new Map<string, {
    date: string; sales: number; units: number; referral: number; fba: number; cogs: number;
  }>();

  for (const row of [...byMonthSku.values()].sort((a, b) =>
    a.ym.localeCompare(b.ym) || a.sku.localeCompare(b.sku),
  )) {
    const unitCost = costs[row.sku];
    const cogsEach = unitCost === undefined ? avgCogs : unitCost;
    if (unitCost === undefined) missing.add(row.sku);
    const sales = money(row.sales);
    const units = row.units;
    const referral = money(sales * referralPct);
    const fba = money(units * fbaPerUnit);
    const cogs = money(units * cogsEach);
    const contrib = money(sales - referral - fba - cogs);
    const line: MonthlySkuLine = {
      sku: row.sku,
      title: titles[row.sku] ?? row.title,
      units,
      gross_sales: sales,
      est_referral_fees: referral,
      est_fba_fees: fba,
      est_cogs: cogs,
      est_contribution: contrib,
    };
    (skusByMonth[row.ym] ??= []).push(line);
    const acc = monthAcc.get(row.ym) ?? {
      date: row.periodStart || `${row.ym}-01`,
      sales: 0, units: 0, referral: 0, fba: 0, cogs: 0,
    };
    acc.sales = money(acc.sales + sales);
    acc.units += units;
    acc.referral = money(acc.referral + referral);
    acc.fba = money(acc.fba + fba);
    acc.cogs = money(acc.cogs + cogs);
    monthAcc.set(row.ym, acc);
  }

  const months: MonthlyPnlRow[] = [];
  for (const [ym, acc] of [...monthAcc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const adsKnown = (adsDays[ym]?.size ?? 0) > 0;
    const ads = adsKnown ? money(adsSpend[ym] ?? 0) : 0;
    const contribution = money(acc.sales - acc.referral - acc.fba - ads - acc.cogs);
    const start = monthStart(acc.date);
    months.push({
      date: start,
      period_end: monthEnd(start),
      gross_sales: acc.sales,
      units: acc.units,
      ad_spend: ads,
      est_referral_fees: acc.referral,
      est_fba_fees: acc.fba,
      est_cogs: acc.cogs,
      est_contribution: contribution,
      amazon_net_proceeds: null,
      net_after_ads: contribution,
      status: "preliminary",
      fees_basis: "estimated",
      ads_basis: adsKnown ? "known" : "unknown",
      source: "sku_monthly",
    });
  }

  return {
    months: [...months].sort((a, b) => b.date.localeCompare(a.date)),
    skusByMonth,
    missingCostSkus: [...missing].sort(),
    coverageMin: months.length ? months[0].date.slice(0, 7) : null,
    coverageMax: months.length ? months[months.length - 1].date.slice(0, 7) : null,
    referralPct,
    fbaPerUnit,
  };
}

/** Keep a monthly row if the month overlaps [from, to] (inclusive). */
export function monthOverlapsWindow(row: Pick<PnlRow, "date">, from: string, to: string): boolean {
  const start = monthStart(row.date);
  const end = monthEnd(row.date);
  return start <= to && end >= from;
}
