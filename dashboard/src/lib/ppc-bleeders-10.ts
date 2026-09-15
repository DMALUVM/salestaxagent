/**
 * Bleeders 1.0 — pasted 10-row triage. Locked until Monday.
 *
 * GET /api/ppc ships this as `bleeders10`. This week is Recovery
 * (buildBlakeRecovery0905List, 66 rows). Do not re-aggregate. Do not
 * expand to 22. Cap 10. Increment not tonight. No 2.0. Nothing writes
 * to Amazon.
 */

import type { WeeklyLockDecision } from "./ppc-weekly";
import {
  reconcileBleeders10Row,
  summarizeBleeders10Ads,
  type Bleeders10AdsSnapshot,
  type Bleeders10AppliedSource,
  type Bleeders10AdsSummary,
} from "./ppc-bleeders-10-ads";

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

/** One-sentence desk rule. Pause only when the query is an Exact KW you own. */
export const BLEEDERS_10_BLURB =
  "These rows come from the SP Search Term report. Pause only when the customer query equals an Exact keyword you own; otherwise add Negative exact on the query. Verify in Ads before acting.";

export const BLEEDERS_10_VERIFY =
  "Confirm the campaign, ad group, and Exact keyword (or add the Negative exact) in Ads before acting. Numbers stay on this pasted payload. Nothing writes to Amazon.";

export const BLEEDERS_10_FLOOR_WHY =
  "Nonbrand search-term CVR 25.79% (~1-in-4). Click floor 6 (1.5×). Window 2026-06-30..08-31 (63d, SP search terms).";

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
  action_label: string;
  suggested_action: string;
  status: "open" | "done" | "skipped" | "already_applied";
  decision_id: string | null;
  applied_reason: string | null;
  applied_source: Bleeders10AppliedSource | null;
  ads_verify_note: string | null;
  soldscope_sv?: number | null;
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
  already_applied_count: number;
  ads_snapshot: Bleeders10AdsSummary;
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
}

function norm(s: string | null | undefined): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function bleeders10TermsEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = norm(a);
  const nb = norm(b);
  return na.length > 0 && na === nb;
}

/**
 * Pasted 1.0 stores campaign_id as the campaign name. Return a distinct
 * Ads id only when it actually differs — never a second copy of the name.
 */
export function bleeders10DistinctCampaignId(
  campaignName: string | null | undefined,
  campaignId: string | null | undefined,
): string | null {
  const name = String(campaignName ?? "").trim();
  const id = String(campaignId ?? "").trim();
  if (!id || id === name) return null;
  return id;
}

function termsEqual(a: string, b: string): boolean {
  return bleeders10TermsEqual(a, b);
}

/**
 * Canonical Bleeders 1.0 lever:
 *   pause_keyword ONLY when match is Exact AND search_term equals that Exact keyword.
 *   Otherwise negative_exact (query ≠ KW, missing KW, Auto, ASIN, Broad, Phrase, targeting).
 * Never leave a misleading pause_keyword when the Exact KW cannot be asserted.
 */
export function resolveBleeders10Action(
  matchType: string,
  searchTerm: string,
  keyword: string | null | undefined,
): Bleeders10Action | null {
  const mt = String(matchType ?? "").trim();
  const term = String(searchTerm ?? "").trim();
  if (!mt || !term) return null;
  if (mt.toUpperCase() === "EXACT" && keyword && termsEqual(term, keyword)) {
    return "pause_keyword";
  }
  return "negative_exact";
}

export function recTypeOfBleeders10(action: Bleeders10Action): string {
  return BLEEDERS_10_REC_TYPES[action];
}

export function actionLabelOf10(row: {
  action: Bleeders10Action;
  search_term: string;
  keyword: string | null;
}): string {
  if (row.action === "pause_keyword") {
    const kw = row.keyword || row.search_term || "?";
    return `Pause Exact keyword "${kw}" in Keywords (this search term IS that keyword)`;
  }
  const term = row.search_term || "?";
  return `Add Negative exact on search term "${term}"`;
}

