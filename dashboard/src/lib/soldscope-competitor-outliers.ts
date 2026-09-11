/**
 * Competitor reverse-ASIN KR outliers — recommend-only checklist for Blake.
 *
 * Observe / recommend only. Candidates come from stored
 * soldscope_competitor_kr rows (weekly reuse of saved searchType0).
 * already_bidding is Exact-only (keyword_targets +
 * has_enabled_exact_elsewhere). Suggested lever never writes Amazon Ads.
 * Empty sources → empty list. Our 1oz balm B0CLF5B27Y is never a competitor.
 */
import bundled from "../../config/soldscope_competitors.json";
import { familyHeroAsin, lookupOrganicRank, type OrganicRankJoin } from "@/lib/organic-rank-progress";
import { normalizeKeyword } from "@/lib/soldscope-status";

function isEnabledExactState(status: string | null | undefined): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  return !s || s === "enabled" || s === "enable";
}

/** Same `| EX | keyword` parse as GNO watch — kept local to avoid a cycle. */
export function extractExactKeyword(campaignName: string): string | null {
  const m = String(campaignName ?? "").match(/\|\s*EX\s*\|\s*([^|]+?)(?:\s*\||\s*$)/i);
  return m ? normalizeKeyword(m[1]) : null;
}

export const COMPETITOR_OUTLIER_EMPTY_COPY =
  "No competitor reverse-ASIN keywords yet. Waiting for a weekly SoldScope reuse of saved searchType0 KR on the 30 competitor ASINs. First fill is `soldscope-competitor-kr --create-missing` (cap 5/run). This desk does not create Rank Tracker groups or Product Research. Em dash means empty, not zero.";

export const COMPETITOR_OUTLIER_CAP = 30;
export const COMPETITOR_OPPORTUNITY_FLOOR = 100;
export const EXCLUDED_OURS = "B0CLF5B27Y";
export const COMPETITOR_FAMILIES = ["lip", "balm", "deo"] as const;
export type CompetitorFamily = (typeof COMPETITOR_FAMILIES)[number];
export type SuggestedLever = "harvest_exact" | "watch" | "skip";

export const COMPETITOR_KR_CSV_HEADERS = [
  "keyword",
  "competitor_asin",
  "our_hero_family",
  "volume",
  "sfr",
  "opportunity",
  "competitor_organic_rank",
  "competitor_sponsored_rank",
  "our_organic_rank",
  "already_bidding",
  "suggested_lever",
] as const;

type CompetitorCfg = {
  opportunity_floor?: number;
  excluded_asins?: string[];
  competitors?: Array<{ asin?: string; family?: string }>;
};

const cfg = bundled as CompetitorCfg;

export const COMPETITOR_ASINS: readonly string[] = (cfg.competitors ?? [])
  .map((c) => String(c.asin ?? "").trim().toUpperCase())
  .filter((a) => a && a !== EXCLUDED_OURS);

export type CompetitorKrRow = {
  competitor_asin?: string | null;
  family?: string | null;
  keyword?: string | null;
  keyword_normalized?: string | null;
  search_volume?: number | null;
  aba_search_frequency_rank?: number | null;
  organic_asin?: string | null;
  organic_rank?: number | null;
  sponsored_asin?: string | null;
  sponsored_rank?: number | null;
  opportunity_score?: number | null;
  as_of?: string | null;
};

export type CompetitorTarget = {
  keyword_text?: string | null;
  match_type?: string | null;
  state?: string | null;
};

export type CompetitorOutlierRow = {
  keyword: string;
  keyword_normalized: string;
  competitor_asin: string;
  our_hero_family: CompetitorFamily;
  volume: number | null;
  sfr: number | null;
  opportunity: number | null;
  competitor_organic_rank: number | null;
  competitor_sponsored_rank: number | null;
  our_organic_rank: number | null;
  already_bidding: "Y" | "N";
  suggested_lever: SuggestedLever;
  as_of: string | null;
};

function asFamily(value: string | null | undefined): CompetitorFamily | null {
  const f = String(value ?? "").trim().toLowerCase();
  return f === "lip" || f === "balm" || f === "deo" ? f : null;
}

function asInt(value: number | null | undefined): number | null {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Number(value);
}

export function competitorPresent(
  row: CompetitorKrRow,
  competitorAsin: string,
): boolean {
  const want = String(competitorAsin ?? "").trim().toUpperCase();
  const orgAsin = String(row.organic_asin ?? "").trim().toUpperCase();
  const spAsin = String(row.sponsored_asin ?? "").trim().toUpperCase();
  const orgRank = asInt(row.organic_rank);
  const spRank = asInt(row.sponsored_rank);
  if (want && orgAsin === want) return true;
  if (want && spAsin === want) return true;
  if (orgRank != null && orgRank > 0) return true;
  if (spRank != null && spRank > 0) return true;
  return false;
}

export function exactKeywordsFromTargets(
  targets: CompetitorTarget[],
  extraExact: Iterable<string> = [],
): Set<string> {
  const out = new Set<string>();
  for (const t of targets) {
    const mt = String(t.match_type ?? "").trim().toLowerCase();
    if (mt && mt !== "exact") continue;
    if (t.state && !isEnabledExactState(t.state)) continue;
    const key = normalizeKeyword(t.keyword_text);
    if (key) out.add(key);
  }
  for (const raw of extraExact) {
    const key = normalizeKeyword(raw);
    if (key) out.add(key);
  }
  return out;
}

export function extraExactFromWatch(watchExact: Iterable<string> = []): string[] {
  const out: string[] = [];
  for (const name of watchExact) {
    const extracted = extractExactKeyword(name);
    if (extracted) out.push(extracted);
  }
  return out;
}

