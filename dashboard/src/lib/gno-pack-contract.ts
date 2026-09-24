/**
 * GNO export pack contract (Dave 2026-09-24). Observe only.
 * Never writes to Amazon, SoldScope, bids, budgets, or negatives.
 * Blank means missing. Do not invent ranks, shares, COGS, or SFR.
 */

import { createHash } from "node:crypto";
import { isBrandConquest, queryNormalized } from "./query-normalized";

export { isBrandConquest, isSoftBodyButter, queryNormalized } from "./query-normalized";

export const CONTRACT_PACK_DATE = "2026-09-24";
export const WINDOW_MISMATCH_RATIO = 0.25;
export const HARVEST_MIN_CLICKS = 5;
export const HARVEST_MIN_ORDERS = 2;
export const NEGATE_MIN_CLICKS = 8;
export const BLEEDERS10_MIN_CLICKS = 10;
export const BLEEDERS20_SP_PP = 20;
export const BLEEDERS20_SB_PP = 10;
export const MAX_NEW_STRUCTURES_PER_WEEK = 3;
export const ORGANIC_STALE_DAYS = 2;
export const ROW_COUNT_SHIFT_RATIO = 0.4;

export const RANKING_LIP_BALM_CAMPAIGN = "Unscented Lip Balm - SP - Lip Balm - KWs - Exact";
export const RANKING_LIP_BALM_QUERY = "lip balm";
export const RANKING_SUCCESS_METRIC = "organic_rank + sqp_impression_share + sqp_purchase_share";

export const CONTRACT_PROPOSED_TAGS = [
  "KEEP", "HARVEST_EXACT", "NEGATIVE_EXACT", "NEGATIVE_PHRASE", "WATCH", "JUNK", "SKIP",
] as const;
export type ContractProposedTag = (typeof CONTRACT_PROPOSED_TAGS)[number];

export type AdProduct = "SP" | "SB" | "SBV" | "SD";
export type CampaignPurpose =
  | "profit" | "ranking" | "discovery" | "defense" | "harvest_exact" | "shell" | "test";

export type QualityLevel = "PASS" | "FAIL" | "WARN";

export interface QualityReport {
  level: QualityLevel;
  fails: string[];
  warns: string[];
  notes: string;
}

export const FRESHNESS_LINES = [
  "pack_id:",
  "pack_timestamp:",
  "account_timezone:",
  "Today:",
  "L1:",
  "L2:",
  "L7:",
  "L30:",
  "L60:",
  "SQP current:",
  "SQP newest_stored_week_end:",
  "SQP source:",
  "SQP_LAG_DAYS:",
  "SQP comparison weeks attached:",
  "organic_as_of:",
  "organic_groups:",
  "placement_as_of:",
  "negatives_as_of:",
  "sku_costs_as_of:",
  "Bleeders 1.0 window (60d):",
  "Bleeders 2.0 window (30d):",
  "unexpected_empty_files:",
  "row_filters_applied:",
  "quality_gates:",
  "quality_gate_notes:",
] as const;

export const REQUIRED_PACK_FILES = [
  "README.txt",
  "pack_manifest.json",
  "watch_campaigns.csv",
  "watch_placements.csv",
  "keyword_targets.csv",
  "auto_loose_search_terms.csv",
  "fat_parent_search_terms.csv",
  "broad_m_search_terms.csv",
  "advertised_product_l7.csv",
  "sqp_weekly_slice.csv",
  "sqp_wow.csv",
  "organic_rank_snapshot.csv",
  "competitor_kr_outliers.csv",
  "negatives_snapshot.csv",
  "bleeders_10.csv",
  "bleeders_20.csv",
  "lifetime_zero.csv",
  "bid_review_candidates.csv",
  "harvest_queue.csv",
  "structure_audit.csv",
  "agreements.csv",
  "gno_decision_rules.txt",
  "gno_outcomes.csv",
] as const;

export const ST_REVIEW_FILES = [
  "auto_loose_search_terms.csv",
  "fat_parent_search_terms.csv",
  "broad_m_search_terms.csv",
] as const;

export const ROW_FILTERS_APPLIED =
  "SUMMARY stamps excluded from L2/L7 (not an ads window); review files are WINDOW_AGG one row per campaign_id+query_normalized+match_type+window_label; no min_clicks or min_spend row drop; ST $ is NOT_SOT";

const AMAZON_ID_HEADER =
  /(^|_)(campaign_id|ad_group_id|keyword_id|target_id|negative_id|portfolio_id)s?$|^entity_ids$/;

/**
 * A closed window is real only when loaded daily facts reach the window
 * start and the window end. A shorter store must not be labeled L60.
 */
