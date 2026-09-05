/**
 * Library: retired Blake-ranked 63d execute list for 2026-06-30..08-31.
 * This week is buildBlakeRecovery0905List (66 rows).
 *
 * Stored ads_search_terms_daily: 63 calendar days inclusive, 23 days with
 * rows, SP-only. Jun/Jul mostly weekly samples; 8/30 missing; 8/31 in.
 * Do not call this 90d or 24d. Do not auto-buildBleeders from all terms.
 * No TOS raise this pass. Nothing writes to Amazon.
 *
 * campaign_id / ad_group are filled from Dashboard ads_search_terms_daily
 * when the name (and term) uniquely match. Ambiguous names keep Blake's
 * campaign string and leave id blank. Do not attach a term to the wrong
 * campaign (e.g. organic lip balm ISO 265530099680823).
 */

import { isBranded } from "./brand-terms";
import {
  WEEKLY_CADENCE,
  WEEKLY_GROK_PROMPT_63D,
  WEEKLY_HOLD,
  WEEKLY_LOCK_DAYS,
  applyWeeklyLocks,
  newBidDownFromAcosPct,
  type WeeklyAction,
  type WeeklyLockDecision,
  type WeeklyPayload,
  type WeeklyRow,
  type WeeklyWindow,
} from "./ppc-weekly";
import {
  campaignNameMatches,
  resolveNamedCampaign,
  type BlakeLookup,
  type WeeklyCampaignRef,
  type WeeklyPlacementRef,
  type WeeklyTermRef,
} from "./ppc-weekly-blake-24d";

export type { BlakeLookup, WeeklyCampaignRef, WeeklyPlacementRef, WeeklyTermRef };

export const BLAKE_63D_START = "2026-06-30";
export const BLAKE_63D_END = "2026-08-31";
export const BLAKE_63D_DAYS = 63;
export const BLAKE_63D_DAYS_WITH_ROWS = 23;
export const BLAKE_63D_WINDOW_LABEL = "2026-06-30..08-31 (63d)";
export const BLAKE_63D_WINDOW_CHIP = "63d Jun 30–Aug 31";

/** Lane CVR from ads_search_terms_daily 2026-06-30..08-31 + brand_terms.json. */
export const BLAKE_63D_LANE = {
  branded: 41.26,
  nonbrand: 25.79,
  click_floor: 10,
} as const;

/** Blended account CVR from ads_campaigns_daily same dates (5,687 / 21,147). */
export const BLAKE_63D_ACCOUNT_CVR = 26.89;

interface BlakeSpec {
  rank: string;
  action: WeeklyAction;
  campaign: string;
  ad_group?: string;
  term?: string;
  match_type?: string;
  clicks?: number;
  spend?: number;
  sales?: number;
  acos?: number | null;
  term_cvr?: number | null;
  orders?: number;
  placement?: string | null;
  why: string;
  /** When set, only resolve id if this term is on the matched campaign. */
  requireTermOnCampaign?: boolean;
}

function liveCpc(lookup: BlakeLookup, campaignId: string, term?: string): number | null {
  if (!term) return null;
  const key = term.trim().toLowerCase().replace(/\s+/g, " ");
  let spend = 0, clicks = 0;
  for (const t of lookup.terms) {
    if (campaignId && t.campaign_id !== campaignId) continue;
    if (t.search_term.trim().toLowerCase().replace(/\s+/g, " ") !== key) continue;
    spend += Number(t.spend ?? 0);
    clicks += Number(t.clicks ?? 0);
  }
  if (clicks > 0 && spend > 0) return spend / clicks;
  return null;
}

function liveAdGroup(lookup: BlakeLookup, campaignId: string, term: string): string {
  if (!campaignId || !term) return "";
  const key = term.trim().toLowerCase().replace(/\s+/g, " ");
  const groups = [...new Set(
    lookup.terms
      .filter((t) => t.campaign_id === campaignId && t.search_term.trim().toLowerCase().replace(/\s+/g, " ") === key)
      .map((t) => String(t.ad_group_name ?? ""))
      .filter(Boolean),
  )];
  return groups.length === 1 ? groups[0] : "";
}

