/**
 * Shopify / paid-social ads (google_ads | meta_ads).
 *
 * Amazon PPC stays in ads_* tables. This module only normalizes Ads Ops
 * structured payloads and rolls windows from daily / snapshot rows.
 * It never scrapes Google or Meta Ads Manager.
 */

import { shiftDays, windowStart } from "./as-of";

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

export interface PaidAdsDailyRow extends PaidAdsMetrics {
  channel: PaidAdsChannel;
  date: string;
  currency: string;
  source: string;
  ingested_at?: string;
}

export interface PaidAdsCampaignDailyRow extends PaidAdsMetrics {
  channel: PaidAdsChannel;
  date: string;
  campaign_id: string;
  campaign_name: string;
  ingested_at?: string;
}

export interface PaidAdsSnapshotRow extends PaidAdsMetrics {
  channel: PaidAdsChannel;
  as_of: string;
  window_days: PaidAdsWindowDays;
  currency: string;
  source: string;
  metrics: Record<string, unknown>;
  ingested_at?: string;
}

export interface PaidAdsCampaignAgg extends PaidAdsMetrics {
  campaign_id: string;
  campaign_name: string;
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
  daily: PaidAdsDailyRow[];
  campaigns: PaidAdsCampaignDailyRow[];
  snapshots: PaidAdsSnapshotRow[];
}

export type NormalizeResult =
  | { ok: true; data: NormalizedPaidAdsPayload }
  | { ok: false; error: string };

export interface ChannelWindowView {
  channel: PaidAdsChannel;
  window_days: PaidAdsWindowDays;
  as_of: string | null;
  source: "snapshot" | "daily_rollup" | "empty";
  currency: string;
  kpis: PaidAdsKpis;
  campaigns: PaidAdsCampaignAgg[];
  date_min: string | null;
  date_max: string | null;
  ingested_at: string | null;
}

export function isPaidAdsChannel(value: string): value is PaidAdsChannel {
  return (PAID_ADS_CHANNELS as readonly string[]).includes(value);
}

export function isPaidAdsWindow(value: number): value is PaidAdsWindowDays {
  return (PAID_ADS_WINDOWS as readonly number[]).includes(value);
}

/** Map Ads Ops / operator aliases to google_ads | meta_ads. Reject Amazon PPC. */
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
  if (typeof raw !== "string") return null;
  const value = raw.trim().slice(0, 10);
  if (!ISO_DATE.test(value)) return null;
  const t = Date.parse(`${value}T12:00:00Z`);
  if (Number.isNaN(t)) return null;
  // Reject overflow like 2026-02-31 which Date.parse accepts then rolls.
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
    "sales_or_conv_value", "sales", "conv_value", "conversion_value",
    "conversions_value", "purchase_value", "revenue",
  ]));
  const clicks = Math.round(num(pickMetric(obj, ["clicks"])));
  const impressions = Math.round(num(pickMetric(obj, ["impressions", "imps"])));
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

export function inInclusiveWindow(date: string, asOf: string, windowDays: number): boolean {
  if (!date || !asOf) return false;
  const from = windowStart(asOf, windowDays);
  return date >= from && date <= asOf;
}

export function rollupDailyWindow(
  daily: PaidAdsDailyRow[],
  asOf: string,
  windowDays: PaidAdsWindowDays,
): PaidAdsKpis {
  const rows = daily.filter((r) => inInclusiveWindow(r.date, asOf, windowDays));
  const metrics = sumMetrics(rows);
  const currency = rows[rows.length - 1]?.currency ?? daily[0]?.currency ?? "USD";
  return { ...metrics, currency, days_in_window: rows.length };
}

export function rollupCampaignsWindow(
  campaigns: PaidAdsCampaignDailyRow[],
  asOf: string,
  windowDays: PaidAdsWindowDays,
  limit = 25,
): PaidAdsCampaignAgg[] {
  const byId = new Map<string, PaidAdsCampaignDailyRow[]>();
  for (const row of campaigns) {
    if (!inInclusiveWindow(row.date, asOf, windowDays)) continue;
    const list = byId.get(row.campaign_id) ?? [];
    list.push(row);
    byId.set(row.campaign_id, list);
  }
  const out: PaidAdsCampaignAgg[] = [];
  for (const [campaign_id, rows] of byId) {
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const latest = rows[rows.length - 1];
    const name = [...rows].reverse().find((r) => r.campaign_name)?.campaign_name
      ?? latest?.campaign_name
      ?? campaign_id;
    out.push({ campaign_id, campaign_name: name, ...sumMetrics(rows) });
  }
  out.sort((a, b) => b.spend - a.spend || a.campaign_name.localeCompare(b.campaign_name));
  return out.slice(0, limit);
}

