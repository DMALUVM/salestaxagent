/**
 * Manual Brand Analytics SQP CSV parser for the GNO Watch upload slot.
 *
 * Mirrors src/amazon_ads/sqp_import.py. Rank is taken from an explicit
 * column or derived as a coarse band from click share. Rows without
 * rank AND without share are skipped — shares are never invented.
 */

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

const QUERY_HEADERS = ["search query", "query", "customer search term", "search term"];
const RANK_HEADERS = ["organic rank", "rank", "organic position", "position", "search query rank"];
const SHARE_HEADERS = [
  "click share", "organic click share", "search query click share",
  "clicks click share", "asin click share",
];
const ASIN_HEADERS = ["asin", "child asin", "parent asin"];
const DATE_HEADERS = ["reporting date", "date", "week", "start date", "reporting period"];

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
  let frac = pct || v > 1 ? v / 100 : v;
  return Math.max(0, Math.min(1, frac));
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

export function parseSqpCsv(content: string, defaultAsin = "", asOf?: string): {
  rows: SqpRankRow[];
  parsed: number;
  skipped: number;
  warnings: string[];
} {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) {
    return { rows: [], parsed: 0, skipped: 0, warnings: ["empty file / no header row"] };
  }
  const headers = parseLine(lines[0]);
  const qCol = findCol(headers, QUERY_HEADERS);
  const rCol = findCol(headers, RANK_HEADERS);
  const sCol = findCol(headers, SHARE_HEADERS);
  const aCol = findCol(headers, ASIN_HEADERS);
  const dCol = findCol(headers, DATE_HEADERS);
  const warnings: string[] = [];
  if (!qCol) {
    return { rows: [], parsed: 0, skipped: 0, warnings: [`no search-query column found in: ${headers.join(", ")}`] };
  }
  if (!rCol && !sCol) {
    warnings.push("export has neither a rank column nor a click-share column — no rank can be established from it");
  }

  const today = asOf ?? new Date().toISOString().slice(0, 10);
  const best = new Map<string, SqpRankRow>();
  let parsed = 0;
  let skipped = 0;
  let derived = 0;

  for (const line of lines.slice(1)) {
    const cols = parseLine(line);
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => { rec[h] = cols[i] ?? ""; });
    const rawQ = rec[qCol] ?? "";
    const kw = normalizeSqpKeyword(rawQ);
    if (!kw) { skipped += 1; continue; }

    let rank: number | null = null;
    let share: number | null = null;
    if (rCol) {
      const v = Number(String(rec[rCol] ?? "").trim());
      if (Number.isFinite(v) && v > 0) rank = Math.trunc(v);
    }
    if (sCol) share = parseShare(rec[sCol]);
    if (rank == null && share != null) {
      rank = rankFromShare(share);
      derived += 1;
    }
    if (rank == null) { skipped += 1; continue; }

    let rowDate = today;
    if (dCol && rec[dCol]) {
      const candidate = String(rec[dCol]).trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(candidate)) rowDate = candidate;
    }

    const row: SqpRankRow = {
      asin: ((aCol ? rec[aCol] : "") || defaultAsin).trim(),
      keyword_normalized: kw,
      keyword_raw: rawQ.trim(),
      organic_rank: rank,
      page: rank <= 48 ? 1 : 2,
      source: "sqp",
      as_of: rowDate,
      impression_share_organic: share,
    };
    parsed += 1;
    const key = `${row.asin}\t${row.keyword_normalized}`;
    const prev = best.get(key);
    if (!prev || row.organic_rank < prev.organic_rank) best.set(key, row);
  }

  if (derived) {
    warnings.push(
      `${derived} row(s) had no rank column — rank BAND derived from click share (>=40% -> 1, >=15% -> 5, else 99). These are bands, not measured SERP positions.`,
    );
  }
  return { rows: [...best.values()], parsed, skipped, warnings };
}
