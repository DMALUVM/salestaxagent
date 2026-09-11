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
  "No net-new unused Exact competitor keywords this week (cap 5/family, 15 total). Competitor-on-SERP only (organic_asin or sponsored_asin equals that row’s competitor_asin) plus family-fit — rank>0 alone is not presence. Real-traffic only — missing/zero search volume is dropped. Weekly job reads cached reverse-ASIN snapshots unless missing or stale. Reuse existing searchType0; do not POST more KR creates. This desk does not create Rank Tracker groups or Product Research. Em dash means empty, not zero.";

export const COMPETITOR_OUTLIER_CAP = 30;
export const COMPETITOR_OPPORTUNITY_FLOOR = 100;
export const SENTINEL_KEYWORD = "__kr_created__";
export const BLAKE_FAMILY_CAP = 5;
export const BLAKE_TOTAL_CAP = 15;
export const MIN_SEARCH_VOLUME = 1;
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

type AllowAllOfRule = { require?: string; also?: string[] };

type CompetitorCfg = {
  opportunity_floor?: number;
  blake_family_cap?: number;
  blake_total_cap?: number;
  stale_after_days?: number;
  min_search_volume?: number;
  max_aba_sfr?: number | null;
  blake_require_competitor_on_serp?: boolean;
  blake_keyword_denylist?: string[];
  blake_family_denylist?: Partial<Record<CompetitorFamily, string[]>>;
  blake_family_allow?: Partial<Record<CompetitorFamily, string[]>>;
  blake_family_allow_all_of?: Partial<Record<CompetitorFamily, AllowAllOfRule[]>>;
  blake_moisturizer_requires?: string[];
  blake_deo_hero_women_first?: boolean;
  blake_soft_watch?: Partial<Record<CompetitorFamily | "any_family", string[]>>;
  blake_soft_watch_brands?: string[];
  blake_harvest_brands?: string[];
  excluded_asins?: string[];
  competitors?: Array<{ asin?: string; family?: string }>;
};

export type BlakeFilters = {
  requireCompetitorOnSerp: boolean;
  denylist: string[];
  familyDenylist: Record<CompetitorFamily, string[]>;
  familyAllow: Record<CompetitorFamily, string[]>;
  familyAllowAllOf: Record<CompetitorFamily, AllowAllOfRule[]>;
  moisturizerRequires: string[];
  deoHeroWomenFirst: boolean;
  softWatch: Record<CompetitorFamily | "any_family", string[]>;
  softWatchBrands: string[];
  harvestBrands: string[];
};

export type FamilyFit = {
  fit: boolean;
  softWatch: boolean;
  harvestBias: boolean;
  reason: string;
};

const cfg = bundled as CompetitorCfg;

function asStrList(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value.map((x) => String(x ?? "").trim()).filter(Boolean);
}

export function blakeFiltersFromCfg(raw: CompetitorCfg = cfg): BlakeFilters {
  const denyFam = raw.blake_family_denylist ?? {};
  const allow = raw.blake_family_allow ?? {};
  const allowAll = raw.blake_family_allow_all_of ?? {};
  const soft = raw.blake_soft_watch ?? {};
  return {
    requireCompetitorOnSerp: raw.blake_require_competitor_on_serp !== false,
    denylist: asStrList(raw.blake_keyword_denylist),
    familyDenylist: {
      lip: asStrList(denyFam.lip),
      balm: asStrList(denyFam.balm),
      deo: asStrList(denyFam.deo),
    },
    familyAllow: {
      lip: asStrList(allow.lip),
      balm: asStrList(allow.balm),
      deo: asStrList(allow.deo),
    },
    familyAllowAllOf: {
      lip: Array.isArray(allowAll.lip) ? allowAll.lip : [],
      balm: Array.isArray(allowAll.balm) ? allowAll.balm : [],
      deo: Array.isArray(allowAll.deo) ? allowAll.deo : [],
    },
    moisturizerRequires: asStrList(raw.blake_moisturizer_requires, [
      "tallow", "balm", "butter", "skin for men",
    ]),
    deoHeroWomenFirst: raw.blake_deo_hero_women_first === true,
    softWatch: {
      any_family: asStrList(soft.any_family),
      lip: asStrList(soft.lip),
      balm: asStrList(soft.balm),
      deo: asStrList(soft.deo),
    },
    softWatchBrands: asStrList(raw.blake_soft_watch_brands),
    harvestBrands: asStrList(raw.blake_harvest_brands),
  };
}

export const BLAKE_FILTERS = blakeFiltersFromCfg();

