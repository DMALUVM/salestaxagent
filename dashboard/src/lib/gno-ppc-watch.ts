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

export const GNO_OBSERVE_ONLY = true as const;

export const WATCH_CAMPAIGN_CSV_HEADERS = [
  "date_start", "date_end", "campaign_name", "asin", "state", "portfolio",
  "daily_budget", "tos_modifier_pct", "ros_modifier_pct", "pp_modifier_pct",
  "tos_spend_share", "ros_spend_share", "pp_spend_share", "impressions",
  "clicks", "spend", "cpc", "orders", "sales", "acos", "watch_list",
  "metrics_complete", "family", "break_even_acos", "acos_vs_be", "cm_note",
] as const;

export const AUTO_LOOSE_TERM_CSV_HEADERS = [
  "date_start", "date_end", "label", "campaign_name", "customer_search_term",
  "match_type", "impressions", "clicks", "spend", "orders", "sales", "acos",
  "cvr", "has_enabled_exact_elsewhere", "proposed_tag",
  "family", "break_even_acos", "acos_vs_be", "cm_note",
] as const;

export const KEYWORD_TARGET_CSV_HEADERS = [
  "date_start", "date_end", "campaign_name", "asin", "keyword_text",
  "match_type", "keyword_state", "bid", "impressions", "clicks", "spend",
  "orders", "sales", "acos", "metrics_complete",
  "family", "break_even_acos", "acos_vs_be", "cm_note",
] as const;

export const NEGATIVES_CSV_HEADERS = [
  "campaign_name", "keyword", "match_type",
] as const;

export const ADVERTISED_PRODUCT_L7_CSV_HEADERS = [
  "date_start", "date_end", "asin", "campaign_name", "watch_list",
  "spend", "orders", "sales", "acos", "sku", "product_name",
  "mixed_asin", "family", "break_even_acos", "acos_vs_be", "cm_note",
] as const;

export const SQP_SLICE_CSV_HEADERS = [
  "week_start", "week_end", "asin", "search_query", "query_normalized",
  "search_query_volume", "impression_share", "click_share", "purchase_share",
  "asin_impressions", "asin_clicks", "asin_purchases", "source",
] as const;

export const SQP_SLICE_QUERIES = ["lip balm", "tallow lip balm", "chapstick"] as const;

export type WatchList = "NEW_EXACT" | "KEEPER" | "DAY5_PAUSE" | "FLAVOR_SHELL" | "OTHER";
export type ProposedTag = "KEEP" | "HARVEST_CANDIDATE" | "JUNK_CANDIDATE";
export type AlertPriority = "P0" | "P1" | "P2";
export type TermWindowLabel = "L2" | "L7";
export type PackWindowLabel = "Today" | "Last2" | "Last7";
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
  campaign_name: string;
  keyword: string;
  match_type?: string | null;
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
  /** UI-only. Not a CSV column. */
  learning_note?: string;
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
  impressions: number;
  clicks: number;
  spend: number;
  cpc: number;
  orders: number;
  sales: number;
  acos: number | null;
  watch_list: WatchList;
  /** false on Today — Ads lag; $0 is not a pause. Read spend/ACOS from L2/L7. */
  metrics_complete: boolean;
  family: GnoFamily;
  break_even_acos: number;
  acos_vs_be: number | null;
  cm_note: string;
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
  impressions: number;
  clicks: number;
  spend: number;
  orders: number;
  sales: number;
  acos: number | null;
  /** false on Today — config-only until Amazon attributes. */
  metrics_complete: boolean;
  family: GnoFamily;
  break_even_acos: number;
  acos_vs_be: number | null;
  cm_note: string;
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
}

