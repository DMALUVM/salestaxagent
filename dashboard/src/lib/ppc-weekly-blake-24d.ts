/**
 * THIS WEEK only: Blake-ranked 24d execute list for 2026-08-06..08-29.
 *
 * HOLD is lifted for this list. Do not wait for 90d. Do not call this 90d.
 * Do not auto-buildBleeders from all terms. Nothing writes to Amazon.
 *
 * campaign_id / ad_group are filled from Dashboard ads_search_terms_daily
 * and ads_placement_daily when the name (and term, if present) uniquely
 * match. Ambiguous names keep Blake's campaign string and leave id blank.
 */

import { isBranded } from "./brand-terms";
import {
  WEEKLY_CADENCE,
  WEEKLY_GROK_PROMPT,
  WEEKLY_HOLD,
  WEEKLY_LOCK_DAYS,
  applyWeeklyLocks,
  newBidDownFromAcosPct,
  newBidUp,
  type WeeklyAction,
  type WeeklyLockDecision,
  type WeeklyPayload,
  type WeeklyRow,
  type WeeklyWindow,
} from "./ppc-weekly";

export const BLAKE_24D_START = "2026-08-06";
export const BLAKE_24D_END = "2026-08-29";
export const BLAKE_24D_DAYS = 24;
export const BLAKE_24D_WINDOW_LABEL = "2026-08-06..08-29 (24d)";
export const BLAKE_24D_WINDOW_CHIP = "24d Aug 6–29";

export const BLAKE_24D_LANE = {
  branded: 35.6,
  nonbrand: 25.6,
  click_floor: 10,
} as const;

export interface WeeklyCampaignRef {
  campaign_id: string;
  campaign_name: string;
}

export interface WeeklyTermRef {
  search_term: string;
  campaign_id: string;
  campaign_name: string;
  ad_group_name?: string;
  keyword?: string;
  match_type?: string;
  clicks?: number;
  spend?: number;
  sales?: number;
}

export interface WeeklyPlacementRef {
  campaign_id: string;
  campaign_name: string;
  placement: string;
  clicks?: number;
  spend?: number;
  sales?: number;
}

export interface BlakeLookup {
  campaigns: WeeklyCampaignRef[];
  terms: WeeklyTermRef[];
  placements: WeeklyPlacementRef[];
}

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

function tokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function expandToken(t: string): string[] {
  if (t === "deo") return ["deo", "deodorant"];
  if (t === "atc") return ["atc", "added", "cart"];
  if (t === "3pck") return ["3pck", "3", "pack"];
  if (t === "alll") return ["alll", "all"];
  return [t];
}

/** True when every Blake token is present on the live name (aliases allowed). */
export function campaignNameMatches(blakeName: string, liveName: string): boolean {
  const have = tokens(liveName);
  const haveSet = new Set(have);
  const want = tokens(blakeName);
  if (!want.length || !have.length) return false;
  return want.every((raw) => {
    const opts = expandToken(raw);
    return opts.some((t) =>
      haveSet.has(t) || have.some((h) => h === t || (t.length >= 4 && (h.includes(t) || t.includes(h)))),
    );
  });
}

function uniqueIds(rows: { campaign_id: string }[]): string[] {
  return [...new Set(rows.map((r) => String(r.campaign_id ?? "")).filter(Boolean))];
}