export function whyOf10(row: {
  action: Bleeders10Action;
  search_term: string;
  keyword: string | null;
  match_type: string;
  clicks: number;
  spend: number;
}): string {
  const spendBit = `$0 on ${row.clicks} clicks / $${row.spend.toFixed(2)}.`;
  if (row.action === "pause_keyword") {
    const kw = row.keyword || row.search_term || "?";
    return `This search term IS the Exact keyword "${kw}". Pause Exact "${kw}" in the Keywords tab. Do not add Negative exact. ${spendBit} ${BLEEDERS_10_FLOOR_WHY} If you cannot find that Exact KW in Ads, do not invent a pause — verify first.`;
  }
  const term = row.search_term || "?";
  const kw = row.keyword ? `"${row.keyword}"` : "missing";
  const mt = String(row.match_type ?? "").toUpperCase();
  let relation: string;
  if (mt.startsWith("TARGETING") && /asin=/i.test(row.keyword ?? "")) {
    relation = `Customer query "${term}" ≠ ASIN targeting ${row.keyword}.`;
  } else if (mt.startsWith("TARGETING")) {
    relation = `Auto/targeting query "${term}" ≠ expression ${kw}.`;
  } else if (mt === "BROAD") {
    relation = `Broad query "${term}" ≠ expression ${kw}.`;
  } else if (mt === "PHRASE") {
    relation = `Phrase query "${term}" ≠ keyword ${kw}.`;
  } else if (mt === "EXACT" && row.keyword && !termsEqual(term, row.keyword)) {
    relation = `Search term "${term}" ≠ Exact keyword ${kw}.`;
  } else if (mt === "EXACT" && !row.keyword) {
    relation = `Exact match but keyword is missing — cannot assert an Exact KW to pause.`;
  } else {
    relation = `Search term "${term}" is not an Exact keyword you own.`;
  }
  return `${relation} Add Negative exact on the search term "${term}". Do not pause a keyword. ${spendBit} ${BLEEDERS_10_FLOOR_WHY}`;
}

export function suggestedActionOf10(row: {
  action: Bleeders10Action;
  campaign_name: string;
  ad_group_name: string;
  search_term: string;
  keyword: string | null;
}): string {
  const camp = row.campaign_name || "?";
  const ag = row.ad_group_name ? `ad group "${row.ad_group_name}"` : "the ad group";
  if (row.action === "pause_keyword") {
    const kw = row.keyword || row.search_term || "?";
    return `Campaign Manager → "${camp}" → ${ag} → Keywords → find Exact "${kw}" → Pause (or archive). This search term IS that Exact keyword — do not add Negative exact. If you cannot find Exact "${kw}" in Ads, do not invent a pause — verify first. Nothing writes to Amazon from this page.`;
  }
  const term = row.search_term || "?";
  return `Campaign Manager → "${camp}" → ${ag} → Negative keywords → add Exact negative for the search term "${term}". Do not pause a keyword. Nothing writes to Amazon from this page.`;
}

/** Desk how-to copy — always visible on the row, not buried in Why. */
export const suggestedActionCopy = suggestedActionOf10;

