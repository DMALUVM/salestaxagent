/**
 * Bleeders 1.0 — pasted 10-row triage. Locked until Monday.
 *
 * GET /api/ppc ships this as `bleeders10`. This week is Recovery
 * (buildBlakeRecovery0905List, 66 rows). Do not re-aggregate. Do not
 * expand to 22. Cap 10. Increment not tonight. No 2.0. Nothing writes
 * to Amazon.
 */

import type { WeeklyLockDecision } from "./ppc-weekly";

export const BLEEDERS_10_VERSION = "1.0";
export const BLEEDERS_10_CLICK_FLOOR = 6;
export const BLEEDERS_10_CAP = 10;
export const BLEEDERS_10_START = "2026-06-30";
export const BLEEDERS_10_END = "2026-08-31";
export const BLEEDERS_10_NONBRAND_CVR = 25.79;
export const BLEEDERS_10_TITLE =
  "Bleeders 1.0 · 2026-06-30..08-31 · nonbrand ST CVR 25.79% · floor 6";
export const BLEEDERS_10_WINDOW_LABEL =
  "2026-06-30..08-31 (63d, SP search terms)";

export const BLEEDERS_10_ACTIONS = ["pause_keyword", "negative_exact"] as const;
export type Bleeders10Action = (typeof BLEEDERS_10_ACTIONS)[number];

export const BLEEDERS_10_REC_TYPES = {
  pause_keyword: "BLEEDER_PAUSE_KEYWORD",
  negative_exact: "BLEEDER_NEGATIVE_EXACT",
} as const;

/** Confirmed skips — do not load on 1.0 tonight. */
export const BLEEDERS_10_SKIP_TERMS = [
  "primal essence deodorant",
  "tallowbourne deodorant",
  "b0c3kw5vjr",
  "tallow balm for lips",
] as const;

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
  account_cvr_source: "nonbrand search-term CVR";
  click_floor: number;
  gno_floor_overridden: true;
  open_count: number;
  done_count: number;
  skipped_count: number;
  search_term_coverage: "SP-only";
  notes: string[];
  rows: Bleeders10Row[];
}

