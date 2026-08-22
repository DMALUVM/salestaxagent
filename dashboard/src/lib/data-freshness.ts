/**
 * Shared "Data as of …" math for the layout freshness strip.
 *
 * Pulse source of truth for Amazon sales is amazon_spapi / sales_daily.
 * Quarantined tax reports never feed this strip.
 */

import { AMAZON, normalizeChannel, SHOPIFY } from "./channels";

export interface FreshnessInputRow {
  sale_date?: string | null;
  channel?: string | null;
}

export interface IngestInputRow {
  ingested_at?: string | null;
  file_type?: string | null;
}

export interface FreshnessSummary {
  asOf: string | null;
  shopifyMax: string | null;
  amazonMax: string | null;
  shopifyIngest: string | null;
  amazonIngest: string | null;
  shopifyStale: boolean;
  amazonStale: boolean;
  stale: boolean;
}

const STALE_MS = 36 * 3600 * 1000;

export function isStaleDate(dateStr: string | null, nowMs: number): boolean {
  if (!dateStr) return true;
  const t = new Date(`${dateStr}T23:59:59`).getTime();
  if (Number.isNaN(t)) return true;
  return nowMs - t > STALE_MS;
}

export function summarizeFreshness(
  sales: FreshnessInputRow[],
  ingest: IngestInputRow[],
  now: Date = new Date(),
): FreshnessSummary {
  let shopifyMax = "";
  let amazonMax = "";
  for (const row of sales) {
    const d = row.sale_date ?? "";
    if (!d) continue;
    const ch = normalizeChannel(row.channel ?? "");
    if (ch === SHOPIFY && d > shopifyMax) shopifyMax = d;
    if (ch === AMAZON && d > amazonMax) amazonMax = d;
  }

  let shopifyIngest = "";
  let amazonIngest = "";
  for (const row of ingest) {
    const at = row.ingested_at ?? "";
    if (!at) continue;
    const ch = normalizeChannel(row.file_type ?? "");
    if (ch === SHOPIFY && at > shopifyIngest) shopifyIngest = at;
    if (ch === AMAZON && at > amazonIngest) amazonIngest = at;
  }

  const nowMs = now.getTime();
  const shopifyStale = isStaleDate(shopifyMax || null, nowMs);
  const amazonStale = isStaleDate(amazonMax || null, nowMs);
  const asOf = shopifyMax >= amazonMax ? shopifyMax || amazonMax || null : amazonMax || shopifyMax || null;

  return {
    asOf,
    shopifyMax: shopifyMax || null,
    amazonMax: amazonMax || null,
    shopifyIngest: shopifyIngest || null,
    amazonIngest: amazonIngest || null,
    shopifyStale,
    amazonStale,
    stale: shopifyStale || amazonStale,
  };
}