function campaignAggFromUnknown(
  raw: unknown,
  fallbackId: string,
): PaidAdsCampaignAgg | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const campaign_id = String(obj.campaign_id ?? obj.id ?? fallbackId).trim();
  if (!campaign_id) return null;
  const campaign_name = String(obj.campaign_name ?? obj.name ?? campaign_id).trim();
  return { campaign_id, campaign_name, ...metricsFromUnknown(obj) };
}

function latestDate(dates: string[]): string | null {
  let max = "";
  for (const d of dates) {
    if (d && d > max) max = d;
  }
  return max || null;
}

export function latestAsOf(opts: {
  daily: Array<{ date?: string | null }>;
  snapshots: Array<{ as_of?: string | null }>;
}): string | null {
  const dates = [
    ...opts.daily.map((r) => r.date ?? ""),
    ...opts.snapshots.map((r) => r.as_of ?? ""),
  ].filter(Boolean);
  return latestDate(dates);
}

function snapshotCampaigns(snapshot: PaidAdsSnapshotRow | undefined): PaidAdsCampaignAgg[] {
  if (!snapshot) return [];
  const raw = snapshot.metrics?.campaigns;
  if (!Array.isArray(raw)) return [];
  const out: PaidAdsCampaignAgg[] = [];
  raw.forEach((item, i) => {
    const row = campaignAggFromUnknown(item, `campaign-${i + 1}`);
    if (row) out.push(row);
  });
  out.sort((a, b) => b.spend - a.spend);
  return out;
}

export function emptyKpis(currency = "USD"): PaidAdsKpis {
  return { ...emptyMetrics(), currency, days_in_window: 0 };
}

/**
 * Prefer a snapshot whose as_of matches the latest available date.
 * Otherwise roll daily rows. Snapshot campaign lists win when present.
 */
export function selectChannelWindow(opts: {
  channel: PaidAdsChannel;
  windowDays: PaidAdsWindowDays;
  daily: PaidAdsDailyRow[];
  campaigns: PaidAdsCampaignDailyRow[];
  snapshots: PaidAdsSnapshotRow[];
  asOf?: string | null;
}): ChannelWindowView {
  const channelDaily = opts.daily.filter((r) => r.channel === opts.channel);
  const channelCampaigns = opts.campaigns.filter((r) => r.channel === opts.channel);
  const channelSnaps = opts.snapshots.filter((r) => r.channel === opts.channel);
  const asOf = opts.asOf ?? latestAsOf({ daily: channelDaily, snapshots: channelSnaps });

  const date_min = latestDate(
    [...channelDaily.map((r) => r.date)].sort(),
  ) && channelDaily.length
    ? [...channelDaily.map((r) => r.date)].sort()[0]
    : null;
  const date_max = latestDate(channelDaily.map((r) => r.date));

  if (!asOf) {
    return {
      channel: opts.channel,
      window_days: opts.windowDays,
      as_of: null,
      source: "empty",
      currency: "USD",
      kpis: emptyKpis(),
      campaigns: [],
      date_min,
      date_max,
      ingested_at: null,
    };
  }

  const snap = channelSnaps
    .filter((s) => s.window_days === opts.windowDays && s.as_of === asOf)
    .sort((a, b) => String(b.ingested_at ?? "").localeCompare(String(a.ingested_at ?? "")))[0];

  const rolled = rollupDailyWindow(channelDaily, asOf, opts.windowDays);
  const rolledCampaigns = rollupCampaignsWindow(channelCampaigns, asOf, opts.windowDays);
  const snapCampaigns = snapshotCampaigns(snap);

  const ingested_at = [
    snap?.ingested_at,
    ...channelDaily.filter((r) => inInclusiveWindow(r.date, asOf, opts.windowDays)).map((r) => r.ingested_at),
  ].filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;

  if (snap) {
    const ratios = deriveRatios(snap);
    return {
      channel: opts.channel,
      window_days: opts.windowDays,
      as_of: asOf,
      source: "snapshot",
      currency: snap.currency || rolled.currency || "USD",
      kpis: {
        spend: snap.spend,
        sales_or_conv_value: snap.sales_or_conv_value,
        clicks: snap.clicks,
        impressions: snap.impressions,
        conversions: snap.conversions,
        cpc: snap.cpc || ratios.cpc,
        roas: snap.roas || ratios.roas,
        currency: snap.currency || "USD",
        days_in_window: rolled.days_in_window || opts.windowDays,
      },
      campaigns: snapCampaigns.length ? snapCampaigns : rolledCampaigns,
      date_min,
      date_max,
      ingested_at,
    };
  }

  const hasDaily = rolled.days_in_window > 0;
  return {
    channel: opts.channel,
    window_days: opts.windowDays,
    as_of: asOf,
    source: hasDaily ? "daily_rollup" : "empty",
    currency: rolled.currency,
    kpis: hasDaily ? rolled : emptyKpis(rolled.currency),
    campaigns: rolledCampaigns,
    date_min,
    date_max,
    ingested_at,
  };
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
  // Never pretend a scrape landed here.
  if (/scrape|ads.?manager|puppeteer|playwright/i.test(value)) return PAID_ADS_SOURCE;
  return value.slice(0, 64);
}

