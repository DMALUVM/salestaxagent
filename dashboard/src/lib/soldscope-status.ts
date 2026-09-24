/**
 * SoldScope enrichment helpers — join warehouse intel onto existing desks.
 *
 * Not a Pulse / Ads / sales_daily source. Never invent volume, ranks, or
 * stars. Empty is a real state (catalog still downloading, or no RT group).
 */
import bundled from "../../config/soldscope.json";
import bundledTitles from "../../config/asin_titles.json";
import { queryNormalized } from "./query-normalized";

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
  asin?: string | null;
  organic_position?: number | null;
  organic_previous_position?: number | null;
  sponsored_position?: number | null;
  search_volume?: number | null;
  aba_search_frequency_rank?: number | null;
  aba_total_click_share?: number | null;
  aba_total_conv_share?: number | null;
  organic_page?: number | null;
  organic_asin?: string | null;
  amazon_choice?: boolean | null;
  as_of?: string | null;
  group_id?: number | null;
};

export type SoldScopeResearchRow = {
  keyword?: string | null;
  asin?: string | null;
  search_volume?: number | null;
  opportunity_score?: number | null;
  organic_rank?: number | null;
  sponsored_rank?: number | null;
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

/**
 * Same join key as query_normalized: lowercase, trim, collapse whitespace,
 * ASCII-fold, women→woman. man/men are not folded.
 */
export function normalizeKeyword(text: string | null | undefined): string {
  return queryNormalized(text);
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

export interface TrackerPhraseCensus {
  /** Distinct SoldScope group_id values. 0 when group_id is missing. */
  groups: number;
  /**
   * Distinct tracker phrases on the newest as_of of each group.
   * Null when the input has no phrase text. Never a raw row count.
   */
  tracker_phrases: number | null;
  /** Rows fed to the counter. Not a phrase count. */
  counted_rows: number;
  /** True when newest-day-per-group membership was available. */
  membership_known: boolean;
}

/**
 * Real SoldScope tracker phrase count.
 * Newest as_of per group_id, then distinct query_normalized.
 * Older days in the same group do not add phrases.
 * Without group_id + as_of, distinct phrases are still counted, but
 * membership_known stays false so callers must not label that number
 * as current group membership or as snapshot rows.
 */
export function countTrackerPhrases(rows: {
  phrase?: string | null;
  group_id?: number | null;
  as_of?: string | null;
}[]): TrackerPhraseCensus {
  const counted_rows = rows.length;
  const groupIds = new Set<string>();
  for (const row of rows) {
    if (row.group_id != null && Number.isFinite(Number(row.group_id))) {
      groupIds.add(String(Number(row.group_id)));
    }
  }
  const dated = rows.some((row) => /^\d{4}-\d{2}-\d{2}$/.test(String(row.as_of ?? "").slice(0, 10)));
  const latestByGroup = new Map<string, string>();
  if (dated && groupIds.size) {
    for (const row of rows) {
      if (row.group_id == null || !Number.isFinite(Number(row.group_id))) continue;
      const day = String(row.as_of ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const group = String(Number(row.group_id));
      const prev = latestByGroup.get(group);
      if (!prev || day > prev) latestByGroup.set(group, day);
    }
  }
  const phrases = new Set<string>();
  let sawPhrase = false;
  for (const row of rows) {
    const phrase = queryNormalized(row.phrase);
    if (!phrase) continue;
    sawPhrase = true;
    if (latestByGroup.size) {
      if (row.group_id == null || !Number.isFinite(Number(row.group_id))) continue;
      const day = String(row.as_of ?? "").slice(0, 10);
      if (latestByGroup.get(String(Number(row.group_id))) !== day) continue;
    }
    phrases.add(phrase);
  }
  return {
    groups: groupIds.size,
    tracker_phrases: sawPhrase ? phrases.size : null,
    counted_rows,
    membership_known: latestByGroup.size > 0,
  };
}

export function rankTrackerCopy(groups: number, phrases: number | null): string {
  if (groups <= 0 && (phrases == null || phrases <= 0)) return RT_EMPTY_COPY;
  if (phrases == null) {
    return `SoldScope Rank Tracker: ${groups} group${groups === 1 ? "" : "s"} / tracker phrases unknown (row count is not a phrase count) — observe-only.`;
  }
  const groupLabel = `${groups} group${groups === 1 ? "" : "s"}`;
  const phraseLabel = `${phrases} tracker phrase${phrases === 1 ? "" : "s"}`;
  return `SoldScope Rank Tracker: ${groupLabel} / ${phraseLabel} — distinct keywords on the newest day of each group, not snapshot rows. Observe-only.`;
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
  phrases: number | null;
  membership_known: boolean;
} {
  const census = countTrackerPhrases(rankRows);
  return {
    groups: census.groups,
    phrases: census.tracker_phrases,
    membership_known: census.membership_known,
  };
}