interface Spec {
  rank: number;
  action: Bleeders10Action;
  campaign: string;
  ad_group: string;
  term: string;
  keyword: string | null;
  match_type: string;
  clicks: number;
  spend: number;
  why: string;
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

function specs(): Spec[] {
  const floor = "Nonbrand search-term CVR 25.79% (~1-in-4). Click floor 6 (1.5×). Window 2026-06-30..08-31 (63d, SP search terms).";
  return [
    {
      rank: 1, action: "pause_keyword",
      campaign: "GG - Deodorant - Exact - SQR - CST", ad_group: "Exact",
      term: "deodorant men", keyword: "deodorant men", match_type: "EXACT",
      clicks: 96, spend: 113.18,
      why: `Exact KW = term. $0 on 96 clicks / $113.18. Pause the keyword. ${floor}`,
    },
    {
      rank: 2, action: "negative_exact",
      campaign: "GG - B0CLHYY3BB - Deodorant - Asin Defense", ad_group: "Asin Defense",
      term: "carpe deodorant", keyword: 'asin="B0CLHYY3BB"', match_type: "TARGETING_EXPRESSION",
      clicks: 42, spend: 78.66,
      why: `Customer query ≠ targeting expression. $0 on 42 clicks / $78.66. Add negative exact. ${floor}`,
    },
    {
      rank: 3, action: "pause_keyword",
      campaign: "GG - SP - KW - Tallow Balm - B0CLF5B27Y - Exact 4", ad_group: "Exact",
      term: "beef tallow moisturizer", keyword: "beef tallow moisturizer", match_type: "EXACT",
      clicks: 31, spend: 59.40,
      why: `Exact KW = term. $0 on 31 clicks / $59.40. Pause the keyword. ${floor}`,
    },
    {
      rank: 4, action: "negative_exact",
      campaign: "GG - Lip Balm - Asin Offense", ad_group: "Asin Offense",
      term: "dr dans cortibalm lip balm", keyword: 'asin="B00PX0ARAK"', match_type: "TARGETING_EXPRESSION",
      clicks: 32, spend: 58.55,
      why: `Customer query ≠ targeting expression. $0 on 32 clicks / $58.55. Add negative exact. ${floor}`,
    },
    {
      rank: 5, action: "negative_exact",
      campaign: "GG - Deodorant - Exact - Low Volume", ad_group: "Exact",
      term: "vanmans deodorant", keyword: "vanman deodorant", match_type: "EXACT",
      clicks: 38, spend: 42.78,
      why: `Exact KW=vanman deodorant (NOT equal). $0 on 38 clicks / $42.78. Add negative exact. ${floor}`,
    },
    {
      rank: 6, action: "negative_exact",
      campaign: "SP - KW - Exact - Tallow Balm MAG", ad_group: "",
      term: "beef tallow and honey balm", keyword: "beef tallow honey balm", match_type: "EXACT",
      clicks: 24, spend: 42.37,
      why: `Exact KW=beef tallow honey balm (NOT equal). $0 on 24 clicks / $42.37. Add negative exact. ${floor}`,
    },
    {
      rank: 7, action: "negative_exact",
      campaign: "GG - Lip Balm - Broad M", ad_group: "Broad",
      term: "coconut oil lip balm", keyword: "+lip +moisturizer", match_type: "BROAD",
      clicks: 21, spend: 40.93,
      why: `Broad query ≠ expression. $0 on 21 clicks / $40.93. Add negative exact. ${floor}`,
    },
    {
      rank: 8, action: "negative_exact",
      campaign: "SP Auto Deo close-match", ad_group: "close-match",
      term: "wild deodorant", keyword: "close-match", match_type: "TARGETING_EXPRESSION_PREDEFINED",
      clicks: 35, spend: 31.18,
      why: `Auto close-match (query ≠ expression). $0 on 35 clicks / $31.18. Add negative exact. ${floor}`,
    },
    {
      rank: 9, action: "negative_exact",
      campaign: "GG Lip Balm Exact Long/Low", ad_group: "Exact",
      term: "goats milk chapstick", keyword: "goat milk chapstick", match_type: "EXACT",
      clicks: 18, spend: 29.27,
      why: `Exact KW=goat milk chapstick (NOT equal). $0 on 18 clicks / $29.27. Add negative exact. ${floor}`,
    },
    {
      rank: 10, action: "pause_keyword",
      campaign: "GG Tallow Balm Exact 2", ad_group: "Exact",
      term: "tallow balm for face", keyword: "tallow balm for face", match_type: "EXACT",
      clicks: 14, spend: 28.48,
      why: `Exact KW = term. $0 on 14 clicks / $28.48. Pause the keyword. ${floor}`,
    },
  ];
}

function checklistId(spec: Spec, campaignId: string): string {
  return [
    "b10",
    BLEEDERS_10_END,
    campaignId || spec.campaign,
    norm(spec.term),
    spec.action,
    String(spec.rank),
  ].join("|");
}

function decisionStatus(
  spec: Spec,
  campaignId: string,
  id: string,
  decisions: Bleeders10Decision[],
): { status: Bleeders10Row["status"]; decision_id: string | null } {
  const term = norm(spec.term);
  let hit: Bleeders10Decision | undefined;
  for (const d of decisions) {
    if (String(d.entity_name ?? "") === id) { hit = d; break; }
  }
  if (!hit) {
    for (const d of decisions) {
      if (norm(d.search_term) !== term) continue;
      if (String(d.action_type ?? "") !== spec.action) continue;
      const cid = String(d.campaign_id ?? "");
      if (campaignId && cid && cid !== campaignId && cid !== spec.campaign) continue;
      hit = d;
      break;
    }
  }
  const st = String(hit?.status ?? "");
  if (st === "applied") return { status: "done", decision_id: hit?.id ? String(hit.id) : null };
  if (st === "dismissed") return { status: "skipped", decision_id: hit?.id ? String(hit.id) : null };
  return { status: "open", decision_id: hit?.id ? String(hit.id) : null };
}

export function emptyBleeders10(): Bleeders10Payload {
  return {
    version: "1.0",
    title: BLEEDERS_10_TITLE,
    window: {
      as_of: BLEEDERS_10_END,
      window_start: BLEEDERS_10_START,
      window_end: BLEEDERS_10_END,
      window_days: 63,
      days_with_rows: 23,
      label: BLEEDERS_10_WINDOW_LABEL,
    },
    account_cvr: BLEEDERS_10_NONBRAND_CVR,
    account_cvr_source: "nonbrand search-term CVR",
    click_floor: BLEEDERS_10_CLICK_FLOOR,
    gno_floor_overridden: true,
    open_count: 0,
    done_count: 0,
    skipped_count: 0,
    search_term_coverage: "SP-only",
    notes: [
      "Bleeders 1.0 — pasted 10. Not This week's Recovery execute list.",
      BLEEDERS_10_WINDOW_LABEL,
      "Nonbrand search-term CVR 25.79% (~1-in-4). Click floor 6 (1.5×).",
    ],
    rows: [],
  };
}

export function buildBleeders10(input: {
  decisions?: Array<Bleeders10Decision | WeeklyLockDecision>;
} = {}): Bleeders10Payload {
  const decisions = (input.decisions ?? []) as Bleeders10Decision[];
  const skip = new Set(BLEEDERS_10_SKIP_TERMS.map(norm));

  const rows: Bleeders10Row[] = specs().slice(0, BLEEDERS_10_CAP).map((spec) => {
    if (skip.has(norm(spec.term))) {
      throw new Error(`Bleeders 1.0 skip list leaked: ${spec.term}`);
    }
    const campaignName = spec.campaign;
    const campaignId = spec.campaign;
    const adGroup = spec.ad_group;
    const id = checklistId(spec, campaignId);
    const marked = decisionStatus(spec, campaignId, id, decisions);
    const keyword = spec.action === "pause_keyword" ? (spec.keyword || spec.term) : spec.keyword;
    const draft = {
      action: spec.action,
      campaign_name: campaignName,
      ad_group_name: adGroup,
      search_term: spec.term,
      keyword,
    };
    return {
      checklist_id: id,
      rank: spec.rank,
      action: spec.action,
      campaign_name: campaignName,
      campaign_id: campaignId,
      ad_group_name: adGroup,
      ad_group_id: "",
      search_term: spec.term,
      keyword,
      match_type: spec.match_type,
      clicks: spec.clicks,
      spend: spec.spend,
      sales_14d: 0,
      orders: 0,
      term_cvr: 0,
      account_cvr: BLEEDERS_10_NONBRAND_CVR,
      click_floor: BLEEDERS_10_CLICK_FLOOR,
      why: spec.why,
      suggested_action: suggestedActionOf10(draft),
      status: marked.status,
      decision_id: marked.decision_id,
    };
  });

  const done_count = rows.filter((r) => r.status === "done").length;
  const skipped_count = rows.filter((r) => r.status === "skipped").length;

  return {
    version: "1.0",
    title: BLEEDERS_10_TITLE,
    window: {
      as_of: BLEEDERS_10_END,
      window_start: BLEEDERS_10_START,
      window_end: BLEEDERS_10_END,
      window_days: 63,
      days_with_rows: 23,
      label: BLEEDERS_10_WINDOW_LABEL,
    },
    account_cvr: BLEEDERS_10_NONBRAND_CVR,
    account_cvr_source: "nonbrand search-term CVR",
    click_floor: BLEEDERS_10_CLICK_FLOOR,
    gno_floor_overridden: true,
    open_count: rows.length - done_count - skipped_count,
    done_count,
    skipped_count,
    search_term_coverage: "SP-only",
    notes: [
      "Bleeders 1.0 — pasted 10 tonight. Not This week's Recovery execute list. Cap 10. Do not expand to 22.",
      "Window 2026-06-30..08-31 (63d, SP search terms).",
      "Nonbrand search-term CVR 25.79% (~1-in-4). Click floor 6 (1.5×).",
      "pause_keyword iff term = exact KW; else negative_exact.",
      "Skip branded $0: primal essence deodorant. tallowbourne deodorant is a confirmed skip (brand misspell — defend). Increment rows (b0c3kw5vjr, tallow balm for lips) hold for Monday.",
      "Done/Skipped records ads_action_decisions. Nothing writes to Amazon.",
    ],
    rows,
  };
}
