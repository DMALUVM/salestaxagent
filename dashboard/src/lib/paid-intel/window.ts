import { agentToday, shiftDays } from "../as-of";
import { productOfPath } from "./classify";
import { deriveCpc, deriveRoas, round2 } from "./csv";
import type {
  CampaignAgg, CampaignDaily, FreshnessSource, GaDaily, IntelFilter, IntelFreshness,
  IntelRangeDays, PlatformKpis, ProductAgg, ProductLine, ProductWeights,
  SearchQueryDaily, SourceFreshness,
} from "./types";

/** GA4 channel groups that represent paid traffic. Cross-network ≈ PMax. */
const PAID_CHANNELS = /^(paid search|paid social|cross-network|display|paid other|paid shopping)$/i;

/** Upload a fresh export once the newest paid row is this many days behind today. */
export const STALE_AFTER_DAYS = 7;

/** A window this thin is not worth trusting as a "30 day" read. */
const PARTIAL_BELOW = 0.8;

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Freshness is measured against the real calendar, not the file as-of.
 * `as_of` drives the range windows; this drives the "upload fresh data" nudge
 * and the per-source coverage of the selected window.
 */
/** True table-wide totals, so a windowed read still reports real history. */
export type SourceStats = Partial<Record<
  FreshnessSource,
  { rows: number; min_date: string | null; max_date: string | null }
>>;

export function buildFreshness(opts: {
  campaigns: Array<{ date: string; platform?: string }>;
  queries: Array<{ date: string; kind?: string }>;
  ga: Array<{ date: string }>;
  today?: string;
  asOf?: string | null;
  range?: IntelRangeDays;
  stats?: SourceStats;
}): IntelFreshness {
  const today = opts.today ?? agentToday();
  const range = opts.range ?? 7;
  const google = opts.campaigns.filter((r) => r.platform !== "meta");
  const meta = opts.campaigns.filter((r) => r.platform === "meta");
  const trend = opts.queries.filter((q) => q.kind === "chart" || (q.date && !q.kind));
  const snapshot = opts.queries.filter((q) => !q.date);

  const asOf = opts.asOf
    ?? maxPaidDate(opts.campaigns)
    ?? maxPaidDate(opts.ga)
    ?? maxPaidDate(trend);
  const windowStart = asOf && range ? rangeStart(asOf, range) : null;

  const dated = (
    key: FreshnessSource,
    label: string,
    file: string,
    rows: Array<{ date: string }>,
  ): SourceFreshness => {
    const days = new Set<string>();
    let min = "";
    let max = "";
    for (const r of rows) {
      if (!r.date) continue;
      days.add(r.date);
      if (!min || r.date < min) min = r.date;
      if (r.date > max) max = r.date;
    }
    const inWindow = windowStart && asOf
      ? [...days].filter((d) => d >= windowStart && d <= asOf).length
      : days.size;
    // Rows here may be a windowed read; the table-wide stats keep the history
    // span honest without loading every row on every request.
    const stat = opts.stats?.[key];
    if (stat) {
      if (stat.min_date && (!min || stat.min_date < min)) min = stat.min_date;
      if (stat.max_date && stat.max_date > max) max = stat.max_date;
    }
    const totalRows = stat ? stat.rows : rows.length;
    const behind = max ? daysBetween(max, today) : null;
    // A source that reports on a lag cannot fill the newest days of the window.
    // Judge it against what it could have, so GSC's 2-day trail is not a "gap".
    const lag = Math.max(0, Math.min(behind ?? 0, range ? range - 1 : 0));
    const expected = range ? Math.max(1, range - lag) : 0;
    return {
      source: key,
      label,
      file,
      rows: totalRows,
      min_date: min || null,
      max_date: max || null,
      days_behind: behind,
      stale: behind == null || behind >= STALE_AFTER_DAYS,
      dated: true,
      days_in_range: inWindow,
      range_days: range,
      expected_days: expected,
      coverage: range && totalRows ? Math.min(1, inWindow / expected) : null,
    };
  };

  const sources: SourceFreshness[] = [
    dated("google", "Google Ads", "Google Ads Daily (Campaign × Day)", google),
    dated("meta", "Meta Ads", "Ads Manager campaign export", meta),
    dated("ga4", "GA4 Explore", "GA4 Explore (Free form)", opts.ga),
    dated("gsc_trend", "Search Console trend", "Chart.csv", trend),
    {
      source: "gsc_snapshot",
      label: "Search Console snapshot",
      file: "Queries.csv + Pages.csv",
      rows: opts.stats?.gsc_snapshot?.rows ?? snapshot.length,
      min_date: null,
      max_date: null,
      days_behind: null,
      stale: false,
      dated: false,
      days_in_range: 0,
      range_days: range,
      expected_days: 0,
      coverage: null,
    },
  ];

  const paidMax = maxPaidDate(opts.campaigns);
  const paidBehind = paidMax ? daysBetween(paidMax, today) : null;
  return {
    today,
    days_behind: paidBehind,
    stale: paidBehind == null ? false : paidBehind >= STALE_AFTER_DAYS,
    stale_after_days: STALE_AFTER_DAYS,
    partial_sources: sources
      .filter((s) => s.dated && s.rows > 0 && s.coverage != null && s.coverage < PARTIAL_BELOW)
      .map((s) => s.source),
    sources,
  };
}