function salesFrom(spend: number, acosPct: number | null | undefined, explicit?: number): number {
  if (explicit != null) return explicit;
  if (acosPct != null && acosPct > 0 && spend > 0) return Math.round((spend / (acosPct / 100)) * 100) / 100;
  return 0;
}

function laneFor(term: string | undefined, action: WeeklyAction): number | null {
  if (action === "cut_detail_page" || action === "raise_tos") return null;
  if (!term) return BLAKE_63D_LANE.nonbrand;
  return isBranded(term) ? BLAKE_63D_LANE.branded : BLAKE_63D_LANE.nonbrand;
}

function blakeWindow(): WeeklyWindow {
  return {
    start: BLAKE_63D_START,
    end: BLAKE_63D_END,
    days: BLAKE_63D_DAYS,
    days_with_rows: BLAKE_63D_DAYS_WITH_ROWS,
    label: BLAKE_63D_WINDOW_LABEL,
  };
}

function specs(): BlakeSpec[] {
  const nb = BLAKE_63D_LANE.nonbrand;
  const win = "63d Blake-ranked (2026-06-30..08-31, 23 days with rows, SP-only)";
  return [
    {
      rank: "R1", action: "pause_keyword",
      campaign: "GG - Deodorant - Exact - SQR - CST", ad_group: "Exact",
      term: "deodorant men", match_type: "EXACT",
      clicks: 96, spend: 113.18, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Exact KW = term, $0 sales on 96 clicks / $113.18. Pause the keyword. Nonbrand lane CVR ${nb}%, click floor 10. ${win}.`,
    },
    {
      rank: "R1", action: "negative_exact",
      campaign: "GG - B0CLHYY3BB - Deodorant - Asin Defense", ad_group: "Asin Defense",
      term: "carpe deodorant", match_type: "TARGETING_EXPRESSION",
      clicks: 42, spend: 78.66, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Customer query ≠ targeting expression (KW=asin="B0CLHYY3BB"); $0 on 42 clicks / $78.66. Add negative exact. Not a Carpe harvest. Nonbrand lane CVR ${nb}%, click floor 10. ${win}.`,
    },
    {
      rank: "R1", action: "pause_keyword",
      campaign: "GG - SP - KW - Tallow Balm - B0CLF5B27Y - Exact 4", ad_group: "Exact",
      term: "beef tallow moisturizer", match_type: "EXACT",
      clicks: 31, spend: 59.40, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Exact KW = term, $0 sales on 31 clicks / $59.40. Pause the keyword. Nonbrand lane CVR ${nb}%, click floor 10. ${win}.`,
    },
    {
      rank: "R1", action: "negative_exact",
      campaign: "GG - Lip Balm - Asin Offense - Lip Balm Category", ad_group: "Asin Offense",
      term: "dr dans cortibalm lip balm", match_type: "TARGETING_EXPRESSION",
      clicks: 32, spend: 58.55, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Customer query ≠ targeting expression (KW=asin="B00PX0ARAK"); $0 on 32 clicks / $58.55. Add negative exact. Nonbrand lane CVR ${nb}%, click floor 10. ${win}.`,
    },
    {
      rank: "R1", action: "negative_exact",
      campaign: "GG - Deodorant - Exact - Low Volume", ad_group: "Exact",
      term: "vanmans deodorant", match_type: "EXACT",
      clicks: 38, spend: 42.78, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Exact KW=vanman deodorant (NOT equal). $0 on 38 clicks / $42.78. Add negative exact — do not pause_keyword. Nonbrand lane CVR ${nb}%, click floor 10. ${win}.`,
    },
    {
      rank: "R1", action: "negative_exact",
      campaign: "SP - KW - Exact - Tallow Balm - B0CLF5B27Y - MAG", ad_group: "B0CLF5B27Y",
      term: "beef tallow and honey balm", match_type: "EXACT",
      clicks: 24, spend: 42.37, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Exact KW=beef tallow honey balm (NOT equal). $0 on 24 clicks / $42.37. Add negative exact — do not pause_keyword. Nonbrand lane CVR ${nb}%, click floor 10. ${win}.`,
    },
    {
      rank: "R1", action: "negative_exact",
      campaign: "GG - Lip Balm - Broad M", ad_group: "Broad",
      term: "coconut oil lip balm", match_type: "BROAD",
      clicks: 21, spend: 40.93, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Broad KW=+lip +moisturizer (query ≠ expression); $0 on 21 clicks / $40.93. Add negative exact. Nonbrand lane CVR ${nb}%, click floor 10. ${win}.`,
    },
    {
      rank: "R1", action: "negative_exact",
      campaign: "SP - Auto - Deodorant - B0CLHYY3BB -", ad_group: "B0CLHYY3BB",
      term: "wild deodorant", match_type: "TARGETING_EXPRESSION_PREDEFINED",
      clicks: 35, spend: 31.18, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Auto close-match (query ≠ expression); $0 on 35 clicks / $31.18. Add negative exact. Nonbrand lane CVR ${nb}%, click floor 10. ${win}.`,
    },
    {
      rank: "R1", action: "negative_exact",
      campaign: "GG - Lip Balm - Exact - SQR - Long/Low", ad_group: "Exact",
      term: "goats milk chapstick", match_type: "EXACT",
      clicks: 18, spend: 29.27, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Exact KW=goat milk chapstick (NOT equal). $0 on 18 clicks / $29.27. Add negative exact — do not pause_keyword. Nonbrand lane CVR ${nb}%, click floor 10. ${win}.`,
    },
    {
      rank: "R1", action: "pause_keyword",
      campaign: "GG - SP - KW - Tallow Balm - B0CLF5B27Y - Exact 2", ad_group: "Exact",
      term: "tallow balm for face", match_type: "EXACT",
      clicks: 14, spend: 28.48, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Exact KW = term, $0 sales on 14 clicks / $28.48. Pause the keyword. Nonbrand lane CVR ${nb}%, click floor 10. ${win}.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "SP KW - Exact(PM) - Lip Balm - DPB0CLHTKY3V/B0CLHVLG2F -",
      ad_group: "Exact NonBranded SSG",
      term: "organic lip balm", match_type: "EXACT",
      clicks: 858, spend: 1547.08, sales: 2584.65, acos: 59.9, term_cvr: 21.45, orders: 184,
      requireTermOnCampaign: true,
      why: `ACOS 59.9% vs lip break-even ~42%. Term CVR 21.45% vs nonbrand lane ${nb}%. Bid down, never pause. Only the Exact PM row — not ISO 265530099680823. new_bid = live CPC × 0.42 / ACOS. ${win}.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "SP - 1KW(900kSV/ROS-PP) - Exact - Lip Balm - B0CLHTKY3V - -lip balm organic",
      ad_group: "B0CLHTKY3V",
      term: "lip balm organic", match_type: "EXACT",
      clicks: 103, spend: 296.11, sales: 321.77, acos: 92.0, term_cvr: 22.33, orders: 23,
      requireTermOnCampaign: true,
      why: `ACOS 92.0% vs lip break-even ~42%. Term CVR 22.33% vs nonbrand lane ${nb}%. Bid down, never pause. new_bid = live CPC × 0.42 / ACOS. ${win}.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "GG - Lip Balm - Asin Offense - Lip Balm Category", ad_group: "Asin Offense",
      term: "b00exprm7c", match_type: "TARGETING_EXPRESSION",
      clicks: 445, spend: 726.24, sales: 1259.10, acos: 57.7, term_cvr: 19.78, orders: 88,
      requireTermOnCampaign: true,
      why: `Product target B00EXPRM7C. ACOS 57.7%, CVR 19.78% vs nonbrand lane ${nb}%. Bid down (not pause). new_bid = live CPC × 0.42 / ACOS. ${win}.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "GG - Lip Balm - Asin Offense - Lip Balm Category", ad_group: "Asin Offense",
      term: "b07xxphqzk", match_type: "TARGETING_EXPRESSION",
      clicks: 470, spend: 662.66, sales: 1175.16, acos: 56.4, term_cvr: 17.87, orders: 84,
      requireTermOnCampaign: true,
      why: `Product target B07XXPHQZK. ACOS 56.4%, CVR 17.87% vs nonbrand lane ${nb}%. Bid down (not pause). new_bid = live CPC × 0.42 / ACOS. ${win}.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "GG - Deodorant - Asin Offense 3", ad_group: "Asin Offense",
      term: "b08wyxnvq7", match_type: "TARGETING_EXPRESSION",
      clicks: 305, spend: 334.83, sales: 461.71, acos: 72.5, term_cvr: 9.18, orders: 28,
      requireTermOnCampaign: true,
      why: `Product target B08WYXNVQ7. ACOS 72.5%, CVR 9.18% vs nonbrand lane ${nb}%. Bid down (not pause). new_bid = live CPC × 0.42 / ACOS. ${win}.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "GG - Deodorant - Asin Offense 3", ad_group: "Asin Offense",
      term: "b09yk5f5nc", match_type: "TARGETING_EXPRESSION",
      clicks: 306, spend: 412.76, sales: 701.56, acos: 58.8, term_cvr: 14.05, orders: 43,
      requireTermOnCampaign: true,
      why: `Product target B09YK5F5NC. ACOS 58.8%, CVR 14.05% vs nonbrand lane ${nb}%. Bid down (not pause). new_bid = live CPC × 0.42 / ACOS. ${win}.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "GG - Lip Balm - Exact - Tallow Balm related KW - TOS", ad_group: "Exact",
      term: "tallow and honey balm", match_type: "EXACT",
      clicks: 278, spend: 288.88, sales: 335.76, acos: 86.0, term_cvr: 8.27, orders: 23,
      requireTermOnCampaign: true,
      why: `ACOS 86.0%, CVR 8.27% vs nonbrand lane ${nb}%. Bid down. new_bid = live CPC × 0.42 / ACOS. ${win}.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "GG - Lip Balm - Exact - ChapStick related", ad_group: "Exact",
      term: "best chapstick", match_type: "EXACT",
      clicks: 44, spend: 137.40, sales: 69.95, acos: 196.4, term_cvr: 11.36, orders: 5,
      requireTermOnCampaign: true,
      why: `ACOS 196.4%, CVR 11.36% vs nonbrand lane ${nb}%. Bid down (never pause). new_bid = live CPC × 0.42 / ACOS. ${win}.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "GG - Lip Balm - Exact - Untargeted", ad_group: "Exact",
      term: "lip moisturizer for very dry lips", match_type: "EXACT",
      clicks: 102, spend: 187.53, sales: 195.86, acos: 95.7, term_cvr: 13.73, orders: 14,
      requireTermOnCampaign: true,
      why: `63d has sales ($195.86 / 14 orders). Bid down, not pause. ACOS 95.7% vs nonbrand lane ${nb}%. new_bid = live CPC × 0.42 / ACOS. ${win}.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "GG - Lip Balm - Exact - ChapStick related", ad_group: "Exact",
      term: "chapstick natural", match_type: "EXACT",
      clicks: 24, spend: 77.36, sales: 69.95, acos: 110.6, term_cvr: 20.83, orders: 5,
      requireTermOnCampaign: true,
      why: `63d has sales ($69.95 / 5 orders). Bid down, not pause. ACOS 110.6% vs nonbrand lane ${nb}%. new_bid = live CPC × 0.42 / ACOS. ${win}.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "GG - Deodorant - Exact - SQR - CST", ad_group: "Exact",
      term: "deodorant aluminum free", match_type: "EXACT",
      clicks: 81, spend: 146.91, sales: 271.83, acos: 54.0, term_cvr: 20.99, orders: 17,
      requireTermOnCampaign: true,
      why: `ACOS 54.0%, CVR 20.99% vs nonbrand lane ${nb}%. Bid down. new_bid = live CPC × 0.42 / ACOS. ${win}.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "SP - KW - Men's Deodorant - Phrase - Deodorant - B0CLHYY3BB -",
      ad_group: "B0CLHYY3BB",
      term: "non toxic mens deodorant", match_type: "PHRASE",
      clicks: 44, spend: 64.83, sales: 31.98, acos: 202.7, term_cvr: 4.55, orders: 2,
      requireTermOnCampaign: true,
      why: `Phrase KW = term. 63d has sales (2 orders). Bid down, not negative_exact. ACOS 202.7% vs nonbrand lane ${nb}%. new_bid = live CPC × 0.42 / ACOS. ${win}.`,
    },
    {
      rank: "R2", action: "negative_exact",
      campaign: "SP - ASIN - COMP - Exact - Tallow Deodorant - B0CLHYY3BB -",
      ad_group: "B0CLHYY3BB",
      term: "b0f7zfzd9z", match_type: "TARGETING_EXPRESSION",
      clicks: 68, spend: 128.66, sales: 15.99, acos: 804.6, term_cvr: 1.47, orders: 1,
      requireTermOnCampaign: true,
      why: `Blake: negative_exact despite 1 order. ACOS 804.6% on 68 clicks / $128.66. Customer query ≠ targeting expression (KW=asin="B0F7ZFZD9Z") — do not pause the ASIN. ${win}.`,
    },
  ];
}

