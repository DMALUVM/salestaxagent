/**
 * Shopify / paid-social ads (google_ads | meta_ads).
 *
 * Matches production tables:
 *   paid_ads_snapshots         UNIQUE (channel, as_of, window_days)
 *   paid_ads_campaigns_window  UNIQUE (channel, as_of, window_days, campaign_name)
 *
 * Amazon PPC stays in ads_* tables. This module never scrapes Ads Manager.
 */

import { shiftDays } from "./as-of";

export const PAID_ADS_CHANNELS = ["google_ads", "meta_ads"] as const;
export type PaidAdsChannel = (typeof PAID_ADS_CHANNELS)[number];

export const PAID_ADS_WINDOWS = [1, 7, 14, 30] as const;
export type PaidAdsWindowDays = (typeof PAID_ADS_WINDOWS)[number];

export const PAID_ADS_SOURCE = "ads_ops";

export const PAID_ADS_ATTRIBUTION =
  "Data from Ads Ops structured feed — not a live Google/Meta Ads Manager scrape.";

const CHANNEL_ALIASES: Record<string, PaidAdsChannel> = {
  google_ads: "google_ads",
  google: "google_ads",
  googleads: "google_ads",
  "google-ads": "google_ads",
  google_ads_shopify: "google_ads",
  meta_ads: "meta_ads",
  meta: "meta_ads",
  facebook: "meta_ads",
  facebook_ads: "meta_ads",
  "facebook-ads": "meta_ads",
  fb_ads: "meta_ads",
  instagram_ads: "meta_ads",
};

const AMAZON_REJECT = /^(amazon|amazon_ads|amazon_ppc|ppc|sponsored_products)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface PaidAdsMetrics {
  spend: number;
  sales_or_conv_value: number;
  clicks: number;
  impressions: number;
  conversions: number;
  cpc: number;
  roas: number;
}

export interface PaidAdsSnapshotRow {
  channel: PaidAdsChannel;
  as_of: string;
  window_days: PaidAdsWindowDays;
  window_start: string | null;
  window_end: string | null;
  account_label: string | null;
  spend: number;
  conv_value: number;
  roas: number | null;
  clicks: number;
  impressions: number;
  conversions: number;
  cpc: number | null;
  currency: string;
  source: string | null;
  notes: unknown;
  ingested_at?: string;
}

export interface PaidAdsCampaignWindowRow {
  channel: PaidAdsChannel;
  as_of: string;
  window_days: PaidAdsWindowDays;
  campaign_id: string | null;
  campaign_name: string;
  spend: number;
  conv_value: number | null;
  roas: number | null;
  clicks: number | null;
  impressions: number | null;
  conversions: number | null;
  cpc: number | null;
  status: string | null;
  note: string | null;
  ingested_at?: string;
}

export interface PaidAdsCampaignAgg {
  campaign_id: string | null;
  campaign_name: string;
  spend: number;
  sales_or_conv_value: number | null;
  clicks: number | null;
  impressions: number | null;
  conversions: number | null;
  cpc: number | null;
  roas: number | null;
  status: string | null;
  note: string | null;
}

export interface PaidAdsKpis extends PaidAdsMetrics {
  currency: string;
  days_in_window: number;
}

export interface NormalizedPaidAdsPayload {
  channel: PaidAdsChannel;
  as_of: string;
  currency: string;
  source: string;
  account_label: string | null;
  snapshots: PaidAdsSnapshotRow[];
  campaignWindows: PaidAdsCampaignWindowRow[];
}

export type NormalizeResult =
  | { ok: true; data: NormalizedPaidAdsPayload }
  | { ok: false; error: string };

export interface ChannelWindowView {
  channel: PaidAdsChannel;
  window_days: PaidAdsWindowDays;
  as_of: string | null;
  source: "snapshot" | "empty";
  currency: string;
  kpis: PaidAdsKpis;
  campaigns: PaidAdsCampaignAgg[];
  account_label: string | null;
  window_start: string | null;
  window_end: string | null;
  notes: string[];
  feed_source: string | null;
  ingested_at: string | null;
}

