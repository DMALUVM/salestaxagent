/**
 * Seller Central SKU Economics / Ads Console campaign CSV → monthly spend.
 * Mirrors src/parsers/amazon_ads_spend.py. Excel files go through the Mini.
 */

import { ADS_SKU_ECONOMICS_MIN_DATE } from "../sku-monthly-pnl";

export type AdsSpendKind = "sku_economics" | "ads_console";

export interface AdsMonthSpendRow {
  period_start: string;
  period_end: string;
  spend: number;
  source: AdsSpendKind;
}

export interface AdsDailySpendRow {
  date: string;
  campaign_id: string;
  campaign_name: string;
  campaign_type: "IMPORT";
  spend: number;
}

export interface AdsSpendParseResult {
  kind: AdsSpendKind | null;
  months: AdsMonthSpendRow[];
  daily: AdsDailySpendRow[];
  rows_total: number;
  rows_parsed: number;
  rows_skipped: number;
  warnings: string[];
}

const AD_FRAGMENTS = [
  "sponsored products charge",
  "sponsored brands charge",
  "sponsored display charge",
  "sponsored products ad fee",
  "sponsored brands ad fee",
  "sponsored display ad fee",
  "advertising cost",
  "advertising spend",
  "ad spend",
  "ppc spend",
  "total advertising",
  "ads cost",
  "cost of advertising",
];

function isAdColumn(name: string): boolean {
  return AD_FRAGMENTS.some((f) => name.includes(f));
}

function isAdSpendTotal(name: string): boolean {
  if (!isAdColumn(name)) return false;
  if (name.includes("per unit") || name.endsWith(" quantity") || name.endsWith(" qty")) {
    return false;
  }
  return true;
}

function norm(h: string): string {
  return h.replace(/^["']|["']$/g, "").trim().toLowerCase().replace(/[\s_\-/]+/g, " ");
}

function money(value: string): number {
  const t = (value || "").trim();
  if (!t || t === "-" || t === "—" || t.toLowerCase() === "n/a") return 0;
  const neg = t.startsWith("(") && t.endsWith(")");
  const n = Number(t.replace(/[$,()]/g, "").replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round((neg ? -n : n) * 100) / 100;
}

function parseDate(value: string): string | null {
  const t = (value || "").trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{4}-\d{2}$/.test(t)) return `${t}-01`;
  const mdy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const y = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${y}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  }
  const monthYear = Date.parse(`1 ${t}`);
  if (!Number.isNaN(monthYear) && /[a-z]/i.test(t)) {
    const d = new Date(monthYear);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
    }
  }
  return null;
}

function monthEnd(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 0));
  return end.toISOString().slice(0, 10);
}

function detectKind(headers: string[]): AdsSpendKind | null {
  const names = headers.map(norm);
  const hasAd = names.some(isAdColumn);
  const hasId = names.some((n) =>
    ["msku", "merchant sku", "child asin", "fnsku", "parent asin", "seller sku"].includes(n),
  );
  const hasSales = names.some((n) => n.includes("ordered product sales") || n === "sales");
  if (hasAd && (hasId || hasSales)) return "sku_economics";
  const set = new Set(names);
  if (set.has("date") && (set.has("spend") || set.has("cost"))
    && (set.has("campaign name") || set.has("campaign id"))) {
    return "ads_console";
  }
  return null;
}

function splitCsv(content: string): string[][] {
  const first = content.split(/\r?\n/, 1)[0] ?? "";
  const delim = first.includes("\t") && first.split("\t").length >= first.split(",").length
    ? "\t" : ",";
  return content.split(/\r?\n/).filter((l) => l.trim()).map((line) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (const ch of line) {
      if (ch === '"') { q = !q; continue; }
      if (ch === delim && !q) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  });
}

function headerRowIndex(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    if (detectKind(rows[i])) return i;
  }
  return -1;
}

export function isAmazonAdsSpendCsv(content: string): boolean {
  const rows = splitCsv(content);
  return headerRowIndex(rows) >= 0;
}

