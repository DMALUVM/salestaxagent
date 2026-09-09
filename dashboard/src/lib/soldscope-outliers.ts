/**
 * SoldScope keyword outliers — bid-base checklist for Blake.
 *
 * Candidates come only from stored Rank Tracker phrases and saved
 * Keyword Research reads. Nothing is invented. Empty sources → empty list.
 *
 * already_bidding is Y when an enabled Exact/Phrase/Broad target matches,
 * a GNO New Exact campaign encodes the keyword, or Auto Loose / Fat Parent
 * already has the term as a search term.
 */
import {
  AUTO_LOOSE_NAME,
  FAT_PARENT_NAME,
  NEW_EXACT,
  extractExactKeyword,
  isEnabledStatus,
  normalizeTerm,
} from "@/lib/gno-ppc-watch";
import { HERO_ASINS, normalizeKeyword } from "@/lib/soldscope-status";

export const OUTLIER_EMPTY_COPY =
  "No keyword outliers yet. Waiting for Rank Tracker phrases or a saved Keyword Research search on the three hero ASINs. This desk does not create Rank Tracker groups or Product Research searches. Em dash means empty, not zero.";

export const OUTLIER_CAP = 30;
export const OPPORTUNITY_FLOOR = 100;
export const OPPORTUNITY_WHALE = 500;

export type OutlierSource = "rank_tracker" | "keyword_research";

export type OutlierCandidate = {
  keyword: string;
  asin: string;
  search_volume: number | null;
  opportunity_score: number | null;
  organic_position: number | null;
  sponsored_position: number | null;
  source: OutlierSource;
};

export type OutlierTarget = {
  keyword_text?: string | null;
  match_type?: string | null;
  state?: string | null;
  campaign_name?: string | null;
};

export type OutlierSearchTerm = {
  search_term?: string | null;
  campaign_name?: string | null;
};

export type OutlierRow = {
  keyword: string;
  asin: string;
  volume: number | null;
  opportunity: number | null;
  already_bidding: "Y" | "N";
  bidding_note: string;
  note: string;
  source: OutlierSource;
};

const MATCH_TYPES = new Set(["exact", "phrase", "broad"]);

export function hasOpportunitySignal(
  volume: number | null | undefined,
  opportunity: number | null | undefined,
): boolean {
  if (opportunity != null && !Number.isNaN(Number(opportunity))) return true;
  if (volume == null || Number.isNaN(Number(volume))) return false;
  return Number(volume) > 0;
}

export function classifyBidding(
  keyword: string,
  targets: OutlierTarget[],
  searchTerms: OutlierSearchTerm[],
  watchExact: Iterable<string> = NEW_EXACT,
): { already: boolean; note: string } {
  const key = normalizeKeyword(keyword);
  if (!key) return { already: false, note: "—" };

  const matches: string[] = [];
  for (const t of targets) {
    if (normalizeKeyword(t.keyword_text) !== key) continue;
    const mt = String(t.match_type ?? "").trim().toLowerCase();
    if (mt && !MATCH_TYPES.has(mt)) continue;
    if (t.state && !isEnabledStatus(t.state)) continue;
    matches.push(mt ? mt[0].toUpperCase() + mt.slice(1) : "Target");
  }

  for (const name of watchExact) {
    const extracted = extractExactKeyword(name);
    if (extracted && extracted === key) matches.push("Exact (GNO New Exact)");
  }

  const auto: string[] = [];
  for (const row of searchTerms) {
    if (normalizeKeyword(row.search_term) !== key) continue;
    const camp = String(row.campaign_name ?? "");
    if (normalizeTerm(camp) === normalizeTerm(AUTO_LOOSE_NAME)) {
      auto.push("Auto ST (Auto Loose)");
    } else if (normalizeTerm(camp) === normalizeTerm(FAT_PARENT_NAME)) {
      auto.push("Auto ST (Fat parent)");
    }
  }

  const labels = [...new Set([...matches, ...auto])];
  if (!labels.length) return { already: false, note: "—" };
  return { already: true, note: labels.join(" · ") };
}

function median(values: number[]): number | null {
  const xs = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function candidatesFromRank(
  rows: Array<{
    phrase?: string | null;
    asin?: string | null;
    search_volume?: number | null;
    organic_position?: number | null;
    sponsored_position?: number | null;
  }>,
  heroes: readonly string[] = HERO_ASINS,
): OutlierCandidate[] {
  const locked = new Set(heroes.map((a) => a.toUpperCase()));
  const out: OutlierCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const keyword = String(row.phrase ?? "").trim();
    const asin = String(row.asin ?? "").trim().toUpperCase();
    const key = `${asin}|${normalizeKeyword(keyword)}`;
    if (!keyword || !locked.has(asin) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      keyword,
      asin,
      search_volume: row.search_volume ?? null,
      opportunity_score: null,
      organic_position: row.organic_position ?? null,
      sponsored_position: row.sponsored_position ?? null,
      source: "rank_tracker",
    });
  }
  return out;
}

