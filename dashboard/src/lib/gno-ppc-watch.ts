/**
 * GNO PPC Watch — observe + export + alert only.
 *
 * Hard-coded Tallowbourn SP watchlists from Dave's 7 Sep 2026 Grok spec.
 * Never pause, negate, raise bids, or raise budgets. Clicking a harvest
 * row only queues it for the next Export GNO pack.
 */

import spec from "../../config/gno_ppc_watch.json";
import { shiftDays, windowStart } from "./as-of";
import {
  applyHarvestLearning,
  lastCallForCampaign,
  type GnoLedgerRow,
} from "./gno-learning";

export const GNO_OBSERVE_ONLY = true as const;

export const WATCH_CAMPAIGN_CSV_HEADERS = [
  "date_start", "date_end", "campaign_name", "state", "portfolio",
  "daily_budget", "tos_pct", "ros_pct", "pp_pct", "impressions",
  "clicks", "spend", "cpc", "orders", "sales", "acos", "watch_list",
] as const;

export const AUTO_LOOSE_TERM_CSV_HEADERS = [
  "campaign_name", "customer_search_term", "match_type", "impressions",
  "clicks", "spend", "orders", "sales", "acos", "cvr",
  "has_enabled_exact_elsewhere", "proposed_tag",
] as const;

export const NEGATIVES_CSV_HEADERS = [
  "campaign_name", "keyword", "match_type",
] as const;

export type WatchList = "NEW_EXACT" | "KEEPER" | "DAY5_PAUSE" | "OTHER";
export type ProposedTag = "KEEP" | "HARVEST_CANDIDATE" | "JUNK_CANDIDATE";
export type AlertPriority = "P0" | "P1" | "P2";

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
  tos_pct: number | null;
  ros_pct: number | null;
  pp_pct: number | null;
}

export interface NewExactTile {
  campaign_name: string;
  keyword: string;
  family: "lip_3pk" | "deo" | "balm" | "other";
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
  zero_impr_after_24h: boolean;
  over_shell_budget: boolean;
  /** Last Dave/Grok bid call from the ledger. Observe only. */
  last_call?: "hold" | "bid_down" | "bid_up" | null;
}

export interface KeeperHeartbeat {
  campaign_name: string;
  role: "auto_loose" | "fat_parent" | "hero_chapstick";
  state: string;
  enabled: boolean;
  daily_budget: number | null;
  spend_today: number;
  spend_l7: number;
  spend_l7_avg: number;
  acos_l7: number | null;
  sparkline: number[];
}

export interface HarvestTerm {
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
  /** UI-only. Not a CSV column. */
  learning_note?: string;
}

export interface WatchCampaignExportRow {
  date_start: string;
  date_end: string;
  campaign_name: string;
  state: string;
  portfolio: string;
  daily_budget: number | null;
  tos_pct: number | null;
  ros_pct: number | null;
  pp_pct: number | null;
  impressions: number;
  clicks: number;
  spend: number;
  cpc: number;
  orders: number;
  sales: number;
  acos: number | null;
  watch_list: WatchList;
}

export const GNO_SPEC = spec;

export const KEEP_ALIVE = spec.keep_alive as readonly string[];
export const NEW_EXACT = spec.new_exact as readonly string[];
export const DAY5_PAUSE = spec.day5_pause as readonly string[];
export const AUTO_LOOSE_NAME = spec.aliases.auto_loose;
export const FAT_PARENT_NAME = spec.aliases.fat_parent;
export const HERO_CHAPSTICK_NAME = spec.aliases.hero_chapstick;
export const AUTO_LOOSE_BUDGET = spec.auto_loose_budget;
export const NEW_EXACT_SPEND_ALERT = spec.new_exact_zero_order_spend_alert;
export const SHELL_DAILY_BUDGET_CAP = spec.shell_daily_budget_cap;
export const LIP_BE_ACOS = spec.family_break_even_acos.lip_3pk;
export const DEO_BE_ACOS = spec.family_break_even_acos.deo;
export const BALM_BE_ACOS = spec.family_break_even_acos.balm;
export const CORE_NEGATIVES = spec.core_negatives as readonly string[];
export const GNO_LAUNCHED_AT = spec.launched_at;
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