export function seriesCoversWindow(
  dates: Iterable<string>,
  start: string,
  end: string,
): { covers: boolean; earliest: string | null; latest: string | null; daysInWindow: number } {
  let earliest: string | null = null;
  let latest: string | null = null;
  const inWindow = new Set<string>();
  for (const raw of dates) {
    const d = String(raw ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (!earliest || d < earliest) earliest = d;
    if (!latest || d > latest) latest = d;
    if (d >= start && d <= end) inWindow.add(d);
  }
  const covers = earliest != null && latest != null && earliest <= start && latest >= end;
  return { covers, earliest, latest, daysInWindow: inWindow.size };
}

/** Quote Amazon IDs so Excel/Sheets cannot rewrite them as scientific notation. */
export function csvEscapeField(
  value: string | number | boolean | null | undefined,
  header?: string,
): string {
  if (value === null || value === undefined) return "";
  const forceQuote = Boolean(header && AMAZON_ID_HEADER.test(header));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    const s = Number.isInteger(value) ? String(value) : value.toFixed(2);
    return forceQuote ? `"${s}"` : s;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  const s = String(value);
  if (!s) return "";
  if (forceQuote || /[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function organicTrackerCensus(
  snapshots: { phrase?: string | null; group_id?: number | null }[],
  rows: { keyword?: string | null; family?: string | null }[],
): { groups: number; phrases: number; snapshot_rows: number; note: string } {
  const groupIds = new Set<string>();
  const phrases = new Set<string>();
  for (const s of snapshots) {
    if (s.group_id != null && Number.isFinite(Number(s.group_id))) groupIds.add(String(s.group_id));
    const q = queryNormalized(s.phrase);
    if (q) phrases.add(q);
  }
  const families = new Set<string>();
  const rowPhrases = new Set<string>();
  for (const r of rows) {
    const q = queryNormalized(r.keyword);
    if (q) rowPhrases.add(q);
    if (r.family) families.add(String(r.family));
  }
  const phraseCount = snapshots.length ? phrases.size : rowPhrases.size;
  const groups = groupIds.size || families.size;
  const snapshot_rows = rows.length;
  let note: string;
  if (snapshot_rows > phraseCount) {
    note = `snapshot_rows ${snapshot_rows} > phrases ${phraseCount} because multi-ASIN expansion stores one query_normalized on more than one ASIN.`;
  } else if (phraseCount > snapshot_rows) {
    note = `tracker phrases ${phraseCount} exceed snapshot_rows ${snapshot_rows}; phrases are distinct query_normalized in the tracker groups.`;
  } else {
    note = `phrases ${phraseCount} equals snapshot_rows ${snapshot_rows}; each snapshot row is one distinct query_normalized.`;
  }
  return { groups, phrases: phraseCount, snapshot_rows, note };
}

export function namesKey(name: string | null | undefined): string {
  return String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function sha256Text(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export function csvDataRowCount(body: string): number {
  const lines = body.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  return Math.max(0, lines.length - 1);
}

export function adProductOf(campaignName: string | null | undefined): AdProduct {
  const n = namesKey(campaignName);
  if (/\bsbv\b|sponsored brands video|video/.test(n)) return "SBV";
  if (/\bsd\b|sponsored display/.test(n)) return "SD";
  if (/^sb\b|sponsored brand/.test(n)) return "SB";
  return "SP";
}

export function bleeder20Threshold(breakEven: number, adProduct: AdProduct): number {
  const pp = adProduct === "SP" ? BLEEDERS20_SP_PP : BLEEDERS20_SB_PP;
  return breakEven + pp;
}

export function childFlavorOf(campaignName: string | null | undefined): string {
  const n = namesKey(campaignName);
  if (/\borange\b/.test(n)) return "Orange";
  if (/\bassorted\b/.test(n)) return "Assorted";
  if (/\bpeppermint\b/.test(n)) return "Peppermint";
  if (/\bunscented\b/.test(n)) return "Unscented";
  if (/\blip\b|\bdeo\b|\bdeodorant\b|\bbalm\b/.test(n)) return "n/a";
  return "unknown";
}

export function campaignPurposeOf(
  campaignName: string,
  watchList: string,
): CampaignPurpose {
  if (namesKey(campaignName) === namesKey(RANKING_LIP_BALM_CAMPAIGN)) return "ranking";
  if (watchList === "NEW_EXACT") return "harvest_exact";
  if (watchList === "FLAVOR_SHELL") return "shell";
  if (watchList === "DAY5_PAUSE") return "discovery";
  if (watchList === "KEEPER") return "profit";
  return "profit";
}

export function isRankingCampaign(campaignName: string | null | undefined): boolean {
  return namesKey(campaignName) === namesKey(RANKING_LIP_BALM_CAMPAIGN);
}

export function isRankingQuery(term: string | null | undefined): boolean {
  return queryNormalized(term) === RANKING_LIP_BALM_QUERY;
}

export function windowLabelFromPack(label: string): string {
  if (label === "Today") return "Today";
  if (label === "Last1" || label === "L1") return "L1";
  if (label === "Last2" || label === "L2") return "L2";
  if (label === "Last7" || label === "L7") return "L7";
  if (label === "Last30" || label === "L30") return "L30";
  if (label === "Last60" || label === "L60") return "L60";
  return label;
}

export function spendsDisagree(left: number, right: number, ratio = WINDOW_MISMATCH_RATIO): boolean {
  const a = Number(left) || 0;
  const b = Number(right) || 0;
  if (a <= 0 && b <= 0) return false;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (lo <= 0) return hi > 0;
  return (hi - lo) / lo > ratio;
}

export interface DedupeWatchRow {
  campaign_id?: string | null;
  campaign_name: string;
  window_label?: string | null;
  date_start?: string;
  date_end?: string;
  duplicate_reason?: string | null;
}

export function watchDedupeKey(row: DedupeWatchRow): string {
  const window = row.window_label || `${row.date_start ?? ""}|${row.date_end ?? ""}`;
  const id = String(row.campaign_id ?? "").trim();
  if (id) return `id:${id}\t${window}`;
  return `name:${namesKey(row.campaign_name)}\t${window}`;
}

/**
 * Drop duplicate campaign_id + window_label rows.
 * Distinct IDs that share a name are kept and marked name_collision.
 */
export function dedupeWatchCampaignRows<T extends DedupeWatchRow>(rows: T[]): Array<T & { duplicate_reason?: string | null }> {
  const byId = new Map<string, T>();
  const order: string[] = [];
  for (const row of rows) {
    const key = watchDedupeKey(row);
    if (byId.has(key)) continue;
    byId.set(key, { ...row });
    order.push(key);
  }
  const nameWindows = new Map<string, string[]>();
  for (const key of order) {
    const row = byId.get(key)!;
    const window = row.window_label || `${row.date_start ?? ""}|${row.date_end ?? ""}`;
    const nk = `${namesKey(row.campaign_name)}\t${window}`;
    const list = nameWindows.get(nk) ?? [];
    list.push(key);
    nameWindows.set(nk, list);
  }
  for (const keys of nameWindows.values()) {
    if (keys.length < 2) continue;
    const ids = new Set(keys.map((k) => String(byId.get(k)?.campaign_id ?? "").trim()).filter(Boolean));
    if (ids.size < 2) continue;
    for (const key of keys) {
      const row = byId.get(key)!;
      row.duplicate_reason = row.duplicate_reason || "name_collision";
    }
  }
  return order.map((k) => byId.get(k)!);
}

export type TermRelevance =
  | "hero" | "family" | "adjacent" | "brand_conquest" | "junk" | "unknown";

const HERO_QUERIES = new Set([
  "lip balm", "chapstick", "tallow lip balm", "tallow balm",
  "beef tallow balm", "tallow deodorant", "tallow deodorant for men",
]);

export function termRelevance(term: string): TermRelevance {
  const q = queryNormalized(term);
  if (!q) return "unknown";
  if (isBrandConquest(q)) return "brand_conquest";
  if (HERO_QUERIES.has(q)) return "hero";
  if (/\b(tallow|chapstick|lip balm|deodorant)\b/.test(q)) return "family";
  if (/\b(free|cheap|diy|recipe|scam|wholesale)\b/.test(q)) return "junk";
  if (/\b(balm|butter|lotion|cream)\b/.test(q)) return "adjacent";
  return "unknown";
}

export function contractSearchTermTag(input: {
  clicks: number;
  orders: number;
  search_term: string;
  has_enabled_exact_elsewhere: boolean;
  already_negative?: boolean;
  destination_exists?: boolean;
  destination_has_impressions?: boolean;
}): { proposed_tag: ContractProposedTag; proposed_tag_reason: string; harvest_ready: boolean; relevance: TermRelevance } {
  const relevance = termRelevance(input.search_term);
  if (input.already_negative) {
    return { proposed_tag: "SKIP", proposed_tag_reason: "already negative", harvest_ready: false, relevance };
  }
  if (input.has_enabled_exact_elsewhere) {
    const tag: ContractProposedTag = input.orders > 0 ? "KEEP" : "SKIP";
    return { proposed_tag: tag, proposed_tag_reason: "exact exists", harvest_ready: false, relevance };
  }
  if (relevance === "brand_conquest") {
    return {
      proposed_tag: "WATCH",
      proposed_tag_reason: "brand conquest — never auto HARVEST_EXACT",
      harvest_ready: false,
      relevance,
    };
  }
  const harvestCandidate = input.clicks >= HARVEST_MIN_CLICKS && input.orders >= HARVEST_MIN_ORDERS;
  if (harvestCandidate) {
    const ready = input.destination_exists === true && input.destination_has_impressions === true;
    if (!ready) {
      return {
        proposed_tag: "WATCH",
        proposed_tag_reason: "harvest blocked: destination Exact missing or destination_exact_has_impressions=false",
        harvest_ready: false,
        relevance,
      };
    }
    return {
      proposed_tag: "HARVEST_EXACT",
      proposed_tag_reason: `clicks>=${HARVEST_MIN_CLICKS} and orders>=${HARVEST_MIN_ORDERS}; destination has impressions`,
      harvest_ready: true,
      relevance,
    };
  }
  const negateEvidence = input.clicks >= NEGATE_MIN_CLICKS
    && input.orders === 0
    && (relevance === "junk" || relevance === "adjacent");
  if (negateEvidence) {
    return {
      proposed_tag: "NEGATIVE_EXACT",
      proposed_tag_reason: `clicks>=${NEGATE_MIN_CLICKS}, orders=0, relevance=${relevance}; proposed only, never applied`,
      harvest_ready: false,
      relevance,
    };
  }
  if (relevance === "junk" && input.orders === 0 && input.clicks > 0) {
    return {
      proposed_tag: "JUNK",
      proposed_tag_reason: "junk relevance; below negate click floor",
      harvest_ready: false,
      relevance,
    };
  }
  if (input.clicks > 0 && input.clicks < HARVEST_MIN_CLICKS) {
    return {
      proposed_tag: "KEEP",
      proposed_tag_reason: "below harvest_min_clicks; do not HARVEST_EXACT on 1–2 clicks",
      harvest_ready: false,
      relevance,
    };
  }
  return { proposed_tag: "KEEP", proposed_tag_reason: "default KEEP", harvest_ready: false, relevance };
}

export interface Bleeders20Input {
  family: string;
  break_even_acos: number;
  ad_product: AdProduct;
  orders_30: number;
  spend_30: number;
  sales_30: number;
  campaign_purpose: CampaignPurpose;
  protected_recent_test?: boolean;
}

export function bleeders20Decision(row: Bleeders20Input): {
  include: boolean;
  threshold_acos: number;
  acos_30: number | null;
  over_by_pp: number | null;
  cut_suggestion: boolean;
  proposed_tag: "WATCH" | "SKIP";
  proposed_tag_reason: string;
} {
  const threshold = bleeder20Threshold(row.break_even_acos, row.ad_product);
  const acos = row.sales_30 > 0 ? (row.spend_30 / row.sales_30) * 100 : null;
  const inBand = row.orders_30 >= 1 && row.orders_30 <= 4 && acos != null && acos > threshold;
  const ranking = row.campaign_purpose === "ranking";
  if (!inBand && !ranking) {
    return {
      include: false, threshold_acos: threshold, acos_30: acos, over_by_pp: null,
      cut_suggestion: false, proposed_tag: "SKIP", proposed_tag_reason: "",
    };
  }
  if (ranking && !inBand) {
    return {
      include: false, threshold_acos: threshold, acos_30: acos, over_by_pp: null,
      cut_suggestion: false, proposed_tag: "SKIP", proposed_tag_reason: "",
    };
  }
  const over = acos != null ? Math.round((acos - threshold) * 10) / 10 : null;
  if (ranking) {
    return {
      include: true,
      threshold_acos: threshold,
      acos_30: acos,
      over_by_pp: over,
      cut_suggestion: false,
      proposed_tag: "SKIP",
      proposed_tag_reason: "ranking agreement: listed for tax context, excluded from Bleeders 2.0 cut",
    };
  }
  return {
    include: true,
    threshold_acos: threshold,
    acos_30: acos,
    over_by_pp: over,
    cut_suggestion: false,
    proposed_tag: "WATCH",
    proposed_tag_reason: `orders 1–4 and ACOS above family BE+${row.ad_product === "SP" ? BLEEDERS20_SP_PP : BLEEDERS20_SB_PP}pp; review only, never auto-pause`,
  };
}

export type BidSuggestion =
  | "hold" | "review_bid_down" | "review_bid_up" | "review_tos" | "review_sibling_auction" | "none";

export function bidReviewSuggestion(input: {
  purpose: CampaignPurpose;
  acos_l7: number | null;
  acos_l30: number | null;
  break_even: number;
  budget_constrained: boolean;
  sibling_auction: boolean;
}): { suggestion: BidSuggestion; reason: string } {
  if (input.purpose === "ranking") {
    if (input.sibling_auction) {
      return {
        suggestion: "review_sibling_auction",
        reason: "ranking campaign: score rank + SQP; auction hygiene is on siblings, not bid_down here",
      };
    }
    return {
      suggestion: "none",
      reason: "ranking agreement: do not suggest bid_down or bid_up for ACOS",
    };
  }
  if (input.budget_constrained) {
    return {
      suggestion: "hold",
      reason: "budget_constrained: do not suggest bid_up into a cap",
    };
  }
  if (input.sibling_auction) {
    return { suggestion: "review_sibling_auction", reason: "2+ ENABLED Exact campaigns bid this query" };
  }
  if (input.acos_l7 != null && input.acos_l7 > input.break_even) {
    return { suggestion: "review_bid_down", reason: "L7 ACOS above family CM BE; review only" };
  }
  if (input.acos_l7 != null && input.acos_l30 != null && input.acos_l7 < input.break_even && input.acos_l7 < input.acos_l30) {
    return { suggestion: "hold", reason: "improving and under family BE" };
  }
  return { suggestion: "none", reason: "no single lever suggested" };
}

export interface SiblingExact {
  query_normalized: string;
  campaigns: { campaign_id: string; campaign_name: string; bid: number | null; keyword_id: string }[];
}

export function siblingExactAuctions(targets: {
  campaign_id?: string | null;
  campaign_name: string;
  keyword_id?: string | null;
  keyword_text: string;
  match_type?: string | null;
  state?: string | null;
  bid?: number | null;
}[]): SiblingExact[] {
  const groups = new Map<string, SiblingExact["campaigns"]>();
  for (const t of targets) {
    const mt = namesKey(t.match_type);
    const state = namesKey(t.state);
    if (mt !== "exact" || (state !== "enabled" && state !== "")) continue;
    if (state === "") continue;
    const q = queryNormalized(t.keyword_text);
    if (!q) continue;
    const list = groups.get(q) ?? [];
    const id = String(t.campaign_id ?? "").trim() || namesKey(t.campaign_name);
    if (list.some((c) => c.campaign_id === id && namesKey(c.campaign_name) === namesKey(t.campaign_name))) continue;
    list.push({
      campaign_id: String(t.campaign_id ?? ""),
      campaign_name: t.campaign_name,
      bid: t.bid ?? null,
      keyword_id: String(t.keyword_id ?? ""),
    });
    groups.set(q, list);
  }
  const out: SiblingExact[] = [];
  for (const [query, campaigns] of groups) {
    const distinct = new Set(campaigns.map((c) => c.campaign_id || namesKey(c.campaign_name)));
    if (distinct.size >= 2) out.push({ query_normalized: query, campaigns });
  }
  return out.sort((a, b) => a.query_normalized.localeCompare(b.query_normalized));
}

export interface StructureFinding {
  finding_type: string;
  severity: "info" | "warn";
  entity_ids: string;
  entity_names: string;
  evidence: string;
}

export function structureAuditFindings(input: {
  siblings: SiblingExact[];
  duplicateWatch?: { campaign_id?: string | null; campaign_name: string; window_label?: string | null }[];
  rankingUnlabeled?: { campaign_id?: string | null; campaign_name: string }[];
  metaSyncMissing?: { campaign_name: string; watch_list: string }[];
}): StructureFinding[] {
  const out: StructureFinding[] = [];
  const siblings = new Map<string, SiblingExact>();
  for (const s of input.siblings) {
    const q = queryNormalized(s.query_normalized);
    if (!q) continue;
    const prev = siblings.get(q);
    if (!prev) {
      siblings.set(q, { query_normalized: q, campaigns: [...s.campaigns] });
      continue;
    }
    for (const c of s.campaigns) {
      const id = String(c.campaign_id ?? "").trim() || namesKey(c.campaign_name);
      if (prev.campaigns.some((x) => (String(x.campaign_id ?? "").trim() || namesKey(x.campaign_name)) === id)) continue;
      prev.campaigns.push(c);
    }
  }
  for (const s of siblings.values()) {
    out.push({
      finding_type: "sibling_exact_auction",
      severity: "warn",
      entity_ids: s.campaigns.map((c) => c.campaign_id).filter(Boolean).join("|"),
      entity_names: s.campaigns.map((c) => c.campaign_name).join(" | "),
      evidence: `${s.campaigns.length} ENABLED Exact campaigns bid query_normalized="${s.query_normalized}"`,
    });
  }
  for (const d of input.duplicateWatch ?? []) {
    out.push({
      finding_type: "duplicate_campaign_row",
      severity: "warn",
      entity_ids: String(d.campaign_id ?? ""),
      entity_names: d.campaign_name,
      evidence: `duplicate campaign_id+window_label ${d.window_label ?? ""} collapsed`,
    });
  }
  for (const r of input.rankingUnlabeled ?? []) {
    out.push({
      finding_type: "ranking_unlabeled",
      severity: "warn",
      entity_ids: String(r.campaign_id ?? ""),
      entity_names: r.campaign_name,
      evidence: "named ranking agreement missing campaign_purpose=ranking",
    });
  }
  for (const m of input.metaSyncMissing ?? []) {
    out.push({
      finding_type: "meta_sync_missing",
      severity: "info",
      entity_ids: "",
      entity_names: m.campaign_name,
      evidence: `${m.watch_list} Today row missing campaign_id or state; meta_sync=false`,
    });
  }
  return out;
}

export function isCutOrPauseSuggestion(value: string | null | undefined): boolean {
  const s = String(value ?? "").toLowerCase();
  if (!s) return false;
  return /\b(pause|bid_down|cut)\b/.test(s) || s === "review_bid_down";
}

export interface QualityInput {
  today: string;
  yesterday: string;
  sqpCurrentWeekEnd: string | null;
  sqpNewestCompleteWeekEnd: string | null;
  sqpLagDays: number | null;
  sqpStaleOver10: boolean;
  sqpFiles: { name: string; week_type: string; week_end: string; stale_pre_raise: boolean }[];
  watchRows: {
    campaign_id?: string | null;
    campaign_name: string;
    window_label: string;
    date_end: string;
    metrics_complete: boolean;
    watch_list: string;
    state?: string | null;
    meta_sync?: boolean | null;
    spend?: number;
    placement_shares_empty?: boolean;
  }[];
  spendMismatches: { window_mismatch: boolean; disagrees: boolean }[];
  stPresentedAsCampaignSot: boolean;
  stFiles: { name: string; rows: number; emptyReason: boolean; grains: string[]; labels: string[] }[];
  organicAsOf: string | null;
  organicZeroFilled: boolean;
  inventedSqpShares: boolean;
  bleeders20: { campaign_purpose: string; threshold_acos: number; break_even_acos: number; ad_product: string; cut_suggestion: boolean; proposed_tag: string }[];
  bidReview: { purpose: string; suggestion: string }[];
  priorCounts?: { auto_loose?: number; broad_m?: number; watch?: number; sqp?: number } | null;
  currentCounts: { auto_loose: number; broad_m: number; watch: number; sqp: number };
  rowFiltersApplied: string;
  fatParentEmpty: boolean;
  ltdUnavailable: boolean;
  addsThisWeekUnknown: boolean;
  skuCostsMissing: boolean;
  outcomesImplementedUnknown: boolean;
  placementLag: boolean;
}

function dayDelta(later: string, earlier: string): number {
  const a = Date.parse(`${earlier}T12:00:00Z`);
  const b = Date.parse(`${later}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

function shifted(count: number, prior: number): boolean {
  if (prior <= 0) return false;
  return Math.abs(count - prior) / prior > ROW_COUNT_SHIFT_RATIO;
}

export function evaluatePackQuality(input: QualityInput): QualityReport {
  const fails: string[] = [];
  const warns: string[] = [];

  if (input.sqpStaleOver10) {
    fails.push("1 SQP_LAG_DAYS>10: do not serve an older week as current");
  }
  if (
    input.sqpCurrentWeekEnd
    && input.sqpNewestCompleteWeekEnd
    && input.sqpCurrentWeekEnd !== input.sqpNewestCompleteWeekEnd
  ) {
    fails.push("1 SQP current week_end != newest stored complete SQP week_end");
  }
  for (const f of input.sqpFiles) {
    if (f.week_type !== "current" && f.stale_pre_raise === false) {
      fails.push(`2 stale_pre_raise=false on non-current SQP file ${f.name} week_end=${f.week_end}`);
    }
  }
  for (const row of input.watchRows) {
    const label = windowLabelFromPack(row.window_label);
    if ((label === "L2" || label === "L7") && row.date_end !== input.yesterday && row.metrics_complete) {
      fails.push(`3 ${label} date_end ${row.date_end} != yesterday ${input.yesterday} with metrics_complete=true`);
    }
  }
  if (input.organicAsOf && dayDelta(input.today, input.organicAsOf) > ORGANIC_STALE_DAYS) {
    fails.push(`4 organic_as_of ${input.organicAsOf} older than ${ORGANIC_STALE_DAYS} days`);
  }
  if (input.stPresentedAsCampaignSot) {
    fails.push("5 file presents ST or keyword sum as campaign spend SoT");
  }
  if (input.spendMismatches.some((m) => m.disagrees && !m.window_mismatch)) {
    fails.push("6 target/campaign spend disagrees >25% without window_mismatch=true");
  }
  const seen = new Set<string>();
  for (const row of input.watchRows) {
    const key = watchDedupeKey({
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      window_label: row.window_label,
    });
    if (seen.has(key)) fails.push(`7 duplicate campaign_id+window_label ${key}`);
    seen.add(key);
  }
  for (const row of input.watchRows) {
    const label = windowLabelFromPack(row.window_label);
    if (label !== "Today") continue;
    if (row.watch_list !== "NEW_EXACT" && row.watch_list !== "FLAVOR_SHELL") continue;
    const missingId = !String(row.campaign_id ?? "").trim();
    const missingState = !String(row.state ?? "").trim();
    if (missingId && missingState && row.meta_sync !== false) {
      fails.push(`8 Today ${row.watch_list} ${row.campaign_name} missing campaign_id and state without meta_sync=false`);
    }
  }
  for (const f of input.stFiles) {
    if (f.rows === 0 && !f.emptyReason) fails.push(`9 ${f.name} has 0 rows and no EMPTY_REASON`);
    for (let i = 0; i < f.labels.length; i++) {
      const label = f.labels[i];
      const grain = f.grains[i] ?? "";
      if ((label === "L7" || label === "L2") && grain !== "WINDOW_AGG") {
        fails.push(`15 ${f.name} labeled ${label} but grain=${grain || "blank"}`);
      }
    }
  }
  const prior = input.priorCounts;
  if (prior && !String(input.rowFiltersApplied || "").trim()) {
    if (shifted(input.currentCounts.auto_loose, prior.auto_loose ?? 0)) {
      fails.push("10 auto_loose row count changed >40% vs prior pack with no row_filters_applied");
    }
    if (shifted(input.currentCounts.broad_m, prior.broad_m ?? 0)) {
      fails.push("10 broad_m row count changed >40% vs prior pack with no row_filters_applied");
    }
  }
  if (input.organicZeroFilled) fails.push("11 organic_rank or aba_sfr filled with 0 for missing");
  for (const b of input.bleeders20) {
    if (b.campaign_purpose === "ranking" && (b.cut_suggestion || isCutOrPauseSuggestion(b.proposed_tag))) {
      fails.push("12 purpose=ranking appears in bleeders_20 as a cut/pause suggestion");
    }
    const be = b.break_even_acos;
    const expected = b.ad_product === "SP" ? be + BLEEDERS20_SP_PP : be + BLEEDERS20_SB_PP;
    if (b.threshold_acos === 37 || b.threshold_acos === 57 || b.threshold_acos === 47) {
      fails.push(`13 Bleeders 2.0 threshold ${b.threshold_acos} is not family BE + pp`);
    } else if (b.threshold_acos !== expected) {
      fails.push(`13 Bleeders 2.0 threshold ${b.threshold_acos} != family BE ${be} + ${b.ad_product === "SP" ? BLEEDERS20_SP_PP : BLEEDERS20_SB_PP}pp`);
    }
  }
  for (const b of input.bidReview) {
    if (b.purpose === "ranking" && isCutOrPauseSuggestion(b.suggestion)) {
      fails.push("12 purpose=ranking appears in bid_review as a cut/pause suggestion");
    }
  }
  if (input.inventedSqpShares) fails.push("14 invented SQP shares");

  if (input.sqpLagDays != null && input.sqpLagDays >= 8 && input.sqpLagDays <= 10) {
    warns.push(`SQP_LAG_DAYS ${input.sqpLagDays} is 8–10`);
  }
  if (input.placementLag) warns.push("placement shares empty while spend > 0 (placement_report_lag)");
  if (input.fatParentEmpty) warns.push("fat_parent empty");
  if (input.ltdUnavailable) warns.push("LTD unavailable so lifetime_zero omitted");
  if (input.addsThisWeekUnknown) warns.push("adds_this_week_already unknown");
  if (input.skuCostsMissing) warns.push("sku_costs missing");
  if (input.outcomesImplementedUnknown) warns.push("outcomes implemented=unknown for prior proposed_tag rows");

  const level: QualityLevel = fails.length ? "FAIL" : (warns.length ? "WARN" : "PASS");
  const notes = [...fails.map((f) => `FAIL ${f}`), ...warns.map((w) => `WARN ${w}`)].join("; ");
  return { level, fails, warns, notes };
}

export interface FreshnessFields {
  pack_id: string;
  pack_timestamp: string;
  account_timezone: string;
  today: string;
  l1: string;
  l2: string;
  l7: string;
  l30: string;
  l60: string;
  sqpCurrent: string;
  sqpNewestStoredWeekEnd: string;
  sqpSource: string;
  sqpLagDays: string;
  sqpComparison: string;
  organicAsOf: string;
  organicGroups: string;
  placementAsOf: string;
  negativesAsOf: string;
  skuCostsAsOf: string;
  bleeders10: string;
  bleeders20: string;
  unexpectedEmpty: string;
  rowFilters: string;
  qualityGates: QualityLevel;
  qualityNotes: string;
}

export function renderFreshnessBlock(f: FreshnessFields): string {
  const lines = [
    `pack_id: ${f.pack_id}`,
    `pack_timestamp: ${f.pack_timestamp}`,
    `account_timezone: ${f.account_timezone}`,
    `Today: ${f.today} (config-only)`,
    `L1: ${f.l1}`,
    `L2: ${f.l2}`,
    `L7: ${f.l7}`,
    `L30: ${f.l30}`,
    `L60: ${f.l60}`,
    `SQP current: ${f.sqpCurrent}`,
    `SQP newest_stored_week_end: ${f.sqpNewestStoredWeekEnd}`,
    `SQP source: ${f.sqpSource}`,
    `SQP_LAG_DAYS: ${f.sqpLagDays}`,
    `SQP comparison weeks attached: ${f.sqpComparison}`,
    `organic_as_of: ${f.organicAsOf}`,
    `organic_groups: ${f.organicGroups}`,
    `placement_as_of: ${f.placementAsOf}`,
    `negatives_as_of: ${f.negativesAsOf}`,
    `sku_costs_as_of: ${f.skuCostsAsOf}`,
    `Bleeders 1.0 window (60d): ${f.bleeders10}`,
    `Bleeders 2.0 window (30d): ${f.bleeders20}`,
    `unexpected_empty_files: ${f.unexpectedEmpty}`,
    `row_filters_applied: ${f.rowFilters}`,
    `quality_gates: ${f.qualityGates}`,
    `quality_gate_notes: ${f.qualityNotes}`,
  ];
  return lines.join("\n");
}

export function renderPackManifest(input: {
  pack_id: string;
  pack_timestamp: string;
  files: { name: string; body: string }[];
  windows: Record<string, string>;
  quality_gates: QualityLevel;
  quality_gate_notes: string;
  prior_pack_id: string | null;
  row_count_deltas: Record<string, { prior: number | null; current: number; delta_pct: number | null }>;
  row_filters_applied: string;
}): string {
  const files = input.files.map((f) => ({
    name: f.name,
    row_count: csvDataRowCount(f.body),
    sha256: sha256Text(f.body),
  }));
  return `${JSON.stringify({
    pack_id: input.pack_id,
    pack_timestamp: input.pack_timestamp,
    files,
    windows: input.windows,
    quality_gates: input.quality_gates,
    quality_gate_notes: input.quality_gate_notes,
    prior_pack_id: input.prior_pack_id,
    row_count_deltas: input.row_count_deltas,
    row_filters_applied: input.row_filters_applied,
    observe_only: true,
  }, null, 2)}\n`;
}

export const WATCH_PLACEMENT_HEADERS = [
  "date_start", "date_end", "window_label", "metrics_complete", "grain",
  "campaign_id", "campaign_name", "placement",
  "impressions", "clicks", "spend", "orders", "sales", "acos",
  "modifier_pct", "spend_share", "click_share", "order_share",
  "agreement_tos", "agreement_ros", "agreement_pp", "high_tos_is",
] as const;

export const BLEEDERS10_HEADERS = [
  "source_type", "date_start", "date_end", "window_label", "metrics_complete", "window_untrusted",
  "campaign_id", "campaign_name", "keyword_id", "target_id", "search_term", "query_normalized",
  "clicks_60", "spend_60", "orders_60", "relevance", "state", "protected_recent_test",
  "conquesting", "last_click_date", "proposed_tag", "proposed_tag_reason", "family",
] as const;

export const BLEEDERS20_HEADERS = [
  "date_start", "date_end", "window_label",
  "campaign_id", "campaign_name", "keyword_id", "target_id", "keyword_text", "query_normalized",
  "family", "break_even_acos", "threshold_acos", "acos_30", "over_by_pp",
  "orders_30", "spend_30", "ad_product", "campaign_purpose", "protected_recent_test",
  "cut_suggestion", "proposed_tag", "proposed_tag_reason",
] as const;

export const LIFETIME_ZERO_HEADERS = [
  "campaign_id", "campaign_name", "keyword_id", "target_id", "keyword_text",
  "clicks_ltd", "orders_ltd", "product_cvr", "family", "proposed_tag", "empty_reason",
] as const;

export const BID_REVIEW_HEADERS = [
  "campaign_id", "campaign_name", "purpose", "spend_l7", "acos_l7", "spend_l30", "acos_l30",
  "trend", "budget_constrained", "one_lever_suggestion", "suggestion_reason",
  "stack_risk", "do_not_stack_with_bleeders",
] as const;

export const HARVEST_QUEUE_HEADERS = [
  "term", "query_normalized", "family", "source_campaign_id",
  "clicks_l7", "orders_l7", "acos_l7", "clicks_l30", "orders_l30",
  "organic_rank", "sqp_ps",
  "destination_exact_exists", "destination_campaign_id", "destination_state",
  "destination_budget", "destination_impressions",
  "source_negate_pending", "slot_cost", "proposed_tag", "proposed_tag_reason", "harvest_ready",
  "adds_this_week_already", "remaining_slots",
] as const;

export const STRUCTURE_AUDIT_HEADERS = [
  "finding_type", "severity", "entity_ids", "entity_names", "evidence",
] as const;

export const AGREEMENTS_HEADERS = [
  "campaign_id", "target_id", "entity_name", "agreement_text", "owner", "as_of", "expires_at", "campaign_purpose",
] as const;

export const SQP_WOW_HEADERS = [
  "query", "query_normalized", "asin",
  "vol_pre", "vol_cur", "vol_wow",
  "is_pre", "is_cur", "is_wow",
  "ps_pre", "ps_cur", "ps_wow",
  "ps_minus_is_cur",
  "imps_pre", "imps_cur", "purch_pre", "purch_cur",
  "wow_incomplete",
] as const;

export function seededAgreements(): Record<string, string>[] {
  return [
    {
      campaign_id: "",
      target_id: "",
      entity_name: RANKING_LIP_BALM_CAMPAIGN,
      agreement_text: 'Unscented Lip Balm Exact "lip balm" is a ranking campaign; do not cut for ACOS; score rank + SQP.',
      owner: "Dave",
      as_of: CONTRACT_PACK_DATE,
      expires_at: "",
      campaign_purpose: "ranking",
    },
    {
      campaign_id: "",
      target_id: "",
      entity_name: "SP | TBL - 3Pck | B0CLHTKY3V |  Auto | Loose Match-TOS | SSG",
      agreement_text: "Auto Loose agreed review; do not infer children from names / Sellerise attributed-product IDs alone.",
      owner: "Dave",
      as_of: CONTRACT_PACK_DATE,
      expires_at: "",
      campaign_purpose: "",
    },
    {
      campaign_id: "",
      target_id: "",
      entity_name: "",
      agreement_text: "Do not overwrite campaign-specific placement agreements with generic 0% ROS/PP.",
      owner: "Dave",
      as_of: CONTRACT_PACK_DATE,
      expires_at: "",
      campaign_purpose: "",
    },
    {
      campaign_id: "",
      target_id: "",
      entity_name: "family_break_even_acos",
      agreement_text: "Family BE lip_3pk 42 / deo 36 / balm 36. Not TACOS. Not Bleeders 2.0 37%.",
      owner: "Dave",
      as_of: CONTRACT_PACK_DATE,
      expires_at: "",
      campaign_purpose: "",
    },
    {
      campaign_id: "",
      target_id: "",
      entity_name: "desk",
      agreement_text: "Desk never raises budgets, never auto-pauses. Pack may FLAG candidates only.",
      owner: "Dave",
      as_of: CONTRACT_PACK_DATE,
      expires_at: "",
      campaign_purpose: "",
    },
  ];
}

export function wowDelta(cur: number | null, pre: number | null): number | null {
  if (cur == null || pre == null) return null;
  return cur - pre;
}

export function joinSqpWow(
  current: { query: string; asin: string; volume: number | null; impression_share: number | null; purchase_share: number | null; impressions: number | null; purchases: number | null }[],
  prior: { query: string; asin: string; volume: number | null; impression_share: number | null; purchase_share: number | null; impressions: number | null; purchases: number | null }[],
): Record<string, unknown>[] {
  const key = (q: string, a: string) => `${queryNormalized(q)}\t${String(a ?? "").toUpperCase()}`;
  const prev = new Map(prior.map((r) => [key(r.query, r.asin), r]));
  const cur = new Map(current.map((r) => [key(r.query, r.asin), r]));
  const keys = new Set([...prev.keys(), ...cur.keys()]);
  const rows: Record<string, unknown>[] = [];
  for (const k of [...keys].sort()) {
    const p = prev.get(k);
    const c = cur.get(k);
    const incomplete = !p || !c;
    const psCur = c?.purchase_share ?? null;
    const isCur = c?.impression_share ?? null;
    rows.push({
      query: (c ?? p)!.query,
      query_normalized: k.split("\t")[0],
      asin: (c ?? p)!.asin ?? "",
      vol_pre: p?.volume ?? null,
      vol_cur: c?.volume ?? null,
      vol_wow: incomplete ? null : wowDelta(c?.volume ?? null, p?.volume ?? null),
      is_pre: p?.impression_share ?? null,
      is_cur: c?.impression_share ?? null,
      is_wow: incomplete ? null : wowDelta(c?.impression_share ?? null, p?.impression_share ?? null),
      ps_pre: p?.purchase_share ?? null,
      ps_cur: c?.purchase_share ?? null,
      ps_wow: incomplete ? null : wowDelta(c?.purchase_share ?? null, p?.purchase_share ?? null),
      ps_minus_is_cur: psCur != null && isCur != null ? psCur - isCur : null,
      imps_pre: p?.impressions ?? null,
      imps_cur: c?.impressions ?? null,
      purch_pre: p?.purchases ?? null,
      purch_cur: c?.purchases ?? null,
      wow_incomplete: incomplete,
    });
  }
  return rows;
}

export function ledgerWithinDays<T extends { created_at?: string | null }>(
  rows: T[],
  packDate: string,
  days = 30,
): T[] {
  const end = Date.parse(`${packDate}T23:59:59Z`);
  if (!Number.isFinite(end)) return rows;
  const start = end - days * 86_400_000;
  return rows.filter((r) => {
    if (!r.created_at) return true;
    const t = Date.parse(r.created_at);
    if (!Number.isFinite(t)) return true;
    return t >= start && t <= end + 86_400_000;
  });
}

export function countDelta(current: number, prior: number | null | undefined): { prior: number | null; current: number; delta_pct: number | null } {
  if (prior == null) return { prior: null, current, delta_pct: null };
  if (prior === 0) return { prior, current, delta_pct: current === 0 ? 0 : null };
  return { prior, current, delta_pct: Math.round(((current - prior) / prior) * 1000) / 10 };
}