export interface AsinCatalogRow {
  asin: string;
  sku?: string | null;
  product_name?: string | null;
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
  return normalizeName(term);
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
  if (NEW_EXACT.some((n) => namesEqual(n, campaignName))) return "NEW_EXACT";
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
  const m = String(campaignName ?? "").match(/\|\s*EX\s*\|\s*([^|]+?)\s*\|/i);
  return m ? normalizeTerm(m[1]) : null;
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

function rollSearchTerms(input: {
  termRows: SearchTermRow[];
  campaignRows: CampaignDailyRow[];
  start: string;
  end: string;
  label: TermWindowLabel;
  campaignPredicate: (name: string) => boolean;
  keywordTargets: KeywordTarget[];
  ledger?: GnoLedgerRow[];
}): HarvestTerm[] {
  const { termRows, campaignRows, start, end, label, campaignPredicate, keywordTargets } = input;
  const ledger = input.ledger ?? [];
  const enabled = enabledExactKeywords(campaignRows, termRows, end, keywordTargets);
  const latest = latestSearchTerms(termRows, start, end)
    .filter((r) => campaignPredicate(r.campaign_name));
  const rolled = new Map<string, SearchTermRow[]>();
  for (const r of latest) {
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
      base,
      { orders: m.orders, spend: m.spend, search_term: term },
      ledger,
    );
    const frame = contributionFrame(campaignName, m.acos);
    out.push({
      date_start: start,
      date_end: end,
      label,
      campaign_name: campaignName,
      customer_search_term: term,
      match_type: group[0].match_type || "",
      impressions: m.impressions,
      clicks: m.clicks,
      spend: m.spend,
      orders: m.orders,
      sales: m.sales,
      acos: m.acos,
      cvr: m.cvr,
      has_enabled_exact_elsewhere: hasExact,
      proposed_tag: learned.tag,
      learning_note: learned.note,
      ...frame,
    });
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
): HarvestTerm[] {
  const windows: Array<{ start: string; end: string; label: TermWindowLabel }> = [
    { start: windowStart(closedEnd, 2), end: closedEnd, label: "L2" },
    { start: windowStart(closedEnd, 7), end: closedEnd, label: "L7" },
  ];
  const out: HarvestTerm[] = [];
  for (const w of windows) {
    out.push(...rollSearchTerms({
      termRows, campaignRows, start: w.start, end: w.end,
      label: w.label, campaignPredicate, keywordTargets, ledger,
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

function uniqueWatchNames(
  campaigns: CampaignDailyRow[],
  extraNames: string[] = [],
): { name: string; list: WatchList }[] {
  const seen = new Set<string>();
  const out: { name: string; list: WatchList }[] = [];
  const add = (name: string, list: WatchList) => {
    const key = normalizeName(name);
    if (!key || seen.has(key)) return;
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
 * Ads Today is incomplete — L2 = yesterday + day before.
 */
export function packClosedEnd(today: string, asOf: string): string {
  return asOf < today ? asOf : shiftDays(today, -1);
}

/**
 * Pack windows as of Amazon Today.
 * Example 2026-09-07: Today=2026-09-07; L2=2026-09-05..2026-09-06;
 * L7=last 7 closed days ending yesterday (2026-08-31..2026-09-06).
 */
export function packWindows(today: string, asOf: string): PackWindow[] {
  const closed = packClosedEnd(today, asOf);
  return [
    { start: today, end: today, label: "Today", metrics_complete: false },
    { start: windowStart(closed, 2), end: closed, label: "Last2", metrics_complete: true },
    { start: windowStart(closed, 7), end: closed, label: "Last7", metrics_complete: true },
  ];
}

export function watchCampaignExportRows(input: {
  asOf: string;
  today?: string;
  campaigns: CampaignDailyRow[];
  placements: PlacementRow[];
  campaignMeta?: CampaignMeta[];
}): WatchCampaignExportRow[] {
  const { campaigns, placements } = input;
  const today = input.today || input.asOf;
  const windows = packWindows(today, input.asOf);
  const latest = latestByCampaign(campaigns);
  const meta = input.campaignMeta ?? [];
  const names = uniqueWatchNames(campaigns, meta.map((m) => m.campaign_name));
  const rows: WatchCampaignExportRow[] = [];
  for (const w of windows) {
    for (const { name, list } of names) {
      const campRows = campaigns.filter((r) =>
        namesEqual(r.campaign_name, name) || (list === "DAY5_PAUSE" && nameContains(r.campaign_name, name)));
      const storedName = campRows[0]?.campaign_name ?? name;
      // Today is config-only. Spend / orders / ACOS live on closed L2 + L7.
      const m = w.metrics_complete
        ? sumMetrics(inWindow(campRows, w.start, w.end))
        : { impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0, cpc: 0, acos: null, cvr: null };
      const place = w.metrics_complete
        ? placementShares(inWindow(
          placements.filter((p) =>
            namesEqual(p.campaign_name, name) || nameContains(p.campaign_name, name)),
          w.start, w.end,
        ))
        : { tos_spend_share: null, ros_spend_share: null, pp_spend_share: null };
      const snap = latest.get(normalizeName(storedName));
      const metaRow = metaForName(meta, storedName) ?? metaForName(meta, name);
      const state = String(snap?.campaign_status || metaRow?.state || "");
      const budget = snap?.budget != null ? Number(snap.budget)
        : (metaRow?.daily_budget != null ? Number(metaRow.daily_budget) : null);
      const portfolio = String(metaRow?.portfolio_name || "").trim() || "none";
      const placementLag = w.metrics_complete
        && m.spend > 0
        && place.tos_spend_share == null
        && place.ros_spend_share == null
        && place.pp_spend_share == null;
      rows.push({
        date_start: w.start,
        date_end: w.end,
        campaign_name: storedName,
        asin: extractAsin(storedName),
        state,
        portfolio,
        daily_budget: budget,
        tos_modifier_pct: metaRow?.tos_modifier_pct ?? null,
        ros_modifier_pct: metaRow?.ros_modifier_pct ?? null,
        pp_modifier_pct: metaRow?.pp_modifier_pct ?? null,
        tos_spend_share: place.tos_spend_share,
        ros_spend_share: place.ros_spend_share,
        pp_spend_share: place.pp_spend_share,
        impressions: m.impressions,
        clicks: m.clicks,
        spend: m.spend,
        cpc: m.cpc,
        orders: m.orders,
        sales: m.sales,
        acos: m.acos,
        watch_list: list,
        metrics_complete: w.metrics_complete,
        ...contributionFrame(storedName, m.acos, placementLag ? [PLACEMENT_LAG_NOTE] : []),
      });
    }
  }
  return rows;
}

export function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: readonly string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h] as string | number | boolean | null)).join(","));
  }
  return `${lines.join("\n")}\n`;
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
    campaign_name: r.campaign_name,
    keyword: r.keyword,
    match_type: r.match_type ?? "",
  })));
}