export function keywordMatchesAny(
  keyword: string,
  patterns: Iterable<string> | null | undefined,
): boolean {
  const text = String(keyword ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!text) return false;
  for (const raw of patterns ?? []) {
    const pat = String(raw ?? "").trim();
    if (!pat) continue;
    try {
      if (new RegExp(pat, "i").test(text)) return true;
    } catch {
      if (text.includes(pat.toLowerCase())) return true;
    }
  }
  return false;
}

export function classifyFamilyFit(
  keyword: string,
  family: CompetitorFamily,
  filters: BlakeFilters = BLAKE_FILTERS,
): FamilyFit {
  if (keywordMatchesAny(keyword, filters.denylist)) {
    return { fit: false, softWatch: false, harvestBias: false, reason: "denylist" };
  }
  if (keywordMatchesAny(keyword, filters.familyDenylist[family] ?? [])) {
    return { fit: false, softWatch: false, harvestBias: false, reason: "family_denylist" };
  }
  if (family === "balm" && keywordMatchesAny(keyword, ["moisturizer"])) {
    if (!keywordMatchesAny(keyword, filters.moisturizerRequires)) {
      return { fit: false, softWatch: false, harvestBias: false, reason: "moisturizer_off_family" };
    }
  }
  let allowed = keywordMatchesAny(keyword, filters.familyAllow[family] ?? []);
  if (!allowed) {
    for (const rule of filters.familyAllowAllOf[family] ?? []) {
      if (
        keywordMatchesAny(keyword, [rule.require ?? ""])
        && keywordMatchesAny(keyword, rule.also ?? [])
      ) {
        allowed = true;
        break;
      }
    }
  }
  if (!allowed) {
    return { fit: false, softWatch: false, harvestBias: false, reason: "family_allow" };
  }
  let soft = keywordMatchesAny(keyword, filters.softWatch.any_family)
    || keywordMatchesAny(keyword, filters.softWatch[family] ?? [])
    || keywordMatchesAny(keyword, filters.softWatchBrands);
  if (family === "deo" && !filters.deoHeroWomenFirst && keywordMatchesAny(keyword, ["lume.*for women"])) {
    soft = true;
  }
  const harvestBias = keywordMatchesAny(keyword, filters.harvestBrands);
  return {
    fit: true,
    softWatch: soft,
    harvestBias,
    reason: soft ? "soft_watch" : harvestBias ? "harvest_brand" : "allow",
  };
}

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
  harvest_bias?: boolean;
  as_of: string | null;
};

function asFamily(value: string | null | undefined): CompetitorFamily | null {
  const f = String(value ?? "").trim().toLowerCase();
  return f === "lip" || f === "balm" || f === "deo" ? f : null;
}

export function isSentinelKrRow(row: {
  keyword?: string | null;
  keyword_normalized?: string | null;
}): boolean {
  const key = normalizeKeyword(row.keyword || row.keyword_normalized);
  return key === SENTINEL_KEYWORD;
}

function asInt(value: number | null | undefined): number | null {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Number(value);
}

export function competitorPresent(
  row: CompetitorKrRow,
  competitorAsin: string,
  requireSerp: boolean = BLAKE_FILTERS.requireCompetitorOnSerp,
): boolean {
  const want = String(competitorAsin ?? "").trim().toUpperCase();
  if (!want) return false;
  const orgAsin = String(row.organic_asin ?? "").trim().toUpperCase();
  const spAsin = String(row.sponsored_asin ?? "").trim().toUpperCase();
  if (orgAsin === want || spAsin === want) return true;
  if (requireSerp) return false;
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

export function hasRealTraffic(
  row: { search_volume?: number | null; aba_search_frequency_rank?: number | null },
  args?: { minSearchVolume?: number; maxAbaSfr?: number | null },
): boolean {
  const raw = args?.minSearchVolume ?? cfg.min_search_volume;
  const parsed = Number(raw);
  const minVol = Number.isFinite(parsed) && parsed >= 1 ? parsed : MIN_SEARCH_VOLUME;
  const vol = asInt(row.search_volume);
  if (vol == null || vol < minVol) return false;
  const maxSfr = args?.maxAbaSfr ?? cfg.max_aba_sfr ?? null;
  if (maxSfr != null) {
    const sfr = asInt(row.aba_search_frequency_rank);
    if (sfr != null && sfr > maxSfr) return false;
  }
  return true;
}

export function suggestLever(args: {
  alreadyExact: boolean;
  present: boolean;
  familyFit: boolean;
  opportunity: number | null;
  opportunityFloor?: number;
  softWatch?: boolean;
}): SuggestedLever {
  if (args.alreadyExact || !args.present || !args.familyFit) return "skip";
  if (args.softWatch) return "watch";
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
  const minVol = Number(cfg.min_search_volume) || MIN_SEARCH_VOLUME;
  const extra = args.extraExact ?? extraExactFromWatch();
  const latest = new Map<string, CompetitorKrRow>();
  for (const row of args.krRows ?? []) {
    const asin = String(row.competitor_asin ?? "").trim().toUpperCase();
    const family = asFamily(row.family);
    const keyword = String(row.keyword ?? "").trim();
    const key = `${asin}|${normalizeKeyword(keyword || row.keyword_normalized)}`;
    if (!asin || !family || !keyword || asin === EXCLUDED_OURS || isSentinelKrRow(row)) continue;
    if (!hasRealTraffic(row, { minSearchVolume: minVol, maxAbaSfr: cfg.max_aba_sfr })) continue;
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
    const present = competitorPresent(row, asin, BLAKE_FILTERS.requireCompetitorOnSerp);
    if (!present) continue;
    const fit = classifyFamilyFit(keyword, family, BLAKE_FILTERS);
    if (!fit.fit) continue;
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
        softWatch: fit.softWatch,
      }),
      harvest_bias: fit.harvestBias,
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
    const bias = Number(Boolean(b.harvest_bias)) - Number(Boolean(a.harvest_bias));
    if (bias !== 0) return bias;
    const opp = (b.opportunity ?? -1) - (a.opportunity ?? -1);
    if (opp !== 0) return opp;
    return (b.volume ?? -1) - (a.volume ?? -1);
  });
  return rows.slice(0, args.cap ?? COMPETITOR_OUTLIER_CAP);
}