/** Collapse whitespace so Dave's extra-space names still match stored rows. */
export function watchListOf(campaignName: string): WatchList {
  if (NEW_EXACT.some((n) => namesEqual(n, campaignName))) return "NEW_EXACT";
  if (KEEP_ALIVE.some((n) => namesEqual(n, campaignName))) return "KEEPER";
  if (DAY5_PAUSE.some((n) => namesEqual(n, campaignName) || nameContains(campaignName, n))) {
    return "DAY5_PAUSE";
  }
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

export function familyOf(campaignName: string): "lip_3pk" | "deo" | "balm" | "other" {
  const n = normalizeName(campaignName);
  if (n.includes("deo") || n.includes("deodorant")) return "deo";
  if (n.includes("3pck") || n.includes("3 pack") || n.includes("b0clhtky3v")) return "lip_3pk";
  if (n.includes("lip") || n.includes("balm") || n.includes("chapstick")) return "lip_3pk";
  return "other";
}

export function breakEvenAcosOf(campaignName: string): number {
  const fam = familyOf(campaignName);
  if (fam === "deo") return DEO_BE_ACOS;
  if (fam === "balm") return BALM_BE_ACOS;
  return LIP_BE_ACOS;
}

export function hoursSinceLaunch(now: Date = new Date(), launchedAt = GNO_LAUNCHED_AT): number {
  const start = Date.parse(launchedAt);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, (now.getTime() - start) / 3_600_000);
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
  if (total <= 0) return { tos_pct: null, ros_pct: null, pp_pct: null };
  return {
    tos_pct: (tos / total) * 100,
    ros_pct: (ros / total) * 100,
    pp_pct: (pp / total) * 100,
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
): Set<string> {
  const latest = latestByCampaign(campaignRows.filter((r) => r.date <= asOf));
  const enabled = new Set<string>();
  for (const name of NEW_EXACT) {
    const row = latest.get(normalizeName(name));
    if (row && !isEnabledStatus(row.campaign_status) && row.campaign_status) continue;
    const kw = extractExactKeyword(name);
    if (kw) enabled.add(kw);
  }
  for (const t of termRows) {
    if (!isNewExact(t.campaign_name)) continue;
    const mt = String(t.match_type ?? "").toLowerCase();
    if (mt && mt !== "exact") continue;
    const kw = normalizeTerm(t.keyword || t.search_term);
    if (kw) enabled.add(kw);
  }
  return enabled;
}

export function tagAutoLooseTerm(
  term: { orders: number; spend: number; sales: number; search_term: string },
  hasExact: boolean,
): ProposedTag {
  const acos = term.sales > 0 ? (term.spend / term.sales) * 100 : null;
  if (
    term.orders >= spec.harvest_min_l7_orders
    && acos != null
    && acos <= LIP_BE_ACOS
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
  ledger: GnoLedgerRow[] = [],
): HarvestTerm[] {
  const start = windowStart(asOf, 7);
  const enabled = enabledExactKeywords(campaignRows, termRows, asOf);
  const latest = latestSearchTerms(termRows, start, asOf)
    .filter((r) => isAutoLoose(r.campaign_name));
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
    const hasExact = enabled.has(normalizeTerm(term));
    const base = tagAutoLooseTerm(
      { orders: m.orders, spend: m.spend, sales: m.sales, search_term: term },
      hasExact,
    );
    const learned = applyHarvestLearning(
      base,
      { orders: m.orders, spend: m.spend, search_term: term },
      ledger,
    );
    out.push({
      campaign_name: group[0].campaign_name || AUTO_LOOSE_NAME,
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
    });
  }
  return out.sort((a, b) => b.spend - a.spend);
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
}): GnoAlert[] {
  const { asOf, today, campaigns, searchTerms, placements } = input;
  const now = input.now ?? new Date();
  const hours = hoursSinceLaunch(now);
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

  const harvest = harvestQueue(searchTerms, campaigns, asOf, input.ledger);
  for (const name of NEW_EXACT) {
    const m = sumMetrics(inWindow(rowsForName(campaigns, name), l7start, asOf));
    alerts.push(alert("P1", "NEW_EXACT_DIGEST", "NEW EXACT L7",
      `${name}: impr ${m.impressions}, clicks ${m.clicks}, spend $${m.spend.toFixed(2)}, CPC $${m.cpc.toFixed(2)}, orders ${m.orders}, ACOS ${m.acos == null ? "—" : `${m.acos.toFixed(1)}%`}`,
      { campaign_name: name }));
  }
  for (const name of KEEP_ALIVE) {
    const rows = rowsForName(campaigns, name);
    const l7 = sumMetrics(inWindow(rows, l7start, asOf));
    const todayM = sumMetrics(inWindow(rows, asOf, asOf));
    const avg = l7.spend / 7;
    alerts.push(alert("P1", "KEEPER_DIGEST", "KEEP-ALIVE spend vs 7-day avg",
      `${name}: as-of spend $${todayM.spend.toFixed(2)} vs L7 daily avg $${avg.toFixed(2)}, L7 ACOS ${l7.acos == null ? "—" : `${l7.acos.toFixed(1)}%`}`,
      { campaign_name: name }));
  }
  for (const t of harvest.filter((x) => x.proposed_tag === "HARVEST_CANDIDATE")) {
    alerts.push(alert("P1", "HARVEST_CANDIDATE", "Auto Loose harvest candidate (do not negate)",
      `"${t.customer_search_term}" L7 orders ${t.orders}, ACOS ${t.acos?.toFixed(1)}%, no enabled 1-child Exact. Tag only.`,
      { campaign_name: t.campaign_name, search_term: t.customer_search_term }));
  }
  for (const t of harvest.filter((x) => x.proposed_tag === "JUNK_CANDIDATE")) {
    alerts.push(alert("P1", "JUNK_CANDIDATE", "Auto Loose junk candidate (do not auto-negate)",
      `"${t.customer_search_term}" L7 spend $${t.spend.toFixed(2)}, 0 orders. Flag only.`,
      { campaign_name: t.campaign_name, search_term: t.customer_search_term }));
  }

  const watchNames = [...KEEP_ALIVE, ...NEW_EXACT, ...DAY5_PAUSE];
  for (const name of watchNames) {
    const rows = placements.filter((p) =>
      namesEqual(p.campaign_name, name) || nameContains(p.campaign_name, name));
    const share = placementShares(inWindow(rows, l7start, asOf));
    if (share.pp_pct != null && share.pp_pct > spec.placement_pp_share_alert_pct) {
      const matched = rows[0]?.campaign_name ?? name;
      alerts.push(alert("P1", "PP_SHARE", "Product Page spend share > 25%",
        `${matched} PP share ${share.pp_pct.toFixed(1)}% of L7 placement spend. Observe — do not auto-cut.`,
        { campaign_name: matched }));
    }
  }

  if (now.getTime() >= Date.parse(GNO_NEXT_REVIEW_AT)) {
    alerts.push(alert("P2", "REVIEW_48H", "Wednesday / 48h pack is due",
      `Next human review target ${GNO_NEXT_REVIEW_AT}. Export GNO pack and send to Grok. Observe only.`));
  } else {
    alerts.push(alert("P2", "REVIEW_48H_PENDING", "48h pack pending",
      `New Exact launched ${GNO_LAUNCHED_AT}. Export GNO pack after ${GNO_NEXT_REVIEW_AT}.`));
  }

  return alerts;
}

