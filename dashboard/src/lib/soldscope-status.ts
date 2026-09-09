/**
 * SoldScope enrichment helpers — join warehouse intel onto existing desks.
 *
 * Not a Pulse / Ads / sales_daily source. Never invent volume, ranks, or
 * stars. Empty is a real state (catalog still downloading, or no RT group).
 */
import bundled from "../../config/soldscope.json";
import bundledTitles from "../../config/asin_titles.json";

export const SOLDSCOPE_OBSERVE_ONLY = true;

export const HERO_ASINS = [
  "B0CLHTF8YN",
  "B0DQFKMJFY",
  "B0HBSZ71XQ",
] as const;

export const EMPTY_STATE_COPY =
  "No SoldScope history yet. The account may still be downloading Amazon data, or the Sunday weekly job has not run. This is not a sales or ads number.";

export const RT_EMPTY_COPY =
  "SoldScope Rank Tracker: 0 groups / 0 phrases — observe-only, nothing created.";

export type SoldScopeHero = { asin: string; title: string };

export type SoldScopeKeywordIntel = {
  keyword_normalized: string;
  search_volume: number | null;
  sv30: number | null;
  organic_position: number | null;
  sponsored_position: number | null;
  as_of: string | null;
};

export type SoldScopeAsinIntel = {
  asin: string;
  rating: number | null;
  ratings_count: number | null;
  rating_as_of: string | null;
  estimate_units: number | null;
  estimate_as_of: string | null;
};

export type SoldScopeVolumeRow = {
  keyword_normalized?: string | null;
  search_volume?: number | null;
  sv30?: number | null;
  as_of?: string | null;
};

export type SoldScopeRankRow = {
  phrase?: string | null;
  organic_position?: number | null;
  sponsored_position?: number | null;
  search_volume?: number | null;
  as_of?: string | null;
  group_id?: number | null;
};

export type SoldScopeRatingRow = {
  asin?: string | null;
  rating?: number | null;
  ratings_count?: number | null;
  date?: string | null;
};

export type SoldScopeSalesRow = {
  asin?: string | null;
  units?: number | null;
  date?: string | null;
};

/** Same join key as src.amazon_ads.organic_rank.normalize_keyword. */
export function normalizeKeyword(text: string | null | undefined): string {
  if (!text) return "";
  return String(text).trim().toLowerCase().replace(/\s+/g, " ");
}

export function heroList(
  rawAsins: unknown = (bundled as { asins?: string[] }).asins,
  titles: Record<string, unknown> = bundledTitles as Record<string, unknown>,
): SoldScopeHero[] {
  const locked = new Set<string>(HERO_ASINS);
  const requested = (Array.isArray(rawAsins) ? rawAsins : [])
    .map((a) => String(a).trim().toUpperCase())
    .filter((a) => locked.has(a));
  const asins = requested.length ? requested : [...HERO_ASINS];
  return asins.map((asin) => {
    const title = titles[asin];
    return {
      asin,
      title: typeof title === "string" && title.trim() ? title.trim() : asin,
    };
  });
}

export function summarizeFreshness(args: {
  salesRows: number;
  bsrRows: number;
  priceRows: number;
  rankRows: number;
  ratingsRows?: number;
  volumeRows?: number;
  newestDate: string | null;
}): { empty: boolean; newestDate: string | null; stored: boolean } {
  const stored =
    args.salesRows + args.bsrRows + args.priceRows + args.rankRows
    + (args.ratingsRows ?? 0) + (args.volumeRows ?? 0) > 0;
  return {
    empty: !stored,
    newestDate: args.newestDate,
    stored,
  };
}

export function rankTrackerCopy(groups: number, phrases: number): string {
  if (groups <= 0 || phrases <= 0) return RT_EMPTY_COPY;
  return `SoldScope Rank Tracker: ${groups} group${groups === 1 ? "" : "s"} / ${phrases} phrase${phrases === 1 ? "" : "s"} — observe-only.`;
}

export function formatSoldScopeVol(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString();
}

export function formatSoldScopeRank(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return String(n);
}

export function formatSoldScopeStars(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(1);
}

function newer(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!b) return false;
  if (!a) return true;
  return String(b) > String(a);
}