export function isPaidAdsChannel(value: string): value is PaidAdsChannel {
  return (PAID_ADS_CHANNELS as readonly string[]).includes(value);
}

export function isPaidAdsWindow(value: number): value is PaidAdsWindowDays {
  return (PAID_ADS_WINDOWS as readonly number[]).includes(value);
}

export function normalizePaidAdsChannel(raw: unknown): PaidAdsChannel | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (!key) return null;
  if (AMAZON_REJECT.test(key) || key.startsWith("amazon")) return null;
  if (key in CHANNEL_ALIASES) return CHANNEL_ALIASES[key];
  if (isPaidAdsChannel(key)) return key;
  return null;
}

export function normalizePaidAdsWindow(raw: unknown): PaidAdsWindowDays | null {
  if (raw == null || raw === "") return null;
  const text = String(raw).trim().toLowerCase().replace(/d$/i, "");
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  const days = Math.trunc(n);
  return isPaidAdsWindow(days) ? days : null;
}

export function parseIsoDate(raw: unknown): string | null {
  if (raw == null) return null;
  const value = String(raw).trim().slice(0, 10);
  if (!ISO_DATE.test(value)) return null;
  const t = Date.parse(`${value}T12:00:00Z`);
  if (Number.isNaN(t)) return null;
  if (new Date(t).toISOString().slice(0, 10) !== value) return null;
  return value;
}