export function newExactTiles(
  campaigns: CampaignDailyRow[],
  asOf: string,
  now: Date = new Date(),
  ledger: GnoLedgerRow[] = [],
): NewExactTile[] {
  const hours = hoursSinceLaunch(now);
  const latest = latestByCampaign(campaigns);
  const start = windowStart(asOf, 7);
  return NEW_EXACT.map((name) => {
    const rows = rowsForName(campaigns, name);
    const m = sumMetrics(inWindow(rows, start, asOf));
    const snap = lastExplicitStatusRow(campaigns, name)
      ?? latest.get(normalizeName(name));
    const budget = snap?.budget != null ? Number(snap.budget) : null;
    return {
      campaign_name: name,
      keyword: extractExactKeyword(name) ?? "",
      family: familyOf(name),
      state: snap?.campaign_status ?? "",
      daily_budget: budget,
      hours_since_launch: hours,
      impressions: m.impressions,
      clicks: m.clicks,
      spend: m.spend,
      orders: m.orders,
      sales: m.sales,
      cpc: m.cpc,
      acos: m.acos,
      zero_impr_after_24h: hours >= 24 && m.impressions === 0,
      over_shell_budget: budget != null && budget > SHELL_DAILY_BUDGET_CAP,
      last_call: lastCallForCampaign(ledger, name),
    };
  });
}

export function keeperHeartbeats(
  campaigns: CampaignDailyRow[],
  asOf: string,
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
    return {
      campaign_name: name,
      role,
      state: snap?.campaign_status ?? "",
      enabled: isEnabledStatus(snap?.campaign_status),
      daily_budget: snap?.budget != null ? Number(snap.budget) : null,
      spend_today: todayM.spend,
      spend_l7: l7.spend,
      spend_l7_avg: l7.spend / 7,
      acos_l7: l7.acos,
      sparkline: dailySpendSeries(rows, start, asOf),
    };
  });
}

