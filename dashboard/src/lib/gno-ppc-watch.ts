/**
 * GNO PPC Watch — observe + export + alert only.
 *
 * Hard-coded Tallowbourn SP watchlists from Dave's 7 Sep 2026 Grok spec.
 * Never pause, negate, raise bids, or raise budgets. Clicking a harvest
 * row only queues it for the next Export GNO pack.
 */

import spec from "../../config/gno_ppc_watch.json";
import { AMAZON_TZ, shiftDays, windowStart } from "./as-of";
import {
  applyHarvestLearning,
  lastCallForCampaign,
  type GnoLedgerRow,
} from "./gno-learning";
import {
  ORGANIC_RANK_EMPTY_CELL_NOTE,
  ORGANIC_RANK_EXPORT_HEADERS,
  ORGANIC_RANK_SNAPSHOT_CSV_HEADERS,
  buildOrganicRankJoinIndex,
  emptyOrganicRankJoin,
  familyHeroAsin,
  lookupOrganicRank,
  organicRankSnapshotRows,
  type OrganicRankJoin,
  type RankSnapshot,
} from "./organic-rank-progress";
import { gnoDecisionRulesTxt, gnoOutcomesCsv } from "./gno-methodology";
import {
  AGREEMENTS_HEADERS,
  BID_REVIEW_HEADERS,
  BLEEDERS10_HEADERS,
  BLEEDERS20_HEADERS,
  BLEEDERS10_MIN_CLICKS,
  HARVEST_MIN_CLICKS,
  HARVEST_MIN_ORDERS,
  HARVEST_QUEUE_HEADERS,
  MAX_NEW_STRUCTURES_PER_WEEK,
  LIFETIME_ZERO_HEADERS,
  RANKING_LIP_BALM_QUERY,
  RANKING_SUCCESS_METRIC,
  REQUIRED_PACK_FILES,
  ROW_FILTERS_APPLIED,
  SQP_WOW_HEADERS,
  STRUCTURE_AUDIT_HEADERS,
  WATCH_PLACEMENT_HEADERS,
  adProductOf,
  bidReviewSuggestion,
  bleeder20Threshold,
  bleeders20Decision,
  campaignPurposeOf,
  childFlavorOf,
  contractSearchTermTag,
  countDelta,
  csvDataRowCount,
  csvEscapeField,
  organicTrackerCensus,
  seriesCoversWindow,
  dedupeWatchCampaignRows,
  evaluatePackQuality,
  isRankingCampaign,
  isRankingQuery,
  joinSqpWow,
  ledgerWithinDays,
  queryNormalized,
  renderFreshnessBlock,
  renderPackManifest,
  seededAgreements,
  siblingExactAuctions,
  spendsDisagree,
  structureAuditFindings,
  termRelevance,
  windowLabelFromPack,
  type CampaignPurpose,
  type QualityLevel,
} from "./gno-pack-contract";
import {
  competitorKrOutliersCsv,
  COMPETITOR_KR_CSV_HEADERS,
  finalizeCompetitorKrRows,
  type CompetitorOutlierRow,
} from "./soldscope-competitor-outliers";

export const GNO_OBSERVE_ONLY = true as const;

export const WATCH_CAMPAIGN_CSV_HEADERS = [
  "date_start", "date_end", "campaign_name", "asin", "state", "portfolio",
  "daily_budget", "tos_modifier_pct", "ros_modifier_pct", "pp_modifier_pct",
  "tos_spend_share", "ros_spend_share", "pp_spend_share", "impressions",
  "clicks", "spend", "cpc", "orders", "sales", "acos", "watch_list",
  "metrics_complete", "family", "break_even_acos", "acos_vs_be", "cm_note",
  ...ORGANIC_RANK_EXPORT_HEADERS,
  "window_label", "grain", "campaign_id", "ad_group_id", "mixed_ad_groups",
  "advertised_asin", "advertised_sku", "parent_asin", "hero_asin", "child_flavor",
  "mixed_asin", "serving_status", "meta_sync", "portfolio_id", "portfolio_name",
  "portfolio_budget", "portfolio_budget_type", "spend_yesterday", "spend_dby",
  "budget_util_yesterday", "budget_capped_yesterday",
  "tos_click_share", "ros_click_share", "pp_click_share", "placement_report_lag",
  "ctr", "aov", "cvr", "roas", "campaign_purpose", "ranking_query", "ranking_success_metric",
  "targeting_type", "match_types_in_campaign", "keyword_count_enabled", "keyword_count_paused",
  "exact_keyword_count", "created_at", "last_updated_at", "days_live",
  "protected_recent_test", "id_missing", "duplicate_reason", "window_mismatch",
] as const;

export const AUTO_LOOSE_TERM_CSV_HEADERS = [
  "date_start", "date_end", "label", "campaign_name", "customer_search_term",
  "match_type", "impressions", "clicks", "spend", "orders", "sales", "acos",
  "cvr", "has_enabled_exact_elsewhere", "proposed_tag",
  "family", "break_even_acos", "acos_vs_be", "cm_note",
  ...ORGANIC_RANK_EXPORT_HEADERS,
  "window_label", "grain", "campaign_id", "query_normalized",
  "ctr", "cpc", "exact_elsewhere_campaign_ids",
  "already_negative", "negative_match_type_if_any", "negative_ids",
  "proposed_tag_reason", "harvest_ready", "destination_exact_campaign_id",
  "destination_exact_has_impressions", "relevance",
  "sqp_impression_share", "sqp_purchase_share", "sqp_week_end", "min_search_volume_ok",
  "metrics_complete", "id_missing",
] as const;

export const KEYWORD_TARGET_CSV_HEADERS = [
  "date_start", "date_end", "campaign_name", "asin", "keyword_text",
  "match_type", "keyword_state", "bid", "impressions", "clicks", "spend",
  "orders", "sales", "acos", "metrics_complete",
  "family", "break_even_acos", "acos_vs_be", "cm_note",
  ...ORGANIC_RANK_EXPORT_HEADERS,
  "window_label", "grain", "campaign_id", "ad_group_id", "keyword_id", "target_id",
  "query_normalized", "ctr", "cpc", "cvr",
  "has_enabled_exact_elsewhere", "exact_elsewhere_campaign_ids",
  "sibling_exact_campaign_count", "sibling_exact_campaign_ids", "highest_sibling_bid",
  "already_negative_exact_in_source", "destination_exact_campaign_id",
  "destination_exact_has_impressions", "bleeders10_flag", "bleeders20_flag",
  "lifetime_zero_flag", "protected_recent_test", "campaign_purpose",
  "window_mismatch", "id_missing", "created_at", "days_live",
] as const;

export const NEGATIVES_CSV_HEADERS = [
  "campaign_id", "ad_group_id", "negative_id", "campaign_name",
  "keyword", "query_normalized", "match_type", "level", "state",
  "added_at", "source",
] as const;

export const ADVERTISED_PRODUCT_L7_CSV_HEADERS = [
  "date_start", "date_end", "asin", "campaign_name", "watch_list",
  "spend", "orders", "sales", "acos", "sku", "product_name",
  "mixed_asin", "family", "break_even_acos", "acos_vs_be", "cm_note",
  "attribution", "do_not_sum", "child_flavor", "hero_child",
  "sku_cogs", "cm_per_unit", "profit_verified",
] as const;

export const SQP_SLICE_CSV_HEADERS = [
  "week_start", "week_end", "asin", "search_query", "query_normalized",
  "search_query_volume", "impression_share", "click_share", "purchase_share",
  "asin_impressions", "asin_clicks", "asin_purchases", "source",
  "stale_pre_raise", "week_type", "advertised_asin", "hero_asin",
  "child_flavor", "sqp_lag_days",
] as const;

export const SQP_SLICE_QUERIES = [
  "lip balm", "tallow lip balm", "chapstick",
  "tallow balm", "beef tallow balm", "tallow deodorant", "tallow deodorant for men",
] as const;
/**
 * Newest stored complete Sun–Sat week older than this many days before
 * pack_date fails the slice (SQP_STALE). Age == 10 still ships as current.
 */
export const SQP_STALE_AFTER_DAYS = 10;
/** Older week, when emitted, is never the current slice file. */
export const SQP_COMPARISON_FILENAME = "sqp_weekly_slice_COMPARISON_PRE_RAISE.csv";

export type WatchList = "NEW_EXACT" | "KEEPER" | "DAY5_PAUSE" | "FLAVOR_SHELL" | "OTHER";
export type ProposedTag =
  | "KEEP" | "HARVEST_CANDIDATE" | "JUNK_CANDIDATE"
  | "HARVEST_EXACT" | "NEGATIVE_EXACT" | "NEGATIVE_PHRASE" | "WATCH" | "JUNK" | "SKIP";
export type AlertPriority = "P0" | "P1" | "P2";
export type TermWindowLabel = "L2" | "L7";
export type PackWindowLabel = "Today" | "Last1" | "Last2" | "Last7" | "Last30" | "Last60";
export type GnoFamily = "lip_3pk" | "deo" | "balm" | "other";

/** Config family contribution-margin BE — not ad-only TACOS. */
export const CM_NOTE = "config family CM BE (not TACOS)";
/** L2/L7 keeper spend exists but ads_placement_daily has no rows in-window. */
export const PLACEMENT_LAG_NOTE = "placement report lag: no ads_placement_daily rows in this window";
/** Keyword_targets must not copy search-term rollups onto every match-type row. */
export const KEYWORD_ST_NOTE =
  "search-term performance stays in fat_parent_search_terms.csv; keyword_targets are not search-term rollups";
export const ADVERTISED_PRODUCT_NOTE =
  "campaign-level L7; no advertised-product report synced — spend not split by ASIN";
/** Campaign daily L2/L7 on watch_campaigns is SoT. ST files are term-level only. */
export const ST_CAMPAIGN_SOT_NOTE =
  "campaign L2/L7 on watch_campaigns is SoT for spend; ST file is term-level negate/harvest only";
/** 1-day ST stamp vs campaign daily — slack so rounding is not treated as a 7d SUMMARY. */
export const ST_DAILY_SPEND_SLACK = 1.25;
export const ST_DAILY_SPEND_ABS = 2;
/**
 * Live TBM Exact shells on balm ASIN B0CLF5B27Y (ads_campaign_meta, Sep 11).
 * Only these two keywords. Balm-ASIN + deodorant name is never NEW_EXACT.
 */
const TBM_ALLOWED_EXACT_RE =
  /^sp \| tbm \| b0clf5b27y \| ex \| (tallow balm|beef tallow balm)(?:\s*\|\s*tos)?$/;
const TBM_FORBIDDEN_DEO_RE = /^sp \| tbm \| b0clf5b27y \| ex \| .*\bdeodorant\b/;

export interface ContributionFrame {
  family: GnoFamily;
  break_even_acos: number;
  /** ACOS − family BE. Negative = under BE / healthier. Null when ACOS is unknown. */
  acos_vs_be: number | null;
  cm_note: string;
}

export interface GnoAlert {
  priority: AlertPriority;
  code: string;
  title: string;
  detail: string;
  campaign_name?: string;
  search_term?: string;
  /** Always false — this engine never writes to Amazon. */
  auto_action: false;
}

export interface CampaignDailyRow {
  date: string;
  campaign_id?: string;
  campaign_name: string;
  campaign_type?: string | null;
  campaign_status?: string | null;
  budget?: number | null;
  spend?: number | null;
  sales_14d?: number | null;
  orders_14d?: number | null;
  clicks?: number | null;
  impressions?: number | null;
  cpc?: number | null;
  acos?: number | null;
}

export interface SearchTermRow {
  date: string;
  search_term: string;
  campaign_id?: string;
  campaign_name: string;
  ad_group_id?: string;
  ad_group_name?: string;
  keyword?: string | null;
  keyword_id?: string | null;
  match_type?: string | null;
  spend?: number | null;
  sales_14d?: number | null;
  orders_14d?: number | null;
  clicks?: number | null;
  impressions?: number | null;
}

export interface PlacementRow {
  date: string;
  campaign_id?: string;
  campaign_name: string;
  placement: string;
  spend?: number | null;
  sales_14d?: number | null;
  orders_14d?: number | null;
  clicks?: number | null;
  impressions?: number | null;
}

export interface NegativeRow {
  campaign_id?: string | null;
  ad_group_id?: string | null;
  negative_id?: string | null;
  campaign_name: string;
  keyword: string;
  match_type?: string | null;
  level?: string | null;
  state?: string | null;
  added_at?: string | null;
  source?: string | null;
}

export interface Metrics {
  impressions: number;
  clicks: number;
  spend: number;
  orders: number;
  sales: number;
  cpc: number;
  acos: number | null;
  cvr: number | null;
}

export interface PlacementShare {
  tos_spend_share: number | null;
  ros_spend_share: number | null;
  pp_spend_share: number | null;
}

export interface CampaignMeta {
  campaign_id?: string;
  campaign_name: string;
  state?: string | null;
  daily_budget?: number | null;
  portfolio_id?: string | null;
  portfolio_name?: string | null;
  tos_modifier_pct?: number | null;
  ros_modifier_pct?: number | null;
  pp_modifier_pct?: number | null;
  /** Campaigns API creationDate, else first snapshot. */
  created_at?: string | number | null;
  /** Raw Campaigns API creationDate (epoch ms or ISO) when not yet persisted. */
  creationDate?: string | number | null;
  /** First snapshot only — later snapshot_at writes must not reset the clock. */
  snapshot_at?: string | null;
}

export interface KeywordTarget {
  keyword_id?: string;
  campaign_id?: string;
  campaign_name: string;
  ad_group_id?: string;
  keyword_text: string;
  match_type?: string | null;
  state?: string | null;
  bid?: number | null;
  created_at?: string | number | null;
}

export interface NewExactTile {
  campaign_name: string;
  keyword: string;
  family: GnoFamily;
  state: string;
  daily_budget: number | null;
  hours_since_launch: number;
  impressions: number;
  clicks: number;
  spend: number;
  orders: number;
  sales: number;
  cpc: number;
  acos: number | null;
  break_even_acos: number;
  acos_vs_be: number | null;
  zero_impr_after_24h: boolean;
  over_shell_budget: boolean;
  /** Last Dave/Grok bid call from the ledger. Observe only. */
  last_call?: "hold" | "bid_down" | "bid_up" | null;
}

export interface KeeperHeartbeat {
  campaign_name: string;
  role: "auto_loose" | "fat_parent" | "hero_chapstick";
  family: GnoFamily;
  state: string;
  enabled: boolean;
  daily_budget: number | null;
  spend_today: number;
  spend_l7: number;
  spend_l7_avg: number;
  acos_l7: number | null;
  break_even_acos: number;
  acos_vs_be: number | null;
  sparkline: number[];
}

export interface HarvestTerm {
  date_start?: string;
  date_end?: string;
  label?: TermWindowLabel;
  campaign_name: string;
  customer_search_term: string;
  match_type: string;
  impressions: number;
  clicks: number;
  spend: number;
  orders: number;
  sales: number;
  acos: number | null;
  cvr: number | null;
  has_enabled_exact_elsewhere: boolean;
  proposed_tag: ProposedTag;
  family: GnoFamily;
  break_even_acos: number;
  acos_vs_be: number | null;
  cm_note: string;
  organic_rank: number | null;
  organic_rank_prev: number | null;
  organic_rank_delta: number | null;
  aba_sfr: number | null;
  organic_as_of: string | null;
  /** UI-only. Not a CSV column. */
  learning_note?: string;
  window_label?: string;
  grain?: string;
  campaign_id?: string;
  query_normalized?: string;
  proposed_tag_reason?: string;
  harvest_ready?: boolean;
  relevance?: string;
  already_negative?: boolean;
  metrics_complete?: boolean;
  id_missing?: boolean;
  ctr?: number | null;
  cpc?: number | null;
  sqp_impression_share?: number | null;
  sqp_purchase_share?: number | null;
  sqp_week_end?: string | null;
  destination_exact_campaign_id?: string;
  destination_exact_has_impressions?: boolean;
  exact_elsewhere_campaign_ids?: string;
}

export interface WatchCampaignExportRow {
  date_start: string;
  date_end: string;
  campaign_name: string;
  asin: string;
  state: string;
  portfolio: string;
  daily_budget: number | null;
  tos_modifier_pct: number | null;
  ros_modifier_pct: number | null;
  pp_modifier_pct: number | null;
  tos_spend_share: number | null;
  ros_spend_share: number | null;
  pp_spend_share: number | null;
  impressions?: number;
  clicks?: number;
  spend?: number;
  cpc?: number;
  orders?: number;
  sales?: number;
  acos: number | null;
  watch_list: WatchList;
  /** false on Today — Ads lag; $0 is not a pause. Read spend/ACOS from L2/L7. */
  metrics_complete: boolean;
  family: GnoFamily;
  break_even_acos: number;
  acos_vs_be: number | null;
  cm_note: string;
  organic_rank: number | null;
  organic_rank_prev: number | null;
  organic_rank_delta: number | null;
  aba_sfr: number | null;
  organic_as_of: string | null;
  window_label?: string;
  grain?: string;
  campaign_id?: string;
  campaign_purpose?: string;
  ranking_query?: string;
  ranking_success_metric?: string;
  meta_sync?: boolean;
  id_missing?: boolean;
  child_flavor?: string;
  duplicate_reason?: string | null;
  window_mismatch?: boolean;
  placement_report_lag?: boolean;
  spend_yesterday?: number | null;
  spend_dby?: number | null;
  budget_util_yesterday?: number | null;
  budget_capped_yesterday?: boolean | null;
  created_at?: string;
  last_updated_at?: string;
  days_live?: number | null;
  protected_recent_test?: boolean;
  advertised_asin?: string;
  portfolio_id?: string;
  portfolio_name?: string;
  serving_status?: string;
}