export function resolveNamedCampaign(
  blakeName: string,
  lookup: BlakeLookup,
  term?: string,
): { campaign_id: string; campaign_name: string; ad_group: string } {
  const nameHits = lookup.campaigns.filter((c) => campaignNameMatches(blakeName, c.campaign_name));
  const nameIds = uniqueIds(nameHits);

  const termKey = String(term ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const termHits = termKey
    ? lookup.terms.filter((t) => {
        const key = String(t.search_term ?? "").trim().toLowerCase().replace(/\s+/g, " ");
        return key === termKey && campaignNameMatches(blakeName, t.campaign_name);
      })
    : [];
  const termIds = uniqueIds(termHits);

  const termAnywhere = termKey
    ? lookup.terms.filter((t) => t.search_term.trim().toLowerCase().replace(/\s+/g, " ") === termKey)
    : [];

  if (termKey && termHits.length) {
    if (termIds.length === 1) {
      const id = termIds[0];
      const live = termHits.find((t) => t.campaign_id === id);
      const groups = [...new Set(termHits.filter((t) => t.campaign_id === id).map((t) => String(t.ad_group_name ?? "")).filter(Boolean))];
      return {
        campaign_id: id,
        campaign_name: live?.campaign_name ?? blakeName,
        ad_group: groups.length === 1 ? groups[0] : "",
      };
    }
    return { campaign_id: "", campaign_name: blakeName, ad_group: "" };
  }

  if (nameIds.length === 1) {
    const id = nameIds[0];
    const live = nameHits.find((c) => c.campaign_id === id);
    if (termKey && termAnywhere.length) {
      const onCampaign = termAnywhere.filter((t) => t.campaign_id === id);
      if (onCampaign.length === 0) {
        // Unique name, but the term lives elsewhere — do not attach the wrong id.
        return { campaign_id: "", campaign_name: blakeName, ad_group: "" };
      }
      const groups = [...new Set(onCampaign.map((t) => String(t.ad_group_name ?? "")).filter(Boolean))];
      return {
        campaign_id: id,
        campaign_name: live?.campaign_name ?? blakeName,
        ad_group: groups.length === 1 ? groups[0] : "",
      };
    }
    // Unique name and (no term, or term absent from Dashboard — e.g. SB/SD).
    return {
      campaign_id: id,
      campaign_name: live?.campaign_name ?? blakeName,
      ad_group: "",
    };
  }

  return { campaign_id: "", campaign_name: blakeName, ad_group: "" };
}

function liveCpc(lookup: BlakeLookup, campaignId: string, term?: string, placement?: string | null): number | null {
  if (term) {
    const key = term.trim().toLowerCase().replace(/\s+/g, " ");
    let spend = 0, clicks = 0;
    for (const t of lookup.terms) {
      if (campaignId && t.campaign_id !== campaignId) continue;
      if (t.search_term.trim().toLowerCase().replace(/\s+/g, " ") !== key) continue;
      spend += Number(t.spend ?? 0);
      clicks += Number(t.clicks ?? 0);
    }
    if (clicks > 0 && spend > 0) return spend / clicks;
  }
  if (placement && campaignId) {
    const pkey = placement.toLowerCase();
    let spend = 0, clicks = 0;
    for (const p of lookup.placements) {
      if (p.campaign_id !== campaignId) continue;
      if (!String(p.placement ?? "").toLowerCase().includes(pkey)) continue;
      spend += Number(p.spend ?? 0);
      clicks += Number(p.clicks ?? 0);
    }
    if (clicks > 0 && spend > 0) return spend / clicks;
  }
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
  if (!term) return BLAKE_24D_LANE.nonbrand;
  return isBranded(term) ? BLAKE_24D_LANE.branded : BLAKE_24D_LANE.nonbrand;
}

function blakeWindow(): WeeklyWindow {
  return {
    start: BLAKE_24D_START,
    end: BLAKE_24D_END,
    days: BLAKE_24D_DAYS,
    days_with_rows: BLAKE_24D_DAYS,
    label: BLAKE_24D_WINDOW_LABEL,
  };
}

function specs(): BlakeSpec[] {
  const nb = BLAKE_24D_LANE.nonbrand;
  const br = BLAKE_24D_LANE.branded;
  return [
    {
      rank: "R1", action: "pause_keyword",
      campaign: "GG Deodorant Exact SQR CST", ad_group: "Exact",
      term: "deodorant men", match_type: "EXACT",
      clicks: 80, spend: 93.99, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Exact KW = term, $0 sales on 80 clicks / $93.99. Pause the keyword. Nonbrand lane CVR ${nb}%, click floor 10. 24d Blake-ranked.`,
    },
    {
      rank: "R1", action: "pause_keyword",
      campaign: "GG Lip Balm Exact Untargeted", ad_group: "Exact",
      term: "lip moisturizer for very dry lips", match_type: "EXACT",
      clicks: 51, spend: 88.51, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Exact KW = term, $0 sales on 51 clicks / $88.51. Pause the keyword. Nonbrand lane CVR ${nb}%, click floor 10. 24d Blake-ranked.`,
    },
    {
      rank: "R1", action: "pause_keyword",
      campaign: "GG SP KW Tallow Balm B0CLF5B27Y Exact 4", ad_group: "Exact",
      term: "beef tallow moisturizer", match_type: "EXACT",
      clicks: 25, spend: 47.63, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Exact KW = term, $0 sales on 25 clicks / $47.63. Pause the keyword. Nonbrand lane CVR ${nb}%, click floor 10. 24d Blake-ranked.`,
    },
    {
      rank: "R1", action: "pause_keyword",
      campaign: "GG Lip Balm Exact ChapStick related", ad_group: "Exact",
      term: "chapstick natural", match_type: "EXACT",
      clicks: 13, spend: 48.20, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Exact KW = term, $0 sales on 13 clicks / $48.20. Pause the keyword. Nonbrand lane CVR ${nb}%, click floor 10. 24d Blake-ranked.`,
    },
    {
      rank: "R1", action: "negative_exact",
      campaign: "SP ASIN COMP Exact Tallow Deo B0CLHYY3BB", ad_group: "B0CLHYY3BB",
      term: "b0f7zfzd9z", match_type: "TARGETING",
      clicks: 55, spend: 106.11, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Customer query ≠ targeting expression; $0 sales on 55 clicks / $106.11. Add negative exact (do not pause the ASIN). Nonbrand lane CVR ${nb}%, click floor 10. 24d Blake-ranked.`,
    },
    {
      rank: "R1", action: "negative_exact",
      campaign: "GG B0CLHYY3BB Deo Asin Defense", ad_group: "Asin Defense",
      term: "carpe deodorant", match_type: "TARGETING",
      clicks: 35, spend: 65.55, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Customer query ≠ targeting expression; $0 sales on 35 clicks / $65.55. Add negative exact. Not a Carpe harvest. Nonbrand lane CVR ${nb}%, click floor 10. 24d Blake-ranked.`,
    },
    {
      rank: "R1", action: "negative_exact",
      campaign: "GG Lip Balm Asin Offense Category", ad_group: "Asin Offense",
      term: "dr dans cortibalm lip balm", match_type: "TARGETING",
      clicks: 27, spend: 49.38, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Customer query ≠ targeting expression; $0 sales on 27 clicks / $49.38. Add negative exact. Nonbrand lane CVR ${nb}%, click floor 10. 24d Blake-ranked.`,
    },
    {
      rank: "R1", action: "negative_exact",
      campaign: "SP KW Men's Deodorant Phrase B0CLHYY3BB", ad_group: "B0CLHYY3BB",
      term: "non toxic mens deodorant", match_type: "PHRASE",
      clicks: 32, spend: 46.57, sales: 0, acos: null, term_cvr: 0,
      requireTermOnCampaign: true,
      why: `Phrase match, term ≠ pause target; $0 sales on 32 clicks / $46.57. Add negative exact. Nonbrand lane CVR ${nb}%, click floor 10. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "SP KW Exact(PM) Lip Balm DPB0CLHTKY3V/B0CLHVLG2F",
      term: "organic lip balm", match_type: "EXACT",
      clicks: 614, spend: 1119, acos: 67.2, term_cvr: 19.4,
      requireTermOnCampaign: true,
      why: `ACOS 67.2% vs lip break-even ~42%. Term CVR 19.4% vs nonbrand lane ${nb}%. Bid down, never pause. new_bid = live CPC × 0.42 / ACOS. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "SP 1KW ROS-PP Exact Lip Balm B0CLHTKY3V",
      term: "lip balm organic", match_type: "EXACT",
      spend: 281, acos: 105.6,
      requireTermOnCampaign: true,
      why: `ACOS 105.6% vs lip break-even ~42%. Bid down, never pause — no pause row. new_bid = live CPC × 0.42 / ACOS. Nonbrand lane ${nb}%. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "Hero TOS chapstick 3Pck",
      term: "natural chapstick", match_type: "EXACT",
      spend: 177, acos: 63.4,
      requireTermOnCampaign: true,
      why: `ACOS 63.4% vs lip break-even ~42%. Bid down (never pause). new_bid = live CPC × 0.42 / ACOS. Nonbrand lane ${nb}%. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "Hero TOS chapstick 3Pck",
      term: "best chapstick", match_type: "EXACT",
      spend: 126, acos: 225,
      requireTermOnCampaign: true,
      why: `Same family as natural chapstick. ACOS 225% vs lip break-even ~42%. Bid down (never pause). new_bid = live CPC × 0.42 / ACOS. Nonbrand lane ${nb}%. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "GG Deo Exact SQR CST",
      term: "deodorant aluminum free", match_type: "EXACT",
      spend: 132, acos: 55.2,
      requireTermOnCampaign: true,
      why: `ACOS 55.2% vs lip break-even ~42%. Bid down. new_bid = live CPC × 0.42 / ACOS. Nonbrand lane ${nb}%. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "GG Lip Balm Asin Offense Category", ad_group: "Asin Offense",
      term: "B07XXPHQZK", match_type: "TARGETING",
      requireTermOnCampaign: true,
      why: `Product target B07XXPHQZK. Bid down (not pause). new_bid = live CPC × 0.42 / ACOS. Nonbrand lane ${nb}%. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "bid_down",
      campaign: "GG Lip Balm Asin Offense Category", ad_group: "Asin Offense",
      term: "B00EXPRM7C", match_type: "TARGETING",
      requireTermOnCampaign: true,
      why: `Product target B00EXPRM7C. Bid down (not pause). new_bid = live CPC × 0.42 / ACOS. Nonbrand lane ${nb}%. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "cut_detail_page",
      campaign: "Auto AUD Catch All Mixed",
      placement: "Detail Page",
      acos: 188,
      why: `Detail Page ACOS 188%. Cut DP. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "cut_detail_page",
      campaign: "GG Lip Balm Broad M",
      placement: "Detail Page",
      acos: 240,
      why: `Detail Page ACOS 240%. Cut DP. No TOS raise. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "cut_detail_page",
      campaign: "STR KW Exact Lip Unscented B0CLHVCPL5",
      placement: "Detail Page",
      acos: 90,
      why: `Detail Page ACOS 90%. Cut DP first. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "raise_tos",
      campaign: "STR KW Exact Lip Unscented B0CLHVCPL5",
      placement: "Top of Search",
      acos: 25.8,
      why: `TOS 25.8%. Raise TOS +20–40pts AFTER the DP cut. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "cut_detail_page",
      campaign: "Auto Loose TOS 3Pck B0CLHTKY3V",
      placement: "Detail Page",
      acos: 122.6,
      why: `Detail Page ACOS 122.6%. Cut DP. HOLD TOS — do not raise TOS on Auto Loose. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "cut_detail_page",
      campaign: "Hero Exact chapstick 3Pck",
      placement: "Detail Page",
      acos: 131,
      why: `Detail Page ACOS 131%. Cut DP. HOLD TOS — do not raise TOS on Hero Exact. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "cut_detail_page",
      campaign: "Catch Alll ATC AMC TOS",
      placement: "Detail Page",
      acos: 136,
      why: `Detail Page ACOS 136%. Cut DP. No TOS raise. 24d Blake-ranked.`,
    },
    {
      rank: "R2", action: "raise_tos",
      campaign: "Deo Broad ISO B0CLHYY3BB",
      placement: "Top of Search",
      acos: 21.7,
      why: `TOS 21.7%. Raise TOS +20–40pts. 24d Blake-ranked.`,
    },
    {
      rank: "R3", action: "bid_up",
      campaign: "SP STR Comp KW Exact Lip Unscented B0CLHVCPL5",
      term: "primal essence tallow lip balm", match_type: "EXACT",
      spend: 55, acos: 9.5, orders: 27,
      requireTermOnCampaign: true,
      why: `ACOS 9.5%, 27 orders. Term CVR vs branded lane ${br}%. Bid up +15% (CPC × 1.15). 24d Blake-ranked.`,
    },
    {
      rank: "R3", action: "brand_defense",
      campaign: "SP Branded KW TOS Exact Tallow Balm Mixed",
      term: "tallowbourne", match_type: "EXACT",
      spend: 41, acos: 15.5,
      requireTermOnCampaign: true,
      why: `Brand term ACOS 15.5% vs branded lane ${br}%. Brand defense (bid up +15%). 24d Blake-ranked.`,
    },
    {
      rank: "R3", action: "bid_up",
      campaign: "SBH Phrase tallow deodorant",
      term: "tallow deodorant", match_type: "PHRASE",
      spend: 93, acos: 21.8, term_cvr: 43.9,
      why: `SBH Phrase ACOS 21.8%, CVR 43.9% vs branded lane ${br}%. Bid up +15% (CPC × 1.15). Search-term reports are SP-only. 24d Blake-ranked.`,
    },
    {
      rank: "R3", action: "bid_up",
      campaign: "SP Exact chap stick",
      term: "chap stick", match_type: "EXACT",
      spend: 80, acos: 23.9, term_cvr: 48,
      requireTermOnCampaign: true,
      why: `SP Exact ACOS 23.9%, CVR 48% vs nonbrand lane ${nb}%. Bid up +15% (CPC × 1.15). 24d Blake-ranked.`,
    },
    {
      rank: "R3", action: "harvest_exact",
      campaign: "Auto Loose TOS 3Pck B0CLHTKY3V",
      term: "beef tallow lip balm", match_type: "AUTO",
      clicks: 95, spend: 155, sales: 518, term_cvr: 38.9,
      requireTermOnCampaign: true,
      why: `95 cl, $155, $518, CVR 38.9% vs nonbrand lane ${nb}%. Harvest into Exact harvest AG, not Auto. Do not harvest Aquaphor/Carpe. 24d Blake-ranked.`,
    },
    {
      rank: "R3", action: "harvest_exact",
      campaign: "GG Lip Balm Broad M", ad_group: "Broad",
      term: "non toxic organic chapstick", match_type: "BROAD",
      orders: 14, acos: 8.1,
      requireTermOnCampaign: true,
      why: `14 orders, 8.1% ACOS vs nonbrand lane ${nb}%. Harvest into Exact, then negative exact in Broad. Do not harvest Aquaphor/Carpe. 24d Blake-ranked.`,
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
      : (outClicks > 0 && spec.orders == null && termKey ? null : spec.term_cvr ?? null);
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
  const cpc = liveCpc(lookup, resolvedId, spec.term, spec.placement)
    ?? (clicks > 0 && spend > 0 ? spend / clicks : null);
  if (cpc == null) return null;
  if (spec.action === "bid_down") {
    return acos != null ? newBidDownFromAcosPct(cpc, acos) : null;
  }
  if (spec.action === "bid_up" || spec.action === "brand_defense") {
    return newBidUp(cpc);
  }
  return null;
}

function rowId(spec: BlakeSpec, campaignId: string, idx: number): string {
  const camp = campaignId || spec.campaign;
  const term = spec.term || spec.placement || "";
  return [
    BLAKE_24D_END,
    camp,
    term,
    spec.match_type ?? "",
    spec.action,
    String(idx + 1),
  ].join("|");
}

export function blake24dWindow(): WeeklyWindow {
  return blakeWindow();
}

export function buildBlake24dList(input: {
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
    // Catch Alll: keep Blake's spelling even when the live name dropped an L.
    const campaign = /catch alll/i.test(spec.campaign)
      ? spec.campaign
      : (resolved.campaign_id ? resolved.campaign_name : spec.campaign);
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
      window: BLAKE_24D_WINDOW_LABEL,
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
    execute_list: "blake_24d",
    window_chip: BLAKE_24D_WINDOW_CHIP,
    window: { search: window, placement: window },
    account_cvr: input.account_cvr ?? 0,
    account_cvr_source: "ads_campaigns_daily",
    account_cvr_branded: BLAKE_24D_LANE.branded,
    account_cvr_nonbranded: BLAKE_24D_LANE.nonbrand,
    lane_cvr_source: "ads_search_terms_daily + brand_terms.json",
    click_floor: BLAKE_24D_LANE.click_floor,
    open_count,
    done_count,
    skipped_count,
    search_term_coverage: "SP-only",
    notes: [
      "24d Blake-ranked list; 90d backfill continues for next Monday.",
      "HOLD lifted for this 24d list only. Window 2026-08-06..08-29 (24d). Do not call this 90d. Do not auto-buildBleeders from all terms.",
      "pause_keyword only where the search term equals the exact keyword. Done/Skipped persist on ads_action_decisions (7-day lock). Nothing writes to Amazon.",
      `Lane context: branded CVR ${BLAKE_24D_LANE.branded}%, nonbrand CVR ${BLAKE_24D_LANE.nonbrand}%, click floor ${BLAKE_24D_LANE.click_floor}. new_bid down = live CPC × 0.42 / ACOS; up = CPC × 1.15. current_bid always blank.`,
    ],
    cadence: [...WEEKLY_CADENCE],
    hold: [...WEEKLY_HOLD],
    grok_prompt: WEEKLY_GROK_PROMPT,
    new_bid: {
      down: "CPC × 0.42 / ACOS (ACOS = spend/sales)",
      up: "CPC × 1.15",
      current_bid: null,
    },
    lock: {
      days: WEEKLY_LOCK_DAYS,
      exception: "still-$0 bleeders may reappear",
    },
    rows: locked,
  };
}
