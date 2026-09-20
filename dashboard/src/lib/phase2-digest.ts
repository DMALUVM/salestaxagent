/**
 * Optional Phase 2 extras on the landed Iris conversion digest.
 *
 * Attached by GET /api/conversion-digest as `phase2`. Locked to the
 * same as_of day. Missing tables / no OAuth rows → null sections.
 * Never invents a session, leak, or SEO number. Never substitutes
 * an older day. Does not feed nexus or P&L.
 */
import { asInt } from "./shopify-funnel";

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
};

export type Phase2Digest = {
  landing_drops: LandingDrop[] | null;
  seo: SeoSection | null;
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
  limit = 10,
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

export function seoSection(
  queries: Array<Record<string, unknown>>,
  pages: Array<Record<string, unknown>>,
  date: string,
): SeoSection | null {
  const q = seoRows(queries, date, "query");
  const p = seoRows(pages, date, "page");
  if (!q.length && !p.length) return null;
  return { queries: q, pages: p };
}

export function phase2FromLockedDay(
  date: string,
  tables: {
    ga4?: Array<Record<string, unknown>>;
    gscQueries?: Array<Record<string, unknown>>;
    gscPages?: Array<Record<string, unknown>>;
    googleAds?: Array<Record<string, unknown>>;
    metaAds?: Array<Record<string, unknown>>;
  },
): Phase2Digest {
  const ga4 = tables.ga4 ?? [];
  const gscQueries = tables.gscQueries ?? [];
  const gscPages = tables.gscPages ?? [];
  const googleAds = tables.googleAds ?? [];
  const metaAds = tables.metaAds ?? [];
  return {
    landing_drops: topLandingDrops(ga4, date),
    seo: seoSection(gscQueries, gscPages, date),
    connectors: {
      ga4: hasDate(ga4, date),
      gsc: hasDate(gscQueries, date) || hasDate(gscPages, date),
      google_ads: hasDate(googleAds, date),
      meta_ads: hasDate(metaAds, date),
    },
  };
}