export function candidatesFromResearch(
  rows: Array<{
    keyword?: string | null;
    asin?: string | null;
    search_volume?: number | null;
    opportunity_score?: number | null;
    organic_rank?: number | null;
    sponsored_rank?: number | null;
  }>,
  heroes: readonly string[] = HERO_ASINS,
): OutlierCandidate[] {
  const locked = new Set(heroes.map((a) => a.toUpperCase()));
  const out: OutlierCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const keyword = String(row.keyword ?? "").trim();
    const asin = String(row.asin ?? "").trim().toUpperCase();
    const key = `${asin}|${normalizeKeyword(keyword)}`;
    if (!keyword || !locked.has(asin) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      keyword,
      asin,
      search_volume: row.search_volume ?? null,
      opportunity_score: row.opportunity_score ?? null,
      organic_position: row.organic_rank ?? null,
      sponsored_position: row.sponsored_rank ?? null,
      source: "keyword_research",
    });
  }
  return out;
}

function mergeCandidates(parts: OutlierCandidate[][]): OutlierCandidate[] {
  const byKey = new Map<string, OutlierCandidate>();
  for (const list of parts) {
    for (const c of list) {
      const key = `${c.asin}|${normalizeKeyword(c.keyword)}`;
      const cur = byKey.get(key);
      if (!cur) {
        byKey.set(key, c);
        continue;
      }
      byKey.set(key, {
        ...cur,
        search_volume: cur.search_volume ?? c.search_volume,
        opportunity_score: cur.opportunity_score ?? c.opportunity_score,
        organic_position: cur.organic_position ?? c.organic_position,
        sponsored_position: cur.sponsored_position ?? c.sponsored_position,
        source: cur.source === "keyword_research" || c.source === "keyword_research"
          ? "keyword_research"
          : "rank_tracker",
      });
    }
  }
  return [...byKey.values()];
}

function sourceNote(c: OutlierCandidate): string {
  const bits: string[] = [];
  bits.push(c.source === "keyword_research" ? "KR saved search" : "RT phrase");
  if (c.organic_position != null) bits.push(`org ${c.organic_position}`);
  if (c.sponsored_position != null) bits.push(`sp ${c.sponsored_position}`);
  return bits.join(", ");
}

/**
 * High-opportunity keywords vs the current PPC book.
 *
 * Unused (N) rows need a real volume or opportunity score. When we already
 * bid on keywords that have volume, unused volume must meet that median —
 * otherwise any unused signal is listed (no fake baseline). Already-bidding
 * whales (opp ≥ 500 or volume ≥ 2× median) stay on the list with Y so Blake
 * can skip them.
 */
export function buildKeywordOutliers(args: {
  rankRows?: Parameters<typeof candidatesFromRank>[0];
  researchRows?: Parameters<typeof candidatesFromResearch>[0];
  targets?: OutlierTarget[];
  searchTerms?: OutlierSearchTerm[];
  heroes?: readonly string[];
  cap?: number;
}): OutlierRow[] {
  const heroes = args.heroes ?? HERO_ASINS;
  const candidates = mergeCandidates([
    candidatesFromRank(args.rankRows ?? [], heroes),
    candidatesFromResearch(args.researchRows ?? [], heroes),
  ]).filter((c) => hasOpportunitySignal(c.search_volume, c.opportunity_score));

  const classified = candidates.map((c) => {
    const bid = classifyBidding(c.keyword, args.targets ?? [], args.searchTerms ?? []);
    return { c, bid };
  });

  const bidVolumes = classified
    .filter((x) => x.bid.already && x.c.search_volume != null)
    .map((x) => Number(x.c.search_volume));
  const bar = median(bidVolumes);

  const rows: OutlierRow[] = [];
  for (const { c, bid } of classified) {
    const vol = c.search_volume;
    const opp = c.opportunity_score;
    const meetsOpp = opp != null && opp >= OPPORTUNITY_FLOOR;
    const meetsVol = vol != null && (bar == null || vol >= bar);
    const keepN = !bid.already && (meetsOpp || meetsVol || (bar == null && hasOpportunitySignal(vol, opp)));
    const keepY = bid.already && (
      (opp != null && opp >= OPPORTUNITY_WHALE)
      || (bar != null && vol != null && vol >= 2 * bar)
    );
    if (!keepN && !keepY) continue;
    rows.push({
      keyword: c.keyword,
      asin: c.asin,
      volume: vol,
      opportunity: opp,
      already_bidding: bid.already ? "Y" : "N",
      bidding_note: bid.note,
      note: sourceNote(c),
      source: c.source,
    });
  }

  rows.sort((a, b) => {
    if (a.already_bidding !== b.already_bidding) {
      return a.already_bidding === "N" ? -1 : 1;
    }
    const opp = (b.opportunity ?? -1) - (a.opportunity ?? -1);
    if (opp !== 0) return opp;
    return (b.volume ?? -1) - (a.volume ?? -1);
  });
  return rows.slice(0, args.cap ?? OUTLIER_CAP);
}
