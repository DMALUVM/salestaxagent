/**
 * Monthly Amazon contribution from sales_by_sku × sku_costs.
 *
 * Mirrors src/pnl_monthly.py. Constants must match
 * config/business_rules.json → pnl.default_referral_pct / default_fba_fee_per_unit.
 *
 * When sales_daily / pnl_daily covers the in-progress Amazon month and
 * is more complete than sales_by_sku, that month is replaced by the
 * daily totals. Closed prior months stay on sales_by_sku. Shopify is
 * never mixed in. Ads stay on ads_campaigns_daily / ads_monthly_spend.
 *
 * Ads: an imported ads_monthly_spend row wins for that month (full
 * SKU Economics / Ads Console month). Otherwise campaign days from
 * ads_campaigns_daily. A month with neither is ads-unknown — not
 * "after $0 ads".
 */

import { monthStart } from "./as-of";
import { inclusiveDays, monthEnd, type PnlRow } from "./pnl-periods";

export const PNL_REFERRAL_PCT = 0.15;
export const PNL_FBA_PER_UNIT = 3.5;

/** Seller Central SKU Economics CSV floor — mirrors config/business_rules.json ads.sku_economics_min_date */
export const ADS_SKU_ECONOMICS_MIN_DATE = "2024-09-01";

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

/** Account-grain daily Amazon row (pnl_daily). */
export interface DailyAccountRow {
  date: string;
  gross_sales: number;
  units: number;
  est_cogs?: number;
  channel?: string;
}

/** Amazon sales_daily row — sales truth; units come from pnl_daily. */
export interface SalesDailyRow {
  sale_date?: string;
  date?: string;
  gross_sales: number;
  channel?: string;
}

/** SKU-grain daily Amazon row from pnl_daily grain=sku. */
export interface DailySkuRow {
  date: string;
  sku: string;
  units: number;
  gross_sales: number;
  est_cogs?: number;
  product_title?: string | null;
}

/** Daily Amazon sales must beat sales_by_sku by this much to replace the month. */
export const DAILY_SALES_MATERIAL_DELTA = 1;

/** Allow this many missing closed days and still treat daily as covering the month. */
export const DAILY_MONTH_COVERAGE_SLACK = 2;

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
  source: "sku_monthly" | "daily";
  period_end: string;
  closed_days?: number;
  sales_basis?: "sales_by_sku" | "daily";
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
  dailyAccount?: DailyAccountRow[];
  dailySkus?: DailySkuRow[];
  salesDaily?: SalesDailyRow[];
  asOf?: string | null;
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
    months.push(accountMonthRow({
      ym,
      date: acc.date,
      sales: acc.sales,
      units: acc.units,
      referral: acc.referral,
      fba: acc.fba,
      cogs: acc.cogs,
      adsSpend: adsSpend[ym] ?? 0,
      adsKnown: (adsDays[ym]?.size ?? 0) > 0,
      source: "sku_monthly",
      salesBasis: "sales_by_sku",
    }));
  }

  overlayDailyMonths({
    months,
    skusByMonth,
    missing,
    titles,
    costs,
    avgCogs,
    adsSpend,
    adsDays,
    dailyAccount: mergeSalesDaily(opts.dailyAccount ?? [], opts.salesDaily ?? [], opts.asOf ?? null),
    dailySkus: opts.dailySkus ?? [],
    asOf: opts.asOf ?? null,
    referralPct,
    fbaPerUnit,
  });

  const sorted = [...months].sort((a, b) => b.date.localeCompare(a.date));
  return {
    months: sorted,
    skusByMonth,
    missingCostSkus: [...missing].sort(),
    coverageMin: sorted.length ? sorted[sorted.length - 1].date.slice(0, 7) : null,
    coverageMax: sorted.length ? sorted[0].date.slice(0, 7) : null,
    referralPct,
    fbaPerUnit,
  };
}