export function classifyExactBidding(
  keyword: string,
  targets: CompetitorTarget[],
  extraExact: Iterable<string> = [],
): { already: boolean; already_bidding: "Y" | "N"; note: string } {
  const key = normalizeKeyword(keyword);
  if (!key) return { already: false, already_bidding: "N", note: "—" };
  const enabled = exactKeywordsFromTargets(targets, extraExact);
  if (enabled.has(key)) {
    return { already: true, already_bidding: "Y", note: "Exact" };
  }
  return { already: false, already_bidding: "N", note: "—" };
}

export function suggestLever(args: {
  alreadyExact: boolean;
  present: boolean;
  familyFit: boolean;
  opportunity: number | null;
  opportunityFloor?: number;
}): SuggestedLever {
  if (args.alreadyExact || !args.present || !args.familyFit) return "skip";
  const floor = args.opportunityFloor ?? COMPETITOR_OPPORTUNITY_FLOOR;
  if (args.opportunity != null && args.opportunity >= floor) return "harvest_exact";
  return "watch";
}

export function buildCompetitorOutliers(args: {
  krRows?: CompetitorKrRow[];
  targets?: CompetitorTarget[];
  extraExact?: Iterable<string>;
  organicIndex?: Map<string, OrganicRankJoin[]>;
  opportunityFloor?: number;
  cap?: number;
}): CompetitorOutlierRow[] {
  const floor = args.opportunityFloor
    ?? Number(cfg.opportunity_floor)
    ?? COMPETITOR_OPPORTUNITY_FLOOR;
  const extra = args.extraExact ?? extraExactFromWatch();
  const latest = new Map<string, CompetitorKrRow>();
  for (const row of args.krRows ?? []) {
    const asin = String(row.competitor_asin ?? "").trim().toUpperCase();
    const family = asFamily(row.family);
    const keyword = String(row.keyword ?? "").trim();
    const key = `${asin}|${normalizeKeyword(keyword || row.keyword_normalized)}`;
    if (!asin || !family || !keyword || asin === EXCLUDED_OURS) continue;
    const cur = latest.get(key);
    if (!cur || String(row.as_of ?? "") >= String(cur.as_of ?? "")) {
      latest.set(key, row);
    }
  }

  const rows: CompetitorOutlierRow[] = [];
  for (const row of latest.values()) {
    const asin = String(row.competitor_asin ?? "").trim().toUpperCase();
    const family = asFamily(row.family);
    const keyword = String(row.keyword ?? "").trim();
    if (!family || !keyword) continue;
    const present = competitorPresent(row, asin);
    if (!present) continue;
    const bid = classifyExactBidding(keyword, args.targets ?? [], extra);
    const opp = asInt(row.opportunity_score);
    const hero = familyHeroAsin(family);
    const ours = args.organicIndex
      ? lookupOrganicRank(args.organicIndex, keyword, hero)
      : null;
    rows.push({
      keyword,
      keyword_normalized: normalizeKeyword(keyword),
      competitor_asin: asin,
      our_hero_family: family,
      volume: asInt(row.search_volume),
      sfr: asInt(row.aba_search_frequency_rank),
      opportunity: opp,
      competitor_organic_rank: asInt(row.organic_rank),
      competitor_sponsored_rank: asInt(row.sponsored_rank),
      our_organic_rank: ours?.organic_rank ?? null,
      already_bidding: bid.already_bidding,
      suggested_lever: suggestLever({
        alreadyExact: bid.already,
        present,
        familyFit: true,
        opportunity: opp,
        opportunityFloor: floor,
      }),
      as_of: row.as_of ?? null,
    });
  }

  const leverRank: Record<SuggestedLever, number> = {
    harvest_exact: 0,
    watch: 1,
    skip: 2,
  };
  rows.sort((a, b) => {
    const lever = leverRank[a.suggested_lever] - leverRank[b.suggested_lever];
    if (lever !== 0) return lever;
    const opp = (b.opportunity ?? -1) - (a.opportunity ?? -1);
    if (opp !== 0) return opp;
    return (b.volume ?? -1) - (a.volume ?? -1);
  });
  return rows.slice(0, args.cap ?? COMPETITOR_OUTLIER_CAP);
}

export function competitorOutlierKey(row: {
  competitor_asin?: string | null;
  keyword?: string | null;
  keyword_normalized?: string | null;
}): string {
  return `${String(row.competitor_asin ?? "").trim().toUpperCase()}|${normalizeKeyword(row.keyword || row.keyword_normalized)}`;
}

export function netNewActionable(
  current: CompetitorOutlierRow[],
  previous: CompetitorOutlierRow[],
  levers: SuggestedLever[] = ["harvest_exact"],
): CompetitorOutlierRow[] {
  const wanted = new Set(levers);
  const prev = new Set(
    previous
      .filter((r) => wanted.has(r.suggested_lever))
      .map(competitorOutlierKey)
      .filter((k) => !k.startsWith("|") && !k.endsWith("|")),
  );
  const seen = new Set<string>();
  const out: CompetitorOutlierRow[] = [];
  for (const row of current) {
    if (!wanted.has(row.suggested_lever)) continue;
    const key = competitorOutlierKey(row);
    if (!key || key.startsWith("|") || key.endsWith("|") || seen.has(key) || prev.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function digestShouldPing(netNew: CompetitorOutlierRow[]): boolean {
  return netNew.some((r) => r.suggested_lever === "harvest_exact");
}

export function competitorKrOutliersCsv(rows: CompetitorOutlierRow[]): string {
  const lines = [COMPETITOR_KR_CSV_HEADERS.join(",")];
  for (const row of rows) {
    lines.push(COMPETITOR_KR_CSV_HEADERS.map((h) => {
      const v = row[h];
      if (v == null) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","));
  }
  return `${lines.join("\n")}\n`;
}