export interface KeywordTargetExportRow {
  date_start: string;
  date_end: string;
  campaign_name: string;
  asin: string;
  keyword_text: string;
  match_type: string;
  keyword_state: string;
  bid: number | null;
  impressions?: number;
  clicks?: number;
  spend?: number;
  orders?: number;
  sales?: number;
  acos: number | null;
  /** false on Today — config-only until Amazon attributes. */
  metrics_complete: boolean;
  family: GnoFamily;
  break_even_acos: number;
  acos_vs_be: number | null;
  cm_note: string;
  organic_rank: number | null;
  organic_rank_prev: number | null;
  organic_rank_delta: number | null;
  aba_sfr: number | null;
  organic_as_of: string | null;
  window_label?: string;
  grain?: string;
  campaign_id?: string;
  keyword_id?: string;
  query_normalized?: string;
  campaign_purpose?: string;
  window_mismatch?: boolean;
  id_missing?: boolean;
  bleeders10_flag?: boolean | null;
  bleeders20_flag?: boolean | null;
  lifetime_zero_flag?: boolean | null;
  protected_recent_test?: boolean;
  created_at?: string;
  days_live?: number | null;
  sibling_exact_campaign_count?: number;
  sibling_exact_campaign_ids?: string;
  highest_sibling_bid?: number | null;
  ad_group_id?: string;
}

export interface AdvertisedProductL7Row {
  date_start: string;
  date_end: string;
  asin: string;
  campaign_name: string;
  watch_list: WatchList;
  spend: number;
  orders: number;
  sales: number;
  acos: number | null;
  sku: string;
  product_name: string;
  mixed_asin: boolean;
  family: GnoFamily;
  break_even_acos: number;
  acos_vs_be: number | null;
  cm_note: string;
  attribution?: string;
  do_not_sum?: boolean;
  child_flavor?: string;
  hero_child?: boolean;
  sku_cogs?: number | null;
  cm_per_unit?: number | null;
  profit_verified?: boolean;
}

export interface SqpSliceRow {
  week_start: string;
  week_end: string;
  asin?: string | null;
  search_query?: string | null;
  query_normalized?: string | null;
  search_query_volume?: number | null;
  impression_share?: number | null;
  click_share?: number | null;
  purchase_share?: number | null;
  asin_impressions?: number | null;
  asin_clicks?: number | null;
  asin_purchases?: number | null;
  source?: string | null;
  /**
   * false only when week_end is the newest stored complete Sun–Sat week.
   * Older weeks emitted as COMPARISON / PRE_RAISE are true.
   */
  stale_pre_raise?: boolean;
  week_type?: string;
  advertised_asin?: string | null;
  hero_asin?: string | null;
  child_flavor?: string | null;
  sqp_lag_days?: number | null;
}

export interface AsinCatalogRow {
  asin: string;
  sku?: string | null;
  product_name?: string | null;
  cogs_per_unit?: number | null;
  updated_at?: string | null;
}

export const GNO_SPEC = spec;

export const KEEP_ALIVE = spec.keep_alive as readonly string[];
export const NEW_EXACT = spec.new_exact as readonly string[];
export const DAY5_PAUSE = spec.day5_pause as readonly string[];
export const FLAVOR_SHELL = spec.flavor_shell as readonly string[];
export const AUTO_LOOSE_NAME = spec.aliases.auto_loose;
export const FAT_PARENT_NAME = spec.aliases.fat_parent;
export const HERO_CHAPSTICK_NAME = spec.aliases.hero_chapstick;
export const BROAD_M_NAME = spec.aliases.broad_m;
export const AUTO_LOOSE_BUDGET = spec.auto_loose_budget;
export const NEW_EXACT_SPEND_ALERT = spec.new_exact_zero_order_spend_alert;
export const SHELL_DAILY_BUDGET_CAP = spec.shell_daily_budget_cap;
export const LIP_BE_ACOS = spec.family_break_even_acos.lip_3pk;
export const DEO_BE_ACOS = spec.family_break_even_acos.deo;
export const BALM_BE_ACOS = spec.family_break_even_acos.balm;
export const CORE_NEGATIVES = spec.core_negatives as readonly string[];
export const GNO_LAUNCHED_AT = spec.launched_at;
/** Historical first 48h slot from config. Not live SoT — use resolveGnoReviewClock. */
export const GNO_NEXT_REVIEW_AT = spec.next_human_review_at;

/**
 * Desk + nightly campaign windows are short spend lookbacks.
 * The 4h GNO snapshot writes 3 closed days; nightly SP writes 7; the
 * /api/ppc/gno desk reads 14. Ads campaign reports omit $0-spend days,
 * so a KEEP-ALIVE with no row in these windows is a data gap — never a P0.
 */
export const GNO_DESK_SPEND_LOOKBACK_DAYS = 14;
export const SHORT_SPEND_LOOKBACK_DAYS = 14;

export function normalizeName(name: string | null | undefined): string {
  return String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function normalizeTerm(term: string | null | undefined): string {
  return queryNormalized(term);
}

function namesEqual(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b) && normalizeName(a) !== "";
}

function nameContains(haystack: string, needle: string): boolean {
  const h = normalizeName(haystack);
  const n = normalizeName(needle);
  return h.length > 0 && n.length > 0 && h.includes(n);
}

/**
 * Flavor-shell 1-keyword Exact campaigns discovered from ads_campaign_meta:
 * `{Orange|Assorted|Peppermint|Unscented} Lip Balm - SP - {kw} - Exact`.
 * Do not invent names — STR Unscented / GG Peppermint Asin Off are not shells.
 */
const FLAVOR_SHELL_NAME_RE = /^(orange|assorted|peppermint|unscented) lip balm - sp\b/;

export function isFlavorShellName(campaignName: string): boolean {
  if (FLAVOR_SHELL.some((n) => namesEqual(n, campaignName))) return true;
  const n = normalizeName(campaignName);
  return FLAVOR_SHELL_NAME_RE.test(n) && n.includes("exact");
}

/** Collapse whitespace so Dave's extra-space names still match stored rows. */
export function watchListOf(campaignName: string): WatchList {
  if (isNewExactName(campaignName)) return "NEW_EXACT";
  if (KEEP_ALIVE.some((n) => namesEqual(n, campaignName))) return "KEEPER";
  if (DAY5_PAUSE.some((n) => namesEqual(n, campaignName) || nameContains(campaignName, n))) {
    return "DAY5_PAUSE";
  }
  if (isFlavorShellName(campaignName)) return "FLAVOR_SHELL";
  return "OTHER";
}

export function isAutoLoose(campaignName: string): boolean {
  return namesEqual(campaignName, AUTO_LOOSE_NAME);
}

export function isFatParent(campaignName: string): boolean {
  return namesEqual(campaignName, FAT_PARENT_NAME);
}

export function isHeroChapstick(campaignName: string): boolean {
  return namesEqual(campaignName, HERO_CHAPSTICK_NAME);
}

export function isBroadM(campaignName: string): boolean {
  return namesEqual(campaignName, BROAD_M_NAME);
}

export function isNewExact(campaignName: string): boolean {
  return watchListOf(campaignName) === "NEW_EXACT";
}

export function isEnabledStatus(status: string | null | undefined): boolean {
  const s = String(status ?? "").trim().toLowerCase();
  return s === "enabled" || s === "enable";
}

export function extractExactKeyword(campaignName: string): string | null {
  const m = String(campaignName ?? "").match(/\|\s*EX\s*\|\s*([^|]+?)(?:\s*\||\s*$)/i);
  return m ? normalizeTerm(m[1]) : null;
}

/** Drop a trailing `| TOS` so config and live ads_campaign_meta names match. */
export function stripOptionalTos(name: string): string {
  return normalizeName(name).replace(/\s*\|\s*tos$/, "");
}

/**
 * Config NEW_EXACT names (optional live `| TOS`), plus the two allowed TBM
 * B0CLF5B27Y Exact shells. Never treat balm-ASIN + deodorant as NEW_EXACT.
 */
export function isNewExactName(campaignName: string): boolean {
  const n = normalizeName(campaignName);
  if (!n) return false;
  if (TBM_FORBIDDEN_DEO_RE.test(n)) return false;
  if (NEW_EXACT.some((cfg) => stripOptionalTos(cfg) === stripOptionalTos(n))) return true;
  if (TBM_ALLOWED_EXACT_RE.test(n)) return true;
  return NEW_EXACT.some((cfg) => {
    const base = stripOptionalTos(cfg);
    const live = stripOptionalTos(n);
    return live === base || live.startsWith(`${base} |`) || live.startsWith(`${base}|`);
  });
}

/** ASINs embedded in campaign names, including mixed keepers (B0…/B0…). */
export function extractAsin(campaignName: string | null | undefined): string {
  const matches = String(campaignName ?? "").match(/B0[A-Z0-9]{8}/gi) ?? [];
  return [...new Set(matches.map((a) => a.toUpperCase()))].join("/");
}

export function familyOf(campaignName: string): GnoFamily {
  const n = normalizeName(campaignName);
  if (n.includes("deo") || n.includes("deodorant")) return "deo";
  // Lip (incl. fat parent / Broad M / lip Exact) is lip_3pk BE 42 — not body balm/36.
  // "tallow lip balm" contains "lip"; body "tallow balm" does not.
  if (
    n.includes("lip")
    || n.includes("chapstick")
    || n.includes("3pck")
    || n.includes("3 pack")
    || n.includes("b0clhtky3v")
    || n.includes("b0clhvcpl5")
    || n.includes("b0clhvlg2f")
    || n.includes("b0clhv3v5c")
  ) {
    return "lip_3pk";
  }
  if (n.includes("balm")) return "balm";
  return "other";
}

export function breakEvenAcosOf(campaignName: string): number {
  const fam = familyOf(campaignName);
  if (fam === "deo") return DEO_BE_ACOS;
  if (fam === "balm") return BALM_BE_ACOS;
  return LIP_BE_ACOS;
}

/** ACOS − family BE. Negative = under BE / healthier contribution. */
export function acosVsBe(acos: number | null | undefined, breakEven: number): number | null {
  if (acos == null || !Number.isFinite(acos)) return null;
  return acos - breakEven;
}

export function contributionFrame(
  campaignName: string,
  acos: number | null | undefined,
  extraNotes: string[] = [],
): ContributionFrame {
  const family = familyOf(campaignName);
  const break_even_acos = breakEvenAcosOf(campaignName);
  const extras = extraNotes.map((s) => s.trim()).filter(Boolean);
  return {
    family,
    break_even_acos,
    acos_vs_be: acosVsBe(acos ?? null, break_even_acos),
    cm_note: extras.length ? [CM_NOTE, ...extras].join("; ") : CM_NOTE,
  };
}

/** Alert / digest line: `ACOS 33.3% vs lip_3pk BE 42% (Δ -8.7)`. */
export function formatAcosVsBe(
  acos: number | null | undefined,
  campaignName: string,
): string {
  const { family, break_even_acos, acos_vs_be } = contributionFrame(campaignName, acos);
  const a = acos == null || !Number.isFinite(acos) ? "—" : `${acos.toFixed(1)}%`;
  const delta = acos_vs_be == null ? "" : ` (Δ ${acos_vs_be.toFixed(1)})`;
  return `ACOS ${a} vs ${family} BE ${break_even_acos}%${delta}`;
}

export function hoursSinceLaunch(now: Date = new Date(), launchedAt = GNO_LAUNCHED_AT): number {
  const start = parseLaunchInstant(launchedAt);
  if (start == null) return 0;
  return Math.max(0, (now.getTime() - start) / 3_600_000);
}

