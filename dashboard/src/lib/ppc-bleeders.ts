/**
 * Bleeder classifier library — not this week's /ppc execute list.
 *
 * GET /api/ppc must not call buildBleeders. This week ships Blake's 24d
 * ranked list via buildBlake24dList. Cut bar is term CVR below that row's
 * lane account CVR (branded vs non-branded). 10/$0 is R3 / a flag.
 *
 * Nothing here writes to Amazon.
 */

import { isBranded, laneOf, type BrandLane } from "./brand-terms";

export const BLEEDER_ACTIONS = [
  "negative_exact",
  "pause_keyword",
  "pause_target",
  // harvest_exact and placement_modifier are later cadence — enum only, not shipped.
  "harvest_exact",
  "placement_modifier",
] as const;

export type BleederAction = (typeof BLEEDER_ACTIONS)[number];
export type ShippedBleederAction = "negative_exact" | "pause_keyword" | "pause_target";

export const BLEEDER_REC_TYPES = {
  negative_exact: "BLEEDER_NEGATIVE_EXACT",
  pause_keyword: "BLEEDER_PAUSE_KEYWORD",
  pause_target: "BLEEDER_PAUSE_TARGET",
} as const;

export type BleederRank = "R1" | "R2" | "R3";
export type BleederStatus = "open" | "done";

export interface BleederTermRow {
  date: string;
  search_term: string;
  campaign_id: string;
  campaign_name?: string;
  ad_group_id?: string;
  ad_group_name?: string;
  keyword?: string;
  match_type?: string;
  spend?: number;
  sales_14d?: number;
  orders_14d?: number;
  clicks?: number;
}

export interface BleederCampaignRow {
  date: string;
  campaign_id: string;
  campaign_name?: string;
  campaign_type?: string;
  campaign_status?: string;
  orders_14d?: number;
  clicks?: number;
}

export interface BleederDecision {
  id?: string;
  entity_name?: string | null;
  status?: string | null;
  rec_type?: string | null;
  campaign_id?: string | null;
}

export interface BleederRow {
  checklist_id: string;
  as_of: string;
  window_start: string;
  window_end: string;
  window_days: number;
  rank: BleederRank;
  action: ShippedBleederAction;
  campaign_name: string;
  campaign_id: string;
  campaign_type: string;
  ad_group_name: string;
  ad_group_id: string;
  search_term: string | null;
  keyword: string | null;
  product_target: string | null;
  match_type: string;
  clicks: number;
  spend: number;
  sales_14d: number;
  orders: number;
  term_cvr: number;
  acos: number | null;
  account_cvr: number;
  account_cvr_branded: number | null;
  account_cvr_nonbranded: number | null;
  lane: BrandLane;
  click_floor: number;
  gno_10_0: boolean;
  why: string;
  priority: "P0" | "P1";
  status: BleederStatus;
  decision_id: string | null;
  suggested_action: string;
}

export interface BleedersPayload {
  window: {
    as_of: string;
    window_start: string;
    window_end: string;
    window_days: number;
    days_with_rows: number;
    label: string;
  };
  account_cvr: number;
  account_cvr_source: "ads_campaigns_daily";
  account_cvr_branded: number | null;
  account_cvr_nonbranded: number | null;
  lane_cvr_source: "ads_search_terms_daily + brand_terms.json";
  click_floor: number;
  open_count: number;
  applied_count: number;
  search_term_coverage: "SP-only";
  notes: string[];
  rows: BleederRow[];
}

export function cvrPct(orders: number, clicks: number): number | null {
  if (clicks <= 0) return null;
  return (orders / clicks) * 100;
}

/**
 * GNO click floor from blended account CVR.
 *   < 4%        → 25
 *   5–10% incl. → 15
 *   otherwise   → 10  (incl. 4–5% where GNO is silent, and >10%)
 */
export function clickFloor(accountCvrPct: number): number {
  if (accountCvrPct < 4) return 25;
  if (accountCvrPct >= 5 && accountCvrPct <= 10) return 15;
  return 10;
}

export function isGnoTenZero(clicks: number, sales: number): boolean {
  return clicks >= 10 && sales <= 0;
}