function specs(): Spec[] {
  // Pasted 10 — ranks/terms/numbers stay locked. `action` is documented intent;
  // buildBleeders10 re-classifies from search_term / keyword / match_type.
  return [
    {
      rank: 1, action: "pause_keyword",
      campaign: "GG - Deodorant - Exact - SQR - CST", ad_group: "Exact",
      term: "deodorant men", keyword: "deodorant men", match_type: "EXACT",
      clicks: 96, spend: 113.18,
    },
    {
      rank: 2, action: "negative_exact",
      campaign: "GG - B0CLHYY3BB - Deodorant - Asin Defense", ad_group: "Asin Defense",
      term: "carpe deodorant", keyword: 'asin="B0CLHYY3BB"', match_type: "TARGETING_EXPRESSION",
      clicks: 42, spend: 78.66,
    },
    {
      rank: 3, action: "pause_keyword",
      campaign: "GG - SP - KW - Tallow Balm - B0CLF5B27Y - Exact 4", ad_group: "Exact",
      term: "beef tallow moisturizer", keyword: "beef tallow moisturizer", match_type: "EXACT",
      clicks: 31, spend: 59.40,
    },
    {
      rank: 4, action: "negative_exact",
      campaign: "GG - Lip Balm - Asin Offense", ad_group: "Asin Offense",
      term: "dr dans cortibalm lip balm", keyword: 'asin="B00PX0ARAK"', match_type: "TARGETING_EXPRESSION",
      clicks: 32, spend: 58.55,
    },
    {
      rank: 5, action: "negative_exact",
      campaign: "GG - Deodorant - Exact - Low Volume", ad_group: "Exact",
      term: "vanmans deodorant", keyword: "vanman deodorant", match_type: "EXACT",
      clicks: 38, spend: 42.78,
    },
    {
      rank: 6, action: "negative_exact",
      campaign: "SP - KW - Exact - Tallow Balm MAG", ad_group: "",
      term: "beef tallow and honey balm", keyword: "beef tallow honey balm", match_type: "EXACT",
      clicks: 24, spend: 42.37,
    },
    {
      rank: 7, action: "negative_exact",
      campaign: "GG - Lip Balm - Broad M", ad_group: "Broad",
      term: "coconut oil lip balm", keyword: "+lip +moisturizer", match_type: "BROAD",
      clicks: 21, spend: 40.93,
    },
    {
      rank: 8, action: "negative_exact",
      campaign: "SP Auto Deo close-match", ad_group: "close-match",
      term: "wild deodorant", keyword: "close-match", match_type: "TARGETING_EXPRESSION_PREDEFINED",
      clicks: 35, spend: 31.18,
    },
    {
      rank: 9, action: "negative_exact",
      campaign: "GG Lip Balm Exact Long/Low", ad_group: "Exact",
      term: "goats milk chapstick", keyword: "goat milk chapstick", match_type: "EXACT",
      clicks: 18, spend: 29.27,
    },
    {
      rank: 10, action: "pause_keyword",
      campaign: "GG Tallow Balm Exact 2", ad_group: "Exact",
      term: "tallow balm for face", keyword: "tallow balm for face", match_type: "EXACT",
      clicks: 14, spend: 28.48,
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
    already_applied_count: 0,
    ads_snapshot: summarizeBleeders10Ads(null),
    search_term_coverage: "SP-only",
    notes: [
      "Bleeders 1.0 — pasted 10. Not This week's Recovery execute list.",
      BLEEDERS_10_BLURB,
      BLEEDERS_10_WINDOW_LABEL,
      "Nonbrand search-term CVR 25.79% (~1-in-4). Click floor 6 (1.5×).",
    ],
    rows: [],
  };
}

export function buildBleeders10(input: {
  decisions?: Array<Bleeders10Decision | WeeklyLockDecision>;
  ads?: Bleeders10AdsSnapshot | null;
} = {}): Bleeders10Payload {
  const decisions = (input.decisions ?? []) as Bleeders10Decision[];
  const adsSummary = summarizeBleeders10Ads(input.ads, input.ads?.now);
  const skip = new Set(BLEEDERS_10_SKIP_TERMS.map(norm));

  const rows: Bleeders10Row[] = specs().slice(0, BLEEDERS_10_CAP).map((spec) => {
    if (skip.has(norm(spec.term))) {
      throw new Error(`Bleeders 1.0 skip list leaked: ${spec.term}`);
    }
    const classified = resolveBleeders10Action(spec.match_type, spec.term, spec.keyword)
      ?? "negative_exact";
    const classifiedSpec: Spec = { ...spec, action: classified };
    const campaignName = spec.campaign;
    const campaignId = spec.campaign;
    const adGroup = spec.ad_group;
    const id = checklistId(classifiedSpec, campaignId);
    const marked = decisionStatus(classifiedSpec, campaignId, id, decisions);
    const keyword = classified === "pause_keyword" ? (spec.keyword || spec.term) : spec.keyword;
    const draft = {
      action: classified,
      campaign_name: campaignName,
      ad_group_name: adGroup,
      search_term: spec.term,
      keyword,
      match_type: spec.match_type,
      clicks: spec.clicks,
      spend: spec.spend,
    };
    const adsHit = marked.status === "open"
      ? reconcileBleeders10Row({
          action: classified,
          campaign_name: campaignName,
          campaign_id: campaignId,
          ad_group_id: "",
          search_term: spec.term,
          keyword,
        }, input.ads, adsSummary)
      : { applied: false, source: null, reason: null, note: null };
    const status: Bleeders10Row["status"] = marked.status !== "open"
      ? marked.status
      : adsHit.applied ? "already_applied" : "open";
    const applied_source: Bleeders10AppliedSource | null = marked.status !== "open"
      ? "manual"
      : adsHit.source;
    const applied_reason = marked.status === "done"
      ? "Marked Done on this desk."
      : marked.status === "skipped"
        ? "Marked Skipped on this desk."
        : adsHit.reason;
    return {
      checklist_id: id,
      rank: spec.rank,
      action: classified,
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
      why: whyOf10(draft),
      action_label: actionLabelOf10(draft),
      suggested_action: suggestedActionCopy(draft),
      status,
      decision_id: marked.decision_id,
      applied_reason,
      applied_source,
      ads_verify_note: status === "open" ? (adsHit.note ?? adsSummary.warning) : null,
    };
  });

  const done_count = rows.filter((r) => r.status === "done").length;
  const skipped_count = rows.filter((r) => r.status === "skipped").length;
  const already_applied_count = rows.filter((r) => r.status === "already_applied").length;

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
    open_count: rows.length - done_count - skipped_count - already_applied_count,
    done_count,
    skipped_count,
    already_applied_count,
    ads_snapshot: adsSummary,
    search_term_coverage: "SP-only",
    notes: [
      "Bleeders 1.0 — pasted 10 tonight. Not This week's Recovery execute list. Cap 10. Do not expand to 22.",
      BLEEDERS_10_BLURB,
      "Window 2026-06-30..08-31 (63d, SP search terms).",
      "Nonbrand search-term CVR 25.79% (~1-in-4). Click floor 6 (1.5×).",
      "Skip branded $0: primal essence deodorant. tallowbourne deodorant is a confirmed skip (brand misspell — defend). Increment rows (b0c3kw5vjr, tallow balm for lips) hold for Monday.",
      "Already applied is Ads truth from ads_negatives / ads_keyword_targets. Manual Done/Skipped still records ads_action_decisions. Nothing writes to Amazon.",
    ],
    rows,
  };
}