export function maxPaidDate(rows: Array<{ date: string }>): string | null {
  let max = "";
  for (const r of rows) {
    if (r.date && r.date > max) max = r.date;
  }
  return max || null;
}

/** Range is relative to max date IN THE FILES, not today. 0 = all. */
export function rangeStart(asOf: string, days: IntelRangeDays): string {
  if (!days) return "0001-01-01";
  return shiftDays(asOf, -(days - 1));
}

export function inRange(date: string, start: string, end: string): boolean {
  return !!date && date >= start && date <= end;
}

export function filterCampaigns(
  rows: CampaignDaily[],
  asOf: string,
  days: IntelRangeDays,
  filter: IntelFilter,
): CampaignDaily[] {
  const start = rangeStart(asOf, days);
  return rows.filter((r) => {
    if (!inRange(r.date, start, asOf)) return false;
    if (filter === "google") return r.platform === "google";
    if (filter === "meta") return r.platform === "meta";
    return true;
  });
}

export function priorWindow(
  rows: CampaignDaily[],
  asOf: string,
  days: IntelRangeDays,
  filter: IntelFilter,
): CampaignDaily[] {
  if (!days) return [];
  const end = shiftDays(asOf, -days);
  const start = rangeStart(end, days);
  return rows.filter((r) => {
    if (!inRange(r.date, start, end)) return false;
    if (filter === "google") return r.platform === "google";
    if (filter === "meta") return r.platform === "meta";
    return true;
  });
}

export function kpisOf(rows: CampaignDaily[], platform: PlatformKpis["platform"]): PlatformKpis {
  let spend = 0, conv = 0, clicks = 0, impressions = 0, conversions = 0;
  const days = new Set<string>();
  for (const r of rows) {
    if (platform !== "blended" && r.platform !== platform) continue;
    spend += r.spend;
    conv += r.conv_value;
    clicks += r.clicks;
    impressions += r.impressions;
    conversions += r.conversions;
    days.add(r.date);
  }
  return {
    platform,
    spend: round2(spend),
    conv_value: round2(conv),
    clicks,
    impressions,
    conversions: round2(conversions),
    roas: deriveRoas(spend, conv),
    cpc: deriveCpc(spend, clicks),
    days: days.size,
  };
}

export function aggregateCampaigns(rows: CampaignDaily[]): CampaignAgg[] {
  const map = new Map<string, CampaignDaily[]>();
  for (const r of rows) {
    const k = `${r.platform}|${r.campaign_name}`;
    const list = map.get(k) ?? [];
    list.push(r);
    map.set(k, list);
  }
  const out: CampaignAgg[] = [];
  for (const list of map.values()) {
    const first = list[0];
    let spend = 0, conv = 0, clicks = 0, impressions = 0, conversions = 0;
    let lostNum = 0, lostDen = 0, freqNum = 0, freqDen = 0, freqPeak: number | null = null;
    const dates = new Set<string>();
    let status: string | null = first.status;
    for (const r of list) {
      spend += r.spend;
      conv += r.conv_value;
      clicks += r.clicks;
      impressions += r.impressions;
      conversions += r.conversions;
      dates.add(r.date);
      if (r.lost_is_budget != null && r.impressions > 0) {
        lostNum += r.lost_is_budget * r.impressions;
        lostDen += r.impressions;
      }
      if (r.frequency != null && r.impressions > 0) {
        freqNum += r.frequency * r.impressions;
        freqDen += r.impressions;
      }
      if (r.frequency_peak != null) {
        freqPeak = Math.max(freqPeak ?? 0, r.frequency_peak);
      }
      if (r.status) status = r.status;
    }
    out.push({
      platform: first.platform,
      campaign_name: first.campaign_name,
      campaign_type: first.campaign_type,
      product: first.product,
      is_brand: first.is_brand,
      audience: first.audience,
      spend: round2(spend),
      conv_value: round2(conv),
      clicks,
      impressions,
      conversions: round2(conversions),
      roas: deriveRoas(spend, conv),
      cpc: deriveCpc(spend, clicks),
      lost_is_budget: lostDen ? lostNum / lostDen : null,
      frequency: freqDen ? freqNum / freqDen : null,
      frequency_peak: freqPeak,
      status,
      days_live: dates.size,
    });
  }
  return out.sort((a, b) => b.spend - a.spend || a.campaign_name.localeCompare(b.campaign_name));
}