export function inclusiveDays(start: string, end: string): number {
  const a = Date.parse(`${start}T12:00:00Z`);
  const b = Date.parse(`${end}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

function norm(s: string | null | undefined): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function isTargetingMatch(matchType: string): boolean {
  return matchType.toUpperCase().startsWith("TARGETING");
}

export function isKeywordMatch(matchType: string): boolean {
  const u = matchType.toUpperCase();
  return u === "EXACT" || u === "PHRASE" || u === "BROAD";
}

function termsEqual(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  return na.length > 0 && na === nb;
}

/**
 * pause KW/PT only where search_term equals the exact keyword / targeting
 * expression. Auto close-match queries (TARGETING_* with a different
 * customer query) are negative_exact — do not invent a targets table.
 */
export function resolveBleederAction(
  matchType: string,
  searchTerm: string,
  keyword: string,
): ShippedBleederAction | null {
  const mt = String(matchType ?? "").trim();
  if (!mt) return null;
  if (isTargetingMatch(mt)) {
    if (keyword && termsEqual(searchTerm, keyword)) return "pause_target";
    if (keyword && !termsEqual(searchTerm, keyword)) return "negative_exact";
    // Targeting expression lives on the search_term when keyword is blank.
    return searchTerm ? "pause_target" : null;
  }
  if (mt.toUpperCase() === "EXACT" && keyword && termsEqual(searchTerm, keyword)) {
    return "pause_keyword";
  }
  if (isKeywordMatch(mt)) return "negative_exact";
  return null;
}

export function recTypeOf(action: ShippedBleederAction): string {
  return BLEEDER_REC_TYPES[action];
}

export function checklistId(parts: {
  windowEnd: string;
  campaignId: string;
  adGroupId: string;
  termKey: string;
  matchType: string;
  action: string;
}): string {
  return [
    parts.windowEnd,
    parts.campaignId,
    parts.adGroupId,
    parts.termKey,
    parts.matchType.toUpperCase(),
    parts.action,
  ].join("|");
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function pct(n: number): string {
  return `${round1(n)}%`;
}

function latestCampaigns(rows: BleederCampaignRow[]): Map<string, {
  status: string; type: string; name: string; date: string;
}> {
  const out = new Map<string, { status: string; type: string; name: string; date: string }>();
  for (const r of rows) {
    const id = String(r.campaign_id ?? "");
    if (!id) continue;
    const date = String(r.date ?? "");
    const prev = out.get(id);
    if (prev && date && prev.date && date < prev.date) continue;
    out.set(id, {
      status: String(r.campaign_status ?? "").toUpperCase(),
      type: String(r.campaign_type ?? "").trim().toUpperCase() || "SP",
      name: String(r.campaign_name ?? ""),
      date,
    });
  }
  return out;
}

function campaignWindowTotals(rows: BleederCampaignRow[], start: string, end: string): {
  orders: number; clicks: number;
} {
  let orders = 0;
  let clicks = 0;
  for (const r of rows) {
    const d = String(r.date ?? "");
    if (!d || d < start || d > end) continue;
    orders += Number(r.orders_14d ?? 0);
    clicks += Number(r.clicks ?? 0);
  }
  return { orders, clicks };
}

interface Agg {
  search_term: string;
  campaign_id: string;
  campaign_name: string;
  ad_group_id: string;
  ad_group_name: string;
  keyword: string;
  match_type: string;
  spend: number;
  sales: number;
  orders: number;
  clicks: number;
}

function aggKey(r: BleederTermRow): string {
  return [
    norm(r.search_term),
    String(r.campaign_id ?? ""),
    String(r.ad_group_id ?? ""),
    String(r.match_type ?? "").toUpperCase(),
  ].join("\u241F");
}

export function suggestedActionOf(row: {
  action: ShippedBleederAction;
  campaign_name: string;
  ad_group_name: string;
  search_term: string | null;
  keyword: string | null;
  product_target: string | null;
}): string {
  const camp = `"${row.campaign_name || "?"}"`;
  const ag = row.ad_group_name ? `ad group "${row.ad_group_name}"` : "the ad group";
  if (row.action === "pause_target") {
    const t = row.product_target || row.search_term || "?";
    return `In Campaign Manager, open ${camp} → ${ag} → Targeting, and pause "${t}". Do not write this from the API — mark the checkbox after you pause it.`;
  }
  if (row.action === "pause_keyword") {
    const kw = row.keyword || row.search_term || "?";
    return `In Campaign Manager, open ${camp} → ${ag} → Keywords, and pause "${kw}". Do not write this from the API — mark the checkbox after you pause it.`;
  }
  const term = row.search_term || "?";
  return `In Campaign Manager, open ${camp} → ${ag} → Negative keywords, and add "${term}" as a Negative exact keyword. Nothing writes to Amazon from this page — mark the checkbox after you add it.`;
}

function whyLine(args: {
  termCvr: number;
  laneCvr: number;
  lane: BrandLane;
  clicks: number;
  orders: number;
  sales: number;
  gno: boolean;
}): string {
  const delta = args.termCvr - args.laneCvr;
  const lane = args.lane === "branded" ? "branded" : "non-branded";
  const salesBit = args.sales <= 0
    ? "$0 sales"
    : `${args.orders} order(s), ${usd(args.sales)} sales`;
  const gno = args.gno ? " GNO 10/$0." : "";
  return `Term CVR ${pct(args.termCvr)} vs ${lane} account CVR ${pct(args.laneCvr)} (${delta >= 0 ? "+" : ""}${round1(delta)} pts) on ${args.clicks} clicks, ${salesBit}.${gno}`;
}

export function emptyBleeders(): BleedersPayload {
  return {
    window: {
      as_of: "", window_start: "", window_end: "", window_days: 0,
      days_with_rows: 0, label: "No search-term rows stored",
    },
    account_cvr: 0,
    account_cvr_source: "ads_campaigns_daily",
    account_cvr_branded: null,
    account_cvr_nonbranded: null,
    lane_cvr_source: "ads_search_terms_daily + brand_terms.json",
    click_floor: 10,
    open_count: 0,
    applied_count: 0,
    search_term_coverage: "SP-only",
    notes: [
      "Search-term reports are SP-only. SB/SD terms will be thin or missing.",
      "Window is the days actually stored — not a fake 60d.",
    ],
    rows: [],
  };
}

export function buildBleeders(
  termRows: BleederTermRow[],
  campaignRows: BleederCampaignRow[],
  decisions: BleederDecision[] = [],
): BleedersPayload {
  const dates = termRows.map((r) => String(r.date ?? "")).filter(Boolean).sort();
  if (dates.length === 0) return emptyBleeders();

  const windowStart = dates[0];
  const windowEnd = dates[dates.length - 1];
  const daysWithRows = new Set(dates).size;
  const windowDays = inclusiveDays(windowStart, windowEnd);
  const asOf = windowEnd;

  const campTotals = campaignWindowTotals(campaignRows, windowStart, windowEnd);
  const accountCvr = cvrPct(campTotals.orders, campTotals.clicks) ?? 0;
  const floor = clickFloor(accountCvr);

  let brandedOrders = 0, brandedClicks = 0;
  let nonOrders = 0, nonClicks = 0;
  for (const r of termRows) {
    const clicks = Number(r.clicks ?? 0);
    const orders = Number(r.orders_14d ?? 0);
    if (isBranded(String(r.search_term ?? ""))) {
      brandedOrders += orders;
      brandedClicks += clicks;
    } else {
      nonOrders += orders;
      nonClicks += clicks;
    }
  }
  const brandedCvr = cvrPct(brandedOrders, brandedClicks);
  const nonCvr = cvrPct(nonOrders, nonClicks);

  const latest = latestCampaigns(campaignRows);
  const byKey = new Map<string, Agg>();
  for (const r of termRows) {
    const d = String(r.date ?? "");
    if (!d || d < windowStart || d > windowEnd) continue;
    const term = String(r.search_term ?? "");
    if (!term) continue;
    const key = aggKey(r);
    let e = byKey.get(key);
    if (!e) {
      e = {
        search_term: term,
        campaign_id: String(r.campaign_id ?? ""),
        campaign_name: String(r.campaign_name ?? ""),
        ad_group_id: String(r.ad_group_id ?? ""),
        ad_group_name: String(r.ad_group_name ?? ""),
        keyword: String(r.keyword ?? ""),
        match_type: String(r.match_type ?? ""),
        spend: 0, sales: 0, orders: 0, clicks: 0,
      };
      byKey.set(key, e);
    }
    e.spend += Number(r.spend ?? 0);
    e.sales += Number(r.sales_14d ?? 0);
    e.orders += Number(r.orders_14d ?? 0);
    e.clicks += Number(r.clicks ?? 0);
    if (!e.keyword && r.keyword) e.keyword = String(r.keyword);
    if (!e.ad_group_name && r.ad_group_name) e.ad_group_name = String(r.ad_group_name);
    if (!e.campaign_name && r.campaign_name) e.campaign_name = String(r.campaign_name);
  }

  const decisionByEntity = new Map<string, BleederDecision>();
  for (const d of decisions) {
    const name = String(d.entity_name ?? "");
    if (name) decisionByEntity.set(name, d);
  }

  const rows: BleederRow[] = [];
  for (const e of byKey.values()) {
    const camp = latest.get(e.campaign_id);
    // Enabled only. Blank status is a pre-status-column row — do not drop it
    // (an 8/26 SB/SD hole must not hide an SP campaign that is still live).
    if (!camp || (camp.status && camp.status !== "ENABLED")) continue;

    const action = resolveBleederAction(e.match_type, e.search_term, e.keyword);
    if (!action) continue;

    const termCvr = cvrPct(e.orders, e.clicks);
    if (termCvr === null) continue;
    if (e.clicks < floor) continue;

    const lane = laneOf(e.search_term);
    const laneCvr = lane === "branded" ? brandedCvr : nonCvr;
    if (laneCvr === null) continue;
    if (termCvr >= laneCvr) continue;

    const gno = isGnoTenZero(e.clicks, e.sales);
    const rank: BleederRank = e.sales <= 0 ? "R1" : "R2";
    const priority: "P0" | "P1" = e.sales <= 0 ? "P0" : "P1";
    const termKey = norm(e.search_term);
    const id = checklistId({
      windowEnd, campaignId: e.campaign_id, adGroupId: e.ad_group_id,
      termKey, matchType: e.match_type, action,
    });
    const decision = decisionByEntity.get(id);
    const applied = (decision?.status ?? "") === "applied";
    const productTarget = action === "pause_target" ? (e.keyword || e.search_term) : null;
    const searchTermOut = action === "pause_target" ? null : e.search_term;
    const keywordOut = action === "pause_keyword" ? (e.keyword || e.search_term) : (e.keyword || null);
    const draft = {
      action,
      campaign_name: e.campaign_name || camp.name,
      ad_group_name: e.ad_group_name,
      search_term: searchTermOut,
      keyword: keywordOut,
      product_target: productTarget,
    };

    rows.push({
      checklist_id: id,
      as_of: asOf,
      window_start: windowStart,
      window_end: windowEnd,
      window_days: windowDays,
      rank,
      action,
      campaign_name: draft.campaign_name,
      campaign_id: e.campaign_id,
      campaign_type: camp.type,
      ad_group_name: e.ad_group_name,
      ad_group_id: e.ad_group_id,
      search_term: draft.search_term,
      keyword: draft.keyword,
      product_target: draft.product_target,
      match_type: e.match_type,
      clicks: e.clicks,
      spend: round2(e.spend),
      sales_14d: round2(e.sales),
      orders: e.orders,
      term_cvr: round2(termCvr),
      acos: e.sales > 0 ? round1((e.spend / e.sales) * 100) : null,
      account_cvr: round2(accountCvr),
      account_cvr_branded: brandedCvr === null ? null : round2(brandedCvr),
      account_cvr_nonbranded: nonCvr === null ? null : round2(nonCvr),
      lane,
      click_floor: floor,
      gno_10_0: gno,
      why: whyLine({
        termCvr, laneCvr, lane, clicks: e.clicks,
        orders: e.orders, sales: e.sales, gno,
      }),
      priority,
      status: applied ? "done" : "open",
      decision_id: decision?.id ? String(decision.id) : null,
      suggested_action: suggestedActionOf(draft),
    });
  }

  rows.sort((a, b) =>
    (a.priority === "P0" ? 0 : 1) - (b.priority === "P0" ? 0 : 1)
    || Number(b.gno_10_0) - Number(a.gno_10_0)
    || b.spend - a.spend
    || b.clicks - a.clicks);

  const appliedCount = rows.filter((r) => r.status === "done").length;
  const notes = [
    `Search terms stored ${windowStart} → ${windowEnd} (${windowDays} calendar days, ${daysWithRows} days with rows). Not 60d — Sunday 03:30 ET 90d search-term backfill extends this after it lands on mini main.`,
    "Search-term reports are SP-only (spSearchTerm). SB/SD terms will be thin or missing. Occasional SB/SD campaign holes (e.g. 8/26) do not block this list.",
    `Blended account CVR ${round2(accountCvr)}% is ads_campaigns_daily orders/clicks over the same window. Lane CVRs are search terms classified by config/brand_terms.json (computed, not the 35.6/25.6 hunch).`,
    "Checking a box records applied on ads_action_decisions. Nothing writes to Amazon.",
  ];

  return {
    window: {
      as_of: asOf,
      window_start: windowStart,
      window_end: windowEnd,
      window_days: windowDays,
      days_with_rows: daysWithRows,
      label: `${windowStart} → ${windowEnd} · ${windowDays}d stored (not 60d)`,
    },
    account_cvr: round2(accountCvr),
    account_cvr_source: "ads_campaigns_daily",
    account_cvr_branded: brandedCvr === null ? null : round2(brandedCvr),
    account_cvr_nonbranded: nonCvr === null ? null : round2(nonCvr),
    lane_cvr_source: "ads_search_terms_daily + brand_terms.json",
    click_floor: floor,
    open_count: rows.length - appliedCount,
    applied_count: appliedCount,
    search_term_coverage: "SP-only",
    notes,
    rows,
  };
}

export function bleedersToCsv(rows: BleederRow[]): string {
  const headers = [
    "checklist_id", "as_of", "window_start", "window_end", "window_days",
    "rank", "action", "campaign_name", "campaign_id", "ad_group_name",
    "ad_group_id", "search_term", "keyword", "product_target", "match_type",
    "clicks", "spend", "sales_14d", "orders", "term_cvr", "acos",
    "account_cvr", "account_cvr_branded", "account_cvr_nonbranded", "lane",
    "click_floor", "gno_10_0", "why", "priority", "status",
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => esc((r as unknown as Record<string, unknown>)[h])).join(","));
  }
  return lines.join("\n");
}