/**
 * Attribute search-term rows to the keyword that actually served.
 * Never fall back to customer search_term — that copies one rollup onto
 * every match-type sibling (paused Exact `tallow lip balm` vs enabled
 * Exact `tallow lip balms`).
 */
export function keywordWindowMetrics(
  terms: SearchTermRow[],
  target: Pick<KeywordTarget, "campaign_name" | "keyword_text" | "match_type" | "keyword_id">,
  start: string,
  end: string,
): Metrics {
  const kw = normalizeTerm(target.keyword_text);
  const mt = normalizeName(target.match_type);
  const kid = String(target.keyword_id ?? "").trim();
  const rows = inWindow(terms, start, end).filter((t) => {
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

function metricFingerprint(m: Pick<Metrics, "impressions" | "clicks" | "spend" | "orders" | "sales">): string {
  return [m.impressions, m.clicks, m.spend.toFixed(2), m.orders, m.sales.toFixed(2)].join("|");
}

function emptyMetrics(): Metrics {
  return { impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0, cpc: 0, acos: null, cvr: null };
}

export function keywordTargetExportRows(input: {
  today: string;
  asOf: string;
  keywordTargets: KeywordTarget[];
  searchTerms: SearchTermRow[];
}): KeywordTargetExportRow[] {
  // Include PAUSED + ENABLED. Today rows are config-only (bid / state).
  const wanted = input.keywordTargets.filter((t) => {
    const list = watchListOf(t.campaign_name);
    return list === "NEW_EXACT" || list === "KEEPER" || list === "FLAVOR_SHELL";
  });
  const rows: KeywordTargetExportRow[] = [];
  for (const w of packWindows(input.today, input.asOf)) {
    const windowRows: KeywordTargetExportRow[] = [];
    for (const t of wanted) {
      const m = w.metrics_complete
        ? keywordWindowMetrics(input.searchTerms, t, w.start, w.end)
        : emptyMetrics();
      windowRows.push({
        date_start: w.start,
        date_end: w.end,
        campaign_name: t.campaign_name,
        asin: extractAsin(t.campaign_name),
        keyword_text: t.keyword_text,
        match_type: t.match_type || "",
        keyword_state: t.state || "",
        bid: t.bid ?? null,
        impressions: m.impressions,
        clicks: m.clicks,
        spend: m.spend,
        orders: m.orders,
        sales: m.sales,
        acos: m.acos,
        metrics_complete: w.metrics_complete,
        ...contributionFrame(t.campaign_name, m.acos),
      });
    }
    if (w.metrics_complete) {
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
          if (r.spend <= 0 && r.impressions <= 0) continue;
          const fp = metricFingerprint(r);
          counts.set(fp, (counts.get(fp) ?? 0) + 1);
        }
        for (const r of group) {
          if (r.spend <= 0 && r.impressions <= 0) continue;
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
    const m = sumMetrics(inWindow(campRows, start, closed));
    const mixed = asins.length > 1;
    const frame = contributionFrame(storedName, m.acos, [ADVERTISED_PRODUCT_NOTE]);
    for (const asin of asins) {
      const cat = catalog.get(asin.toUpperCase());
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
        ...frame,
      });
    }
  }
  return out.sort((a, b) => b.spend - a.spend || a.campaign_name.localeCompare(b.campaign_name) || a.asin.localeCompare(b.asin));
}

export function advertisedProductL7Csv(rows: AdvertisedProductL7Row[]): string {
  return toCsv(ADVERTISED_PRODUCT_L7_CSV_HEADERS, rows.map((r) => ({ ...r })));
}

export function sqpWeeklySliceRows(rows: SqpSliceRow[]): SqpSliceRow[] {
  const wanted = new Set<string>(SQP_SLICE_QUERIES);
  const filtered = rows.filter((r) => {
    const q = normalizeTerm(r.query_normalized || r.search_query);
    return wanted.has(q);
  });
  if (!filtered.length) return [];
  let latest = "";
  for (const r of filtered) {
    const end = String(r.week_end ?? "");
    if (end > latest) latest = end;
  }
  return filtered
    .filter((r) => String(r.week_end ?? "") === latest)
    .sort((a, b) => {
      const qa = normalizeTerm(a.query_normalized || a.search_query);
      const qb = normalizeTerm(b.query_normalized || b.search_query);
      if (qa !== qb) return qa.localeCompare(qb);
      return String(a.asin ?? "").localeCompare(String(b.asin ?? ""));
    });
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
  })));
}