function accountMonthRow(opts: {
  ym: string;
  date: string;
  sales: number;
  units: number;
  referral: number;
  fba: number;
  cogs: number;
  adsSpend: number;
  adsKnown: boolean;
  source: "sku_monthly" | "daily";
  salesBasis: "sales_by_sku" | "daily";
  closedDays?: number;
}): MonthlyPnlRow {
  const ads = opts.adsKnown ? money(opts.adsSpend) : 0;
  const contribution = money(opts.sales - opts.referral - opts.fba - ads - opts.cogs);
  const start = monthStart(opts.date || `${opts.ym}-01`);
  return {
    date: start,
    period_end: monthEnd(start),
    gross_sales: opts.sales,
    units: opts.units,
    ad_spend: ads,
    est_referral_fees: opts.referral,
    est_fba_fees: opts.fba,
    est_cogs: opts.cogs,
    est_contribution: contribution,
    amazon_net_proceeds: null,
    net_after_ads: contribution,
    status: "preliminary",
    fees_basis: "estimated",
    ads_basis: opts.adsKnown ? "known" : "unknown",
    source: opts.source,
    sales_basis: opts.salesBasis,
    closed_days: opts.closedDays,
  };
}

function groupAmazonDays<T extends { date: string; channel?: string }>(
  rows: T[],
  asOf: string | null,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    if ((r.channel || "amazon").toLowerCase() !== "amazon") continue;
    if (asOf && r.date > asOf) continue;
    const ym = ymOf(r.date);
    if (ym.length !== 7) continue;
    const list = out.get(ym) ?? [];
    list.push(r);
    out.set(ym, list);
  }
  return out;
}

export function dailyCoversMonth(
  days: number,
  ym: string,
  asOf: string | null,
): boolean {
  if (days <= 0 || ym.length !== 7) return false;
  const start = `${ym}-01`;
  const end = monthEnd(start);
  const cap = asOf && asOf < end ? asOf : end;
  const expected = inclusiveDays(start, cap);
  return days >= Math.max(1, expected - DAILY_MONTH_COVERAGE_SLACK);
}

export function isOpenMonth(ym: string, asOf: string | null): boolean {
  if (!asOf || ym.length !== 7) return false;
  return asOf < monthEnd(`${ym}-01`);
}

/** Prefer sales_daily Amazon sales when they beat pnl_daily for a day. */
export function mergeSalesDaily(
  account: DailyAccountRow[],
  salesDaily: SalesDailyRow[],
  asOf: string | null,
): DailyAccountRow[] {
  const byDate = new Map<string, DailyAccountRow>();
  for (const r of account) {
    if ((r.channel || "amazon").toLowerCase() !== "amazon") continue;
    if (asOf && r.date > asOf) continue;
    byDate.set(r.date, {
      date: r.date,
      gross_sales: Number(r.gross_sales) || 0,
      units: Number(r.units) || 0,
      est_cogs: Number(r.est_cogs) || 0,
      channel: "amazon",
    });
  }
  for (const r of salesDaily) {
    if ((r.channel || "amazon").toLowerCase() !== "amazon") continue;
    const date = (r.sale_date || r.date || "").slice(0, 10);
    if (date.length !== 10) continue;
    if (asOf && date > asOf) continue;
    const sales = Number(r.gross_sales) || 0;
    const existing = byDate.get(date);
    if (!existing) {
      byDate.set(date, { date, gross_sales: sales, units: 0, est_cogs: 0, channel: "amazon" });
    } else if (sales > existing.gross_sales + DAILY_SALES_MATERIAL_DELTA) {
      existing.gross_sales = sales;
    }
  }
  return [...byDate.values()];
}