/**
 * Which products paid traffic actually lands on, from GA4 product pages.
 * PMax and Brand Search campaign names carry no product, so without this the
 * product view only sees the Meta campaigns that happen to be named.
 */
export function productWeightsFromGa(ga: GaDaily[]): ProductWeights {
  const paid = ga.filter((r) => PAID_CHANNELS.test(r.channel_group));
  const pool = paid.length ? paid : ga;
  const ke = new Map<ProductLine, number>();
  const rev = new Map<ProductLine, number>();
  const sess = new Map<ProductLine, number>();
  for (const r of pool) {
    const product = productOfPath(r.landing_page);
    if (product === "other") continue;
    ke.set(product, (ke.get(product) ?? 0) + r.key_events);
    rev.set(product, (rev.get(product) ?? 0) + r.revenue);
    sess.set(product, (sess.get(product) ?? 0) + r.sessions);
  }
  const pick = (): { map: Map<ProductLine, number>; basis: ProductWeights["basis"] } => {
    const total = (m: Map<ProductLine, number>) => [...m.values()].reduce((s, v) => s + v, 0);
    if (total(ke) > 0) return { map: ke, basis: "key_events" };
    if (total(rev) > 0) return { map: rev, basis: "revenue" };
    if (total(sess) > 0) return { map: sess, basis: "sessions" };
    return { map: new Map(), basis: "none" };
  };
  const { map, basis } = pick();
  const total = [...map.values()].reduce((s, v) => s + v, 0);
  if (!total) return { weights: {}, basis: "none", sample: 0 };
  const weights: Partial<Record<ProductLine, number>> = {};
  for (const [product, v] of map) weights[product] = v / total;
  return { weights, basis, sample: total };
}

export function aggregateProducts(rows: CampaignDaily[], weights?: ProductWeights): ProductAgg[] {
  const map = new Map<ProductLine, { spend: number; conv: number; conversions: number; est: boolean }>();
  const add = (product: ProductLine, spend: number, conv: number, conversions: number, est: boolean) => {
    const cur = map.get(product) ?? { spend: 0, conv: 0, conversions: 0, est: false };
    cur.spend += spend;
    cur.conv += conv;
    cur.conversions += conversions;
    cur.est = cur.est || est;
    map.set(product, cur);
  };
  const w = weights?.weights ?? {};
  const entries = Object.entries(w) as Array<[ProductLine, number]>;
  const usable = entries.filter(([, share]) => share > 0);

  for (const r of rows) {
    // A campaign that names its product is attributed directly. One that does
    // not (PMax, Brand Search) is split by where paid traffic actually landed.
    if (r.product !== "other" || !usable.length) {
      add(r.product, r.spend, r.conv_value, r.conversions, false);
      continue;
    }
    for (const [product, share] of usable) {
      add(product, r.spend * share, r.conv_value * share, r.conversions * share, true);
    }
  }
  return [...map.entries()]
    .map(([product, v]) => ({
      product,
      spend: round2(v.spend),
      conv_value: round2(v.conv),
      roas: deriveRoas(v.spend, v.conv),
      conversions: round2(v.conversions),
      estimated: v.est,
    }))
    .sort((a, b) => b.spend - a.spend);
}

export function dailySeries(rows: CampaignDaily[], asOf: string, days: IntelRangeDays) {
  const start = rangeStart(asOf, days);
  const by = new Map<string, { google_spend: number; google_revenue: number; meta_spend: number; meta_revenue: number }>();
  for (const r of rows) {
    if (!inRange(r.date, start, asOf)) continue;
    const cur = by.get(r.date) ?? { google_spend: 0, google_revenue: 0, meta_spend: 0, meta_revenue: 0 };
    if (r.platform === "google") {
      cur.google_spend += r.spend;
      cur.google_revenue += r.conv_value;
    } else {
      cur.meta_spend += r.spend;
      cur.meta_revenue += r.conv_value;
    }
    by.set(r.date, cur);
  }
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({
      date,
      google_spend: round2(v.google_spend),
      google_revenue: round2(v.google_revenue),
      meta_spend: round2(v.meta_spend),
      meta_revenue: round2(v.meta_revenue),
    }));
}

export function snapshotQueries(rows: SearchQueryDaily[], kind: SearchQueryDaily["kind"]): SearchQueryDaily[] {
  return rows.filter((r) => r.kind === kind).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

export function gaInRange(rows: GaDaily[], asOf: string, days: IntelRangeDays): GaDaily[] {
  const start = rangeStart(asOf, days);
  return rows.filter((r) => inRange(r.date, start, asOf));
}