export function gnoPackReadme(input: { files: string[]; sqpIncluded: boolean }): string {
  const sqpLine = input.sqpIncluded
    ? "- sqp_weekly_slice.csv — latest week for lip balm / tallow lip balm / chapstick (from sqp_weekly). Shares are reported, never invented."
    : "- sqp_weekly_slice.csv — OMITTED. No sqp_weekly / Brand Analytics rows for lip balm, tallow lip balm, or chapstick. Do not invent SQP rows.";
  return [
    "GNO Export pack — observe only. Never writes to Amazon.",
    "",
    "Windows:",
    "- Today = config only (metrics_complete=false). $0 is not a pause.",
    "- L2 / L7 = closed Amazon days ending yesterday.",
    "",
    "Family BE (config family_break_even_acos, not TACOS):",
    "- lip_3pk (lip campaigns, fat parent, GG Lip Broad M, lip Exact) = 42",
    "- deo = 36",
    "- balm (body tallow balm, not lip) = 36",
    "",
    "Files:",
    "- watch_campaigns.csv — NEW_EXACT + KEEPER + DAY5_PAUSE + FLAVOR_SHELL",
    "- auto_loose_search_terms.csv",
    "- fat_parent_search_terms.csv",
    "- broad_m_search_terms.csv — campaign exactly GG - Lip Balm - Broad M",
    "- keyword_targets.csv — bid/state per keyword_id; Today config-only; L2/L7 attributed to the serving keyword (not copied across match types)",
    "- advertised_product_l7.csv — L7 by ASIN from campaign names. No advertised-product report is synced; mixed-ASIN spend is campaign-level (not split).",
    sqpLine,
    "- negatives_snapshot.csv — optional",
    "- README.txt — this file",
    "",
    `Pack files: ${input.files.join(", ")}`,
    "",
    "Placement shares on L2/L7 come from ads_placement_daily. If spend exists but shares are empty, cm_note says placement report lag.",
    "FLAVOR_SHELL = Orange / Assorted / Peppermint / Unscented 1-keyword Exact campaigns discovered from ads_campaign_meta (not invented).",
    "",
  ].join("\n");
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
}): { files: { name: string; body: string }[]; filename: string } {
  const today = input.today || input.asOf;
  const asOf = input.asOf;
  const closed = packClosedEnd(today, asOf);
  const targets = input.keywordTargets ?? [];
  const ledger = input.ledger ?? [];
  const watch = watchCampaignExportRows({
    asOf,
    today,
    campaigns: input.campaigns,
    placements: input.placements,
    campaignMeta: input.campaignMeta,
  });
  const autoTerms = searchTermExportRows(
    input.searchTerms, input.campaigns, closed, isAutoLoose, targets, ledger);
  const fatTerms = searchTermExportRows(
    input.searchTerms, input.campaigns, closed, isFatParent, targets, ledger);
  const broadTerms = searchTermExportRows(
    input.searchTerms, input.campaigns, closed, isBroadM, targets, ledger);
  const keywords = keywordTargetExportRows({
    today, asOf, keywordTargets: targets, searchTerms: input.searchTerms,
  });
  const advertised = advertisedProductL7Rows({
    today, asOf, campaigns: input.campaigns,
    campaignMeta: input.campaignMeta, asinCatalog: input.asinCatalog,
  });
  const files = [
    { name: "watch_campaigns.csv", body: watchCampaignsCsv(watch) },
    { name: "auto_loose_search_terms.csv", body: autoLooseSearchTermsCsv(autoTerms) },
    { name: "fat_parent_search_terms.csv", body: autoLooseSearchTermsCsv(fatTerms) },
    { name: "broad_m_search_terms.csv", body: autoLooseSearchTermsCsv(broadTerms) },
    { name: "keyword_targets.csv", body: keywordTargetsCsv(keywords) },
    { name: "advertised_product_l7.csv", body: advertisedProductL7Csv(advertised) },
  ];
  const sqp = sqpWeeklySliceRows(input.sqpWeekly ?? []);
  if (sqp.length) {
    files.push({ name: "sqp_weekly_slice.csv", body: sqpWeeklySliceCsv(sqp) });
  }
  if (input.negatives && input.negatives.length) {
    const wanted = input.negatives.filter((n) =>
      isAutoLoose(n.campaign_name) || isFatParent(n.campaign_name)
      || isNewExact(n.campaign_name) || isBroadM(n.campaign_name));
    if (wanted.length) {
      files.push({ name: "negatives_snapshot.csv", body: negativesSnapshotCsv(wanted) });
    }
  }
  files.push({
    name: "README.txt",
    body: gnoPackReadme({
      files: files.map((f) => f.name).concat("README.txt"),
      sqpIncluded: sqp.length > 0,
    }),
  });
  return { files, filename: `gno-pack-${gnoPackStamp(input.now)}.zip` };
}
