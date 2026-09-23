/**
 * Optional Phase 2 extras on the landed Iris conversion digest.
 *
 * TODO(Nora): gsc_query_device_daily / gsc_page_device_daily are warehouse-
 * ready for a money-term mobile CTR card. Not wired here — keep query/page
 * totals as seo.queries / seo.pages SoT.
 *
 * Attached by GET /api/conversion-digest as `phase2`. Locked to the
 * same as_of day. Missing tables / no OAuth rows → null sections.
 * Never invents a session, leak, or SEO number. Never substitutes
 * an older day. Does not feed nexus or P&L.
 *
 * Iris Morning Brief prints `phase2.meta` for the prior day (as_of /
 * D-1 America/New_York). Never substitute an older Meta day.
 * ads_read warehouse only (`meta_ads_daily`). `phase2.ads` is Google-only
 * so Meta spend is not counted twice.
 */
import { asInt } from "./shopify-funnel";
import { metaDigestActions } from "./paid-intel/meta-call";

export type LandingDrop = {
  path: string;
  device: string;
  sessions: number;
  purchases: number;
  lost: number;
  rate: number | null;
};

export type SeoRow = {
  key: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
};

export type SeoSection = {
  queries: SeoRow[];
  pages: SeoRow[];
  /** Site-wide gsc_dim_daily. Empty until Mini writes the locked day. */
  devices?: SeoRow[];
  countries?: SeoRow[];
  appearances?: SeoRow[];
};

export type AdsCampaign = {
  campaign_id: string;
  campaign_name: string;
  spend: number | null;
  clicks: number | null;
  conversions: number | null;
};

/** Locked-day Meta pause lines. Null when that day has no meta_ads_daily rows. */
export type MetaDigestAction = {
  campaign_name: string;
  spend: number;
  conversions: number | null;
  say: string;
};

export type MetaCampaignFact = {
  campaign_id: string;
  campaign_name: string;
  spend: number | null;
  clicks: number | null;
  conversions: number | null;
  conversion_value: number | null;
  /** conversion_value / spend when spend > 0 and value is known. Else null. */
  roas: number | null;
};

export type MetaDigestTotals = {
  spend: number | null;
  clicks: number | null;
  /** Null when no locked-day row returned impressions. */
  impressions: number | null;
  conversions: number | null;
  conversion_value: number | null;
  /**
   * totals.conversion_value / totals.spend when spend > 0 and every
   * positive-spend row stored a conversion_value. Else null.
   */
  roas: number | null;
};

/** Locked-day Meta facts. Null when that day has zero meta_ads_daily rows. */
export type MetaDigestSection = {
  totals: MetaDigestTotals;
  campaigns: MetaCampaignFact[];
  /** Pause lines only (spend ≥ $5, conversions known and < 0.5). Locked day. */
  actions: MetaDigestAction[];
};

export type Phase2Digest = {
  landing_drops: LandingDrop[] | null;
  seo: SeoSection | null;
  /** Google Ads campaigns for the locked day. Meta is `meta`, not this list. */
  ads: AdsCampaign[] | null;
  /**
   * Prior-day Meta from meta_ads_daily. Iris Morning Brief prints this.
   * Null when the locked day has zero rows — never an older substitute.
   */
  meta: MetaDigestSection | null;
  /** Same pause lines as `meta.actions`. Null when `meta` is null. */
  meta_actions: MetaDigestAction[] | null;
  connectors: {
    ga4: boolean;
    gsc: boolean;
    google_ads: boolean;
    meta_ads: boolean;
  };
};

export function emptyPhase2(): Phase2Digest {
  return {
    landing_drops: null,
    seo: null,
    ads: null,
    meta: null,
    meta_actions: null,
    connectors: { ga4: false, gsc: false, google_ads: false, meta_ads: false },
  };
}

function hasDate(
  rows: Array<{ metric_date?: unknown }> | undefined,
  date: string,
): boolean {
  return Boolean(rows?.some((r) => String(r.metric_date ?? "") === date));
}

export function topLandingDrops(
  rows: Array<Record<string, unknown>>,
  date: string,
  limit = 8,
): LandingDrop[] | null {
  const day = rows.filter((r) => String(r.metric_date ?? "") === date);
  if (!day.length) return null;
  const out: LandingDrop[] = [];
  for (const r of day) {
    const sessions = asInt(r.sessions);
    const purchases = asInt(r.purchase ?? r.purchases);
    if (sessions === null || purchases === null || sessions <= 0) continue;
    if (purchases > sessions) continue;
    const lost = sessions - purchases;
    out.push({
      path: String(r.landing_page ?? r.path ?? ""),
      device: String(r.device ?? ""),
      sessions,
      purchases,
      lost,
      rate: sessions ? Math.round((lost / sessions) * 10000) / 10000 : null,
    });
  }
  return out
    .sort((a, b) => b.lost - a.lost || b.sessions - a.sessions || a.path.localeCompare(b.path))
    .slice(0, limit);
}