/** ISO / epoch-ms / epoch-seconds → ms since epoch. */
export function parseLaunchInstant(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/**
 * Per-campaign launch clock. Prefer Campaigns API / ads_campaign_meta
 * created_at (creationDate or first snapshot). Config launched_at is
 * fallback only — a later campaign created_at always wins.
 */
export function campaignLaunchedAt(
  meta?: Pick<CampaignMeta, "created_at" | "creationDate" | "snapshot_at"> | null,
  fallback = GNO_LAUNCHED_AT,
): string {
  const ms =
    parseLaunchInstant(meta?.created_at)
    ?? parseLaunchInstant(meta?.creationDate)
    ?? parseLaunchInstant(meta?.snapshot_at);
  if (ms == null) return fallback;
  return new Date(ms).toISOString();
}

export function hoursSinceCampaignLaunch(
  now: Date = new Date(),
  meta?: Pick<CampaignMeta, "created_at" | "creationDate" | "snapshot_at"> | null,
  fallback = GNO_LAUNCHED_AT,
): number {
  return hoursSinceLaunch(now, campaignLaunchedAt(meta, fallback));
}

/** Inclusive closed-day span of the campaign rows, or the declared desk window. */
export function spendLookbackDays(
  campaigns: CampaignDailyRow[],
  asOf: string,
  declaredDays?: number,
): number {
  if (declaredDays != null && Number.isFinite(declaredDays) && declaredDays > 0) {
    return Math.trunc(declaredDays);
  }
  const dates = campaigns.map((r) => r.date).filter(Boolean).sort();
  if (!dates.length) return 0;
  const startMs = Date.parse(`${dates[0]}T12:00:00Z`);
  const asOfMs = Date.parse(`${asOf}T12:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(asOfMs)) return 0;
  return Math.max(0, Math.round((asOfMs - startMs) / 86_400_000) + 1);
}

/**
 * Absence from ads_campaigns_daily is not evidence a KEEP-ALIVE is paused.
 * Always P2 — even a 90-day spend report omits $0 days. True P0 is
 * KEEPER_NOT_ENABLED when a stored row says the state is not Enabled.
 */
export function keeperMissingPriority(_lookbackDays: number): AlertPriority {
  return "P2";
}

export function n(v: unknown): number {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

export function sumMetrics(rows: CampaignDailyRow[] | SearchTermRow[]): Metrics {
  let impressions = 0, clicks = 0, spend = 0, orders = 0, sales = 0;
  for (const r of rows) {
    impressions += n(r.impressions);
    clicks += n(r.clicks);
    spend += n(r.spend);
    orders += n((r as CampaignDailyRow).orders_14d);
    sales += n((r as CampaignDailyRow).sales_14d);
  }
  return {
    impressions,
    clicks,
    spend,
    orders,
    sales,
    cpc: clicks > 0 ? spend / clicks : 0,
    acos: sales > 0 ? (spend / sales) * 100 : null,
    cvr: clicks > 0 ? (orders / clicks) * 100 : null,
  };
}

export function inWindow<T extends { date: string }>(
  rows: T[], start: string, end: string,
): T[] {
  return rows.filter((r) => r.date >= start && r.date <= end);
}

const TOS_RE = /top of search/i;
const PP_RE = /detail page/i;
const ROS_RE = /other on-amazon|rest of search/i;

export function placementShares(rows: PlacementRow[]): PlacementShare {
  let tos = 0, ros = 0, pp = 0, other = 0;
  for (const r of rows) {
    const spend = n(r.spend);
    const p = String(r.placement ?? "");
    if (TOS_RE.test(p)) tos += spend;
    else if (PP_RE.test(p)) pp += spend;
    else if (ROS_RE.test(p)) ros += spend;
    else other += spend;
  }
  const total = tos + ros + pp + other;
  if (total <= 0) return { tos_spend_share: null, ros_spend_share: null, pp_spend_share: null };
  return {
    tos_spend_share: (tos / total) * 100,
    ros_spend_share: (ros / total) * 100,
    pp_spend_share: (pp / total) * 100,
  };
}

function latestByCampaign(rows: CampaignDailyRow[]): Map<string, CampaignDailyRow> {
  const out = new Map<string, CampaignDailyRow>();
  for (const r of rows) {
    const key = normalizeName(r.campaign_name);
    if (!key) continue;
    const prev = out.get(key);
    if (!prev || r.date > prev.date) out.set(key, r);
  }
  return out;
}

/** Last stored row with a non-blank campaign_status (spend reports omit 0-impr). */
export function lastExplicitStatusRow(
  rows: CampaignDailyRow[],
  name: string,
): CampaignDailyRow | null {
  let best: CampaignDailyRow | null = null;
  for (const r of rowsForName(rows, name)) {
    const status = String(r.campaign_status ?? "").trim();
    if (!status) continue;
    if (!best || r.date > best.date) best = r;
  }
  return best;
}

function rowsForName(rows: CampaignDailyRow[], name: string): CampaignDailyRow[] {
  return rows.filter((r) => namesEqual(r.campaign_name, name));
}

function dailySpendSeries(rows: CampaignDailyRow[], start: string, end: string): number[] {
  const byDate = new Map<string, number>();
  for (const r of inWindow(rows, start, end)) {
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + n(r.spend));
  }
  const out: number[] = [];
  let d = start;
  while (d <= end) {
    out.push(byDate.get(d) ?? 0);
    d = shiftDays(d, 1);
  }
  return out;
}

export function enabledExactKeywords(
  campaignRows: CampaignDailyRow[],
  termRows: SearchTermRow[],
  asOf: string,
  keywordTargets: KeywordTarget[] = [],
): Set<string> {
  const latest = latestByCampaign(campaignRows.filter((r) => r.date <= asOf));
  const enabled = new Set<string>();
  // Account-wide Campaigns API keyword text is the source of truth.
  // lowercase + trim (normalizeTerm) so "Beef Tallow Lip Balm " matches.
  for (const t of keywordTargets) {
    const mt = String(t.match_type ?? "").toLowerCase();
    if (mt && mt !== "exact") continue;
    if (t.state && !isEnabledStatus(t.state)) continue;
    const kw = normalizeTerm(t.keyword_text);
    if (kw) enabled.add(kw);
  }
  for (const name of NEW_EXACT) {
    const row = latest.get(normalizeName(name));
    if (row && !isEnabledStatus(row.campaign_status) && row.campaign_status) continue;
    const kw = extractExactKeyword(name);
    if (kw) enabled.add(kw);
  }
  for (const t of termRows) {
    const mt = String(t.match_type ?? "").toLowerCase();
    if (mt && mt !== "exact") continue;
    const status = latest.get(normalizeName(t.campaign_name));
    if (status?.campaign_status && !isEnabledStatus(status.campaign_status)) continue;
    const kw = normalizeTerm(t.keyword);
    if (kw) enabled.add(kw);
  }
  return enabled;
}

export function tagAutoLooseTerm(
  term: {
    orders: number;
    spend: number;
    sales: number;
    search_term: string;
    campaign_name?: string;
  },
  hasExact: boolean,
): ProposedTag {
  const acos = term.sales > 0 ? (term.spend / term.sales) * 100 : null;
  const be = breakEvenAcosOf(term.campaign_name ?? "");
  if (
    term.orders >= spec.harvest_min_l7_orders
    && acos != null
    && acos <= be
    && !hasExact
  ) {
    return "HARVEST_CANDIDATE";
  }
  if (term.spend >= spec.junk_min_l7_spend && term.orders === 0) {
    return "JUNK_CANDIDATE";
  }
  return "KEEP";
}

/** Newest SUMMARY date per (term, campaign, match) inside the window. */
export function latestSearchTerms(
  rows: SearchTermRow[],
  start: string,
  end: string,
): SearchTermRow[] {
  const best = new Map<string, SearchTermRow>();
  for (const r of inWindow(rows, start, end)) {
    const key = [
      normalizeName(r.campaign_name),
      normalizeTerm(r.search_term),
      String(r.campaign_id ?? ""),
      String(r.ad_group_id ?? ""),
      normalizeName(r.match_type),
    ].join("\t");
    const prev = best.get(key);
    if (!prev || r.date > prev.date) best.set(key, r);
  }
  return [...best.values()];
}

export function harvestQueue(
  termRows: SearchTermRow[],
  campaignRows: CampaignDailyRow[],
  asOf: string,
  extra: KeywordTarget[] | GnoLedgerRow[] | {
    keywordTargets?: KeywordTarget[];
    ledger?: GnoLedgerRow[];
  } = [],
): HarvestTerm[] {
  const { keywordTargets, ledger } = splitHarvestExtra(extra);
  return rollSearchTerms({
    termRows,
    campaignRows,
    start: windowStart(asOf, 7),
    end: asOf,
    label: "L7",
    campaignPredicate: isAutoLoose,
    keywordTargets,
    ledger,
  });
}

function splitHarvestExtra(
  extra: KeywordTarget[] | GnoLedgerRow[] | {
    keywordTargets?: KeywordTarget[];
    ledger?: GnoLedgerRow[];
  },
): { keywordTargets: KeywordTarget[]; ledger: GnoLedgerRow[] } {
  if (Array.isArray(extra)) {
    if (extra.length && extra.every((r) => r && typeof r === "object" && "keyword_text" in r)) {
      return { keywordTargets: extra as KeywordTarget[], ledger: [] };
    }
    return { keywordTargets: [], ledger: extra as GnoLedgerRow[] };
  }
  return {
    keywordTargets: extra.keywordTargets ?? [],
    ledger: extra.ledger ?? [],
  };
}

function organicExportFields(hit: OrganicRankJoin = emptyOrganicRankJoin()) {
  const organic_rank = hit.organic_rank === 0 ? null : hit.organic_rank;
  const aba_sfr = hit.aba_sfr === 0 ? null : hit.aba_sfr;
  const organic_rank_prev = hit.organic_rank_prev === 0 ? null : hit.organic_rank_prev;
  const organic_rank_delta = organic_rank == null || organic_rank_prev == null
    ? null
    : hit.organic_rank_delta;
  return {
    organic_rank,
    organic_rank_prev,
    organic_rank_delta,
    aba_sfr,
    organic_as_of: hit.organic_as_of,
  };
}

function attachOrganicFields<T extends Record<string, unknown>>(
  row: T,
  keyword: string,
  family: string,
  index?: Map<string, OrganicRankJoin[]>,
): T & ReturnType<typeof organicExportFields> {
  const hit = index
    ? lookupOrganicRank(index, keyword, familyHeroAsin(family))
    : emptyOrganicRankJoin();
  return { ...row, ...organicExportFields(hit) };
}

/**
 * ads_search_terms_daily is requested as timeUnit=DAILY (Amazon date =
 * that calendar day). Leftover 7-day SUMMARY stamps (chunk END) remain
 * until Mini ads-search-terms-rebuild. A 7-day SUMMARY is not L2 or L7.
 * Compare that date's ST total to campaign daily (SoT) —
 * ST ≫ campaign daily means multi-day.
 */
export function stDateLooksDaily(stSpend: number, campaignSpend: number): boolean {
  if (campaignSpend <= 0) return true;
  return stSpend <= campaignSpend * ST_DAILY_SPEND_SLACK + ST_DAILY_SPEND_ABS;
}

export function campaignSpendOnDate(
  campaigns: CampaignDailyRow[],
  predicate: (name: string) => boolean,
  date: string,
): number {
  return sumMetrics(campaigns.filter((r) => r.date === date && predicate(r.campaign_name))).spend;
}

export function searchTermSpendOnDate(
  terms: SearchTermRow[],
  predicate: (name: string) => boolean,
  date: string,
): number {
  return sumMetrics(terms.filter((r) => r.date === date && predicate(r.campaign_name))).spend;
}

export function sumHarvestSpend(rows: HarvestTerm[], label?: TermWindowLabel): number {
  return rows
    .filter((r) => (label ? r.label === label : true))
    .reduce((s, r) => s + n(r.spend), 0);
}

function rollSearchTerms(input: {
  termRows: SearchTermRow[];
  campaignRows: CampaignDailyRow[];
  start: string;
  end: string;
  label: TermWindowLabel;
  campaignPredicate: (name: string) => boolean;
  keywordTargets: KeywordTarget[];
  ledger?: GnoLedgerRow[];
  organicIndex?: Map<string, OrganicRankJoin[]>;
}): HarvestTerm[] {
  const { termRows, campaignRows, start, end, label, campaignPredicate, keywordTargets } = input;
  const ledger = input.ledger ?? [];
  const organicIndex = input.organicIndex;
  const enabled = enabledExactKeywords(campaignRows, termRows, end, keywordTargets);
  const scoped = inWindow(termRows, start, end).filter((r) => campaignPredicate(r.campaign_name));
  const dates = [...new Set(scoped.map((r) => r.date))].sort();
  const dailyDates = dates.filter((d) => stDateLooksDaily(
    searchTermSpendOnDate(scoped, campaignPredicate, d),
    campaignSpendOnDate(campaignRows, campaignPredicate, d),
  ));
  const hasSummaryDate = dates.some((d) => !dailyDates.includes(d));

  let source: SearchTermRow[] = [];
  const extraNotes: string[] = [ST_CAMPAIGN_SOT_NOTE];
  // SUMMARY stamped on chunk END is not an L2 or L7 day. Use 1-day stamps only.
  if (!dailyDates.length) {
    return [];
  }
  if (hasSummaryDate) extraNotes.push("SUMMARY search-term stamp omitted; not L2 or L7");
  for (const d of dailyDates) {
    source.push(...latestSearchTerms(scoped, d, d));
  }

  const rolled = new Map<string, SearchTermRow[]>();
  for (const r of source) {
    const key = `${normalizeTerm(r.search_term)}\t${normalizeName(r.match_type)}`;
    const list = rolled.get(key) ?? [];
    list.push(r);
    rolled.set(key, list);
  }
  const out: HarvestTerm[] = [];
  for (const group of rolled.values()) {
    const m = sumMetrics(group);
    const term = group[0].search_term;
    const campaignName = group[0].campaign_name || AUTO_LOOSE_NAME;
    const hasExact = enabled.has(normalizeTerm(term));
    const base = tagAutoLooseTerm(
      {
        orders: m.orders, spend: m.spend, sales: m.sales,
        search_term: term, campaign_name: campaignName,
      },
      hasExact,
    );
    const learned = applyHarvestLearning(
      base as "KEEP" | "HARVEST_CANDIDATE" | "JUNK_CANDIDATE",
      { orders: m.orders, spend: m.spend, search_term: term },
      ledger,
    );
    const frame = contributionFrame(campaignName, m.acos, extraNotes);
    const row = attachOrganicFields({
      date_start: start,
      date_end: end,
      label,
      window_label: label,
      grain: "WINDOW_AGG",
      campaign_id: String(group[0].campaign_id ?? ""),
      campaign_name: campaignName,
      customer_search_term: term,
      query_normalized: queryNormalized(term),
      match_type: group[0].match_type || "",
      impressions: m.impressions,
      clicks: m.clicks,
      spend: m.spend,
      orders: m.orders,
      sales: m.sales,
      acos: m.acos,
      cvr: m.cvr,
      ctr: m.impressions > 0 ? m.clicks / m.impressions : null,
      cpc: m.cpc,
      has_enabled_exact_elsewhere: hasExact,
      proposed_tag: learned.tag,
      learning_note: learned.note,
      metrics_complete: true,
      id_missing: !String(group[0].campaign_id ?? "").trim(),
      ...frame,
    }, term, frame.family, organicIndex);
    out.push(row);
  }
  return out.sort((a, b) => b.spend - a.spend);
}

/** Auto Loose or fat parent search terms for closed-day L2 + L7 (export pack). */
export function searchTermExportRows(
  termRows: SearchTermRow[],
  campaignRows: CampaignDailyRow[],
  closedEnd: string,
  campaignPredicate: (name: string) => boolean,
  keywordTargets: KeywordTarget[] = [],
  ledger: GnoLedgerRow[] = [],
  organicIndex?: Map<string, OrganicRankJoin[]>,
): HarvestTerm[] {
  const windows: Array<{ start: string; end: string; label: TermWindowLabel }> = [
    { start: windowStart(closedEnd, 2), end: closedEnd, label: "L2" },
    { start: windowStart(closedEnd, 7), end: closedEnd, label: "L7" },
  ];
  const out: HarvestTerm[] = [];
  for (const w of windows) {
    out.push(...rollSearchTerms({
      termRows, campaignRows, start: w.start, end: w.end,
      label: w.label, campaignPredicate, keywordTargets, ledger, organicIndex,
    }));
  }
  return out;
}

function alert(
  priority: AlertPriority,
  code: string,
  title: string,
  detail: string,
  extra: Partial<GnoAlert> = {},
): GnoAlert {
  return { priority, code, title, detail, auto_action: false, ...extra };
}

export function evaluateGnoAlerts(input: {
  asOf: string;
  today: string;
  now?: Date;
  campaigns: CampaignDailyRow[];
  searchTerms: SearchTermRow[];
  placements: PlacementRow[];
  negatives?: NegativeRow[] | null;
  negativesAvailable?: boolean;
  bidsKnown?: boolean;
  /** Declared spend window (desk = 14). Absence inside this is never P0. */
  lookbackDays?: number;
  ledger?: GnoLedgerRow[];
  keywordTargets?: KeywordTarget[];
  /** Per-campaign create time from Campaigns API / ads_campaign_meta. */
  campaignMeta?: CampaignMeta[];
}): GnoAlert[] {
  const { asOf, today, campaigns, searchTerms, placements } = input;
  const now = input.now ?? new Date();
  const campaignMeta = input.campaignMeta ?? [];
  const latest = latestByCampaign(campaigns);
  const l7start = windowStart(asOf, 7);
  const trailStart = windowStart(shiftDays(asOf, -1), 7);
  const lookback = spendLookbackDays(campaigns, asOf, input.lookbackDays);
  const alerts: GnoAlert[] = [];

  for (const name of KEEP_ALIVE) {
    // Spend reports omit $0 / zero-impression ENABLED campaigns. A missing
    // as-of row (or a blank status on a later spend day) is not a P0.
    const statusRow = lastExplicitStatusRow(campaigns, name);
    if (!statusRow) {
      const pri = keeperMissingPriority(lookback);
      alerts.push(alert(pri, "KEEPER_MISSING",
        "KEEP-ALIVE not in spend lookback (not a P0)",
        `${name} has no ads_campaigns_daily status row in the ${lookback || "loaded"}-day spend window through ${asOf}. Ads campaign reports omit $0-spend days — this is not a pause or a delete. Confirm in Ads console if needed. Observe only.`,
        { campaign_name: name }));
      continue;
    }
    if (!isEnabledStatus(statusRow.campaign_status)) {
      alerts.push(alert("P0", "KEEPER_NOT_ENABLED", "KEEP-ALIVE state ≠ Enabled",
        `${name} latest status is ${statusRow.campaign_status || "(blank)"} on ${statusRow.date}. Never auto-pause; re-enable only after Dave confirms.`,
        { campaign_name: name }));
    }
  }

  const autoStatus = lastExplicitStatusRow(campaigns, AUTO_LOOSE_NAME);
  const auto = autoStatus ?? latest.get(normalizeName(AUTO_LOOSE_NAME));
  if (auto) {
    if (autoStatus && !isEnabledStatus(autoStatus.campaign_status)) {
      alerts.push(alert("P0", "AUTO_LOOSE_NOT_ENABLED", "Auto Loose state ≠ Enabled",
        `Auto Loose status is ${autoStatus.campaign_status || "(blank)"}. Do not auto-enable.`,
        { campaign_name: AUTO_LOOSE_NAME }));
    }
    if (auto.budget != null && Number(auto.budget) !== AUTO_LOOSE_BUDGET) {
      alerts.push(alert("P0", "AUTO_LOOSE_BUDGET", "Auto Loose budget off $303",
        `Stored daily budget is ${auto.budget}, expected ${AUTO_LOOSE_BUDGET}. Observe only — do not auto-change.`,
        { campaign_name: AUTO_LOOSE_NAME }));
    }
  }

  const fatRows = rowsForName(campaigns, FAT_PARENT_NAME);
  const fatToday = sumMetrics(inWindow(fatRows, asOf, asOf));
  const fatTrail = sumMetrics(inWindow(fatRows, trailStart, shiftDays(asOf, -1)));
  const fatDays = new Set(inWindow(fatRows, trailStart, shiftDays(asOf, -1)).map((r) => r.date)).size;
  const fatAvg = fatDays > 0 ? fatTrail.spend / fatDays : 0;
  if (fatAvg > 0 && fatToday.spend < fatAvg * (spec.fat_parent_spend_floor_pct / 100)) {
    alerts.push(alert("P0", "FAT_PARENT_SPEND_DROP", "Fat parent spend today < 50% of trailing-7 daily average",
      `As-of ${asOf} spend $${fatToday.spend.toFixed(2)} vs T7 avg $${fatAvg.toFixed(2)}. Do not raise budget automatically.`,
      { campaign_name: FAT_PARENT_NAME }));
  }

  for (const name of NEW_EXACT) {
    const rows = rowsForName(campaigns, name);
    const day = inWindow(rows, asOf, asOf);
    const todayRows = inWindow(rows, today, today);
    const checkDays = todayRows.length ? todayRows : day;
    const m = sumMetrics(checkDays.length ? checkDays : day);
    const all = sumMetrics(rows);
    const hours = hoursSinceCampaignLaunch(now, metaForName(campaignMeta, name));
    const kw = extractExactKeyword(name) ?? "";
    const tallowHole = kw.includes("tallow lip balm");
    if (tallowHole && hours >= 24 && all.impressions === 0) {
      const bidNote = input.bidsKnown
        ? "bid not yet bumped"
        : "keyword bid is not in stored tables — confirm in Ads console before any bid change";
      alerts.push(alert("P0", "NEW_EXACT_ZERO_IMPR", "New Exact tallow lip balm still 0 impressions after 24h",
        `${name} has 0 impressions ${hours.toFixed(0)}h after launch (${bidNote}). Do not auto-raise the bid.`,
        { campaign_name: name }));
    }
    if (m.spend > NEW_EXACT_SPEND_ALERT && m.orders === 0) {
      alerts.push(alert("P0", "NEW_EXACT_BURN", "New Exact spend > $15 same day with 0 orders",
        `${name} spent $${m.spend.toFixed(2)} with 0 orders on ${todayRows.length ? today : asOf}. Flag only — do not pause.`,
        { campaign_name: name }));
    }
  }

  if (input.negativesAvailable && input.negatives) {
    for (const neg of input.negatives) {
      if (!isAutoLoose(neg.campaign_name) && !isFatParent(neg.campaign_name)) continue;
      const mt = String(neg.match_type ?? "").toLowerCase();
      if (mt && mt !== "exact") continue;
      const kw = normalizeTerm(neg.keyword);
      if (CORE_NEGATIVES.some((c) => normalizeTerm(c) === kw)) {
        alerts.push(alert("P0", "CORE_NEGATIVE", "Core Exact negative on Auto or fat parent",
          `${neg.keyword} is a Negative Exact on ${neg.campaign_name}. Do not add more cores. Wait for Grok harvest approval before any negate.`,
          { campaign_name: neg.campaign_name, search_term: neg.keyword }));
      }
    }
  }

  const harvest = harvestQueue(searchTerms, campaigns, asOf, {
    ledger: input.ledger,
    keywordTargets: input.keywordTargets,
  });
  for (const name of NEW_EXACT) {
    const m = sumMetrics(inWindow(rowsForName(campaigns, name), l7start, asOf));
    alerts.push(alert("P1", "NEW_EXACT_DIGEST", "NEW EXACT L7",
      `${name}: impr ${m.impressions}, clicks ${m.clicks}, spend $${m.spend.toFixed(2)}, CPC $${m.cpc.toFixed(2)}, orders ${m.orders}, ${formatAcosVsBe(m.acos, name)}`,
      { campaign_name: name }));
  }
  for (const name of KEEP_ALIVE) {
    const rows = rowsForName(campaigns, name);
    const l7 = sumMetrics(inWindow(rows, l7start, asOf));
    const todayM = sumMetrics(inWindow(rows, asOf, asOf));
    const avg = l7.spend / 7;
    alerts.push(alert("P1", "KEEPER_DIGEST", "KEEP-ALIVE spend vs 7-day avg",
      `${name}: as-of spend $${todayM.spend.toFixed(2)} vs L7 daily avg $${avg.toFixed(2)}, L7 ${formatAcosVsBe(l7.acos, name)}`,
      { campaign_name: name }));
  }
  for (const t of harvest.filter((x) => x.proposed_tag === "HARVEST_CANDIDATE")) {
    alerts.push(alert("P1", "HARVEST_CANDIDATE", "Auto Loose harvest candidate (do not negate)",
      `"${t.customer_search_term}" L7 orders ${t.orders}, ${formatAcosVsBe(t.acos, t.campaign_name)}, no enabled 1-child Exact. Tag only.`,
      { campaign_name: t.campaign_name, search_term: t.customer_search_term }));
  }
  for (const t of harvest.filter((x) => x.proposed_tag === "JUNK_CANDIDATE")) {
    alerts.push(alert("P1", "JUNK_CANDIDATE", "Auto Loose junk candidate (do not auto-negate)",
      `"${t.customer_search_term}" L7 spend $${t.spend.toFixed(2)}, 0 orders. Flag only.`,
      { campaign_name: t.campaign_name, search_term: t.customer_search_term }));
  }

  const watchNames = [...KEEP_ALIVE, ...NEW_EXACT, ...DAY5_PAUSE, ...FLAVOR_SHELL];
  for (const name of watchNames) {
    const rows = placements.filter((p) =>
      namesEqual(p.campaign_name, name) || nameContains(p.campaign_name, name));
    const share = placementShares(inWindow(rows, l7start, asOf));
    if (share.pp_spend_share != null && share.pp_spend_share > spec.placement_pp_share_alert_pct) {
      const matched = rows[0]?.campaign_name ?? name;
      alerts.push(alert("P1", "PP_SHARE", "Product Page spend share > 25%",
        `${matched} PP share ${share.pp_spend_share.toFixed(1)}% of L7 placement spend. Observe — do not auto-cut.`,
        { campaign_name: matched }));
    }
  }

  alerts.push(alert("P2", "REVIEW_48H_CADENCE", "Wednesday 6pm PT / 48h pack",
    "Standing cadence: export the GNO pack Wednesday evenings (6:00 PM America/Los_Angeles). Observe only."));

  return alerts;
}

export function metaForName(meta: CampaignMeta[], name: string): CampaignMeta | undefined {
  const key = normalizeName(name);
  if (!key) return undefined;
  return meta.find((m) => normalizeName(m.campaign_name) === key);
}

function splitTileExtra(
  extra: CampaignMeta[] | GnoLedgerRow[] | {
    campaignMeta?: CampaignMeta[];
    ledger?: GnoLedgerRow[];
  },
): { campaignMeta: CampaignMeta[]; ledger: GnoLedgerRow[] } {
  if (Array.isArray(extra)) {
    if (extra.length && extra.every((r) => r && typeof r === "object" && "dave_action" in r)) {
      return { campaignMeta: [], ledger: extra as GnoLedgerRow[] };
    }
    return { campaignMeta: extra as CampaignMeta[], ledger: [] };
  }
  return {
    campaignMeta: extra.campaignMeta ?? [],
    ledger: extra.ledger ?? [],
  };
}

export function newExactTiles(
  campaigns: CampaignDailyRow[],
  asOf: string,
  now: Date = new Date(),
  extra: CampaignMeta[] | GnoLedgerRow[] | {
    campaignMeta?: CampaignMeta[];
    ledger?: GnoLedgerRow[];
  } = [],
): NewExactTile[] {
  const { campaignMeta, ledger } = splitTileExtra(extra);
  const latest = latestByCampaign(campaigns);
  const start = windowStart(asOf, 7);
  return NEW_EXACT.map((name) => {
    const rows = rowsForName(campaigns, name);
    const m = sumMetrics(inWindow(rows, start, asOf));
    const snap = lastExplicitStatusRow(campaigns, name)
      ?? latest.get(normalizeName(name));
    const meta = metaForName(campaignMeta, name);
    const hours = hoursSinceCampaignLaunch(now, meta);
    const budget = snap?.budget != null ? Number(snap.budget)
      : (meta?.daily_budget != null ? Number(meta.daily_budget) : null);
    const frame = contributionFrame(name, m.acos);
    return {
      campaign_name: name,
      keyword: extractExactKeyword(name) ?? "",
      family: frame.family,
      state: snap?.campaign_status || meta?.state || "",
      daily_budget: budget,
      hours_since_launch: hours,
      impressions: m.impressions,
      clicks: m.clicks,
      spend: m.spend,
      orders: m.orders,
      sales: m.sales,
      cpc: m.cpc,
      acos: m.acos,
      break_even_acos: frame.break_even_acos,
      acos_vs_be: frame.acos_vs_be,
      zero_impr_after_24h: hours >= 24 && m.impressions === 0,
      over_shell_budget: budget != null && budget > SHELL_DAILY_BUDGET_CAP,
      last_call: lastCallForCampaign(ledger, name),
    };
  });
}

export function keeperHeartbeats(
  campaigns: CampaignDailyRow[],
  asOf: string,
  campaignMeta: CampaignMeta[] = [],
): KeeperHeartbeat[] {
  const start = windowStart(asOf, 7);
  const latest = latestByCampaign(campaigns);
  const roles = [
    ["auto_loose", AUTO_LOOSE_NAME],
    ["fat_parent", FAT_PARENT_NAME],
    ["hero_chapstick", HERO_CHAPSTICK_NAME],
  ] as const;
  return roles.map(([role, name]) => {
    const rows = rowsForName(campaigns, name);
    const l7 = sumMetrics(inWindow(rows, start, asOf));
    const todayM = sumMetrics(inWindow(rows, asOf, asOf));
    const snap = lastExplicitStatusRow(campaigns, name)
      ?? latest.get(normalizeName(name));
    const meta = metaForName(campaignMeta, name);
    const state = snap?.campaign_status || meta?.state || "";
    const budget = snap?.budget != null ? Number(snap.budget)
      : (meta?.daily_budget != null ? Number(meta.daily_budget) : null);
    const frame = contributionFrame(name, l7.acos);
    return {
      campaign_name: name,
      role,
      family: frame.family,
      state,
      enabled: isEnabledStatus(state),
      daily_budget: budget,
      spend_today: todayM.spend,
      spend_l7: l7.spend,
      spend_l7_avg: l7.spend / 7,
      acos_l7: l7.acos,
      break_even_acos: frame.break_even_acos,
      acos_vs_be: frame.acos_vs_be,
      sparkline: dailySpendSeries(rows, start, asOf),
    };
  });
}

function newExactAliasKey(name: string): string {
  const kw = extractExactKeyword(name);
  return `${extractAsin(name)}\t${kw || normalizeName(name)}`;
}

function uniqueWatchNames(
  campaigns: CampaignDailyRow[],
  extraNames: string[] = [],
): { name: string; list: WatchList }[] {
  const seen = new Set<string>();
  const seenExact = new Set<string>();
  const out: { name: string; list: WatchList }[] = [];
  const add = (name: string, list: WatchList) => {
    const key = normalizeName(name);
    if (!key || seen.has(key)) return;
    if (list === "NEW_EXACT") {
      const alias = newExactAliasKey(name);
      if (seenExact.has(alias)) {
        const idx = out.findIndex((x) =>
          x.list === "NEW_EXACT" && newExactAliasKey(x.name) === alias);
        if (idx >= 0) out[idx] = { name, list };
        seen.add(key);
        return;
      }
      seenExact.add(alias);
    }
    seen.add(key);
    out.push({ name, list });
  };
  for (const n of NEW_EXACT) add(n, "NEW_EXACT");
  for (const n of KEEP_ALIVE) add(n, "KEEPER");
  for (const n of DAY5_PAUSE) add(n, "DAY5_PAUSE");
  for (const n of FLAVOR_SHELL) add(n, "FLAVOR_SHELL");
  for (const r of campaigns) {
    const list = watchListOf(r.campaign_name);
    if (list !== "OTHER") add(r.campaign_name, list);
  }
  for (const name of extraNames) {
    const list = watchListOf(name);
    if (list !== "OTHER") add(name, list);
  }
  return out;
}

export interface PackWindow {
  start: string;
  end: string;
  label: PackWindowLabel;
  metrics_complete: boolean;
}

/**
 * Last closed Amazon day that L2/L7 may include. Never `today`.
 * Always yesterday in the account calendar. A lagging `asOf` must not
 * slide the window backward.
 */
export function packClosedEnd(today: string, _asOf?: string): string {
  return shiftDays(today, -1);
}

/**
 * Yesterday's ads_campaigns_daily is closed when `asOf` reaches yesterday
 * and, if campaign rows were loaded, at least one row is dated yesterday
 * or later. A hole does not move L2/L7; callers flag metrics_complete=false.
 */
export function l2L7MetricsComplete(
  today: string,
  asOf: string,
  campaigns?: { date: string }[],
): boolean {
  const yesterday = packClosedEnd(today);
  if (asOf < yesterday) return false;
  if (!campaigns || campaigns.length === 0) return true;
  let maxDate = "";
  for (const row of campaigns) {
    if (row.date > maxDate) maxDate = row.date;
  }
  return maxDate >= yesterday;
}

/**
 * Pack windows as of Amazon Today.
 * Example 2026-09-07: Today=2026-09-07; L2=2026-09-05..2026-09-06;
 * L7=last 7 closed days ending yesterday (2026-08-31..2026-09-06).
 * If yesterday is not closed, L2/L7 stay on those dates with
 * metrics_complete=false.
 */
export function packWindows(
  today: string,
  asOf: string,
  campaigns?: { date: string }[],
): PackWindow[] {
  const closed = packClosedEnd(today, asOf);
  const complete = l2L7MetricsComplete(today, asOf, campaigns);
  return [
    { start: today, end: today, label: "Today", metrics_complete: false },
    { start: windowStart(closed, 2), end: closed, label: "Last2", metrics_complete: complete },
    { start: windowStart(closed, 7), end: closed, label: "Last7", metrics_complete: complete },
  ];
}

/** Today + L1/L2/L7/L30/L60. All closed windows end yesterday and do not slide. */
export function contractPackWindows(
  today: string,
  asOf: string,
  campaigns?: { date: string }[],
): PackWindow[] {
  const base = packWindows(today, asOf, campaigns);
  const closed = packClosedEnd(today, asOf);
  const complete = base[1]?.metrics_complete ?? false;
  return [
    base[0],
    { start: closed, end: closed, label: "Last1", metrics_complete: complete },
    base[1],
    base[2],
    { start: windowStart(closed, 30), end: closed, label: "Last30", metrics_complete: complete },
    { start: windowStart(closed, 60), end: closed, label: "Last60", metrics_complete: complete },
  ];
}

export function watchCampaignExportRows(input: {
  asOf: string;
  today?: string;
  campaigns: CampaignDailyRow[];
  placements: PlacementRow[];
  campaignMeta?: CampaignMeta[];
  organicIndex?: Map<string, OrganicRankJoin[]>;
  windows?: PackWindow[];
}): WatchCampaignExportRow[] {
  const { campaigns, placements } = input;
  const today = input.today || input.asOf;
  const windows = input.windows ?? packWindows(today, input.asOf, campaigns);
  const latest = latestByCampaign(campaigns);
  const meta = input.campaignMeta ?? [];
  const organicIndex = input.organicIndex;
  const names = uniqueWatchNames(campaigns, meta.map((m) => m.campaign_name));
  const rows: WatchCampaignExportRow[] = [];
  const yesterday = packClosedEnd(today);
  const l60Window = windows.find((w) => windowLabelFromPack(w.label) === "L60");
  const l60Trusted = l60Window
    ? seriesCoversWindow(campaigns.map((c) => c.date), l60Window.start, l60Window.end).covers
    : false;
  for (const w of windows) {
    for (const { name, list } of names) {
      const matched = campaigns.filter((r) =>
        namesEqual(r.campaign_name, name) || (list === "DAY5_PAUSE" && nameContains(r.campaign_name, name)));
      const idBuckets = distinctCampaignBuckets(matched);
      for (const campRows of idBuckets) {
        const storedName = campRows[0]?.campaign_name ?? name;
        const label = windowLabelFromPack(w.label);
        const l60Blank = label === "L60" && !l60Trusted;
        // Today is config-only. Untrusted L60 is blank, not a copy of the shorter window.
        const useMetrics = w.metrics_complete && !l60Blank;
        const m = useMetrics
          ? sumMetrics(inWindow(campRows, w.start, w.end))
          : l60Blank
            ? { impressions: undefined, clicks: undefined, spend: undefined, orders: undefined, sales: undefined, cpc: undefined, acos: null, cvr: null }
            : { impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0, cpc: 0, acos: null, cvr: null };
        const place = useMetrics
          ? placementShares(inWindow(
            placements.filter((p) =>
              namesEqual(p.campaign_name, storedName) || namesEqual(p.campaign_name, name)
              || nameContains(p.campaign_name, name)),
            w.start, w.end,
          ))
          : { tos_spend_share: null, ros_spend_share: null, pp_spend_share: null };
        const snap = latest.get(normalizeName(storedName)) ?? latest.get(normalizeName(name));
        const metaRow = metaForName(meta, storedName) ?? metaForName(meta, name);
        const state = String(snap?.campaign_status || metaRow?.state || "");
        const campaignId = String(campRows.find((r) => r.campaign_id)?.campaign_id
          ?? metaRow?.campaign_id ?? "").trim();
        const budget = snap?.budget != null ? Number(snap.budget)
          : (metaRow?.daily_budget != null ? Number(metaRow.daily_budget) : null);
        const portfolio = String(metaRow?.portfolio_name || "").trim() || "none";
        const placementLag = useMetrics
          && (m.spend ?? 0) > 0
          && place.tos_spend_share == null
          && place.ros_spend_share == null
          && place.pp_spend_share == null;
        const frame = contributionFrame(storedName, m.acos, placementLag ? [PLACEMENT_LAG_NOTE] : []);
        const purpose = campaignPurposeOf(storedName, list);
        const clock = clockFields(
          metaRow?.created_at ?? metaRow?.creationDate,
          metaRow?.snapshot_at,
          today,
          frame.cm_note,
        );
        const isToday = label === "Today";
        const yRow = campRows.find((r) => r.date === yesterday);
        const dby = campRows.find((r) => r.date === shiftDays(yesterday, -1));
        const asins = extractAsin(storedName).split("/").map((a) => a.trim()).filter(Boolean);
        const ranking = purpose === "ranking";
        rows.push(attachOrganicFields({
          date_start: w.start,
          date_end: w.end,
          window_label: label,
          grain: "campaign",
          campaign_id: campaignId,
          campaign_name: storedName,
          asin: extractAsin(storedName),
          advertised_asin: asins.length === 1 ? asins[0] : "",
          child_flavor: childFlavorOf(storedName),
          mixed_asin: asins.length > 1,
          state,
          serving_status: state ? state.toUpperCase() : "",
          meta_sync: Boolean(campaignId) && Boolean(state),
          id_missing: !campaignId,
          portfolio,
          portfolio_id: metaRow?.portfolio_id ?? "",
          portfolio_name: portfolio === "none" ? "" : portfolio,
          daily_budget: budget,
          spend_yesterday: isToday && yRow ? n(yRow.spend) : null,
          spend_dby: isToday && dby ? n(dby.spend) : null,
          budget_util_yesterday: isToday && yRow && budget ? n(yRow.spend) / budget : null,
          budget_capped_yesterday: isToday ? Boolean(yRow && budget && n(yRow.spend) >= budget) : null,
          tos_modifier_pct: metaRow?.tos_modifier_pct ?? null,
          ros_modifier_pct: metaRow?.ros_modifier_pct ?? null,
          pp_modifier_pct: metaRow?.pp_modifier_pct ?? null,
          tos_spend_share: place.tos_spend_share,
          ros_spend_share: place.ros_spend_share,
          pp_spend_share: place.pp_spend_share,
          placement_report_lag: placementLag,
          impressions: m.impressions,
          clicks: m.clicks,
          spend: m.spend,
          cpc: m.cpc,
          orders: m.orders,
          sales: m.sales,
          acos: m.acos,
          ctr: (m.impressions ?? 0) > 0 ? (m.clicks ?? 0) / (m.impressions ?? 1) : null,
          cvr: m.cvr,
          aov: (m.orders ?? 0) > 0 ? (m.sales ?? 0) / (m.orders ?? 1) : null,
          roas: (m.spend ?? 0) > 0 ? (m.sales ?? 0) / (m.spend ?? 1) : null,
          watch_list: list,
          campaign_purpose: purpose,
          ranking_query: ranking ? RANKING_LIP_BALM_QUERY : "",
          ranking_success_metric: ranking ? RANKING_SUCCESS_METRIC : "",
          metrics_complete: useMetrics,
          protected_recent_test: false,
          window_mismatch: false,
          duplicate_reason: "",
          ...frame,
          created_at: clock.created_at,
          last_updated_at: clock.last_updated_at,
          days_live: clock.days_live,
          cm_note: clock.cm_note,
        }, extractExactKeyword(storedName) ?? (ranking ? RANKING_LIP_BALM_QUERY : ""), frame.family, organicIndex));
      }
    }
  }
  return dedupeWatchCampaignRows(rows);
}

function distinctCampaignBuckets(rows: CampaignDailyRow[]): CampaignDailyRow[][] {
  if (!rows.length) return [[]];
  const ids = [...new Set(rows.map((r) => String(r.campaign_id ?? "").trim()).filter(Boolean))];
  if (ids.length < 2) return [rows];
  return ids.map((id) => rows.filter((r) => String(r.campaign_id ?? "").trim() === id));
}

export function csvEscape(
  value: string | number | boolean | null | undefined,
  header?: string,
): string {
  return csvEscapeField(value, header);
}

export function toCsv(headers: readonly string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h] as string | number | boolean | null, h)).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Calendar days from created_at to pack Today. Blank when created_at is missing. */
export function daysLiveAsOf(createdAt: unknown, todayYmd: string): number | null {
  const ms = parseLaunchInstant(createdAt);
  if (ms == null) return null;
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: AMAZON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
  const days = isoDayDelta(todayYmd, ymd);
  if (!Number.isFinite(days) || days < 0) return null;
  return days;
}

function clockFields(
  createdAt: unknown,
  updatedAt: unknown,
  today: string,
  cmNote: string,
): { created_at: string; last_updated_at: string; days_live: number | null; cm_note: string } {
  const createdMs = parseLaunchInstant(createdAt);
  const updatedMs = parseLaunchInstant(updatedAt);
  const days = daysLiveAsOf(createdAt, today);
  const cm_note = createdMs == null
    ? [cmNote, "days_live blank: created_at missing"].filter(Boolean).join("; ")
    : cmNote;
  return {
    created_at: createdMs == null ? "" : new Date(createdMs).toISOString(),
    last_updated_at: updatedMs == null ? "" : new Date(updatedMs).toISOString(),
    days_live: days,
    cm_note,
  };
}

export function watchCampaignsCsv(rows: WatchCampaignExportRow[]): string {
  return toCsv(WATCH_CAMPAIGN_CSV_HEADERS, rows.map((r) => ({ ...r })));
}

export function autoLooseSearchTermsCsv(rows: HarvestTerm[]): string {
  return toCsv(AUTO_LOOSE_TERM_CSV_HEADERS, rows.map((r) => ({
    ...r,
    has_enabled_exact_elsewhere: r.has_enabled_exact_elsewhere,
  })));
}

export function keywordTargetsCsv(rows: KeywordTargetExportRow[]): string {
  return toCsv(KEYWORD_TARGET_CSV_HEADERS, rows.map((r) => ({ ...r })));
}

export function negativesSnapshotCsv(rows: NegativeRow[]): string {
  return toCsv(NEGATIVES_CSV_HEADERS, rows.map((r) => ({
    campaign_id: r.campaign_id ?? "",
    ad_group_id: r.ad_group_id ?? "",
    negative_id: r.negative_id ?? "",
    campaign_name: r.campaign_name,
    keyword: r.keyword,
    query_normalized: queryNormalized(r.keyword),
    match_type: r.match_type ?? "",
    level: r.level ?? "",
    state: r.state ?? "",
    added_at: r.added_at ?? "",
    source: r.source || "unknown",
  })));
}

/**
 * Attribute search-term rows to the keyword that actually served.
 * Never fall back to customer search_term — that copies one rollup onto
 * every match-type sibling (paused Exact `tallow lip balm` vs enabled
 * Exact `tallow lip balms`).
 */
/** Dates whose search-term stamp is a multi-day SUMMARY, not a calendar day. */
export function summarySearchTermDates(
  terms: SearchTermRow[],
  campaigns: CampaignDailyRow[],
  campaignName: string,
  start: string,
  end: string,
): Set<string> {
  const pred = (name: string) => namesEqual(name, campaignName);
  const scoped = inWindow(terms, start, end).filter((r) => pred(r.campaign_name));
  const out = new Set<string>();
  for (const d of new Set(scoped.map((r) => r.date))) {
    if (!stDateLooksDaily(
      searchTermSpendOnDate(scoped, pred, d),
      campaignSpendOnDate(campaigns, pred, d),
    )) out.add(d);
  }
  return out;
}

export function keywordWindowMetrics(
  terms: SearchTermRow[],
  target: Pick<KeywordTarget, "campaign_name" | "keyword_text" | "match_type" | "keyword_id">,
  start: string,
  end: string,
  opts?: { skipDates?: Set<string> },
): Metrics {
  const kw = normalizeTerm(target.keyword_text);
  const mt = normalizeName(target.match_type);
  const kid = String(target.keyword_id ?? "").trim();
  const skip = opts?.skipDates;
  const rows = inWindow(terms, start, end).filter((t) => {
    if (skip?.has(t.date)) return false;
    if (!namesEqual(t.campaign_name, target.campaign_name)) return false;
    const termKid = String(t.keyword_id ?? "").trim();
    if (kid && termKid) return termKid === kid;
    if (normalizeTerm(t.keyword) !== kw) return false;
    const termMt = normalizeName(t.match_type);
    if (mt && termMt && termMt !== mt) return false;
    return true;
  });
  return sumMetrics(rows);
}

function metricFingerprint(m: {
  impressions?: number | null;
  clicks?: number | null;
  spend?: number | null;
  orders?: number | null;
  sales?: number | null;
}): string {
  return [
    m.impressions ?? 0,
    m.clicks ?? 0,
    (m.spend ?? 0).toFixed(2),
    m.orders ?? 0,
    (m.sales ?? 0).toFixed(2),
  ].join("|");
}

function emptyMetrics(): Metrics {
  return { impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0, cpc: 0, acos: null, cvr: null };
}

export function keywordTargetExportRows(input: {
  today: string;
  asOf: string;
  keywordTargets: KeywordTarget[];
  searchTerms: SearchTermRow[];
  campaigns?: CampaignDailyRow[];
  campaignMeta?: CampaignMeta[];
  organicIndex?: Map<string, OrganicRankJoin[]>;
  windows?: PackWindow[];
}): KeywordTargetExportRow[] {
  // Include PAUSED + ENABLED. Today rows are config-only (bid / state).
  const wanted = input.keywordTargets.filter((t) => {
    const list = watchListOf(t.campaign_name);
    return list === "NEW_EXACT" || list === "KEEPER" || list === "FLAVOR_SHELL";
  });
  const campaigns = input.campaigns ?? [];
  const meta = input.campaignMeta ?? [];
  const rows: KeywordTargetExportRow[] = [];
  const windows = input.windows ?? packWindows(input.today, input.asOf, campaigns);
  const l60Window = windows.find((w) => windowLabelFromPack(w.label) === "L60");
  const l60Trusted = l60Window
    ? seriesCoversWindow(input.searchTerms.map((t) => t.date), l60Window.start, l60Window.end).covers
    : false;
  for (const w of windows) {
    const windowRows: KeywordTargetExportRow[] = [];
    const summaryByCampaign = new Map<string, Set<string>>();
    for (const t of wanted) {
      const campKey = normalizeName(t.campaign_name);
      let skip = summaryByCampaign.get(campKey);
      if (!skip) {
        skip = w.metrics_complete
          ? summarySearchTermDates(input.searchTerms, campaigns, t.campaign_name, w.start, w.end)
          : new Set<string>();
        summaryByCampaign.set(campKey, skip);
      }
      const label = windowLabelFromPack(w.label);
      const l60Blank = label === "L60" && !l60Trusted;
      const useMetrics = w.metrics_complete && !l60Blank;
      const m = useMetrics
        ? keywordWindowMetrics(input.searchTerms, t, w.start, w.end, { skipDates: skip })
        : emptyMetrics();
      const frame = contributionFrame(t.campaign_name, useMetrics ? m.acos : null);
      const purpose = campaignPurposeOf(t.campaign_name, watchListOf(t.campaign_name));
      const metaRow = meta.find((row) => String(row.campaign_id ?? "") === String(t.campaign_id ?? "") && String(t.campaign_id ?? ""))
        ?? metaForName(meta, t.campaign_name);
      const clock = clockFields(t.created_at ?? metaRow?.created_at ?? metaRow?.creationDate, metaRow?.snapshot_at, input.today, frame.cm_note);
      const isToday = label === "Today";
      windowRows.push(attachOrganicFields({
        date_start: w.start,
        date_end: w.end,
        window_label: label,
        grain: "target",
        campaign_id: String(t.campaign_id ?? ""),
        ad_group_id: String(t.ad_group_id ?? ""),
        keyword_id: String(t.keyword_id ?? ""),
        query_normalized: queryNormalized(t.keyword_text),
        campaign_name: t.campaign_name,
        asin: extractAsin(t.campaign_name),
        keyword_text: t.keyword_text,
        match_type: t.match_type || "",
        keyword_state: t.state || "",
        bid: t.bid ?? null,
        campaign_purpose: purpose,
        window_mismatch: false,
        id_missing: !String(t.keyword_id ?? t.campaign_id ?? "").trim(),
        protected_recent_test: false,
        bleeders10_flag: isToday ? false : null,
        bleeders20_flag: isToday ? false : null,
        lifetime_zero_flag: isToday ? false : null,
        impressions: l60Blank ? undefined : m.impressions,
        clicks: l60Blank ? undefined : m.clicks,
        spend: l60Blank ? undefined : m.spend,
        orders: l60Blank ? undefined : m.orders,
        sales: l60Blank ? undefined : m.sales,
        acos: l60Blank ? null : m.acos,
        metrics_complete: useMetrics,
        ...frame,
        created_at: clock.created_at,
        days_live: clock.days_live,
        cm_note: clock.cm_note,
      }, t.keyword_text, frame.family, input.organicIndex));
    }
    if (w.metrics_complete && !(windowLabelFromPack(w.label) === "L60" && !l60Trusted)) {
      const byCamp = new Map<string, KeywordTargetExportRow[]>();
      for (const r of windowRows) {
        const key = normalizeName(r.campaign_name);
        const list = byCamp.get(key) ?? [];
        list.push(r);
        byCamp.set(key, list);
      }
      for (const group of byCamp.values()) {
        const counts = new Map<string, number>();
        for (const r of group) {
          if ((r.spend ?? 0) <= 0 && (r.impressions ?? 0) <= 0) continue;
          const fp = metricFingerprint(r);
          counts.set(fp, (counts.get(fp) ?? 0) + 1);
        }
        for (const r of group) {
          if ((r.spend ?? 0) <= 0 && (r.impressions ?? 0) <= 0) continue;
          const fp = metricFingerprint(r);
          if ((counts.get(fp) ?? 0) < 2) continue;
          const keep = isEnabledStatus(r.keyword_state);
          if (keep && group.filter((x) =>
            metricFingerprint(x) === fp && isEnabledStatus(x.keyword_state)).length === 1) {
            continue;
          }
          r.impressions = 0;
          r.clicks = 0;
          r.spend = 0;
          r.orders = 0;
          r.sales = 0;
          r.acos = null;
          Object.assign(r, contributionFrame(r.campaign_name, null, [KEYWORD_ST_NOTE]));
        }
      }
    }
    rows.push(...windowRows);
  }
  return rows;
}

export function advertisedProductL7Rows(input: {
  today: string;
  asOf: string;
  campaigns: CampaignDailyRow[];
  campaignMeta?: CampaignMeta[];
  asinCatalog?: AsinCatalogRow[];
}): AdvertisedProductL7Row[] {
  const closed = packClosedEnd(input.today, input.asOf);
  const complete = l2L7MetricsComplete(input.today, input.asOf, input.campaigns);
  const start = windowStart(closed, 7);
  const catalog = new Map<string, AsinCatalogRow>();
  for (const row of input.asinCatalog ?? []) {
    const asin = String(row.asin ?? "").trim().toUpperCase();
    if (asin) catalog.set(asin, row);
  }
  const names = uniqueWatchNames(
    input.campaigns,
    (input.campaignMeta ?? []).map((m) => m.campaign_name),
  );
  const out: AdvertisedProductL7Row[] = [];
  for (const { name, list } of names) {
    if (list === "DAY5_PAUSE") continue;
    const campRows = input.campaigns.filter((r) => namesEqual(r.campaign_name, name));
    const storedName = campRows[0]?.campaign_name ?? name;
    const asins = extractAsin(storedName).split("/").map((a) => a.trim()).filter(Boolean);
    if (!asins.length) continue;
    const m = complete
      ? sumMetrics(inWindow(campRows, start, closed))
      : { impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0, cpc: 0, acos: null, cvr: null };
    const mixed = asins.length > 1;
    const frame = contributionFrame(storedName, m.acos, [
      ADVERTISED_PRODUCT_NOTE,
      ...(complete ? [] : ["yesterday ads_campaigns_daily not closed; L7 window not slid"]),
    ]);
    for (const asin of asins) {
      const cat = catalog.get(asin.toUpperCase());
      const cogs = cat?.cogs_per_unit != null && Number(cat.cogs_per_unit) > 0
        ? Number(cat.cogs_per_unit) : null;
      const hero = familyHeroAsin(frame.family);
      out.push({
        date_start: start,
        date_end: closed,
        asin,
        campaign_name: storedName,
        watch_list: list,
        spend: m.spend,
        orders: m.orders,
        sales: m.sales,
        acos: m.acos,
        sku: String(cat?.sku ?? ""),
        product_name: String(cat?.product_name ?? ""),
        mixed_asin: mixed,
        attribution: "campaign_name_parse",
        do_not_sum: mixed,
        child_flavor: childFlavorOf(storedName),
        hero_child: Boolean(hero && asin.toUpperCase() === hero.toUpperCase()),
        sku_cogs: cogs,
        cm_per_unit: null,
        profit_verified: false,
        ...frame,
      });
    }
  }
  return out.sort((a, b) => b.spend - a.spend || a.campaign_name.localeCompare(b.campaign_name) || a.asin.localeCompare(b.asin));
}

export function advertisedProductL7Csv(rows: AdvertisedProductL7Row[]): string {
  return toCsv(ADVERTISED_PRODUCT_L7_CSV_HEADERS, rows.map((r) => ({ ...r })));
}

export interface SqpWeekRef {
  weekStart: string;
  weekEnd: string;
}

export interface SqpSlicePlan {
  packDate: string;
  /** Newest stored week_end, including an in-progress week that must not ship. */
  lastStoredWeekEnd: string | null;
  /** Newest complete Sun–Sat week_end, if any. */
  lastCompleteWeekEnd: string | null;
  current: SqpWeekRef | null;
  /** Next-older complete week. Never written into sqp_weekly_slice.csv. */
  comparison: SqpWeekRef | null;
  /** True when the slice must not ship as current. */
  stale: boolean;
  staleReason: string | null;
  note: string;
}

function utcWeekday(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const t = Date.parse(`${iso}T12:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t).getUTCDay();
}

function isoDayDelta(later: string, earlier: string): number {
  const a = Date.parse(`${earlier}T12:00:00Z`);
  const b = Date.parse(`${later}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Complete Brand Analytics SQP week: Sunday–Saturday, and the Saturday
 * has already closed before pack_date. The in-progress week is not complete.
 */
export function isCompleteSqpWeek(weekStart: string, weekEnd: string, packDate: string): boolean {
  const start = String(weekStart ?? "");
  const end = String(weekEnd ?? "");
  if (!start || !end || !packDate) return false;
  if (utcWeekday(start) !== 0 || utcWeekday(end) !== 6) return false;
  if (shiftDays(start, 6) !== end) return false;
  return end < packDate;
}

/** Pack CSV source. Blank stays blank — shares and source are never invented. */
export function sqpPackSource(source: string | null | undefined): string {
  const s = String(source ?? "").trim().toLowerCase();
  if (s === "sqp_spapi") return "sqp_spapi";
  if (s === "sqp_csv" || s === "sqp_brand_csv") return "sqp_csv";
  return "";
}

function completeSqpWeeks(rows: SqpSliceRow[], packDate: string): SqpWeekRef[] {
  const byEnd = new Map<string, SqpWeekRef>();
  for (const row of rows) {
    const weekStart = String(row.week_start ?? "");
    const weekEnd = String(row.week_end ?? "");
    if (!isCompleteSqpWeek(weekStart, weekEnd, packDate)) continue;
    if (!byEnd.has(weekEnd)) byEnd.set(weekEnd, { weekStart, weekEnd });
  }
  return [...byEnd.values()].sort((a, b) => b.weekEnd.localeCompare(a.weekEnd));
}

/**
 * Current slice = newest stored complete Sun–Sat week as of packDate.
 * A bid-raise or other older week is comparison only. An in-progress
 * week is never current. Age > 10 days fails the slice (SQP_STALE).
 */
export function selectSqpSliceWeek(rows: SqpSliceRow[], packDate: string): SqpSlicePlan {
  const storedEnds = rows
    .map((r) => String(r.week_end ?? ""))
    .filter((end) => /^\d{4}-\d{2}-\d{2}$/.test(end))
    .sort();
  const lastStoredWeekEnd = storedEnds.length ? storedEnds[storedEnds.length - 1] : null;
  const complete = completeSqpWeeks(rows, packDate);
  const newest = complete[0] ?? null;
  const prior = complete[1] ?? null;
  const empty: SqpSlicePlan = {
    packDate,
    lastStoredWeekEnd,
    lastCompleteWeekEnd: newest?.weekEnd ?? null,
    current: null,
    comparison: null,
    stale: false,
    staleReason: null,
    note: "",
  };
  if (!rows.length) {
    return { ...empty, note: "No stored SQP rows. Do not invent a slice." };
  }
  if (!newest) {
    return {
      ...empty,
      stale: true,
      staleReason: "no_complete_sun_sat_week",
      note: `SQP_STALE reason=no_complete_sun_sat_week last_week_end=${lastStoredWeekEnd ?? ""}`,
    };
  }
  const age = isoDayDelta(packDate, newest.weekEnd);
  if (age > SQP_STALE_AFTER_DAYS) {
    return {
      ...empty,
      lastCompleteWeekEnd: newest.weekEnd,
      stale: true,
      staleReason: "newest_complete_week_older_than_10_days",
      note: `SQP_STALE reason=newest_complete_week_older_than_10_days last_week_end=${newest.weekEnd}`,
    };
  }
  return {
    packDate,
    lastStoredWeekEnd,
    lastCompleteWeekEnd: newest.weekEnd,
    current: newest,
    comparison: prior,
    stale: false,
    staleReason: null,
    note: (
      `CURRENT SQP week ${newest.weekStart}–${newest.weekEnd} `
      + `(newest stored complete week_end). stale_pre_raise=false.`
    ),
  };
}

function sqpRowsForWeek(rows: SqpSliceRow[], weekEnd: string, stale: boolean): SqpSliceRow[] {
  const wanted = new Set<string>(SQP_SLICE_QUERIES);
  return rows
    .filter((r) => {
      const q = normalizeTerm(r.query_normalized || r.search_query);
      return wanted.has(q) && String(r.week_end ?? "") === weekEnd;
    })
    .map((r) => ({
      ...r,
      source: sqpPackSource(r.source),
      impression_share: r.impression_share ?? null,
      click_share: r.click_share ?? null,
      purchase_share: r.purchase_share ?? null,
      stale_pre_raise: stale,
      week_type: stale ? "comparison" : "current",
      advertised_asin: r.asin ?? "",
      hero_asin: "",
      child_flavor: "",
    }))
    .sort((a, b) => {
      const qa = normalizeTerm(a.query_normalized || a.search_query);
      const qb = normalizeTerm(b.query_normalized || b.search_query);
      if (qa !== qb) return qa.localeCompare(qb);
      return String(a.asin ?? "").localeCompare(String(b.asin ?? ""));
    });
}

function withSqpLag(rows: SqpSliceRow[], packDate: string): SqpSliceRow[] {
  return rows.map((r) => ({
    ...r,
    sqp_lag_days: isoDayDelta(packDate, String(r.week_end ?? "")),
  }));
}

/** Current file only: newest complete week, stale_pre_raise=false. */
export function sqpWeeklySliceRows(rows: SqpSliceRow[], packDate: string): SqpSliceRow[] {
  const plan = selectSqpSliceWeek(rows, packDate);
  if (!plan.current || plan.stale) return [];
  return withSqpLag(sqpRowsForWeek(rows, plan.current.weekEnd, false), packDate);
}

/** Separately labeled COMPARISON / PRE_RAISE week. Not current. */
export function sqpComparisonSliceRows(rows: SqpSliceRow[], packDate: string): SqpSliceRow[] {
  const plan = selectSqpSliceWeek(rows, packDate);
  if (!plan.comparison || plan.stale || !plan.current) return [];
  if (plan.comparison.weekEnd === plan.current.weekEnd) return [];
  return withSqpLag(sqpRowsForWeek(rows, plan.comparison.weekEnd, true), packDate);
}

export function sqpWeeklySliceCsv(rows: SqpSliceRow[]): string {
  return toCsv(SQP_SLICE_CSV_HEADERS, rows.map((r) => ({
    week_start: r.week_start ?? "",
    week_end: r.week_end ?? "",
    asin: r.asin ?? "",
    search_query: r.search_query ?? "",
    query_normalized: r.query_normalized ?? "",
    search_query_volume: r.search_query_volume ?? null,
    impression_share: r.impression_share ?? null,
    click_share: r.click_share ?? null,
    purchase_share: r.purchase_share ?? null,
    asin_impressions: r.asin_impressions ?? null,
    asin_clicks: r.asin_clicks ?? null,
    asin_purchases: r.asin_purchases ?? null,
    source: r.source ?? "",
    stale_pre_raise: r.stale_pre_raise === true,
    week_type: r.week_type ?? (r.stale_pre_raise ? "comparison" : "current"),
    advertised_asin: r.advertised_asin ?? r.asin ?? "",
    hero_asin: r.hero_asin ?? "",
    child_flavor: r.child_flavor ?? "",
    sqp_lag_days: r.sqp_lag_days ?? null,
  })));
}

export function organicRankSnapshotCsv(rows: ReturnType<typeof organicRankSnapshotRows>): string {
  return toCsv(ORGANIC_RANK_SNAPSHOT_CSV_HEADERS, rows.map((r) => ({ ...r })));
}

export function gnoPackReadme(input: {
  files: string[];
  sqpIncluded: boolean;
  sqpNote?: string;
  sqpStale?: boolean;
  sqpStaleReason?: string | null;
  sqpLastWeekEnd?: string | null;
  sqpWeek?: SqpWeekRef | null;
  sqpComparison?: SqpWeekRef | null;
  organicIncluded: boolean;
  competitorIncluded?: boolean;
}): string {
  const sqpLine = input.sqpStale
    ? `- sqp_weekly_slice.csv — OMITTED. SQP_STALE reason=${input.sqpStaleReason ?? "stale"} last_week_end=${input.sqpLastWeekEnd ?? ""}. Do not fall back to a bid-raise week and call it current. Shares are never invented.`
    : input.sqpIncluded && input.sqpWeek
      ? `- sqp_weekly_slice.csv — CURRENT newest stored complete Sun–Sat week ${input.sqpWeek.weekStart}–${input.sqpWeek.weekEnd} for ${SQP_SLICE_QUERIES.join(" / ")}. stale_pre_raise=false. source is sqp_spapi or sqp_csv. Shares are reported, never invented.`
      : input.sqpWeek
        ? `- sqp_weekly_slice.csv — OMITTED. Newest complete week ${input.sqpWeek.weekStart}–${input.sqpWeek.weekEnd} has no stored rows for the slice queries. Do not substitute an older week. Shares are never invented.`
        : "- sqp_weekly_slice.csv — OMITTED. No stored complete Sun–Sat SQP week. Do not invent SQP rows.";
  const sqpComparisonLine = input.sqpComparison
    ? `- ${SQP_COMPARISON_FILENAME} — COMPARISON / PRE_RAISE week ${input.sqpComparison.weekStart}–${input.sqpComparison.weekEnd}. stale_pre_raise=true. Not the current slice.`
    : "";
  const sqpStatus = input.sqpNote ? `SQP week: ${input.sqpNote}` : "";
  const organicLine = input.organicIncluded
    ? "- organic_rank_snapshot.csv — hero ASINs B0CLHTF8YN (lip) / B0DQFKMJFY (balm) / B0HBSZ71XQ (deo). Rank from soldscope_rank_snapshots. aba_sfr is Brand Analytics SFR only."
    : "- organic_rank_snapshot.csv — headers only. No SoldScope Rank Tracker snapshots for the three heroes. Empty is real — this desk never creates RT groups.";
  const competitorLine = input.competitorIncluded
    ? "- competitor_kr_outliers.csv — net-new unused Exact only (already_bidding=N). Competitor-on-SERP required (organic_asin or sponsored_asin == competitor_asin); rank>0 alone is not presence. Family-fit allow/deny; soft-watch never auto harvest_exact. Real-traffic only (search volume ≥ min_search_volume). Cap 5/family, 15 total. suggested_lever is recommend-only (harvest_exact / watch / skip). Never writes Amazon Ads."
    : "- competitor_kr_outliers.csv — headers only. No net-new unused Exact outliers this week. Competitor-on-SERP + family-fit; real-traffic only; weekly job uses cached snapshots unless missing/stale. Do not POST more KR creates. Empty is real.";
  return [
    "GNO Export pack — observe only. Never writes to Amazon.",
    "",
    "Windows:",
    "- Today = config only (metrics_complete=false). $0 is not a pause and is not missing data.",
    "- L2 / L7 = closed Amazon days ending yesterday. If yesterday's ads_campaigns_daily is not closed, metrics_complete=false. The window does not slide back.",
    "",
    "Spend source of truth:",
    "- watch_campaigns.csv campaign-level L2/L7 is SoT for spend (ads_campaigns_daily).",
    "- auto_loose / fat_parent / broad_m search-term files are WINDOW_AGG term-level negate/harvest only (NOT_SOT). Do not sum ST $ or keyword $ and call it campaign spend.",
    "- ads_search_terms_daily is requested as timeUnit=DAILY (Amazon date = that calendar day). Until Mini ads-search-terms-rebuild --days 90, some dates may still be old 7-day SUMMARY stamps on chunk END. A 7-day SUMMARY is not L2 or L7.",
    "- Auto Loose L2 ST rows are omitted unless 1-day ST stamps exist for that window. Do not sum ST $ vs the campaign tile.",
    "",
    "Family BE (config family_break_even_acos, not TACOS):",
    "- lip_3pk (lip campaigns, fat parent, GG Lip Broad M, lip Exact) = 42",
    "- deo = 36",
    "- balm (body tallow balm, not lip) = 36",
    "",
    "Organic rank (SoldScope Rank Tracker — observe only):",
    "- Columns organic_rank / organic_rank_prev / organic_rank_delta / aba_sfr / organic_as_of join by normalized keyword/phrase.",
    "- aba_sfr is Brand Analytics SFR (`aba_search_frequency_rank`) only. Never from SoldScope searchVolume. Blank = not stored.",
    `- ${ORGANIC_RANK_EMPTY_CELL_NOTE}`,
    "- This desk never creates SoldScope Rank Tracker groups.",
    "- organic_groups / phrases / snapshot_rows: snapshot_rows can exceed phrases when one phrase is stored on more than one ASIN.",
    "- Action (Blake): strong organic (low #) + high paid spend → harvest / negate / bid restraint.",
    "- Action (Blake): weak or missing organic + converting ST → Exact protect.",
    "",
    "Files:",
    "- watch_campaigns.csv — NEW_EXACT + KEEPER + DAY5_PAUSE + FLAVOR_SHELL (incl. TBM B0CLF5B27Y Exact shells)",
    "- auto_loose_search_terms.csv",
    "- fat_parent_search_terms.csv",
    "- broad_m_search_terms.csv — campaign exactly GG - Lip Balm - Broad M",
    "- keyword_targets.csv — bid/state per keyword_id; Today config-only; L2/L7 attributed to the serving keyword (not copied across match types)",
    "- advertised_product_l7.csv — L7 by ASIN from campaign names. No advertised-product report is synced; mixed-ASIN spend is campaign-level (not split).",
    sqpLine,
    ...(sqpComparisonLine ? [sqpComparisonLine] : []),
    organicLine,
    competitorLine,
    "- negatives_snapshot.csv — optional",
    "- gno_decision_rules.txt — curated GNO review rules (family CM BE is SoT; 37% is a scenario)",
    "- gno_outcomes.csv — harvest-desk ledger (hold / bid_down / bid_up / skip / approve_harvest_neg). Headers only when empty.",
    "- README.txt — this file",
    "",
    `Pack files: ${input.files.join(", ")}`,
    "",
    sqpStatus,
    "Placement shares on L2/L7 come from ads_placement_daily. If spend exists but shares are empty, cm_note says placement report lag.",
    "FLAVOR_SHELL = Orange / Assorted / Peppermint / Unscented 1-keyword Exact campaigns discovered from ads_campaign_meta (not invented).",
    "",
  ].filter((line, i, arr) => line !== "" || arr[i - 1] !== "").join("\n");
}

/** `gno-pack-YYYY-MM-DD_HHMM` in America/Los_Angeles. */
export function gnoPackStamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AMAZON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const g = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}_${g("hour")}${g("minute")}`;
}

function blankZeroRank<T extends { organic_rank?: number | null; aba_sfr?: number | null }>(row: T): T {
  return {
    ...row,
    organic_rank: row.organic_rank === 0 ? null : row.organic_rank ?? null,
    aba_sfr: row.aba_sfr === 0 ? null : row.aba_sfr ?? null,
  };
}

function placementCode(placement: string): "TOS" | "ROS" | "PP" | "" {
  if (TOS_RE.test(placement)) return "TOS";
  if (PP_RE.test(placement)) return "PP";
  if (ROS_RE.test(placement)) return "ROS";
  return "";
}

function tagContractTerms(rows: HarvestTerm[], negatives: NegativeRow[]): HarvestTerm[] {
  const neg = new Set(negatives.map((n) => `${normalizeName(n.campaign_name)}\t${queryNormalized(n.keyword)}`));
  return rows.map((r) => {
    const scored = contractSearchTermTag({
      clicks: r.clicks,
      orders: r.orders,
      search_term: r.customer_search_term,
      has_enabled_exact_elsewhere: r.has_enabled_exact_elsewhere,
      already_negative: neg.has(`${normalizeName(r.campaign_name)}\t${queryNormalized(r.customer_search_term)}`),
      destination_exists: false,
      destination_has_impressions: false,
    });
    return {
      ...r,
      proposed_tag: scored.proposed_tag,
      proposed_tag_reason: scored.proposed_tag_reason,
      harvest_ready: scored.harvest_ready,
      relevance: scored.relevance,
      already_negative: neg.has(`${normalizeName(r.campaign_name)}\t${queryNormalized(r.customer_search_term)}`),
      query_normalized: queryNormalized(r.customer_search_term),
    };
  });
}

function campWindowKey(name: string, start: string, end: string): string {
  return `${normalizeName(name)}\t${start}\t${end}`;
}

function flagSpendMismatches(
  watch: WatchCampaignExportRow[],
  keywords: KeywordTargetExportRow[],
  terms: HarvestTerm[],
): { disagrees: boolean; window_mismatch: boolean }[] {
  const tile = new Map<string, number>();
  for (const row of watch) {
    if (!row.metrics_complete) continue;
    tile.set(campWindowKey(row.campaign_name, row.date_start, row.date_end), n(row.spend));
  }
  const sums = new Map<string, number>();
  const add = (name: string, start: string, end: string, spend: number | null | undefined, complete: boolean) => {
    if (!complete) return;
    const key = campWindowKey(name, start, end);
    sums.set(key, (sums.get(key) ?? 0) + n(spend));
  };
  for (const row of keywords) add(row.campaign_name, row.date_start, row.date_end, row.spend, row.metrics_complete);
  for (const row of terms) {
    if (!row.date_start || !row.date_end) continue;
    add(row.campaign_name, row.date_start, row.date_end, row.spend, row.metrics_complete !== false);
  }
  const flagged = new Set<string>();
  const checks: { disagrees: boolean; window_mismatch: boolean }[] = [];
  for (const [key, sum] of sums) {
    const camp = tile.get(key);
    if (camp == null) continue;
    const disagrees = spendsDisagree(sum, camp);
    if (!disagrees) continue;
    flagged.add(key);
    checks.push({ disagrees: true, window_mismatch: true });
  }
  for (const row of keywords) {
    const key = campWindowKey(row.campaign_name, row.date_start, row.date_end);
    if (flagged.has(key)) row.window_mismatch = true;
  }
  for (const row of watch) {
    const key = campWindowKey(row.campaign_name, row.date_start, row.date_end);
    if (flagged.has(key)) row.window_mismatch = true;
  }
  return checks;
}

export function buildGnoPack(input: {
  asOf: string;
  today?: string;
  now?: Date;
  campaigns: CampaignDailyRow[];
  searchTerms: SearchTermRow[];
  placements: PlacementRow[];
  campaignMeta?: CampaignMeta[];
  keywordTargets?: KeywordTarget[];
  negatives?: NegativeRow[] | null;
  ledger?: GnoLedgerRow[];
  sqpWeekly?: SqpSliceRow[] | null;
  asinCatalog?: AsinCatalogRow[];
  organicSnapshots?: RankSnapshot[] | null;
  competitorOutliers?: CompetitorOutlierRow[] | null;
  priorPack?: { id?: string; counts?: { auto_loose?: number; broad_m?: number; watch?: number; sqp?: number } } | null;
  addsThisWeekAlready?: number | null;
}): { files: { name: string; body: string }[]; filename: string; quality_gates: QualityLevel } {
  const today = input.today || input.asOf;
  const asOf = input.asOf;
  const closed = packClosedEnd(today, asOf);
  const windows = contractPackWindows(today, asOf, input.campaigns);
  const metricsOpen = !l2L7MetricsComplete(today, asOf, input.campaigns);
  const targets = input.keywordTargets ?? [];
  const ledger = ledgerWithinDays(input.ledger ?? [], today, 30);
  const negatives = input.negatives ?? [];
  const organicIndex = buildOrganicRankJoinIndex(input.organicSnapshots ?? []);
  const organicRows = organicRankSnapshotRows(input.organicSnapshots ?? []).map(blankZeroRank);
  const watch = watchCampaignExportRows({
    asOf, today, campaigns: input.campaigns, placements: input.placements,
    campaignMeta: input.campaignMeta, organicIndex, windows,
  });
  const stampComplete = <T extends HarvestTerm>(rows: T[]): T[] => rows.map((r) => ({
    ...r,
    metrics_complete: metricsOpen ? false : r.metrics_complete !== false,
  }));
  const autoTerms = tagContractTerms(stampComplete(searchTermExportRows(
    input.searchTerms, input.campaigns, closed, isAutoLoose, targets, input.ledger ?? [], organicIndex,
  )), negatives);
  const fatTerms = tagContractTerms(stampComplete(searchTermExportRows(
    input.searchTerms, input.campaigns, closed, isFatParent, targets, input.ledger ?? [], organicIndex,
  )), negatives);
  const broadTerms = tagContractTerms(stampComplete(searchTermExportRows(
    input.searchTerms, input.campaigns, closed, isBroadM, targets, input.ledger ?? [], organicIndex,
  )), negatives);
  const keywords = keywordTargetExportRows({
    today, asOf, keywordTargets: targets, searchTerms: input.searchTerms,
    campaigns: input.campaigns, campaignMeta: input.campaignMeta, organicIndex, windows,
  });
  const advertised = advertisedProductL7Rows({
    today, asOf, campaigns: input.campaigns,
    campaignMeta: input.campaignMeta, asinCatalog: input.asinCatalog,
  });
  const mismatchChecks = flagSpendMismatches(watch, keywords, [...autoTerms, ...fatTerms, ...broadTerms]);

  const sqpRowsIn = input.sqpWeekly ?? [];
  const sqpPlan = selectSqpSliceWeek(sqpRowsIn, today);
  const sqp = sqpWeeklySliceRows(sqpRowsIn, today);
  const sqpComparison = sqpComparisonSliceRows(sqpRowsIn, today);
  const l30 = windowStart(closed, 30);
  const l60 = windowStart(closed, 60);
  const l7 = windowStart(closed, 7);
  const complete = !metricsOpen;
  const stCoverage = seriesCoversWindow(input.searchTerms.map((t) => t.date), l60, closed);
  const bleederTrusted = complete && stCoverage.covers;

  const bleeders10: Record<string, unknown>[] = [];
  const bleeders20: Record<string, unknown>[] = [];
  const seenBleeder = new Set<string>();
  for (const t of targets) {
    const list = watchListOf(t.campaign_name);
    if (list === "OTHER" && !isRankingCampaign(t.campaign_name)) continue;
    const skip = summarySearchTermDates(input.searchTerms, input.campaigns, t.campaign_name, l60, closed);
    const m60 = complete
      ? keywordWindowMetrics(input.searchTerms, t, l60, closed, { skipDates: skip })
      : emptyMetrics();
    const m30 = complete
      ? keywordWindowMetrics(input.searchTerms, t, l30, closed, { skipDates: skip })
      : emptyMetrics();
    const frame = contributionFrame(t.campaign_name, m30.acos);
    const purpose = campaignPurposeOf(t.campaign_name, list === "OTHER" ? "FLAVOR_SHELL" : list);
    const relevance = termRelevance(t.keyword_text);
    const key = `${t.campaign_id ?? t.campaign_name}\t${queryNormalized(t.keyword_text)}`;
    if (bleederTrusted && m60.clicks >= BLEEDERS10_MIN_CLICKS && m60.orders === 0 && !seenBleeder.has(`10:${key}`)) {
      seenBleeder.add(`10:${key}`);
      const watchTag = (relevance === "hero" || relevance === "family") && m60.clicks <= 12;
      bleeders10.push({
        source_type: "target",
        date_start: l60, date_end: closed, window_label: "L60",
        metrics_complete: true, window_untrusted: false,
        campaign_id: t.campaign_id ?? "", campaign_name: t.campaign_name,
        keyword_id: t.keyword_id ?? "", target_id: t.keyword_id ?? "",
        search_term: "", query_normalized: queryNormalized(t.keyword_text),
        clicks_60: m60.clicks, spend_60: m60.spend, orders_60: m60.orders,
        relevance, state: t.state ?? "", protected_recent_test: false,
        conquesting: relevance === "brand_conquest", last_click_date: "",
        proposed_tag: watchTag ? "WATCH" : "SKIP",
        proposed_tag_reason: watchTag
          ? "highly relevant, 10–12 clicks; stay WATCH. Never auto-pause."
          : "60d clicks>=10 and 0 orders; review only. Never auto-pause.",
        family: frame.family,
      });
    }
    const decision = bleeders20Decision({
      family: frame.family,
      break_even_acos: frame.break_even_acos,
      ad_product: adProductOf(t.campaign_name),
      orders_30: m30.orders,
      spend_30: m30.spend,
      sales_30: m30.sales,
      campaign_purpose: purpose,
      protected_recent_test: false,
    });
    if (decision.include && !seenBleeder.has(`20:${key}`)) {
      seenBleeder.add(`20:${key}`);
      bleeders20.push({
        date_start: l30, date_end: closed, window_label: "L30",
        campaign_id: t.campaign_id ?? "", campaign_name: t.campaign_name,
        keyword_id: t.keyword_id ?? "", target_id: t.keyword_id ?? "",
        keyword_text: t.keyword_text, query_normalized: queryNormalized(t.keyword_text),
        family: frame.family, break_even_acos: frame.break_even_acos,
        threshold_acos: decision.threshold_acos,
        acos_30: decision.acos_30, over_by_pp: decision.over_by_pp,
        orders_30: m30.orders, spend_30: m30.spend,
        ad_product: adProductOf(t.campaign_name),
        campaign_purpose: purpose, protected_recent_test: false,
        cut_suggestion: false,
        proposed_tag: decision.proposed_tag,
        proposed_tag_reason: decision.proposed_tag_reason,
      });
      for (const kw of keywords) {
        if (kw.window_label !== "Today") continue;
        if (normalizeName(kw.campaign_name) === normalizeName(t.campaign_name)
          && queryNormalized(kw.keyword_text) === queryNormalized(t.keyword_text)) {
          kw.bleeders20_flag = true;
        }
      }
    }
    if (bleederTrusted && m60.clicks >= BLEEDERS10_MIN_CLICKS && m60.orders === 0) {
      for (const kw of keywords) {
        if (kw.window_label !== "Today") continue;
        if (normalizeName(kw.campaign_name) === normalizeName(t.campaign_name)
          && queryNormalized(kw.keyword_text) === queryNormalized(t.keyword_text)) {
          kw.bleeders10_flag = true;
        }
      }
    }
  }

  const siblings = siblingExactAuctions(targets);
  const siblingQueries = new Set(siblings.map((s) => s.query_normalized));
  for (const kw of keywords) {
    const q = queryNormalized(kw.keyword_text);
    const hit = siblings.find((s) => s.query_normalized === q);
    if (!hit) continue;
    kw.sibling_exact_campaign_count = hit.campaigns.length;
    kw.sibling_exact_campaign_ids = hit.campaigns.map((c) => c.campaign_id).filter(Boolean).join("|");
    const bids = hit.campaigns.map((c) => c.bid).filter((b): b is number => b != null);
    kw.highest_sibling_bid = bids.length ? Math.max(...bids) : null;
  }

  const bidReview = watch
    .filter((r) => r.window_label === "L7")
    .map((l7row) => {
      const l30row = watch.find((r) =>
        r.window_label === "L30" && normalizeName(r.campaign_name) === normalizeName(l7row.campaign_name)
        && String(r.campaign_id ?? "") === String(l7row.campaign_id ?? ""));
      const purpose = (l7row.campaign_purpose || "profit") as CampaignPurpose;
      const acosL7 = l7row.acos;
      const acosL30 = l30row?.acos ?? null;
      let trend: "improving" | "worsening" | "flat" | "unknown" = "unknown";
      if (acosL7 != null && acosL30 != null) {
        if (Math.abs(acosL7 - acosL30) <= 1) trend = "flat";
        else trend = acosL7 < acosL30 ? "improving" : "worsening";
      }
      const todayRow = watch.find((r) =>
        r.window_label === "Today" && normalizeName(r.campaign_name) === normalizeName(l7row.campaign_name)
        && String(r.campaign_id ?? "") === String(l7row.campaign_id ?? ""));
      const budgetConstrained = todayRow?.budget_capped_yesterday === true
        || (todayRow?.budget_util_yesterday != null && todayRow.budget_util_yesterday >= 0.9);
      const query = queryNormalized(l7row.ranking_query || extractExactKeyword(l7row.campaign_name) || "");
      const sibling = query ? siblingQueries.has(query) : false;
      const suggestion = bidReviewSuggestion({
        purpose, acos_l7: acosL7, acos_l30: acosL30,
        break_even: l7row.break_even_acos, budget_constrained: budgetConstrained,
        sibling_auction: sibling,
      });
      const onBleeder10 = bleeders10.some((b) => normalizeName(String(b.campaign_name)) === normalizeName(l7row.campaign_name));
      const ladder = (l30row?.orders ?? 0) === 0 && (l30row?.clicks ?? 0) >= 5;
      return {
        campaign_id: l7row.campaign_id ?? "",
        campaign_name: l7row.campaign_name,
        purpose,
        spend_l7: l7row.spend,
        acos_l7: acosL7,
        spend_l30: l30row?.spend ?? null,
        acos_l30: acosL30,
        trend,
        budget_constrained: budgetConstrained,
        one_lever_suggestion: suggestion.suggestion,
        suggestion_reason: suggestion.reason,
        stack_risk: onBleeder10 && ladder,
        do_not_stack_with_bleeders: true,
      };
    })
    .sort((a, b) => n(b.spend_l7) - n(a.spend_l7));

  const addsUnknown = input.addsThisWeekAlready == null || !Number.isFinite(Number(input.addsThisWeekAlready));
  const adds = addsUnknown ? null : Number(input.addsThisWeekAlready);
  const remaining = addsUnknown ? 0 : Math.max(0, MAX_NEW_STRUCTURES_PER_WEEK - (adds ?? 0));
  const harvestPool = [...autoTerms, ...fatTerms, ...broadTerms]
    .filter((r) => r.label === "L7" && (r.proposed_tag === "HARVEST_EXACT" || r.proposed_tag === "WATCH") && r.orders >= 2);
  const harvestQueue = harvestPool.slice(0, remaining).map((r) => ({
    term: r.customer_search_term,
    query_normalized: queryNormalized(r.customer_search_term),
    family: r.family,
    source_campaign_id: r.campaign_id ?? "",
    clicks_l7: r.clicks, orders_l7: r.orders, acos_l7: r.acos,
    clicks_l30: null, orders_l30: null,
    organic_rank: r.organic_rank, sqp_ps: r.sqp_purchase_share ?? null,
    destination_exact_exists: false, destination_campaign_id: "",
    destination_state: "", destination_budget: null, destination_impressions: 0,
    source_negate_pending: false, slot_cost: 1,
    proposed_tag: "WATCH",
    proposed_tag_reason: "destination impressions unknown; HARVEST_EXACT not allowed",
    harvest_ready: false,
    adds_this_week_already: addsUnknown ? "unknown" : adds,
    remaining_slots: remaining,
  }));

  const findings = structureAuditFindings({
    siblings,
    metaSyncMissing: [...new Map(watch
      .filter((r) => r.window_label === "Today" && r.meta_sync === false)
      .map((r) => [r.campaign_name, { campaign_name: r.campaign_name, watch_list: r.watch_list }])).values()],
    rankingUnlabeled: watch
      .filter((r) => isRankingCampaign(r.campaign_name) && r.campaign_purpose !== "ranking" && r.window_label === "Today")
      .map((r) => ({ campaign_id: r.campaign_id, campaign_name: r.campaign_name })),
  });

  const placementRows: Record<string, unknown>[] = [];
  for (const label of ["L7", "L30"] as const) {
    const w = windows.find((x) => windowLabelFromPack(x.label) === label);
    if (!w) continue;
    const names = new Map<string, WatchCampaignExportRow>();
    for (const row of watch.filter((r) => r.window_label === label)) {
      names.set(`${row.campaign_id ?? ""}\t${normalizeName(row.campaign_name)}`, row);
    }
    for (const row of names.values()) {
      const matched = inWindow(input.placements, w.start, w.end).filter((p) =>
        namesEqual(p.campaign_name, row.campaign_name));
      const buckets = new Map<string, PlacementRow[]>();
      for (const p of matched) {
        const code = placementCode(p.placement);
        if (!code) continue;
        const list = buckets.get(code) ?? [];
        list.push(p);
        buckets.set(code, list);
      }
      for (const [code, group] of buckets) {
        const m = sumMetrics(group);
        const spendAll = [...buckets.values()].reduce((s, g) => s + sumMetrics(g).spend, 0);
        placementRows.push({
          date_start: w.start, date_end: w.end, window_label: label,
          metrics_complete: w.metrics_complete, grain: "placement",
          campaign_id: row.campaign_id ?? "", campaign_name: row.campaign_name,
          placement: code,
          impressions: m.impressions, clicks: m.clicks, spend: m.spend,
          orders: m.orders, sales: m.sales, acos: m.acos,
          modifier_pct: code === "TOS" ? row.tos_modifier_pct : code === "ROS" ? row.ros_modifier_pct : row.pp_modifier_pct,
          spend_share: spendAll > 0 ? m.spend / spendAll : null,
          click_share: null, order_share: null,
          agreement_tos: false, agreement_ros: false, agreement_pp: false,
          high_tos_is: false,
        });
      }
    }
  }

  const agreements = seededAgreements();
  const rank = watch.find((r) => isRankingCampaign(r.campaign_name) && r.campaign_id);
  if (rank?.campaign_id) agreements[0].campaign_id = rank.campaign_id;

  const wow = joinSqpWow(
    sqp.map((r) => ({
      query: String(r.search_query ?? r.query_normalized ?? ""),
      asin: String(r.asin ?? ""),
      volume: r.search_query_volume ?? null,
      impression_share: r.impression_share ?? null,
      purchase_share: r.purchase_share ?? null,
      impressions: r.asin_impressions ?? null,
      purchases: r.asin_purchases ?? null,
    })),
    sqpComparison.map((r) => ({
      query: String(r.search_query ?? r.query_normalized ?? ""),
      asin: String(r.asin ?? ""),
      volume: r.search_query_volume ?? null,
      impression_share: r.impression_share ?? null,
      purchase_share: r.purchase_share ?? null,
      impressions: r.asin_impressions ?? null,
      purchases: r.asin_purchases ?? null,
    })),
  );

  const organicPackHeaders = [
    ...ORGANIC_RANK_SNAPSHOT_CSV_HEADERS,
    "query_normalized", "hero_asin", "tracker_group_name", "sfr_source",
    "soldscope_search_volume", "organic_as_of_prev", "paid_spend_l7_on_phrase", "converting_st_no_exact",
  ] as const;
  const exactL7Spend = new Map<string, number>();
  for (const kw of keywords) {
    if (kw.window_label !== "L7" || !kw.metrics_complete) continue;
    if (normalizeName(kw.match_type) !== "exact") continue;
    const q = queryNormalized(kw.query_normalized || kw.keyword_text);
    if (!q) continue;
    exactL7Spend.set(q, (exactL7Spend.get(q) ?? 0) + n(kw.spend));
  }
  const organicBody = toCsv(organicPackHeaders, organicRows.map((r) => {
    const q = queryNormalized(r.keyword);
    return {
      ...r,
      query_normalized: q,
      hero_asin: familyHeroAsin(r.family) ?? "",
      tracker_group_name: "",
      sfr_source: r.aba_sfr == null ? "" : "aba",
      soldscope_search_volume: null,
      organic_as_of_prev: "",
      paid_spend_l7_on_phrase: exactL7Spend.has(q) ? exactL7Spend.get(q) : null,
      converting_st_no_exact: "",
    };
  }));

  const competitorRows = finalizeCompetitorKrRows(input.competitorOutliers ?? []);
  const competitorBody = toCsv(
    [...COMPETITOR_KR_CSV_HEADERS, "query_normalized", "bidding_campaign_ids", "our_exact_bid",
      "competitor_on_serp_evidence", "family_fit", "cap_slot", "suggested_lever_reason", "harvest_blocked_reason"],
    competitorRows.map((r) => ({
      ...r,
      already_bidding: r.already_bidding === "Y" ? true : r.already_bidding === "N" ? false : r.already_bidding,
      query_normalized: queryNormalized(r.keyword),
      bidding_campaign_ids: "",
      our_exact_bid: null,
      competitor_on_serp_evidence: r.competitor_on_serp_evidence ?? "",
      family_fit: r.family_fit ?? "",
      cap_slot: r.cap_slot ?? null,
      suggested_lever: r.suggested_lever,
      suggested_lever_reason: r.suggested_lever_reason ?? "",
      harvest_blocked_reason: r.suggested_lever === "harvest_exact" ? "" : (r.harvest_blocked_reason ?? ""),
    })),
  );

  const autoL2 = autoTerms.filter((r) => r.label === "L2").length;
  const fatEmpty = fatTerms.length === 0;
  const skuDates = (input.asinCatalog ?? [])
    .map((r) => String(r.updated_at ?? "").slice(0, 10))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const skuAsOf = skuDates.length ? skuDates[skuDates.length - 1] : "";
  const skuMissing = !(input.asinCatalog ?? []).some((r) => r.cogs_per_unit != null && Number(r.cogs_per_unit) > 0);
  const organicAsOf = organicRows.map((r) => r.organic_as_of).filter((d): d is string => !!d).sort().at(-1) ?? "";
  const organicCensus = organicTrackerCensus(input.organicSnapshots ?? [], organicRows);
  const groups = organicCensus.groups;
  const phrases = organicCensus.phrases;
  const sqpLag = sqpPlan.lastCompleteWeekEnd ? isoDayDelta(today, sqpPlan.lastCompleteWeekEnd) : null;
  const sqpSources = [...new Set(sqp.map((r) => String(r.source ?? "")).filter(Boolean))];
  const rankingLines = watch
    .filter((r) => r.campaign_purpose === "ranking" && r.window_label === "Today")
    .map((r) => `${r.campaign_id || "id_missing"} | ${r.campaign_name} | ${r.ranking_query}`);
  const metaMissing = [...new Set(watch
    .filter((r) => r.window_label === "Today" && r.meta_sync === false)
    .map((r) => r.campaign_name))];
  const emptyReasons = [
    autoTerms.length === 0 ? "EMPTY_REASON auto_loose_search_terms.csv: no 1-day search-term stamps in the closed L2/L7 windows" : "",
    fatEmpty ? "EMPTY_REASON fat_parent_search_terms.csv: no fat-parent search-term stamps (or none configured in window)" : "",
    broadTerms.length === 0 ? "EMPTY_REASON broad_m_search_terms.csv: no 1-day stamps for GG - Lip Balm - Broad M" : "",
    sqp.length === 0 ? "EMPTY_REASON sqp_weekly_slice.csv: no current complete Sun–Sat slice shipped" : "",
    "EMPTY_REASON lifetime_zero.csv: ltd_unavailable — do not substitute 60-day data as lifetime",
  ].filter(Boolean);

  const stFile = (name: string, rows: HarvestTerm[]) => ({
    name,
    rows: rows.length,
    emptyReason: rows.length > 0 || emptyReasons.some((line) => line.includes(name)),
    grains: rows.map((r) => r.grain || "WINDOW_AGG"),
    labels: rows.map((r) => r.label || r.window_label || ""),
  });
  const quality = evaluatePackQuality({
    today,
    yesterday: closed,
    sqpCurrentWeekEnd: sqp[0]?.week_end ?? null,
    sqpNewestCompleteWeekEnd: sqpPlan.lastCompleteWeekEnd,
    sqpLagDays: sqpLag,
    sqpStaleOver10: sqpPlan.staleReason === "newest_complete_week_older_than_10_days",
    sqpFiles: [
      ...sqp.map((r) => ({ name: "sqp_weekly_slice.csv", week_type: "current", week_end: String(r.week_end ?? ""), stale_pre_raise: r.stale_pre_raise === true })),
      ...sqpComparison.map((r) => ({ name: SQP_COMPARISON_FILENAME, week_type: "comparison", week_end: String(r.week_end ?? ""), stale_pre_raise: r.stale_pre_raise === true })),
    ],
    watchRows: watch.map((r) => ({
      campaign_id: r.campaign_id, campaign_name: r.campaign_name,
      window_label: r.window_label || "", date_end: r.date_end,
      metrics_complete: r.metrics_complete, watch_list: r.watch_list,
      state: r.state, meta_sync: r.meta_sync, spend: r.spend,
      placement_shares_empty: r.placement_report_lag === true,
    })),
    spendMismatches: mismatchChecks,
    stPresentedAsCampaignSot: false,
    stFiles: [stFile("auto_loose_search_terms.csv", autoTerms), stFile("fat_parent_search_terms.csv", fatTerms), stFile("broad_m_search_terms.csv", broadTerms)],
    organicAsOf: organicAsOf || null,
    organicZeroFilled: organicRows.some((r) => r.organic_rank === 0 || r.aba_sfr === 0),
    inventedSqpShares: false,
    bleeders20: bleeders20.map((b) => ({
      campaign_purpose: String(b.campaign_purpose),
      threshold_acos: Number(b.threshold_acos),
      break_even_acos: Number(b.break_even_acos),
      ad_product: String(b.ad_product),
      cut_suggestion: b.cut_suggestion === true,
      proposed_tag: String(b.proposed_tag),
    })),
    bidReview: bidReview.map((b) => ({ purpose: b.purpose, suggestion: b.one_lever_suggestion })),
    priorCounts: input.priorPack?.counts ?? null,
    currentCounts: {
      auto_loose: autoTerms.length,
      broad_m: broadTerms.length,
      watch: watch.length,
      sqp: sqp.length,
    },
    rowFiltersApplied: ROW_FILTERS_APPLIED,
    fatParentEmpty: fatEmpty,
    ltdUnavailable: true,
    addsThisWeekUnknown: addsUnknown,
    skuCostsMissing: skuMissing,
    outcomesImplementedUnknown: ledger.some((r) => !!r.proposed_tag),
    placementLag: watch.some((r) => r.placement_report_lag === true),
  });

  const prior = input.priorPack?.counts;
  const beforeAfter = [
    `auto_loose BEFORE ${prior?.auto_loose ?? "n/a"} AFTER ${autoTerms.length}`,
    `broad_m BEFORE ${prior?.broad_m ?? "n/a"} AFTER ${broadTerms.length}`,
    `watch BEFORE ${prior?.watch ?? "n/a"} AFTER ${watch.length}`,
    `sqp BEFORE ${prior?.sqp ?? "n/a"} AFTER ${sqp.length}`,
  ].join("; ");
  const windowLine = (label: string) => {
    const w = windows.find((x) => windowLabelFromPack(x.label) === label);
    if (!w) return "";
    return label === "L1" || label === "Today" ? w.start : `${w.start} → ${w.end}`;
  };
  const sqpCurrentText = sqpPlan.current && sqp.length
    ? `${sqpPlan.current.weekStart} → ${sqpPlan.current.weekEnd}`
    : "";
  const comparisonText = sqpComparison.length && sqpPlan.comparison
    ? `${sqpPlan.comparison.weekStart}→${sqpPlan.comparison.weekEnd}`
    : "none";
  const unexpected = [
    ...[autoTerms, fatTerms, broadTerms].flatMap((rows, i) => rows.length ? [] : [ST_REVIEW_FILES_SAFE[i]]),
    sqp.length ? "" : "sqp_weekly_slice.csv",
  ].filter(Boolean).join(", ");

  const filename = `gno-pack-${gnoPackStamp(input.now)}.zip`;
  const packId = filename.replace(/\.zip$/, "");
  const freshness = renderFreshnessBlock({
    pack_id: packId,
    pack_timestamp: (input.now ?? new Date()).toISOString(),
    account_timezone: AMAZON_TZ,
    today,
    l1: windowLine("L1"),
    l2: windowLine("L2"),
    l7: windowLine("L7"),
    l30: windowLine("L30"),
    l60: windowLine("L60"),
    sqpCurrent: sqpCurrentText,
    sqpNewestStoredWeekEnd: sqpPlan.lastStoredWeekEnd ?? "",
    sqpSource: sqpSources.length === 1 ? sqpSources[0] : sqpSources.join("|"),
    sqpLagDays: sqpLag == null || !Number.isFinite(sqpLag) ? "" : String(sqpLag),
    sqpComparison: comparisonText,
    organicAsOf,
    organicGroups: `${groups} / phrases: ${phrases} / snapshot_rows: ${organicCensus.snapshot_rows}`,
    placementAsOf: input.placements.map((p) => p.date).sort().at(-1) ?? "",
    negativesAsOf: negatives.length ? "stored snapshot; added_at not on every row" : "",
    skuCostsAsOf: skuAsOf || "missing",
    bleeders10: `${l60} → ${closed}${stCoverage.covers ? ` coverage_days=${stCoverage.daysInWindow}` : ` untrusted coverage_days=${stCoverage.daysInWindow}`}`,
    bleeders20: `${l30} → ${closed}`,
    unexpectedEmpty: unexpected,
    rowFilters: ROW_FILTERS_APPLIED,
    qualityGates: quality.level,
    qualityNotes: quality.notes,
  });
  const contractNotes = [
    "ST grain: WINDOW_AGG (review files). Raw optional files, when present, are grain=DAILY and are not labeled L7.",
    "ST filters: none. SUMMARY stamps are excluded from L2/L7 rather than relabeled.",
    `BEFORE/AFTER vs prior pack: ${beforeAfter}`,
    `prior_pack_id: ${input.priorPack?.id ?? ""}`,
    ledger.length
      ? "outcomes: last 30 days of gno_decision_ledger carried into gno_outcomes.csv. implemented stays unknown unless the ledger records it."
      : "outcomes_empty_reason: no stored gno_outcomes / decision-ledger rows in the last 30 days",
    `Auto Loose L2 omitted? ${autoL2 === 0 ? "yes — no 1-day ST stamps for that window" : "no"}`,
    fatEmpty ? "fat_parent empty reason: no search-term stamps for the configured fat-parent campaign in the closed windows." : "fat_parent empty reason: n/a",
    `NEW_EXACT / flavor rows with meta_sync=false: ${metaMissing.length ? metaMissing.join(" | ") : "none"}`,
    organicCensus.note,
    "query_normalized: lowercase, trim, collapse whitespace, ASCII-fold, fold women→woman so woman/women join across ST, Exact, SQP, SoldScope, KR, and negatives. man/men are not folded.",
    "SOP flags bleeders10_flag, bleeders20_flag, and lifetime_zero_flag are set on Today rows only. L1/L2/L7/L30/L60 leave them blank.",
    "spend_yesterday, spend_dby, budget_util_yesterday, and budget_capped_yesterday are Today rows only.",
    `harvest_min_clicks: ${HARVEST_MIN_CLICKS}`,
    `harvest_min_orders: ${HARVEST_MIN_ORDERS}`,
    `max_new_structures_per_week: ${MAX_NEW_STRUCTURES_PER_WEEK}`,
    `adds_this_week_already: ${addsUnknown ? "unknown" : String(adds)}`,
    `remaining_slots: ${remaining}`,
    `harvest_queue_rows: ${harvestQueue.length}`,
    addsUnknown ? "adds_this_week_already unknown; remaining_slots capped conservative at 0." : "",
    `ranking campaigns: ${rankingLines.length ? rankingLines.join(" || ") : "none in this pack"}`,
    ...emptyReasons,
    "Campaign spend SoT is ads_campaigns_daily on watch_campaigns. Keyword and search-term dollars are NOT_SOT.",
    "Family BE lip_3pk=42, deo=36, balm=36. Bleeders 2.0 is family BE+20pp (SP) or BE+10pp (SB/SBV/SD).",
    "Never writes to Amazon.",
  ].filter(Boolean).join("\n");

  const methodology = gnoPackReadme({
    files: [...REQUIRED_PACK_FILES],
    sqpIncluded: sqp.length > 0,
    sqpNote: sqpPlan.note,
    sqpStale: sqpPlan.stale,
    sqpStaleReason: sqpPlan.staleReason,
    sqpLastWeekEnd: sqpPlan.stale
      ? (sqpPlan.lastCompleteWeekEnd ?? sqpPlan.lastStoredWeekEnd)
      : sqpPlan.lastCompleteWeekEnd,
    sqpWeek: sqpPlan.current,
    sqpComparison: sqpComparison.length ? sqpPlan.comparison : null,
    organicIncluded: organicRows.length > 0,
    competitorIncluded: (input.competitorOutliers ?? []).length > 0,
  });
  const readme = `${freshness}\n\n${contractNotes}\n\n${methodology}\n`;

  const rawAuto = rawDailySearchTerms(input.searchTerms, input.campaigns, closed, isAutoLoose);
  const rawBroad = rawDailySearchTerms(input.searchTerms, input.campaigns, closed, isBroadM);
  const rawFat = rawDailySearchTerms(input.searchTerms, input.campaigns, closed, isFatParent);

  const files: { name: string; body: string }[] = [
    { name: "watch_campaigns.csv", body: watchCampaignsCsv(watch) },
    { name: "watch_placements.csv", body: toCsv(WATCH_PLACEMENT_HEADERS, placementRows) },
    { name: "keyword_targets.csv", body: keywordTargetsCsv(keywords) },
    { name: "auto_loose_search_terms.csv", body: autoLooseSearchTermsCsv(autoTerms) },
    { name: "fat_parent_search_terms.csv", body: autoLooseSearchTermsCsv(fatTerms) },
    { name: "broad_m_search_terms.csv", body: autoLooseSearchTermsCsv(broadTerms) },
    { name: "advertised_product_l7.csv", body: advertisedProductL7Csv(advertised) },
    { name: "sqp_weekly_slice.csv", body: sqpWeeklySliceCsv(sqp) },
    { name: "sqp_wow.csv", body: toCsv(SQP_WOW_HEADERS, wow) },
    { name: "organic_rank_snapshot.csv", body: organicBody },
    { name: "competitor_kr_outliers.csv", body: competitorBody },
    { name: "negatives_snapshot.csv", body: negativesSnapshotCsv(negatives) },
    { name: "bleeders_10.csv", body: toCsv(BLEEDERS10_HEADERS, bleeders10) },
    { name: "bleeders_20.csv", body: toCsv(BLEEDERS20_HEADERS, bleeders20) },
    { name: "lifetime_zero.csv", body: toCsv(LIFETIME_ZERO_HEADERS, []) },
    { name: "bid_review_candidates.csv", body: toCsv(BID_REVIEW_HEADERS, bidReview) },
    { name: "harvest_queue.csv", body: toCsv(HARVEST_QUEUE_HEADERS, harvestQueue) },
    { name: "structure_audit.csv", body: toCsv(STRUCTURE_AUDIT_HEADERS, findings as unknown as Record<string, unknown>[]) },
    { name: "agreements.csv", body: toCsv(AGREEMENTS_HEADERS, agreements) },
    { name: "gno_decision_rules.txt", body: gnoDecisionRulesTxt() },
    { name: "gno_outcomes.csv", body: gnoOutcomesCsv(ledger) },
  ];
  if (sqpComparison.length) {
    files.push({ name: SQP_COMPARISON_FILENAME, body: sqpWeeklySliceCsv(sqpComparison) });
  }
  if (rawAuto.length) files.push({ name: "auto_loose_search_terms_raw.csv", body: autoLooseSearchTermsCsv(rawAuto) });
  if (rawBroad.length) files.push({ name: "broad_m_search_terms_raw.csv", body: autoLooseSearchTermsCsv(rawBroad) });
  if (rawFat.length) files.push({ name: "fat_parent_search_terms_raw.csv", body: autoLooseSearchTermsCsv(rawFat) });
  files.unshift({ name: "README.txt", body: readme });
  const manifest = renderPackManifest({
    pack_id: packId,
    pack_timestamp: (input.now ?? new Date()).toISOString(),
    files,
    windows: {
      Today: today,
      L1: windowLine("L1"),
      L2: windowLine("L2"),
      L7: windowLine("L7"),
      L30: windowLine("L30"),
      L60: windowLine("L60"),
      sqp_current: sqpCurrentText,
    },
    quality_gates: quality.level,
    quality_gate_notes: quality.notes,
    prior_pack_id: input.priorPack?.id ?? null,
    row_count_deltas: {
      auto_loose: countDelta(autoTerms.length, prior?.auto_loose),
      broad_m: countDelta(broadTerms.length, prior?.broad_m),
      watch: countDelta(watch.length, prior?.watch),
      sqp: countDelta(sqp.length, prior?.sqp),
    },
    row_filters_applied: ROW_FILTERS_APPLIED,
  });
  files.splice(1, 0, { name: "pack_manifest.json", body: manifest });
  return { files, filename, quality_gates: quality.level };
}

const ST_REVIEW_FILES_SAFE = ["auto_loose_search_terms.csv", "fat_parent_search_terms.csv", "broad_m_search_terms.csv"] as const;

function rawDailySearchTerms(
  termRows: SearchTermRow[],
  campaignRows: CampaignDailyRow[],
  closedEnd: string,
  predicate: (name: string) => boolean,
): HarvestTerm[] {
  const start = windowStart(closedEnd, 7);
  const scoped = inWindow(termRows, start, closedEnd).filter((r) => predicate(r.campaign_name));
  const dates = [...new Set(scoped.map((r) => r.date))];
  const daily = dates.filter((d) => stDateLooksDaily(
    searchTermSpendOnDate(scoped, predicate, d),
    campaignSpendOnDate(campaignRows, predicate, d),
  ));
  if (daily.length < 2) return [];
  return scoped.filter((r) => daily.includes(r.date)).map((r) => {
    const frame = contributionFrame(r.campaign_name, null);
    return {
      date_start: r.date,
      date_end: r.date,
      label: undefined,
      window_label: "DAILY",
      grain: "DAILY",
      campaign_id: String(r.campaign_id ?? ""),
      campaign_name: r.campaign_name,
      customer_search_term: r.search_term,
      query_normalized: queryNormalized(r.search_term),
      match_type: r.match_type || "",
      impressions: n(r.impressions),
      clicks: n(r.clicks),
      spend: n(r.spend),
      orders: n(r.orders_14d),
      sales: n(r.sales_14d),
      acos: n(r.sales_14d) > 0 ? (n(r.spend) / n(r.sales_14d)) * 100 : null,
      cvr: null,
      has_enabled_exact_elsewhere: false,
      proposed_tag: "KEEP",
      proposed_tag_reason: "raw daily stamp; not an L7 review row",
      family: frame.family,
      break_even_acos: frame.break_even_acos,
      acos_vs_be: null,
      cm_note: "NOT_SOT raw daily stamp",
      organic_rank: null,
      organic_rank_prev: null,
      organic_rank_delta: null,
      aba_sfr: null,
      organic_as_of: null,
    };
  });
}
