/**
 * Map official API warehouse rows into the CampaignDaily / GaDaily /
 * SearchQueryDaily shapes /paid-ads intel already consumes.
 *
 * Prefer google_ads_daily / ga4_landing_daily / gsc_*_daily / meta_ads_daily
 * when they have rows. Fall back to the CSV tables (paid_campaign_daily,
 * paid_ga_daily, paid_search_query_daily) when the API table is empty —
 * Meta Marketing API is still pending, so Meta stays on CSV until
 * meta_ads_daily is populated.
 *
 * Never invent spend, conversions, revenue, or channel groups. API GA4
 * has no session default channel group and no last-click revenue.
 */

import {
  audienceOf, campaignTypeOf, isBrandCampaign, productOf,
} from "./classify";
import type {
  CampaignDaily, GaDaily, SearchQueryDaily, WarehouseOrigin,
} from "./types";

export interface ApiTableStats {
  rows: number;
  min_date: string | null;
  max_date: string | null;
  fetched_at: string | null;
  missing: boolean;
}

export function isoDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
}

export function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Search Console API stores CTR as 0–1; intel / CSV path stores 0–100. */
export function gscCtrToPct(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n;
}

/** Bounce 0–100 from engaged/sessions. Null when either side is missing. */
export function bounceFromEngaged(
  sessions: unknown,
  engaged: unknown,
): number | null {
  if (sessions == null || engaged == null || sessions === "" || engaged === "") {
    return null;
  }
  const s = num(sessions);
  if (s <= 0) return null;
  const e = num(engaged);
  const bounce = (1 - e / s) * 100;
  return Number.isFinite(bounce) ? Math.max(0, Math.min(100, bounce)) : null;
}

export function preferApiWhenPresent(api: ApiTableStats): WarehouseOrigin {
  return !api.missing && api.rows > 0 ? "api" : "csv";
}

export function pickOriginStats(
  origin: WarehouseOrigin,
  api: ApiTableStats,
  csv: { rows: number; min_date: string | null; max_date: string | null },
): {
  rows: number;
  min_date: string | null;
  max_date: string | null;
  origin: WarehouseOrigin;
  fetched_at: string | null;
} {
  if (origin === "api") {
    return {
      rows: api.rows,
      min_date: api.min_date,
      max_date: api.max_date,
      origin: "api",
      fetched_at: api.fetched_at,
    };
  }
  return {
    rows: csv.rows,
    min_date: csv.min_date,
    max_date: csv.max_date,
    origin: "csv",
    fetched_at: null,
  };
}

export function adaptGoogleAdsDaily(row: Record<string, unknown>): CampaignDaily | null {
  return adaptAdsApiRow(row, "google");
}

export function adaptMetaAdsDaily(row: Record<string, unknown>): CampaignDaily | null {
  return adaptAdsApiRow(row, "meta");
}

function adaptAdsApiRow(
  row: Record<string, unknown>,
  platform: "google" | "meta",
): CampaignDaily | null {
  const date = isoDate(row.metric_date);
  const campaign_name = String(row.campaign_name ?? "").trim();
  if (!date || !campaign_name) return null;
  const campaign_type = campaignTypeOf(campaign_name);
  return {
    platform,
    date,
    campaign_name,
    campaign_type,
    product: productOf(campaign_name),
    is_brand: isBrandCampaign(campaign_name),
    audience: audienceOf(campaign_name, platform),
    spend: num(row.spend),
    conv_value: num(row.conversion_value),
    clicks: num(row.clicks),
    impressions: num(row.impressions),
    conversions: num(row.conversions),
    lost_is_budget: null,
    lost_is_rank: null,
    search_impr_share: null,
    search_top_is: null,
    frequency: null,
    frequency_peak: null,
    status: null,
  };
}

export function adaptGa4LandingDaily(row: Record<string, unknown>): GaDaily | null {
  const date = isoDate(row.metric_date);
  if (!date) return null;
  const landing = String(row.landing_page ?? "").trim() || "/";
  const device = String(row.device ?? "").trim() || "unknown";
  return {
    date,
    // Official GA4 landing pull has no session-default channel group.
    // Do not invent Paid Search / Paid Social from the landing path.
    channel_group: "(not set)",
    landing_page: landing,
    device,
    sessions: num(row.sessions),
    active_users: 0,
    // purchase is the only ecommerce conversion the API stores. Never infer.
    key_events: row.purchase == null ? 0 : num(row.purchase),
    // No last-click revenue on ga4_landing_daily. Leave 0 — do not invent.
    revenue: 0,
    bounce_rate: bounceFromEngaged(row.sessions, row.engaged_sessions),
  };
}

export function adaptGscQueryDaily(row: Record<string, unknown>): SearchQueryDaily | null {
  const date = isoDate(row.metric_date);
  const query = String(row.query ?? "").trim();
  if (!date || !query) return null;
  return {
    kind: "query",
    date,
    query,
    clicks: num(row.clicks),
    impressions: num(row.impressions),
    ctr: gscCtrToPct(row.ctr),
    position: row.position == null ? null : num(row.position),
  };
}

export function adaptGscPageDaily(row: Record<string, unknown>): SearchQueryDaily | null {
  const date = isoDate(row.metric_date);
  const page = String(row.page ?? "").trim();
  if (!date || !page) return null;
  return {
    kind: "page",
    date,
    query: page,
    clicks: num(row.clicks),
    impressions: num(row.impressions),
    ctr: gscCtrToPct(row.ctr),
    position: row.position == null ? null : num(row.position),
  };
}

/** Daily site totals from dated GSC query rows — stands in for Chart.csv. */
export function synthesizeGscChart(queries: SearchQueryDaily[]): SearchQueryDaily[] {
  const by = new Map<string, { clicks: number; impressions: number; posNum: number; posDen: number }>();
  for (const row of queries) {
    if (row.kind !== "query" || !row.date) continue;
    const cur = by.get(row.date) ?? { clicks: 0, impressions: 0, posNum: 0, posDen: 0 };
    cur.clicks += row.clicks;
    cur.impressions += row.impressions;
    if (row.position != null && row.impressions > 0) {
      cur.posNum += row.position * row.impressions;
      cur.posDen += row.impressions;
    }
    by.set(row.date, cur);
  }
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({
      kind: "chart" as const,
      date,
      query: "(site)",
      clicks: v.clicks,
      impressions: v.impressions,
      ctr: v.impressions ? (v.clicks / v.impressions) * 100 : null,
      position: v.posDen ? v.posNum / v.posDen : null,
    }));
}

export function maxFetchedAt(values: Array<string | null | undefined>): string | null {
  let max = "";
  for (const value of values) {
    if (value && value > max) max = value;
  }
  return max || null;
}