export function parseAmazonAdsSpendCsv(content: string): AdsSpendParseResult {
  const empty: AdsSpendParseResult = {
    kind: null, months: [], daily: [], rows_total: 0,
    rows_parsed: 0, rows_skipped: 0, warnings: [],
  };
  const rows = splitCsv(content);
  const hi = headerRowIndex(rows);
  if (hi < 0) {
    return { ...empty, warnings: ["Not a SKU Economics or Ads Console campaign report."] };
  }
  const headers = rows[hi];
  const kind = detectKind(headers);
  const body = rows.slice(hi + 1);
  const names = headers.map(norm);

  if (kind === "sku_economics") {
    const startIdx = names.findIndex((n) =>
      ["start date", "amazon store start date", "start date of amazon store",
        "period start", "report start date", "start"].includes(n));
    const endIdx = names.findIndex((n) =>
      ["end date", "amazon store end date", "end date of amazon store",
        "period end", "report end date", "end"].includes(n));
    const monthIdx = names.findIndex((n) =>
      ["month", "year month", "year-month", "reporting month"].includes(n));
    const adIdxs = names
      .map((n, i) => (isAdSpendTotal(n) ? i : -1))
      .filter((i) => i >= 0);
    const spend: Record<string, number> = {};
    let skipped = 0;
    let wide = 0;
    for (const row of body) {
      const start = parseDate(row[startIdx] ?? "") ?? (monthIdx >= 0 ? parseDate(row[monthIdx] ?? "") : null);
      if (!start) { skipped += 1; continue; }
      const end = parseDate(row[endIdx] ?? "") ?? monthEnd(start.slice(0, 7) + "-01");
      const span = (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400000 + 1;
      if (span > 32) { wide += 1; continue; }
      const ym = `${start.slice(0, 7)}-01`;
      spend[ym] = (spend[ym] ?? 0) + adIdxs.reduce((s, i) => s + money(row[i] ?? ""), 0);
    }
    const warnings: string[] = [];
    if (wide && !Object.keys(spend).length) {
      warnings.push("Rows span more than one month. Re-export SKU Economics with Monthly aggregation.");
    } else if (wide) {
      warnings.push(`Skipped ${wide} row(s) whose date range spans more than one month.`);
    }
    const months = Object.entries(spend).sort(([a], [b]) => a.localeCompare(b)).map(([period_start, s]) => ({
      period_start,
      period_end: monthEnd(period_start),
      spend: Math.round(s * 100) / 100,
      source: "sku_economics" as const,
    }));
    const floor = ADS_SKU_ECONOMICS_MIN_DATE.slice(0, 7) + "-01";
    const beforeFloor = months.filter((m) => m.period_start < floor);
    const kept = months.filter((m) => m.period_start >= floor);
    if (beforeFloor.length) {
      const d = new Date(`${ADS_SKU_ECONOMICS_MIN_DATE}T12:00:00`);
      const label = d.toLocaleString(undefined, { month: "long", year: "numeric" });
      warnings.push(
        `SKU Economics exports only go back to ${label}. Skipped ${beforeFloor.length} earlier month(s) — use Ads Console for older ad spend.`,
      );
    }
    return {
      kind, months: kept, daily: [], rows_total: body.length,
      rows_parsed: body.length - skipped - wide, rows_skipped: skipped + wide, warnings,
    };
  }

  const dateIdx = names.indexOf("date");
  const spendIdx = names.includes("spend") ? names.indexOf("spend") : names.indexOf("cost");
  const nameIdx = names.indexOf("campaign name");
  const idIdx = names.indexOf("campaign id");
  const daily: AdsDailySpendRow[] = [];
  const monthSpend: Record<string, number> = {};
  let skipped = 0;
  for (const row of body) {
    const day = parseDate(row[dateIdx] ?? "");
    if (!day) { skipped += 1; continue; }
    const name = (row[nameIdx] ?? "").trim() || "imported";
    const rawId = (row[idIdx] ?? "").trim();
    const spend = money(row[spendIdx] ?? "");
    daily.push({
      date: day,
      campaign_id: `csv:${rawId || name}:${day}`.slice(0, 120),
      campaign_name: name.slice(0, 200),
      campaign_type: "IMPORT",
      spend,
    });
    const ym = `${day.slice(0, 7)}-01`;
    monthSpend[ym] = (monthSpend[ym] ?? 0) + spend;
  }
  const months = Object.entries(monthSpend).sort(([a], [b]) => a.localeCompare(b)).map(([period_start, s]) => ({
    period_start,
    period_end: monthEnd(period_start),
    spend: Math.round(s * 100) / 100,
    source: "ads_console" as const,
  }));
  return {
    kind: "ads_console", months, daily, rows_total: body.length,
    rows_parsed: daily.length, rows_skipped: skipped, warnings: [],
  };
}