function seoRows(
  rows: Array<Record<string, unknown>>,
  date: string,
  keyField: "query" | "page",
  limit = 40,
): SeoRow[] {
  return rows
    .filter((r) => String(r.metric_date ?? "") === date)
    .map((r) => ({
      key: String(r[keyField] ?? ""),
      clicks: asInt(r.clicks),
      impressions: asInt(r.impressions),
      ctr: r.ctr == null || r.ctr === "" ? null : Number(r.ctr),
      position: r.position == null || r.position === "" ? null : Number(r.position),
    }))
    .filter((r) => r.key)
    .sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1) || (b.impressions ?? 0) - (a.impressions ?? 0))
    .slice(0, limit);
}

function dimRows(
  rows: Array<Record<string, unknown>>,
  date: string,
  kind: string,
  limit = 40,
): SeoRow[] {
  return rows
    .filter((r) => String(r.metric_date ?? "") === date && String(r.dim_kind ?? "") === kind)
    .map((r) => ({
      key: String(r.dim_value ?? ""),
      clicks: asInt(r.clicks),
      impressions: asInt(r.impressions),
      ctr: r.ctr == null || r.ctr === "" ? null : Number(r.ctr),
      position: r.position == null || r.position === "" ? null : Number(r.position),
    }))
    .filter((r) => r.key)
    .sort((a, b) => (b.clicks ?? -1) - (a.clicks ?? -1) || (b.impressions ?? 0) - (a.impressions ?? 0))
    .slice(0, limit);
}

export function seoSection(
  queries: Array<Record<string, unknown>>,
  pages: Array<Record<string, unknown>>,
  date: string,
  dims: Array<Record<string, unknown>> = [],
): SeoSection | null {
  const q = seoRows(queries, date, "query");
  const p = seoRows(pages, date, "page");
  const devices = dimRows(dims, date, "device");
  const countries = dimRows(dims, date, "country");
  const appearances = dimRows(dims, date, "search_appearance");
  if (!q.length && !p.length && !devices.length && !countries.length && !appearances.length) {
    return null;
  }
  return { queries: q, pages: p, devices, countries, appearances };
}

function asMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function asQty(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function metricDay(v: unknown): string {
  return String(v ?? "").slice(0, 10);
}

function sumKnown(values: Array<number | null>, digits: number): number | null {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    total += v;
    any = true;
  }
  if (!any) return null;
  const factor = 10 ** digits;
  return Math.round(total * factor) / factor;
}

/** Value / spend when spend > 0 and value is known. Never invent a ratio. */
function roasOf(spend: number | null, value: number | null): number | null {
  if (spend == null || !(spend > 0) || value == null) return null;
  return Math.round((value / spend) * 10000) / 10000;
}

const META_CAMPAIGN_CAP = 10;

/**
 * Locked-day Meta block for Iris. Null when that day has zero rows.
 * Totals sum every row (warehouse SUM). Campaigns are the top spend slice.
 * Actions are the existing pause lines — no weekly cut/scale.
 */
export function metaSection(
  rows: Array<Record<string, unknown>>,
  date: string,
  limit = META_CAMPAIGN_CAP,
): MetaDigestSection | null {
  const day = rows.filter((r) => metricDay(r.metric_date) === date);
  if (!day.length) return null;

  const campaigns: MetaCampaignFact[] = [];
  for (const r of day) {
    const campaign_id = String(r.campaign_id ?? "").trim();
    const campaign_name = String(r.campaign_name ?? "").trim();
    if (!campaign_id && !campaign_name) continue;
    const spend = asMoney(r.spend);
    const conversion_value = asMoney(r.conversion_value);
    campaigns.push({
      campaign_id,
      campaign_name,
      spend,
      clicks: asInt(r.clicks),
      conversions: asQty(r.conversions),
      conversion_value,
      roas: roasOf(spend, conversion_value),
    });
  }
  campaigns.sort((a, b) =>
    (b.spend ?? -1) - (a.spend ?? -1)
    || a.campaign_name.localeCompare(b.campaign_name)
    || a.campaign_id.localeCompare(b.campaign_id));

  const spend = sumKnown(day.map((r) => asMoney(r.spend)), 2);
  const conversion_value = sumKnown(day.map((r) => asMoney(r.conversion_value)), 2);
  // A positive-spend row with no stored value would make value/spend
  // treat that spend as $0 returned. Leave ROAS null instead.
  const valueIncomplete = day.some((r) => {
    const rowSpend = asMoney(r.spend);
    return rowSpend != null && rowSpend > 0 && asMoney(r.conversion_value) == null;
  });
  return {
    totals: {
      spend,
      clicks: sumKnown(day.map((r) => asInt(r.clicks)), 0),
      impressions: sumKnown(day.map((r) => asInt(r.impressions)), 0),
      conversions: sumKnown(day.map((r) => asQty(r.conversions)), 4),
      conversion_value,
      roas: valueIncomplete ? null : roasOf(spend, conversion_value),
    },
    campaigns: campaigns.slice(0, limit),
    actions: metaDigestActions(day, date),
  };
}

