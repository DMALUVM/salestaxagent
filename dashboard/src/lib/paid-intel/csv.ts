/** RFC-style CSV + a small ZIP reader for GSC exports. */

import { inflateRawSync } from "node:zlib";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
}

export function normHeader(h: string): string {
  return String(h ?? "")
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.]/g, "")
    .trim();
}

export function headerIndex(headers: string[]): Map<string, number> {
  const map = new Map<string, number>();
  headers.forEach((h, i) => map.set(normHeader(h), i));
  return map;
}

export function col(idx: Map<string, number>, row: string[], ...aliases: string[]): string {
  for (const a of aliases) {
    const i = idx.get(normHeader(a));
    if (i != null && row[i] != null && String(row[i]).trim() !== "") return String(row[i]).trim();
  }
  return "";
}

export function parseMoney(raw: unknown): number {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s || s === "--" || s === "—" || s === "-" || s === "n/a") return 0;
  const n = Number(s.replace(/[$,]/g, "").replace(/%/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

/** Percent as 0–100. `< 10%` → 10, `> 90%` → 90. `--` → null. */
export function parsePct(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s === "--" || s === "—" || s === "-") return null;
  if (s.startsWith(">") || s.startsWith("<")) {
    const n = parseFloat(s.slice(1).replace(/%/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  const n = parseFloat(s.replace(/%/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/;

export function parseDate(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s || s.startsWith("#")) return null;
  if (ISO.test(s)) {
    const t = Date.parse(`${s}T12:00:00Z`);
    if (Number.isNaN(t)) return null;
    if (new Date(t).toISOString().slice(0, 10) !== s) return null;
    return s;
  }
  const compact = s.match(COMPACT);
  if (compact) return parseDate(`${compact[1]}-${compact[2]}-${compact[3]}`);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mm = m[1].padStart(2, "0");
    const dd = m[2].padStart(2, "0");
    return parseDate(`${m[3]}-${mm}-${dd}`);
  }
  return null;
}

export function isTotalLabel(raw: unknown): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "total" || s === "totals" || s.startsWith("total:") || s === "grand total"
    || s === "total: account" || /\bgrand total\b/.test(s);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function deriveRoas(spend: number, conv: number): number {
  return spend > 0 ? round4(conv / spend) : 0;
}

export function deriveCpc(spend: number, clicks: number): number {
  return clicks > 0 ? round4(spend / clicks) : 0;
}

/**
 * Extract CSV members from a GSC (or any) zip. Supports store (0) and
 * deflate (8). Bit-3 data-descriptor zips are skipped with an empty result
 * so the caller can ask for the three CSVs instead.
 */
export function unzipCsvs(buf: Buffer): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  let i = 0;
  while (i < buf.length - 30) {
    const sig = buf.readUInt32LE(i);
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    if (sig !== 0x04034b50) {
      i++;
      continue;
    }
    const flags = buf.readUInt16LE(i + 6);
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString("utf8");
    const dataStart = i + 30 + nameLen + extraLen;
    if (flags & 0x08) return out;
    const data = buf.subarray(dataStart, dataStart + compSize);
    let raw: Buffer;
    if (method === 0) raw = Buffer.from(data);
    else if (method === 8) raw = inflateRawSync(data);
    else {
      i = dataStart + compSize;
      continue;
    }
    const base = name.split("/").pop() || name;
    if (base.toLowerCase().endsWith(".csv") && !base.startsWith(".")) {
      out.push({ name: base, text: raw.toString("utf8") });
    }
    i = dataStart + compSize;
  }
  return out;
}