export function splitCompetitorKrByAsOf(rows: CompetitorKrRow[]): {
  latest: CompetitorKrRow[];
  previous: CompetitorKrRow[];
} {
  const latestAsOf = new Map<string, string>();
  for (const row of rows) {
    if (isSentinelKrRow(row)) continue;
    const asin = String(row.competitor_asin ?? "").trim().toUpperCase();
    const asOf = String(row.as_of ?? "");
    if (!asin || !asOf) continue;
    const cur = latestAsOf.get(asin);
    if (!cur || asOf > cur) latestAsOf.set(asin, asOf);
  }
  const latest: CompetitorKrRow[] = [];
  const previous: CompetitorKrRow[] = [];
  for (const row of rows) {
    if (isSentinelKrRow(row)) continue;
    const asin = String(row.competitor_asin ?? "").trim().toUpperCase();
    const asOf = String(row.as_of ?? "");
    const max = latestAsOf.get(asin);
    if (max && asOf === max) latest.push(row);
    else if (max && asOf && asOf < max) previous.push(row);
  }
  return { latest, previous };
}

export function buildBlakeCompetitorSurface(args: {
  krRows?: CompetitorKrRow[];
  previousKrRows?: CompetitorKrRow[];
  targets?: CompetitorTarget[];
  extraExact?: Iterable<string>;
  organicIndex?: Map<string, OrganicRankJoin[]>;
  opportunityFloor?: number;
  familyCap?: number;
  totalCap?: number;
}): CompetitorOutlierRow[] {
  const familyCap = args.familyCap
    ?? Number(cfg.blake_family_cap)
    ?? BLAKE_FAMILY_CAP;
  const totalCap = args.totalCap
    ?? Number(cfg.blake_total_cap)
    ?? BLAKE_TOTAL_CAP;
  const krRows = (args.krRows ?? []).filter((r) => !isSentinelKrRow(r));
  const outliers = buildCompetitorOutliers({
    ...args,
    krRows,
    cap: 10_000,
  });
  let unused = outliers.filter(
    (r) => r.already_bidding === "N" && r.suggested_lever !== "skip",
  );
  const previous = (args.previousKrRows ?? []).filter((r) => !isSentinelKrRow(r));
  if (previous.length) {
    const prevKeys = new Set(previous.map(competitorOutlierKey));
    unused = unused.filter((r) => !prevKeys.has(competitorOutlierKey(r)));
  }
  const byFamily: Record<CompetitorFamily, number> = { lip: 0, balm: 0, deo: 0 };
  const out: CompetitorOutlierRow[] = [];
  for (const row of unused) {
    const fam = row.our_hero_family;
    if (byFamily[fam] >= familyCap) continue;
    byFamily[fam] += 1;
    out.push(row);
    if (out.length >= totalCap) break;
  }
  return out;
}

export function blakeSurfaceFromWarehouse(args: {
  krRows?: CompetitorKrRow[];
  targets?: CompetitorTarget[];
  extraExact?: Iterable<string>;
  organicIndex?: Map<string, OrganicRankJoin[]>;
  opportunityFloor?: number;
  familyCap?: number;
  totalCap?: number;
}): CompetitorOutlierRow[] {
  const { latest, previous } = splitCompetitorKrByAsOf(args.krRows ?? []);
  return buildBlakeCompetitorSurface({
    ...args,
    krRows: latest,
    previousKrRows: previous,
  });
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