/** Locked-day Google Ads campaign facts. Null when that day has no rows. */
export function adsCampaigns(
  rows: Array<Record<string, unknown>>,
  date: string,
  limit = 10,
): AdsCampaign[] | null {
  const day = rows.filter((r) => String(r.metric_date ?? "") === date);
  if (!day.length) return null;
  const out: AdsCampaign[] = [];
  for (const r of day) {
    const campaign_id = String(r.campaign_id ?? "").trim();
    const campaign_name = String(r.campaign_name ?? "").trim();
    if (!campaign_id && !campaign_name) continue;
    out.push({
      campaign_id,
      campaign_name,
      spend: asMoney(r.spend),
      clicks: asInt(r.clicks),
      conversions: asQty(r.conversions),
    });
  }
  if (!out.length) return null;
  return out
    .sort((a, b) =>
      (b.spend ?? -1) - (a.spend ?? -1)
      || a.campaign_name.localeCompare(b.campaign_name)
      || a.campaign_id.localeCompare(b.campaign_id))
    .slice(0, limit);
}

/** High-impression, weak-CTR/position queries on the locked day. */
export function gscOpportunities(queries: SeoRow[] | null | undefined, limit = 3): SeoRow[] {
  if (!queries?.length) return [];
  return queries
    .filter((q) => {
      if (!q.key) return false;
      if (q.impressions == null || q.impressions < 50) return false;
      if (q.clicks === 0) return true;
      if (q.clicks == null) return false;
      if (q.ctr != null && Number.isFinite(q.ctr) && q.ctr < 0.02 && q.impressions >= 100) {
        return true;
      }
      if (q.position != null && Number.isFinite(q.position)
        && q.position >= 15 && q.clicks <= 1) {
        return true;
      }
      return false;
    })
    .sort((a, b) =>
      (b.impressions ?? 0) - (a.impressions ?? 0)
      || (a.clicks ?? 0) - (b.clicks ?? 0)
      || a.key.localeCompare(b.key))
    .slice(0, limit);
}

/** Spend with ~0 conversions. Null conversions are skipped — never invented. */
export function adsWaste(campaigns: AdsCampaign[] | null | undefined, limit = 3): AdsCampaign[] {
  if (!campaigns?.length) return [];
  return campaigns
    .filter((c) => {
      if (!c.campaign_name && !c.campaign_id) return false;
      if (c.spend == null || c.spend < 5) return false;
      if (c.conversions == null) return false;
      return c.conversions < 0.5;
    })
    .sort((a, b) =>
      (b.spend ?? 0) - (a.spend ?? 0)
      || (a.campaign_name || a.campaign_id).localeCompare(b.campaign_name || b.campaign_id))
    .slice(0, limit);
}

export function phase2FromLockedDay(
  date: string,
  tables: {
    ga4?: Array<Record<string, unknown>>;
    gscQueries?: Array<Record<string, unknown>>;
    gscPages?: Array<Record<string, unknown>>;
    gscDims?: Array<Record<string, unknown>>;
    googleAds?: Array<Record<string, unknown>>;
    metaAds?: Array<Record<string, unknown>>;
  },
): Phase2Digest {
  const ga4 = tables.ga4 ?? [];
  const gscQueries = tables.gscQueries ?? [];
  const gscPages = tables.gscPages ?? [];
  const gscDims = tables.gscDims ?? [];
  const googleAds = tables.googleAds ?? [];
  const metaAds = tables.metaAds ?? [];
  const meta = metaSection(metaAds, date);
  return {
    landing_drops: topLandingDrops(ga4, date),
    seo: seoSection(gscQueries, gscPages, date, gscDims),
    ads: adsCampaigns(googleAds, date),
    meta,
    meta_actions: meta ? meta.actions : null,
    connectors: {
      ga4: hasDate(ga4, date),
      gsc: hasDate(gscQueries, date) || hasDate(gscPages, date) || hasDate(gscDims, date),
      google_ads: hasDate(googleAds, date),
      meta_ads: meta != null,
    },
  };
}
