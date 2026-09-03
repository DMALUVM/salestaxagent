/**
 * Bleeders 1.0 — client-safe types and helpers.
 *
 * Live flag math lives in ppc-bleeders-10-live.ts (server-only: brand_terms).
 * This week stays buildBlake63dList. 1.0 is a triage flag list, not an
 * execute list. Nothing writes to Amazon.
 */

export const BLEEDERS_10_VERSION = "1.0";
export const BLEEDERS_10_CLICK_FLOOR = 6;

export const BLEEDERS_10_ACTIONS = ["pause_keyword", "negative_exact"] as const;
export type Bleeders10Action = (typeof BLEEDERS_10_ACTIONS)[number];

export const BLEEDERS_10_REC_TYPES = {
  pause_keyword: "BLEEDER_PAUSE_KEYWORD",
  negative_exact: "BLEEDER_NEGATIVE_EXACT",
} as const;

export interface Bleeders10TermRow {
  date?: string | null;
  search_term?: string | null;
  campaign_id?: string | null;
  campaign_name?: string | null;
  ad_group_id?: string | null;
  ad_group_name?: string | null;
  keyword?: string | null;
  match_type?: string | null;
  spend?: number | null;
  sales_14d?: number | null;
  orders_14d?: number | null;
  clicks?: number | null;
}

export interface Bleeders10CampaignRow {
  date?: string | null;
  campaign_id?: string | null;
  campaign_name?: string | null;
  campaign_type?: string | null;
  campaign_status?: string | null;
  orders_14d?: number | null;
  clicks?: number | null;
}

export interface Bleeders10Decision {
  id?: string | null;
  campaign_id?: string | null;
  search_term?: string | null;
  action_type?: string | null;
  status?: string | null;
  entity_name?: string | null;
  rec_type?: string | null;
}

export interface Bleeders10Row {
  checklist_id: string;
  rank: number;
  action: Bleeders10Action;
  campaign_name: string;
  campaign_id: string;
  ad_group_name: string;
  ad_group_id: string;
  search_term: string;
  keyword: string | null;
  match_type: string;
  clicks: number;
  spend: number;
  sales_14d: number;
  orders: number;
  term_cvr: number;
  account_cvr: number;
  click_floor: number;
  why: string;
  suggested_action: string;
  status: "open" | "done" | "skipped";
  decision_id: string | null;
}

export interface Bleeders10Payload {
  version: "1.0";
  kind: "triage";
  title: string;
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
  account_cvr_nonbranded: number | null;
  click_floor: number;
  gno_floor_overridden: true;
  open_count: number;
  done_count: number;
  skipped_count: number;
  search_term_coverage: "SP-only";
  notes: string[];
  rows: Bleeders10Row[];
}

