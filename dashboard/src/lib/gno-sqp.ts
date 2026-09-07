/**
 * Manual Brand Analytics SQP CSV parser for the GNO Watch upload slot.
 *
 * Mirrors src/amazon_ads/sqp_import.py. Rank is taken from an explicit
 * column or derived as a coarse band from click share. Rows without
 * rank AND without share are skipped for keyword_organic_rank — shares
 * are never invented. Full funnel rows still land in sqp_weekly.
 *
 * Official Seller Central Brand Analytics exports often start with a
 * metadata preamble (Brand=/Reporting Range=/Select week=) before the
 * real header row that contains "Search Query".
 */

import { matchBrandRule } from "@/lib/brand-terms";

export interface SqpRankRow {
  asin: string;
  keyword_normalized: string;
  keyword_raw: string;
  organic_rank: number;
  page: number;
  source: "sqp";
  as_of: string;
  impression_share_organic: number | null;
}

export interface SqpWeeklyRow {
  asin: string;
  search_query: string;
  query_normalized: string;
  week_start: string;
  week_end: string;
  report_period: "WEEK";
  is_branded: boolean;
  brand_rule: string | null;
  total_impressions: number | null;
  total_clicks: number | null;
  total_purchases: number | null;
  search_query_volume: number | null;
  asin_impressions: number | null;
  asin_clicks: number | null;
  asin_purchases: number | null;
  impression_share: number | null;
  click_share: number | null;
  purchase_share: number | null;
  source: "sqp_brand_csv";
}

export interface SqpParseResult {
  rows: SqpRankRow[];
  weekly: SqpWeeklyRow[];
  weekStart: string | null;
  weekEnd: string | null;
  parsed: number;
  skipped: number;
  warnings: string[];
}

const QUERY_HEADERS = ["search query", "query", "customer search term", "search term"];
const RANK_HEADERS = ["organic rank", "rank", "organic position", "position", "search query rank"];
/** Click-share synonyms for rank banding — Brand Analytics uses "Clicks: Brand Share %". */
const CLICK_SHARE_HEADERS = [
  "clicks brand share",
  "click share",
  "organic click share",
  "search query click share",
  "clicks click share",
  "asin click share",
];
const IMP_SHARE_HEADERS = [
  "impressions brand share",
  "impression share",
  "asin impression share",
];
const PURCH_SHARE_HEADERS = [
  "purchases brand share",
  "purchase share",
  "asin purchase share",
];
const ASIN_HEADERS = ["asin", "child asin", "parent asin"];
const DATE_HEADERS = ["reporting date", "date", "week", "start date", "reporting period"];
const VOLUME_HEADERS = ["search query volume", "query volume", "search volume"];
const IMP_TOTAL_HEADERS = ["impressions total count", "total impressions", "impression count"];
const IMP_BRAND_HEADERS = ["impressions brand count", "asin impressions", "brand impressions"];
const CLICK_TOTAL_HEADERS = ["clicks total count", "total clicks", "click count"];
const CLICK_BRAND_HEADERS = ["clicks brand count", "asin clicks", "brand clicks"];
const PURCH_TOTAL_HEADERS = ["purchases total count", "total purchases", "purchase count"];
const PURCH_BRAND_HEADERS = ["purchases brand count", "asin purchases", "brand purchases"];

const WEEK_SOURCE = "sqp_brand_csv" as const;