/**
 * Accept a single Ads Ops payload and produce upsert-ready rows.
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

  const dailyIn = Array.isArray(root.daily) ? root.daily : [];
  const windowIn = Array.isArray(root.windows) ? root.windows : [];
  const campaignIn = Array.isArray(root.campaigns) ? root.campaigns : [];

  const datedDaily = dailyIn
    .map((row) => parseIsoDate(asRecord(row).date))
    .filter((d): d is string => Boolean(d));
  const asOf = parseIsoDate(root.as_of)
    ?? latestDate(datedDaily)
    ?? parseIsoDate(root.date);
  if (!asOf) {
    return { ok: false, error: "as_of (YYYY-MM-DD) is required when daily dates are absent" };
  }

  const currency = currencyOf(root.currency);
  const source = sourceOf(root.source);
  const account = root.account && typeof root.account === "object" ? root.account : null;

  const dailyByDate = new Map<string, PaidAdsDailyRow>();
  for (const item of dailyIn) {
    const obj = asRecord(item);
    const date = parseIsoDate(obj.date);
    if (!date) continue;
    dailyByDate.set(date, {
      channel,
      date,
      currency: currencyOf(obj.currency, currency),
      source: sourceOf(obj.source ?? source),
      ...metricsFromUnknown(obj),
    });
  }

  if (account && !dailyByDate.has(asOf)) {
    dailyByDate.set(asOf, {
      channel,
      date: asOf,
      currency,
      source,
      ...metricsFromUnknown(account),
    });
  }

  // A 1-day window is also a daily account rollup when no daily row exists.
  for (const item of windowIn) {
    const obj = asRecord(item);
    const days = normalizePaidAdsWindow(obj.window_days ?? obj.days ?? obj.window);
    if (days === 1 && !dailyByDate.has(asOf)) {
      dailyByDate.set(asOf, {
        channel,
        date: asOf,
        currency: currencyOf(obj.currency, currency),
        source,
        ...metricsFromUnknown(obj),
      });
    }
  }

  const snapshots: PaidAdsSnapshotRow[] = [];
  const snapshotCampaigns = new Map<PaidAdsWindowDays, PaidAdsCampaignAgg[]>();

  for (const item of windowIn) {
    const obj = asRecord(item);
    const days = normalizePaidAdsWindow(obj.window_days ?? obj.days ?? obj.window);
    if (!days) continue;
    const winCampaigns: PaidAdsCampaignAgg[] = [];
    if (Array.isArray(obj.campaigns)) {
      obj.campaigns.forEach((c, i) => {
        const row = campaignAggFromUnknown(c, `campaign-${i + 1}`);
        if (row) winCampaigns.push(row);
      });
    }
    if (winCampaigns.length) snapshotCampaigns.set(days, winCampaigns);
    snapshots.push({
      channel,
      as_of: parseIsoDate(obj.as_of) ?? asOf,
      window_days: days,
      currency: currencyOf(obj.currency, currency),
      source,
      metrics: winCampaigns.length ? { campaigns: winCampaigns } : {},
      ...metricsFromUnknown(obj),
    });
  }

  const topLevelWindow = normalizePaidAdsWindow(
    root.campaign_window_days ?? root.window_days ?? root.window,
  );
  const campaigns: PaidAdsCampaignDailyRow[] = [];
  const undatedCampaigns: PaidAdsCampaignAgg[] = [];

  for (const item of campaignIn) {
    const obj = asRecord(item);
    const campaign_id = String(obj.campaign_id ?? obj.id ?? "").trim();
    if (!campaign_id) continue;
    const campaign_name = String(obj.campaign_name ?? obj.name ?? campaign_id).trim();
    const date = parseIsoDate(obj.date);
    const metrics = metricsFromUnknown(obj);
    if (date) {
      campaigns.push({
        channel, date, campaign_id, campaign_name, ...metrics,
      });
    } else {
      const win = normalizePaidAdsWindow(obj.window_days) ?? topLevelWindow;
      if (win && win !== 1) {
        const list = snapshotCampaigns.get(win) ?? [];
        list.push({ campaign_id, campaign_name, ...metrics });
        snapshotCampaigns.set(win, list);
      } else {
        campaigns.push({
          channel, date: asOf, campaign_id, campaign_name, ...metrics,
        });
        undatedCampaigns.push({ campaign_id, campaign_name, ...metrics });
      }
    }
  }

  if (undatedCampaigns.length && topLevelWindow && topLevelWindow !== 1) {
    snapshotCampaigns.set(topLevelWindow, [
      ...(snapshotCampaigns.get(topLevelWindow) ?? []),
      ...undatedCampaigns,
    ]);
  }

  for (const [days, list] of snapshotCampaigns) {
    const existing = snapshots.find((s) => s.window_days === days && s.as_of === asOf);
    if (existing) {
      existing.metrics = { ...existing.metrics, campaigns: list };
    } else {
      const fromDaily = rollupDailyWindow([...dailyByDate.values()], asOf, days);
      snapshots.push({
        channel,
        as_of: asOf,
        window_days: days,
        currency,
        source,
        metrics: { campaigns: list },
        spend: fromDaily.spend,
        sales_or_conv_value: fromDaily.sales_or_conv_value,
        clicks: fromDaily.clicks,
        impressions: fromDaily.impressions,
        conversions: fromDaily.conversions,
        cpc: fromDaily.cpc,
        roas: fromDaily.roas,
      });
    }
  }

  if (account && !snapshots.some((s) => s.window_days === 1 && s.as_of === asOf)) {
    snapshots.push({
      channel,
      as_of: asOf,
      window_days: 1,
      currency,
      source,
      metrics: undatedCampaigns.length ? { campaigns: undatedCampaigns } : {},
      ...metricsFromUnknown(account),
    });
  }

  return {
    ok: true,
    data: {
      channel,
      as_of: asOf,
      currency,
      source,
      daily: [...dailyByDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
      campaigns,
      snapshots,
    },
  };
}

/** Rows ready for PostgREST upsert (no generated timestamps required). */
export function toUpsertRows(data: NormalizedPaidAdsPayload, ingestedAt: string) {
  return {
    daily: data.daily.map((row) => ({ ...row, ingested_at: ingestedAt })),
    campaigns: data.campaigns.map((row) => ({ ...row, ingested_at: ingestedAt })),
    snapshots: data.snapshots.map((row) => ({ ...row, ingested_at: ingestedAt })),
  };
}

export function emptyChannelBundle() {
  return {
    daily: [] as PaidAdsDailyRow[],
    campaigns: [] as PaidAdsCampaignDailyRow[],
    snapshots: [] as PaidAdsSnapshotRow[],
  };
}

/** Inclusive start of a paid-ads window (same math as Amazon PPC windows). */
export function paidAdsWindowStart(asOf: string, windowDays: PaidAdsWindowDays): string {
  return windowStart(asOf, windowDays);
}

export function paidAdsWindowEndExclusive(asOf: string): string {
  return shiftDays(asOf, 1);
}