function fillFromLookup(spec: BlakeSpec, lookup: BlakeLookup): {
  clicks: number; spend: number; sales: number; acos: number | null; term_cvr: number | null;
} {
  const termKey = String(spec.term ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  let clicks = 0, spend = 0, sales = 0;
  if (termKey) {
    for (const t of lookup.terms) {
      if (t.search_term.trim().toLowerCase().replace(/\s+/g, " ") !== termKey) continue;
      if (spec.campaign && !campaignNameMatches(spec.campaign, t.campaign_name)) continue;
      clicks += Number(t.clicks ?? 0);
      spend += Number(t.spend ?? 0);
      sales += Number(t.sales ?? 0);
    }
  }
  const outClicks = spec.clicks ?? clicks;
  const outSpend = spec.spend ?? spend;
  const outSales = spec.sales ?? (spec.acos != null
    ? salesFrom(outSpend, spec.acos, spec.sales)
    : sales);
  const acos = spec.acos != null ? spec.acos : (outSales > 0 ? Math.round((outSpend / outSales) * 1000) / 10 : null);
  const termCvr = spec.term_cvr != null
    ? spec.term_cvr
    : (spec.orders != null && outClicks > 0)
      ? Math.round((spec.orders / outClicks) * 1000) / 10
      : spec.term_cvr ?? null;
  return { clicks: outClicks, spend: outSpend, sales: outSales, acos, term_cvr: termCvr };
}

function newBidFor(
  spec: BlakeSpec,
  resolvedId: string,
  clicks: number,
  spend: number,
  acos: number | null,
  lookup: BlakeLookup,
): number | null {
  const cpc = liveCpc(lookup, resolvedId, spec.term)
    ?? (clicks > 0 && spend > 0 ? spend / clicks : null);
  if (cpc == null) return null;
  if (spec.action === "bid_down") {
    return acos != null ? newBidDownFromAcosPct(cpc, acos) : null;
  }
  return null;
}

function rowId(spec: BlakeSpec, campaignId: string, idx: number): string {
  const camp = campaignId || spec.campaign;
  const term = spec.term || spec.placement || "";
  return [
    BLAKE_63D_END,
    camp,
    term,
    spec.match_type ?? "",
    spec.action,
    String(idx + 1),
  ].join("|");
}

export function blake63dWindow(): WeeklyWindow {
  return blakeWindow();
}

export function buildBlake63dList(input: {
  lookup?: BlakeLookup;
  decisions?: WeeklyLockDecision[];
  account_cvr?: number;
  now?: Date;
} = {}): WeeklyPayload {
  const lookup: BlakeLookup = {
    campaigns: input.lookup?.campaigns ?? [],
    terms: input.lookup?.terms ?? [],
    placements: input.lookup?.placements ?? [],
  };
  const window = blakeWindow();
  const raw: WeeklyRow[] = specs().map((spec, idx) => {
    const resolved = resolveNamedCampaign(spec.campaign, lookup, spec.term);
    const campaign = resolved.campaign_id ? resolved.campaign_name : spec.campaign;
    const filled = fillFromLookup(spec, lookup);
    const adGroup = spec.ad_group || resolved.ad_group || liveAdGroup(lookup, resolved.campaign_id, spec.term ?? "");
    const lane = laneFor(spec.term, spec.action);
    const newBid = newBidFor(spec, resolved.campaign_id, filled.clicks, filled.spend, filled.acos, lookup);
    let termCvr = filled.term_cvr;
    if (termCvr == null && spec.orders != null && filled.clicks > 0) {
      termCvr = Math.round((spec.orders / filled.clicks) * 1000) / 10;
    }
    return {
      id: rowId(spec, resolved.campaign_id, idx),
      rank: spec.rank,
      action: spec.action,
      campaign,
      campaign_id: resolved.campaign_id,
      ad_group: adGroup,
      term: spec.term ?? "",
      match_type: spec.match_type ?? "",
      clicks: filled.clicks,
      spend: Math.round(filled.spend * 100) / 100,
      sales: Math.round(filled.sales * 100) / 100,
      acos: filled.acos,
      term_cvr: termCvr,
      account_cvr_lane: lane,
      current_bid: null,
      new_bid: newBid,
      placement: spec.placement ?? null,
      window: BLAKE_63D_WINDOW_LABEL,
      why: spec.why,
      status: "open",
      decision_id: null,
    };
  });

  const locked = applyWeeklyLocks(raw, input.decisions ?? [], input.now ?? new Date()).map((row) => {
    const prior = (input.decisions ?? []).find((d) => {
      const sameTerm = String(d.search_term ?? "").trim().toLowerCase() === row.term.trim().toLowerCase();
      const sameAction = String(d.action_type ?? "") === row.action;
      const sameCamp = String(d.campaign_id ?? "") === row.campaign_id
        || (!row.campaign_id && String(d.campaign_id ?? "") === row.campaign);
      return sameTerm && sameAction && sameCamp;
    });
    return { ...row, decision_id: prior && row.status !== "open" ? String((prior as { id?: string }).id ?? "") || row.decision_id : row.decision_id };
  });

  const open_count = locked.filter((r) => r.status === "open").length;
  const done_count = locked.filter((r) => r.status === "done").length;
  const skipped_count = locked.filter((r) => r.status === "skipped").length;

  return {
    execute_ready: true,
    execute_list: "blake_63d",
    window_chip: BLAKE_63D_WINDOW_CHIP,
    window: { search: window, placement: window },
    account_cvr: input.account_cvr ?? BLAKE_63D_ACCOUNT_CVR,
    account_cvr_source: "ads_campaigns_daily",
    account_cvr_branded: BLAKE_63D_LANE.branded,
    account_cvr_nonbranded: BLAKE_63D_LANE.nonbrand,
    lane_cvr_source: "ads_search_terms_daily + brand_terms.json",
    click_floor: BLAKE_63D_LANE.click_floor,
    open_count,
    done_count,
    skipped_count,
    search_term_coverage: "SP-only",
    notes: [
      "63d Blake-ranked list from stored ads_search_terms_daily 2026-06-30..08-31 (63 calendar days, 23 days with rows, SP-only). Jun/Jul mostly weekly samples; 8/30 missing; 8/31 in. Do not call this 90d or 24d.",
      "HOLD lifted for this pasted Blake list only. Do not auto-buildBleeders from all terms. No TOS raise this pass. new_bid up unused this pass.",
      "pause_keyword only where the search term equals the exact keyword (deodorant men, beef tallow moisturizer, tallow balm for face). Done/Skipped persist on ads_action_decisions (7-day lock). Still-$0 bleeders may reappear. Nothing writes to Amazon.",
      `Lane context: branded CVR ${BLAKE_63D_LANE.branded}%, nonbrand CVR ${BLAKE_63D_LANE.nonbrand}%, click floor ${BLAKE_63D_LANE.click_floor}. Blended account CVR 26.89% (5,687 orders / 21,147 clicks) from ads_campaigns_daily same dates. new_bid down = live CPC × 0.42 / ACOS. current_bid always blank.`,
    ],
    cadence: [...WEEKLY_CADENCE],
    hold: [...WEEKLY_HOLD],
    grok_prompt: WEEKLY_GROK_PROMPT_63D,
    new_bid: {
      down: "CPC × 0.42 / ACOS (ACOS = spend/sales)",
      up: "unused this pass",
      current_bid: null,
    },
    lock: {
      days: WEEKLY_LOCK_DAYS,
      exception: "still-$0 bleeders may reappear",
    },
    rows: locked,
  };
}