function overlayDailyMonths(opts: {
  months: MonthlyPnlRow[];
  skusByMonth: Record<string, MonthlySkuLine[]>;
  missing: Set<string>;
  titles: Record<string, string>;
  costs: Record<string, number>;
  avgCogs: number;
  adsSpend: Record<string, number>;
  adsDays: Record<string, Set<string>>;
  dailyAccount: DailyAccountRow[];
  dailySkus: DailySkuRow[];
  asOf: string | null;
  referralPct: number;
  fbaPerUnit: number;
}): void {
  const accountByYm = groupAmazonDays(opts.dailyAccount, opts.asOf);
  const skuByYm = groupAmazonDays(opts.dailySkus, opts.asOf);
  if (accountByYm.size === 0) return;

  const monthByYm = new Map(opts.months.map((m) => [ymOf(m.date), m]));

  for (const [ym, days] of accountByYm) {
    if (!dailyCoversMonth(days.length, ym, opts.asOf)) continue;
    const dailySales = money(days.reduce((s, r) => s + (Number(r.gross_sales) || 0), 0));
    const dailyUnits = days.reduce((s, r) => s + (Number(r.units) || 0), 0);
    const existing = monthByYm.get(ym);
    const skuSales = existing?.gross_sales ?? 0;
    const moreComplete = dailySales > skuSales + DAILY_SALES_MATERIAL_DELTA;
    // Closed prior months stay on sales_by_sku. Only the in-progress
    // month may take daily totals, and only when those are ahead.
    if (!isOpenMonth(ym, opts.asOf)) continue;
    if (existing && !moreComplete) continue;

    const skuDays = skuByYm.get(ym) ?? [];
    let cogs: number;
    if (skuDays.length > 0) {
      const built = buildDailySkuLines(skuDays, opts.costs, opts.avgCogs, opts.titles, opts.referralPct, opts.fbaPerUnit);
      opts.skusByMonth[ym] = built.lines;
      for (const sku of built.missing) opts.missing.add(sku);
      cogs = built.cogs;
    } else if (existing && skuSales > 0) {
      cogs = money(existing.est_cogs * (dailySales / skuSales));
    } else {
      cogs = money(days.reduce((s, r) => s + (Number(r.est_cogs) || 0), 0));
    }

    const referral = money(dailySales * opts.referralPct);
    const fba = money(dailyUnits * opts.fbaPerUnit);
    const next = accountMonthRow({
      ym,
      date: existing?.date ?? `${ym}-01`,
      sales: dailySales,
      units: dailyUnits,
      referral,
      fba,
      cogs,
      adsSpend: opts.adsSpend[ym] ?? existing?.ad_spend ?? 0,
      adsKnown: (opts.adsDays[ym]?.size ?? 0) > 0 || existing?.ads_basis === "known",
      source: "daily",
      salesBasis: "daily",
      closedDays: days.length,
    });

    if (existing) {
      const idx = opts.months.indexOf(existing);
      opts.months[idx] = next;
      monthByYm.set(ym, next);
    } else {
      opts.months.push(next);
      monthByYm.set(ym, next);
    }
  }
}

function buildDailySkuLines(
  rows: DailySkuRow[],
  costs: Record<string, number>,
  avgCogs: number,
  titles: Record<string, string>,
  referralPct: number,
  fbaPerUnit: number,
): { lines: MonthlySkuLine[]; missing: string[]; cogs: number } {
  const bySku = new Map<string, { units: number; sales: number; title: string | null }>();
  for (const r of rows) {
    const sku = normalizeSku(r.sku);
    if (!sku || sku === "UNKNOWN" || sku === "__UNALLOCATED__") continue;
    const existing = bySku.get(sku);
    if (existing) {
      existing.units += Number(r.units) || 0;
      existing.sales += Number(r.gross_sales) || 0;
    } else {
      bySku.set(sku, {
        units: Number(r.units) || 0,
        sales: Number(r.gross_sales) || 0,
        title: r.product_title ?? null,
      });
    }
    const title = r.product_title || "";
    if (title && (!titles[sku] || title.length > titles[sku].length)) titles[sku] = title;
  }

  const missing: string[] = [];
  const lines: MonthlySkuLine[] = [];
  let cogsTotal = 0;
  for (const [sku, row] of [...bySku.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const unitCost = costs[sku];
    const cogsEach = unitCost === undefined ? avgCogs : unitCost;
    if (unitCost === undefined) missing.push(sku);
    const sales = money(row.sales);
    const referral = money(sales * referralPct);
    const fba = money(row.units * fbaPerUnit);
    const cogs = money(row.units * cogsEach);
    cogsTotal = money(cogsTotal + cogs);
    lines.push({
      sku,
      title: titles[sku] ?? row.title,
      units: row.units,
      gross_sales: sales,
      est_referral_fees: referral,
      est_fba_fees: fba,
      est_cogs: cogs,
      est_contribution: money(sales - referral - fba - cogs),
    });
  }
  return { lines, missing, cogs: cogsTotal };
}

/** Keep a monthly row if the month overlaps [from, to] (inclusive). */
export function monthOverlapsWindow(row: Pick<PnlRow, "date">, from: string, to: string): boolean {
  const start = monthStart(row.date);
  const end = monthEnd(row.date);
  return start <= to && end >= from;
}