export function mergeKeywordIntel(
  volumeRows: SoldScopeVolumeRow[],
  rankRows: SoldScopeRankRow[],
): Map<string, SoldScopeKeywordIntel> {
  const out = new Map<string, SoldScopeKeywordIntel>();

  const ranked = [...rankRows].sort((a, b) =>
    String(b.as_of ?? "").localeCompare(String(a.as_of ?? "")),
  );
  for (const row of ranked) {
    const key = normalizeKeyword(row.phrase);
    if (!key) continue;
    const cur = out.get(key);
    if (cur && !newer(cur.as_of, row.as_of ?? null)) continue;
    out.set(key, {
      keyword_normalized: key,
      search_volume: row.search_volume ?? cur?.search_volume ?? null,
      sv30: cur?.sv30 ?? null,
      organic_position: row.organic_position ?? null,
      sponsored_position: row.sponsored_position ?? null,
      as_of: row.as_of ?? cur?.as_of ?? null,
    });
  }

  for (const row of volumeRows) {
    const key = normalizeKeyword(row.keyword_normalized);
    if (!key) continue;
    const cur = out.get(key) ?? {
      keyword_normalized: key,
      search_volume: null,
      sv30: null,
      organic_position: null,
      sponsored_position: null,
      as_of: null,
    };
    out.set(key, {
      ...cur,
      search_volume: row.search_volume ?? cur.search_volume,
      sv30: row.sv30 ?? cur.sv30,
      as_of: row.as_of ?? cur.as_of,
    });
  }
  return out;
}

export function lookupKeywordIntel(
  intel: Map<string, SoldScopeKeywordIntel>,
  term: string | null | undefined,
): SoldScopeKeywordIntel | null {
  const key = normalizeKeyword(term);
  if (!key) return null;
  return intel.get(key) ?? null;
}

export function attachKeywordIntel<T extends Record<string, unknown>>(
  rows: T[],
  termOf: (row: T) => string | null | undefined,
  intel: Map<string, SoldScopeKeywordIntel>,
): Array<T & {
  soldscope_sv: number | null;
  soldscope_sv30: number | null;
  soldscope_organic: number | null;
  soldscope_sponsored: number | null;
}> {
  return rows.map((row) => {
    const hit = lookupKeywordIntel(intel, termOf(row));
    return {
      ...row,
      soldscope_sv: hit?.search_volume ?? null,
      soldscope_sv30: hit?.sv30 ?? null,
      soldscope_organic: hit?.organic_position ?? null,
      soldscope_sponsored: hit?.sponsored_position ?? null,
    };
  });
}

export function mergeAsinIntel(
  ratingRows: SoldScopeRatingRow[],
  salesRows: SoldScopeSalesRow[],
  heroes: readonly string[] = HERO_ASINS,
): Map<string, SoldScopeAsinIntel> {
  const locked = new Set(heroes.map((a) => a.toUpperCase()));
  const out = new Map<string, SoldScopeAsinIntel>();
  const seed = (asin: string): SoldScopeAsinIntel => ({
    asin,
    rating: null,
    ratings_count: null,
    rating_as_of: null,
    estimate_units: null,
    estimate_as_of: null,
  });

  for (const row of ratingRows) {
    const asin = String(row.asin ?? "").trim().toUpperCase();
    if (!asin || !locked.has(asin)) continue;
    const cur = out.get(asin) ?? seed(asin);
    if (newer(cur.rating_as_of, row.date ?? null) || cur.rating_as_of == null) {
      out.set(asin, {
        ...cur,
        rating: row.rating ?? null,
        ratings_count: row.ratings_count ?? null,
        rating_as_of: row.date ?? null,
      });
    }
  }

  for (const row of salesRows) {
    const asin = String(row.asin ?? "").trim().toUpperCase();
    if (!asin || !locked.has(asin)) continue;
    const cur = out.get(asin) ?? seed(asin);
    if (newer(cur.estimate_as_of, row.date ?? null) || cur.estimate_as_of == null) {
      out.set(asin, {
        ...cur,
        estimate_units: row.units ?? null,
        estimate_as_of: row.date ?? null,
      });
    }
  }
  return out;
}

export function rankTrackerCounts(rankRows: SoldScopeRankRow[]): {
  groups: number;
  phrases: number;
} {
  const groups = new Set<number>();
  const phrases = new Set<string>();
  for (const row of rankRows) {
    if (row.group_id != null) groups.add(Number(row.group_id));
    const phrase = normalizeKeyword(row.phrase);
    if (phrase) phrases.add(phrase);
  }
  return { groups: groups.size, phrases: phrases.size };
}