function uniqueWatchNames(campaigns: CampaignDailyRow[]): { name: string; list: WatchList }[] {
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
  for (const r of campaigns) {
    const list = watchListOf(r.campaign_name);
    if (list !== "OTHER") add(r.campaign_name, list);
  }
  return out;
}

export function watchCampaignExportRows(input: {
  asOf: string;
  campaigns: CampaignDailyRow[];
  placements: PlacementRow[];
}): WatchCampaignExportRow[] {
  const { asOf, campaigns, placements } = input;
  const windows = [
    { start: windowStart(asOf, 2), end: asOf },
    { start: windowStart(asOf, 7), end: asOf },
  ];
  const latest = latestByCampaign(campaigns);
  const names = uniqueWatchNames(campaigns);
  const rows: WatchCampaignExportRow[] = [];
  for (const w of windows) {
    for (const { name, list } of names) {
      const campRows = campaigns.filter((r) =>
        namesEqual(r.campaign_name, name) || (list === "DAY5_PAUSE" && nameContains(r.campaign_name, name)));
      const m = sumMetrics(inWindow(campRows, w.start, w.end));
      const place = placementShares(inWindow(
        placements.filter((p) =>
          namesEqual(p.campaign_name, name) || nameContains(p.campaign_name, name)),
        w.start, w.end,
      ));
      const snap = latest.get(normalizeName(campRows[0]?.campaign_name ?? name));
      rows.push({
        date_start: w.start,
        date_end: w.end,
        campaign_name: campRows[0]?.campaign_name ?? name,
        state: snap?.campaign_status ?? "",
        portfolio: "",
        daily_budget: snap?.budget != null ? Number(snap.budget) : null,
        tos_pct: place.tos_pct,
        ros_pct: place.ros_pct,
        pp_pct: place.pp_pct,
        impressions: m.impressions,
        clicks: m.clicks,
        spend: m.spend,
        cpc: m.cpc,
        orders: m.orders,
        sales: m.sales,
        acos: m.acos,
        watch_list: list,
      });
    }
  }
  return rows;
}

export function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "number" && Number.isFinite(value)
    ? (Number.isInteger(value) ? String(value) : value.toFixed(2))
    : String(value);
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
  return toCsv(WATCH_CAMPAIGN_CSV_HEADERS, rows.map((r) => ({
    ...r,
    daily_budget: r.daily_budget,
    tos_pct: r.tos_pct,
    ros_pct: r.ros_pct,
    pp_pct: r.pp_pct,
    acos: r.acos,
  })));
}

export function autoLooseSearchTermsCsv(rows: HarvestTerm[]): string {
  return toCsv(AUTO_LOOSE_TERM_CSV_HEADERS, rows.map((r) => ({
    ...r,
    has_enabled_exact_elsewhere: r.has_enabled_exact_elsewhere,
    acos: r.acos,
    cvr: r.cvr,
  })));
}

export function negativesSnapshotCsv(rows: NegativeRow[]): string {
  return toCsv(NEGATIVES_CSV_HEADERS, rows.map((r) => ({
    campaign_name: r.campaign_name,
    keyword: r.keyword,
    match_type: r.match_type ?? "",
  })));
}

export function buildGnoPack(input: {
  asOf: string;
  campaigns: CampaignDailyRow[];
  searchTerms: SearchTermRow[];
  placements: PlacementRow[];
  negatives?: NegativeRow[] | null;
  ledger?: GnoLedgerRow[];
}): { files: { name: string; body: string }[]; filename: string } {
  const watch = watchCampaignExportRows(input);
  const terms = harvestQueue(input.searchTerms, input.campaigns, input.asOf, input.ledger);
  const files = [
    { name: "watch_campaigns.csv", body: watchCampaignsCsv(watch) },
    { name: "auto_loose_search_terms.csv", body: autoLooseSearchTermsCsv(terms) },
  ];
  if (input.negatives && input.negatives.length) {
    const wanted = input.negatives.filter((n) =>
      isAutoLoose(n.campaign_name) || isFatParent(n.campaign_name) || isNewExact(n.campaign_name));
    if (wanted.length) {
      files.push({ name: "negatives_snapshot.csv", body: negativesSnapshotCsv(wanted) });
    }
  }
  return { files, filename: `gno-pack-${input.asOf}.zip` };
}