function canon(h: string): string {
  return String(h || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function findCol(fields: string[], candidates: string[]): string | null {
  const map = new Map(fields.map((f) => [canon(f), f]));
  for (const c of candidates) {
    if (map.has(c)) return map.get(c) ?? null;
  }
  for (const [c, original] of map) {
    if (candidates.some((cand) => c.includes(cand))) return original;
  }
  return null;
}

function parseShare(value: unknown): number | null {
  if (value == null || value === "") return null;
  let s = String(value).trim().replace(/,/g, "");
  const pct = s.endsWith("%");
  s = s.replace(/%$/, "").trim();
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  const frac = pct || v > 1 ? v / 100 : v;
  return Math.max(0, Math.min(1, frac));
}

function parseCount(value: unknown): number | null {
  if (value == null || value === "") return null;
  const s = String(value).trim().replace(/,/g, "");
  if (!s) return null;
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  return Math.trunc(v);
}

function rankFromShare(share: number): number {
  if (share >= 0.40) return 1;
  if (share >= 0.15) return 5;
  return 99;
}

export function normalizeSqpKeyword(text: string | null | undefined): string {
  return String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Amazon Brand Analytics metadata line before the real CSV header. */
export function isAmazonSqpPreamble(line: string): boolean {
  const s = String(line || "");
  return /Brand\s*=/.test(s) && /Reporting\s*Range\s*=/i.test(s);
}

/**
 * Parse week bounds from Seller Central preamble, e.g.
 * Select week=["Week 35 | 2026-08-23 - 2026-08-29 2026"]
 */
export function parseSelectWeekPreamble(text: string): {
  weekStart: string | null;
  weekEnd: string | null;
} {
  const m = String(text || "").match(
    /Select\s*week\s*=\s*\[[^\]]*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/i,
  );
  if (!m) return { weekStart: null, weekEnd: null };
  return { weekStart: m[1], weekEnd: m[2] };
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** First line whose cells include a Search Query (or synonym) header. */
export function findSqpHeaderRowIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    if (findCol(cols, QUERY_HEADERS)) return i;
  }
  return 0;
}

export function parseSqpCsv(content: string, defaultAsin = "", asOf?: string): SqpParseResult {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) {
    return {
      rows: [], weekly: [], weekStart: null, weekEnd: null,
      parsed: 0, skipped: 0, warnings: ["empty file / no header row"],
    };
  }

  const headerIdx = findSqpHeaderRowIndex(lines);
  const preambleText = lines.slice(0, headerIdx).join("\n");
  let { weekStart, weekEnd } = parseSelectWeekPreamble(
    preambleText || (isAmazonSqpPreamble(lines[0]) ? lines[0] : ""),
  );

  const headers = parseLine(lines[headerIdx]);
  const qCol = findCol(headers, QUERY_HEADERS);
  const rCol = findCol(headers, RANK_HEADERS);
  const clickShareCol = findCol(headers, CLICK_SHARE_HEADERS);
  const impShareCol = findCol(headers, IMP_SHARE_HEADERS);
  const purchShareCol = findCol(headers, PURCH_SHARE_HEADERS);
  const aCol = findCol(headers, ASIN_HEADERS);
  const dCol = findCol(headers, DATE_HEADERS);
  const volCol = findCol(headers, VOLUME_HEADERS);
  const impTotalCol = findCol(headers, IMP_TOTAL_HEADERS);
  const impBrandCol = findCol(headers, IMP_BRAND_HEADERS);
  const clickTotalCol = findCol(headers, CLICK_TOTAL_HEADERS);
  const clickBrandCol = findCol(headers, CLICK_BRAND_HEADERS);
  const purchTotalCol = findCol(headers, PURCH_TOTAL_HEADERS);
  const purchBrandCol = findCol(headers, PURCH_BRAND_HEADERS);

  const warnings: string[] = [];
  if (!qCol) {
    return {
      rows: [], weekly: [], weekStart, weekEnd,
      parsed: 0, skipped: 0,
      warnings: [`no search-query column found in: ${headers.join(", ")}`],
    };
  }
  if (!rCol && !clickShareCol) {
    warnings.push(
      "export has neither a rank column nor a click-share column — no rank can be established from it",
    );
  }
  if (headerIdx > 0) {
    warnings.push(`skipped ${headerIdx} Amazon metadata line(s) before header row`);
  }

  const today = asOf ?? new Date().toISOString().slice(0, 10);
  const bestRank = new Map<string, SqpRankRow>();
  const bestWeekly = new Map<string, SqpWeeklyRow>();
  let parsed = 0;
  let skipped = 0;
  let derived = 0;
  let reportingDateSeen: string | null = null;

  for (const line of lines.slice(headerIdx + 1)) {
    const cols = parseLine(line);
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => { rec[h] = cols[i] ?? ""; });
    const rawQ = rec[qCol] ?? "";
    const kw = normalizeSqpKeyword(rawQ);
    if (!kw) { skipped += 1; continue; }

    const asin = ((aCol ? rec[aCol] : "") || defaultAsin).trim();
    const clickShare = clickShareCol ? parseShare(rec[clickShareCol]) : null;
    const impShare = impShareCol ? parseShare(rec[impShareCol]) : null;
    const purchShare = purchShareCol ? parseShare(rec[purchShareCol]) : null;

    let rowDate = today;
    if (dCol && rec[dCol]) {
      const candidate = String(rec[dCol]).trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) {
        rowDate = candidate;
        reportingDateSeen = reportingDateSeen ?? candidate;
      }
    }

    let rank: number | null = null;
    if (rCol) {
      const v = Number(String(rec[rCol] ?? "").trim());
      if (Number.isFinite(v) && v > 0) rank = Math.trunc(v);
    }
    if (rank == null && clickShare != null) {
      rank = rankFromShare(clickShare);
      derived += 1;
    }

    if (rank != null) {
      const row: SqpRankRow = {
        asin,
        keyword_normalized: kw,
        keyword_raw: rawQ.trim(),
        organic_rank: rank,
        page: rank <= 48 ? 1 : 2,
        source: "sqp",
        as_of: rowDate,
        // Prefer reported click share; never invent from counts.
        impression_share_organic: clickShare,
      };
      parsed += 1;
      const key = `${row.asin}\t${row.keyword_normalized}`;
      const prev = bestRank.get(key);
      if (!prev || row.organic_rank < prev.organic_rank) bestRank.set(key, row);
    } else {
      skipped += 1;
    }

    // Funnel row for sqp_weekly — store reported values only (shares may be null).
    const rule = matchBrandRule(rawQ);
    const weekly: SqpWeeklyRow = {
      asin,
      search_query: rawQ.trim(),
      query_normalized: kw,
      week_start: weekStart ?? today,
      week_end: weekEnd ?? rowDate,
      report_period: "WEEK",
      is_branded: rule != null,
      brand_rule: rule,
      total_impressions: impTotalCol ? parseCount(rec[impTotalCol]) : null,
      total_clicks: clickTotalCol ? parseCount(rec[clickTotalCol]) : null,
      total_purchases: purchTotalCol ? parseCount(rec[purchTotalCol]) : null,
      search_query_volume: volCol ? parseCount(rec[volCol]) : null,
      asin_impressions: impBrandCol ? parseCount(rec[impBrandCol]) : null,
      asin_clicks: clickBrandCol ? parseCount(rec[clickBrandCol]) : null,
      asin_purchases: purchBrandCol ? parseCount(rec[purchBrandCol]) : null,
      impression_share: impShare,
      click_share: clickShare,
      purchase_share: purchShare,
      source: WEEK_SOURCE,
    };
    const wKey = `${weekly.asin}\t${weekly.query_normalized}\t${weekly.week_start}\t${weekly.source}`;
    bestWeekly.set(wKey, weekly);
  }

  // If preamble lacked Select week, derive from Reporting Date (week_end) − 6 days.
  if ((!weekStart || !weekEnd) && reportingDateSeen) {
    weekEnd = weekEnd ?? reportingDateSeen;
    weekStart = weekStart ?? addDaysIso(weekEnd, -6);
    for (const w of bestWeekly.values()) {
      w.week_start = weekStart;
      w.week_end = weekEnd;
    }
    warnings.push(
      `week bounds derived from Reporting Date ${reportingDateSeen} (week_start = week_end − 6 days)`,
    );
  } else if (weekStart && weekEnd) {
    for (const w of bestWeekly.values()) {
      w.week_start = weekStart;
      w.week_end = weekEnd;
    }
  }

  if (derived) {
    warnings.push(
      `${derived} row(s) had no rank column — rank BAND derived from click share (>=40% -> 1, >=15% -> 5, else 99). These are bands, not measured SERP positions.`,
    );
  }

  return {
    rows: [...bestRank.values()],
    weekly: [...bestWeekly.values()],
    weekStart,
    weekEnd,
    parsed,
    skipped,
    warnings,
  };
}