export function num(raw: unknown): number {
  if (raw == null || raw === "") return 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === "string") {
    const n = Number(raw.replace(/[$,]/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function optionalNum(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = num(raw);
  return Number.isFinite(n) ? n : null;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function emptyMetrics(): PaidAdsMetrics {
  return {
    spend: 0,
    sales_or_conv_value: 0,
    clicks: 0,
    impressions: 0,
    conversions: 0,
    cpc: 0,
    roas: 0,
  };
}

/** CPC / ROAS are ratios — never sum stored values across days. */
export function deriveRatios(m: {
  spend: number;
  clicks: number;
  sales_or_conv_value: number;
}): { cpc: number; roas: number } {
  return {
    cpc: m.clicks > 0 ? round4(m.spend / m.clicks) : 0,
    roas: m.spend > 0 ? round4(m.sales_or_conv_value / m.spend) : 0,
  };
}

function pickMetric(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] != null && obj[key] !== "") return obj[key];
  }
  return undefined;
}

export function metricsFromUnknown(raw: unknown): PaidAdsMetrics {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const spend = num(pickMetric(obj, ["spend", "cost", "amount_spent"]));
  const sales = num(pickMetric(obj, [
    "conv_value", "sales_or_conv_value", "sales", "conversion_value",
    "conversions_value", "purchase_value", "revenue",
  ]));
  const clicks = num(pickMetric(obj, ["clicks"]));
  const impressions = num(pickMetric(obj, ["impressions", "imps"]));
  const conversions = num(pickMetric(obj, ["conversions", "conv", "purchases"]));
  const providedCpc = pickMetric(obj, ["cpc"]);
  const providedRoas = pickMetric(obj, ["roas"]);
  const derived = deriveRatios({ spend, clicks, sales_or_conv_value: sales });
  return {
    spend: round2(spend),
    sales_or_conv_value: round2(sales),
    clicks,
    impressions,
    conversions: round2(conversions),
    cpc: providedCpc != null ? round4(num(providedCpc)) : derived.cpc,
    roas: providedRoas != null ? round4(num(providedRoas)) : derived.roas,
  };
}

export function sumMetrics(rows: Iterable<PaidAdsMetrics>): PaidAdsMetrics {
  const acc = emptyMetrics();
  for (const row of rows) {
    acc.spend += row.spend;
    acc.sales_or_conv_value += row.sales_or_conv_value;
    acc.clicks += row.clicks;
    acc.impressions += row.impressions;
    acc.conversions += row.conversions;
  }
  const ratios = deriveRatios(acc);
  return {
    spend: round2(acc.spend),
    sales_or_conv_value: round2(acc.sales_or_conv_value),
    clicks: acc.clicks,
    impressions: acc.impressions,
    conversions: round2(acc.conversions),
    cpc: ratios.cpc,
    roas: ratios.roas,
  };
}

/**
 * Production Ads Ops windows: N days ending the day before as_of.
 * 2026-08-22 / 7 → 2026-08-15 .. 2026-08-21.
 */
export function inferWindowBounds(asOf: string, windowDays: PaidAdsWindowDays): {
  window_start: string;
  window_end: string;
} {
  return {
    window_start: shiftDays(asOf, -windowDays),
    window_end: shiftDays(asOf, -1),
  };
}

export function notesFromUnknown(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

export function notesAsStrings(raw: unknown): string[] {
  return notesFromUnknown(raw)
    .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
    .filter(Boolean);
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

function currencyOf(raw: unknown, fallback = "USD"): string {
  const value = typeof raw === "string" && raw.trim() ? raw.trim().toUpperCase() : fallback;
  return value.slice(0, 8) || "USD";
}

function sourceOf(raw: unknown): string {
  const value = typeof raw === "string" && raw.trim() ? raw.trim() : PAID_ADS_SOURCE;
  if (/scrape|ads.?manager|puppeteer|playwright/i.test(value)) return PAID_ADS_SOURCE;
  return value.slice(0, 80);
}

function latestDate(dates: string[]): string | null {
  let max = "";
  for (const d of dates) {
    if (d && d > max) max = d;
  }
  return max || null;
}

export function latestAsOf(opts: {
  snapshots: Array<{ as_of?: string | null }>;
  campaignWindows?: Array<{ as_of?: string | null }>;
}): string | null {
  const dates = [
    ...opts.snapshots.map((r) => parseIsoDate(r.as_of) ?? ""),
    ...(opts.campaignWindows ?? []).map((r) => parseIsoDate(r.as_of) ?? ""),
  ].filter(Boolean);
  return latestDate(dates);
}

export function emptyKpis(currency = "USD"): PaidAdsKpis {
  return { ...emptyMetrics(), currency, days_in_window: 0 };
}

function campaignFromUnknown(
  raw: unknown,
  fallback: { channel: PaidAdsChannel; as_of: string; window_days: PaidAdsWindowDays },
): PaidAdsCampaignWindowRow | null {
  const obj = asRecord(raw);
  const campaign_name = String(obj.campaign_name ?? obj.name ?? "").trim();
  const campaign_id = String(obj.campaign_id ?? obj.id ?? "").trim() || null;
  if (!campaign_name && !campaign_id) return null;
  const name = campaign_name || campaign_id!;
  const metrics = metricsFromUnknown(obj);
  const hasConv = pickMetric(obj, [
    "conv_value", "sales_or_conv_value", "sales", "conversion_value",
    "conversions_value", "purchase_value", "revenue",
  ]) != null;
  const hasClicks = obj.clicks != null && obj.clicks !== "";
  const hasImpr = pickMetric(obj, ["impressions", "imps"]) != null;
  const hasConvCount = pickMetric(obj, ["conversions", "conv", "purchases"]) != null;
  const hasCpc = obj.cpc != null && obj.cpc !== "";
  const hasRoas = obj.roas != null && obj.roas !== "";
  const days = normalizePaidAdsWindow(obj.window_days ?? obj.days ?? obj.window)
    ?? fallback.window_days;
  return {
    channel: fallback.channel,
    as_of: parseIsoDate(obj.as_of) ?? fallback.as_of,
    window_days: days,
    campaign_id,
    campaign_name: name,
    spend: metrics.spend,
    conv_value: hasConv ? metrics.sales_or_conv_value : null,
    roas: hasRoas ? metrics.roas : (metrics.spend > 0 && hasConv ? metrics.roas : null),
    clicks: hasClicks ? metrics.clicks : null,
    impressions: hasImpr ? metrics.impressions : null,
    conversions: hasConvCount ? metrics.conversions : null,
    cpc: hasCpc ? metrics.cpc : null,
    status: typeof obj.status === "string" && obj.status.trim() ? obj.status.trim() : null,
    note: typeof obj.note === "string" && obj.note.trim() ? obj.note.trim() : null,
  };
}

function snapshotFromUnknown(
  raw: unknown,
  fallback: {
    channel: PaidAdsChannel;
    as_of: string;
    window_days: PaidAdsWindowDays;
    currency: string;
    source: string;
    account_label: string | null;
    notes: unknown;
  },
): PaidAdsSnapshotRow {
  const obj = asRecord(raw);
  const days = normalizePaidAdsWindow(obj.window_days ?? obj.days ?? obj.window)
    ?? fallback.window_days;
  const as_of = parseIsoDate(obj.as_of) ?? fallback.as_of;
  const bounds = inferWindowBounds(as_of, days);
  const metrics = metricsFromUnknown(obj);
  const notes = obj.notes != null ? notesFromUnknown(obj.notes) : notesFromUnknown(fallback.notes);
  return {
    channel: fallback.channel,
    as_of,
    window_days: days,
    window_start: parseIsoDate(obj.window_start) ?? bounds.window_start,
    window_end: parseIsoDate(obj.window_end) ?? bounds.window_end,
    account_label: typeof obj.account_label === "string" && obj.account_label.trim()
      ? obj.account_label.trim()
      : fallback.account_label,
    spend: metrics.spend,
    conv_value: metrics.sales_or_conv_value,
    roas: metrics.roas,
    clicks: metrics.clicks,
    impressions: metrics.impressions,
    conversions: metrics.conversions,
    cpc: metrics.cpc,
    currency: currencyOf(obj.currency, fallback.currency),
    source: sourceOf(obj.source ?? fallback.source),
    notes,
  };
}

export function campaignWindowToAgg(row: PaidAdsCampaignWindowRow): PaidAdsCampaignAgg {
  return {
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    spend: row.spend,
    sales_or_conv_value: row.conv_value,
    clicks: row.clicks,
    impressions: row.impressions,
    conversions: row.conversions,
    cpc: row.cpc,
    roas: row.roas,
    status: row.status,
    note: row.note,
  };
}

/**
 * Prefer the snapshot at the latest as_of for this window.
 * Campaigns come from paid_ads_campaigns_window at the same grain.
 */
export function selectChannelWindow(opts: {
  channel: PaidAdsChannel;
  windowDays: PaidAdsWindowDays;
  snapshots: PaidAdsSnapshotRow[];
  campaignWindows: PaidAdsCampaignWindowRow[];
  asOf?: string | null;
}): ChannelWindowView {
  const snaps = opts.snapshots.filter((r) => r.channel === opts.channel);
  const camps = opts.campaignWindows.filter((r) => r.channel === opts.channel);
  const asOf = opts.asOf ?? latestAsOf({ snapshots: snaps, campaignWindows: camps });

  if (!asOf) {
    return {
      channel: opts.channel,
      window_days: opts.windowDays,
      as_of: null,
      source: "empty",
      currency: "USD",
      kpis: emptyKpis(),
      campaigns: [],
      account_label: null,
      window_start: null,
      window_end: null,
      notes: [],
      feed_source: null,
      ingested_at: null,
    };
  }

  const snap = snaps
    .filter((s) => s.window_days === opts.windowDays && parseIsoDate(s.as_of) === asOf)
    .sort((a, b) => String(b.ingested_at ?? "").localeCompare(String(a.ingested_at ?? "")))[0];

  const campaigns = camps
    .filter((c) => c.window_days === opts.windowDays && parseIsoDate(c.as_of) === asOf)
    .map(campaignWindowToAgg)
    .sort((a, b) => b.spend - a.spend || a.campaign_name.localeCompare(b.campaign_name));

  if (!snap) {
    return {
      channel: opts.channel,
      window_days: opts.windowDays,
      as_of: asOf,
      source: "empty",
      currency: "USD",
      kpis: emptyKpis(),
      campaigns,
      account_label: null,
      window_start: null,
      window_end: null,
      notes: [],
      feed_source: null,
      ingested_at: camps.find((c) => parseIsoDate(c.as_of) === asOf)?.ingested_at ?? null,
    };
  }

  const ratios = deriveRatios({
    spend: snap.spend,
    clicks: snap.clicks,
    sales_or_conv_value: snap.conv_value,
  });
  return {
    channel: opts.channel,
    window_days: opts.windowDays,
    as_of: asOf,
    source: "snapshot",
    currency: snap.currency || "USD",
    kpis: {
      spend: snap.spend,
      sales_or_conv_value: snap.conv_value,
      clicks: snap.clicks,
      impressions: snap.impressions,
      conversions: snap.conversions,
      cpc: snap.cpc ?? ratios.cpc,
      roas: snap.roas ?? ratios.roas,
      currency: snap.currency || "USD",
      days_in_window: opts.windowDays,
    },
    campaigns,
    account_label: snap.account_label,
    window_start: parseIsoDate(snap.window_start),
    window_end: parseIsoDate(snap.window_end),
    notes: notesAsStrings(snap.notes),
    feed_source: snap.source,
    ingested_at: snap.ingested_at
      ?? campaigns.map((c) => camps.find((r) => r.campaign_name === c.campaign_name)?.ingested_at).find(Boolean)
      ?? null,
  };
}

/**
 * Accept a single Ads Ops payload and produce upsert-ready window rows.
 * Amazon / scrape-shaped sources are rejected, not coerced.
 */
export function normalizePaidAdsPayload(body: unknown): NormalizeResult {
  const root = asRecord(body);
  const channel = normalizePaidAdsChannel(root.channel);
  if (!channel) {
    return {
      ok: false,
      error: "channel must be google_ads or meta_ads (Amazon PPC stays in ads_* tables)",
    };
  }

  const windowIn = Array.isArray(root.windows) ? root.windows : [];
  const campaignIn = Array.isArray(root.campaigns) ? root.campaigns : [];
  const asOf = parseIsoDate(root.as_of)
    ?? parseIsoDate(root.date)
    ?? latestDate(windowIn.map((w) => parseIsoDate(asRecord(w).as_of) ?? "").filter(Boolean));
  if (!asOf) {
    return { ok: false, error: "as_of (YYYY-MM-DD) is required" };
  }

  const currency = currencyOf(root.currency);
  const source = sourceOf(root.source);
  const account_label = typeof root.account_label === "string" && root.account_label.trim()
    ? root.account_label.trim()
    : null;
  const notes = notesFromUnknown(root.notes);
  const fallbackWindow = normalizePaidAdsWindow(
    root.campaign_window_days ?? root.window_days ?? root.window,
  );

  const snapshotsByKey = new Map<string, PaidAdsSnapshotRow>();
  const campaignsByKey = new Map<string, PaidAdsCampaignWindowRow>();

  function putSnap(row: PaidAdsSnapshotRow) {
    snapshotsByKey.set(`${row.as_of}:${row.window_days}`, row);
  }
  function putCamp(row: PaidAdsCampaignWindowRow) {
    campaignsByKey.set(`${row.as_of}:${row.window_days}:${row.campaign_name}`, row);
  }

  for (const item of windowIn) {
    const obj = asRecord(item);
    const days = normalizePaidAdsWindow(obj.window_days ?? obj.days ?? obj.window);
    if (!days) continue;
    putSnap(snapshotFromUnknown(obj, {
      channel, as_of: asOf, window_days: days, currency, source, account_label, notes,
    }));
    if (Array.isArray(obj.campaigns)) {
      for (const c of obj.campaigns) {
        const row = campaignFromUnknown(c, { channel, as_of: asOf, window_days: days });
        if (row) putCamp(row);
      }
    }
  }

  const account = root.account && typeof root.account === "object" ? root.account : null;
  if (account && !snapshotsByKey.has(`${asOf}:1`)) {
    putSnap(snapshotFromUnknown(account, {
      channel, as_of: asOf, window_days: 1, currency, source, account_label, notes,
    }));
  }

  const defaultCampWindow = fallbackWindow
    ?? (windowIn.length
      ? Math.max(...[...snapshotsByKey.values()].map((s) => s.window_days)) as PaidAdsWindowDays
      : 30);

  for (const item of campaignIn) {
    const row = campaignFromUnknown(item, {
      channel, as_of: asOf, window_days: defaultCampWindow,
    });
    if (row) putCamp(row);
  }

  if (!snapshotsByKey.size && !campaignsByKey.size) {
    return { ok: false, error: "windows[] or campaigns[] or account is required" };
  }

  return {
    ok: true,
    data: {
      channel,
      as_of: asOf,
      currency,
      source,
      account_label,
      snapshots: [...snapshotsByKey.values()].sort((a, b) => a.window_days - b.window_days),
      campaignWindows: [...campaignsByKey.values()]
        .sort((a, b) => a.window_days - b.window_days || b.spend - a.spend),
    },
  };
}

function compactRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

/** Rows ready for PostgREST upsert against the production uniques. */
export function toUpsertRows(data: NormalizedPaidAdsPayload, ingestedAt: string) {
  return {
    snapshots: data.snapshots.map((row) => compactRow({
      channel: row.channel,
      as_of: row.as_of,
      window_days: row.window_days,
      window_start: row.window_start,
      window_end: row.window_end,
      account_label: row.account_label,
      spend: row.spend,
      conv_value: row.conv_value,
      roas: row.roas,
      clicks: row.clicks,
      impressions: row.impressions,
      conversions: row.conversions,
      cpc: row.cpc,
      currency: row.currency,
      source: row.source,
      notes: row.notes ?? [],
      ingested_at: ingestedAt,
    })),
    campaignWindows: data.campaignWindows.map((row) => compactRow({
      channel: row.channel,
      as_of: row.as_of,
      window_days: row.window_days,
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      spend: row.spend,
      conv_value: row.conv_value,
      roas: row.roas,
      clicks: row.clicks,
      impressions: row.impressions,
      conversions: row.conversions,
      cpc: row.cpc,
      status: row.status,
      note: row.note,
      ingested_at: ingestedAt,
    })),
  };
}

export function rowToSnapshot(raw: Record<string, unknown>): PaidAdsSnapshotRow | null {
  const channel = normalizePaidAdsChannel(raw.channel);
  const as_of = parseIsoDate(raw.as_of);
  const window_days = normalizePaidAdsWindow(raw.window_days);
  if (!channel || !as_of || !window_days) return null;
  return {
    channel,
    as_of,
    window_days,
    window_start: parseIsoDate(raw.window_start),
    window_end: parseIsoDate(raw.window_end),
    account_label: typeof raw.account_label === "string" ? raw.account_label : null,
    spend: num(raw.spend),
    conv_value: num(raw.conv_value ?? raw.sales_or_conv_value),
    roas: optionalNum(raw.roas),
    clicks: num(raw.clicks),
    impressions: num(raw.impressions),
    conversions: num(raw.conversions),
    cpc: optionalNum(raw.cpc),
    currency: currencyOf(raw.currency),
    source: typeof raw.source === "string" ? raw.source : null,
    notes: raw.notes,
    ingested_at: typeof raw.ingested_at === "string" ? raw.ingested_at : undefined,
  };
}

export function rowToCampaignWindow(raw: Record<string, unknown>): PaidAdsCampaignWindowRow | null {
  const channel = normalizePaidAdsChannel(raw.channel);
  const as_of = parseIsoDate(raw.as_of);
  const window_days = normalizePaidAdsWindow(raw.window_days);
  const campaign_name = String(raw.campaign_name ?? "").trim();
  if (!channel || !as_of || !window_days || !campaign_name) return null;
  return {
    channel,
    as_of,
    window_days,
    campaign_id: String(raw.campaign_id ?? "").trim() || null,
    campaign_name,
    spend: num(raw.spend),
    conv_value: optionalNum(raw.conv_value ?? raw.sales_or_conv_value),
    roas: optionalNum(raw.roas),
    clicks: optionalNum(raw.clicks),
    impressions: optionalNum(raw.impressions),
    conversions: optionalNum(raw.conversions),
    cpc: optionalNum(raw.cpc),
    status: typeof raw.status === "string" ? raw.status : null,
    note: typeof raw.note === "string" ? raw.note : null,
    ingested_at: typeof raw.ingested_at === "string" ? raw.ingested_at : undefined,
  };
}