export function isBleeders10Hit(clicks: number, sales: number, orders: number): boolean {
  return clicks >= BLEEDERS_10_CLICK_FLOOR && sales <= 0 && orders <= 0;
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

function termsEqual(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  return na.length > 0 && na === nb;
}

/**
 * pause_keyword ONLY where search_term equals the exact keyword.
 * Else negative_exact (including TARGETING query ≠ expression).
 * TARGETING query = expression is not 1.0 (would be pause_target).
 */
export function resolveBleeders10Action(
  matchType: string,
  searchTerm: string,
  keyword: string,
): Bleeders10Action | null {
  const mt = String(matchType ?? "").trim();
  if (!mt) return null;
  if (mt.toUpperCase() === "EXACT" && keyword && termsEqual(searchTerm, keyword)) {
    return "pause_keyword";
  }
  if (mt.toUpperCase().startsWith("TARGETING")) {
    if (!keyword) return null;
    if (termsEqual(searchTerm, keyword)) return null;
    return "negative_exact";
  }
  const u = mt.toUpperCase();
  if (u === "EXACT" || u === "PHRASE" || u === "BROAD") return "negative_exact";
  return null;
}

export function recTypeOfBleeders10(action: Bleeders10Action): string {
  return BLEEDERS_10_REC_TYPES[action];
}

export function suggestedActionOf10(row: {
  action: Bleeders10Action;
  campaign_name: string;
  ad_group_name: string;
  search_term: string;
  keyword: string | null;
}): string {
  const camp = `"${row.campaign_name || "?"}"`;
  const ag = row.ad_group_name ? `ad group "${row.ad_group_name}"` : "the ad group";
  if (row.action === "pause_keyword") {
    const kw = row.keyword || row.search_term || "?";
    return `In Campaign Manager, open ${camp} → ${ag} → Keywords, and pause "${kw}". Nothing writes to Amazon from this page.`;
  }
  const term = row.search_term || "?";
  return `In Campaign Manager, open ${camp} → ${ag} → Negative keywords, and add "${term}" as a Negative exact keyword. Nothing writes to Amazon from this page.`;
}

export function windowLabel10(
  start: string,
  end: string,
  days: number,
  daysWithRows: number,
): string {
  return `${start} → ${end} · ${days}d stored · ${daysWithRows} days with rows (sparse) — not 90d`;
}

export function title10(start: string, end: string, accountCvr: number): string {
  return `Bleeders 1.0 · ${start}..${end} · CVR ${accountCvr}% · floor 6`;
}

export function emptyBleeders10(): Bleeders10Payload {
  return {
    version: "1.0",
    kind: "triage",
    title: "Bleeders 1.0 · no stored search terms · floor 6",
    window: {
      as_of: "",
      window_start: "",
      window_end: "",
      window_days: 0,
      days_with_rows: 0,
      label: "No search-term rows stored — not 90d",
    },
    account_cvr: 0,
    account_cvr_source: "ads_campaigns_daily",
    account_cvr_nonbranded: null,
    click_floor: BLEEDERS_10_CLICK_FLOOR,
    gno_floor_overridden: true,
    open_count: 0,
    done_count: 0,
    skipped_count: 0,
    search_term_coverage: "SP-only",
    notes: [
      "Bleeders 1.0 live triage — clicks>=6 AND sales=$0. Not This week.",
      "Blake ranks this pull. Dana loads This week. Nothing writes to Amazon.",
    ],
    rows: [],
  };
}

export const BLEEDERS_10_CSV_HEADERS = [
  "pull_order",
  "action",
  "campaign",
  "campaign_id",
  "ad_group",
  "term",
  "keyword",
  "match_type",
  "clicks",
  "spend",
  "sales",
  "orders",
  "term_cvr_pct",
  "account_cvr_pct",
  "status",
  "why",
  "window_start",
  "window_end",
  "days_inclusive",
  "days_with_rows",
] as const;

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Structured Dashboard pull Blake ranks. Not a This week execute list. */
export function bleeders10ToCsv(list: Bleeders10Payload): string {
  const lines = [BLEEDERS_10_CSV_HEADERS.join(",")];
  for (const r of list.rows) {
    lines.push([
      csvCell(r.rank),
      csvCell(r.action),
      csvCell(r.campaign_name),
      csvCell(r.campaign_id),
      csvCell(r.ad_group_name),
      csvCell(r.search_term),
      csvCell(r.keyword),
      csvCell(r.match_type),
      csvCell(r.clicks),
      csvCell(r.spend.toFixed(2)),
      csvCell(r.sales_14d.toFixed(2)),
      csvCell(r.orders),
      csvCell(r.term_cvr.toFixed(2)),
      csvCell(r.account_cvr.toFixed(2)),
      csvCell(r.status),
      csvCell(r.why),
      csvCell(list.window.window_start),
      csvCell(list.window.window_end),
      csvCell(list.window.window_days),
      csvCell(list.window.days_with_rows),
    ].join(","));
  }
  return lines.join("\n") + "\n";
}
