/**
 * Bleeders 1.0 Ads-truth reconcile.
 *
 * Reads warehouse snapshots (ads_negatives, ads_keyword_targets) and marks
 * a row already_applied when Amazon already has the lever. Never writes to
 * Amazon. Manual Done/Skipped still win when present.
 */

import type { Bleeders10Action } from "./ppc-bleeders-10";

function bleeders10TermsEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = String(a ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const nb = String(b ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return na.length > 0 && na === nb;
}

export const BLEEDERS_10_ADS_STALE_HOURS = 48;

export interface Bleeders10AdsNegative {
  campaign_id?: string | null;
  campaign_name?: string | null;
  ad_group_id?: string | null;
  keyword: string;
  match_type?: string | null;
  state?: string | null;
  level?: string | null;
  snapshot_at?: string | null;
}

export interface Bleeders10AdsKeyword {
  campaign_id?: string | null;
  campaign_name?: string | null;
  ad_group_id?: string | null;
  keyword_text: string;
  match_type?: string | null;
  state?: string | null;
  snapshot_at?: string | null;
}

export interface Bleeders10AdsCampaign {
  campaign_id?: string | null;
  campaign_name?: string | null;
}

export interface Bleeders10AdsSnapshot {
  negatives?: Bleeders10AdsNegative[];
  keywords?: Bleeders10AdsKeyword[];
  campaigns?: Bleeders10AdsCampaign[];
  now?: Date | string;
}

export interface Bleeders10AdsSummary {
  negatives_count: number;
  keywords_count: number;
  pulled_at: string | null;
  stale: boolean;
  missing: boolean;
  warning: string | null;
}

export type Bleeders10AppliedSource =
  | "manual"
  | "ads_negatives"
  | "ads_keyword_targets";

export interface Bleeders10AdsHit {
  applied: boolean;
  source: "ads_negatives" | "ads_keyword_targets" | null;
  reason: string | null;
  note: string | null;
}

function normName(s: string | null | undefined): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function upper(s: string | null | undefined): string {
  return String(s ?? "").trim().toUpperCase();
}

function isExactNegativeMatch(matchType: string | null | undefined): boolean {
  const u = upper(matchType).replace(/[\s-]+/g, "_");
  return u === "EXACT" || u === "NEGATIVE_EXACT";
}

function isExactKeywordMatch(matchType: string | null | undefined): boolean {
  return upper(matchType) === "EXACT";
}

function isEnabledState(state: string | null | undefined): boolean {
  const u = upper(state);
  return u === "" || u === "ENABLED";
}

function isPausedOrArchived(state: string | null | undefined): boolean {
  const u = upper(state);
  return u === "PAUSED" || u === "ARCHIVED";
}

function parseStamp(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : null;
}

function maxSnapshotAt(
  negatives: Bleeders10AdsNegative[],
  keywords: Bleeders10AdsKeyword[],
): string | null {
  let best: string | null = null;
  let bestMs = -1;
  for (const row of [...negatives, ...keywords]) {
    const iso = row.snapshot_at ? String(row.snapshot_at) : "";
    const ms = parseStamp(iso);
    if (ms != null && ms > bestMs) {
      bestMs = ms;
      best = iso;
    }
  }
  return best;
}

function nowMs(now?: Date | string): number {
  if (!now) return Date.now();
  if (now instanceof Date) return now.getTime();
  const n = Date.parse(now);
  return Number.isFinite(n) ? n : Date.now();
}

export function summarizeBleeders10Ads(
  ads: Bleeders10AdsSnapshot | null | undefined,
  now?: Date | string,
): Bleeders10AdsSummary {
  const negatives = ads?.negatives ?? [];
  const keywords = ads?.keywords ?? [];
  const pulled_at = maxSnapshotAt(negatives, keywords);
  const missing = negatives.length === 0 && keywords.length === 0;
  const pulledMs = parseStamp(pulled_at);
  const stale = !missing && pulledMs != null
    && (nowMs(now ?? ads?.now) - pulledMs) > BLEEDERS_10_ADS_STALE_HOURS * 3600_000;
  let warning: string | null = null;
  if (missing) {
    warning = "No ads_negatives / ads_keyword_targets snapshot. Cannot detect already-applied actions. Open rows may already be done in Ads — verify before acting.";
  } else if (stale && pulled_at) {
    warning = `Ads keyword/negative snapshot is older than ${BLEEDERS_10_ADS_STALE_HOURS}h (pulled_at ${pulled_at}). Open rows may already be done in Ads — verify before acting.`;
  } else if (!pulled_at) {
    warning = "ads_negatives / ads_keyword_targets have rows but no snapshot_at. Treating as current — still verify in Ads.";
  }
  return {
    negatives_count: negatives.length,
    keywords_count: keywords.length,
    pulled_at,
    stale,
    missing,
    warning,
  };
}

function campaignIdByName(ads: Bleeders10AdsSnapshot): Map<string, string> {
  const out = new Map<string, string>();
  const add = (name: string | null | undefined, id: string | null | undefined) => {
    const n = normName(name);
    const cid = String(id ?? "").trim();
    if (n && cid) out.set(n, cid);
  };
  for (const c of ads.campaigns ?? []) add(c.campaign_name, c.campaign_id);
  for (const r of ads.negatives ?? []) add(r.campaign_name, r.campaign_id);
  for (const r of ads.keywords ?? []) add(r.campaign_name, r.campaign_id);
  return out;
}

export function bleeders10CampaignMatches(
  row: { campaign_name: string; campaign_id?: string | null; ad_group_id?: string | null },
  adsRow: { campaign_name?: string | null; campaign_id?: string | null; ad_group_id?: string | null },
  nameToId?: Map<string, string>,
): boolean {
  const rowName = normName(row.campaign_name);
  const adsName = normName(adsRow.campaign_name);
  if (rowName && adsName && rowName === adsName) return true;
  const rowId = String(row.campaign_id ?? "").trim();
  const adsId = String(adsRow.campaign_id ?? "").trim();
  if (rowId && adsId && rowId === adsId) return true;
  const resolved = nameToId?.get(rowName);
  if (resolved && adsId && resolved === adsId) return true;
  return false;
}

function adGroupScoped(
  rowAdGroupId: string | null | undefined,
  adsAdGroupId: string | null | undefined,
  level?: string | null,
): boolean {
  const rowAg = String(rowAdGroupId ?? "").trim();
  const adsAg = String(adsAdGroupId ?? "").trim();
  const lvl = String(level ?? "").trim().toLowerCase();
  if (lvl === "campaign" || !adsAg) return true;
  if (!rowAg) return true;
  return rowAg === adsAg;
}

function campaignHasRows(
  row: { campaign_name: string; campaign_id?: string | null },
  ads: Bleeders10AdsSnapshot,
  nameToId: Map<string, string>,
): { hasNegatives: boolean; hasKeywords: boolean } {
  let hasNegatives = false;
  let hasKeywords = false;
  for (const n of ads.negatives ?? []) {
    if (bleeders10CampaignMatches(row, n, nameToId)) { hasNegatives = true; break; }
  }
  for (const k of ads.keywords ?? []) {
    if (bleeders10CampaignMatches(row, k, nameToId)) { hasKeywords = true; break; }
  }
  return { hasNegatives, hasKeywords };
}

function pulledSuffix(iso: string | null): string {
  return iso ? ` pulled_at ${iso}` : "";
}

export function reconcileBleeders10Row(
  row: {
    action: Bleeders10Action;
    campaign_name: string;
    campaign_id?: string | null;
    ad_group_id?: string | null;
    search_term: string;
    keyword: string | null;
  },
  ads: Bleeders10AdsSnapshot | null | undefined,
  summary?: Bleeders10AdsSummary,
): Bleeders10AdsHit {
  const empty: Bleeders10AdsHit = { applied: false, source: null, reason: null, note: null };
  if (!ads) {
    return {
      ...empty,
      note: summary?.warning ?? "No Ads keyword/negative snapshot. Verify in Ads before acting.",
    };
  }
  const negatives = ads.negatives ?? [];
  const keywords = ads.keywords ?? [];
  const nameToId = campaignIdByName(ads);
  const cover = campaignHasRows(row, ads, nameToId);
  const pulled = summary?.pulled_at ?? maxSnapshotAt(negatives, keywords);

  if (row.action === "negative_exact") {
    for (const n of negatives) {
      if (!bleeders10CampaignMatches(row, n, nameToId)) continue;
      if (!isExactNegativeMatch(n.match_type)) continue;
      if (!isEnabledState(n.state)) continue;
      if (!bleeders10TermsEqual(row.search_term, n.keyword)) continue;
      if (!adGroupScoped(row.ad_group_id, n.ad_group_id, n.level)) continue;
      return {
        applied: true,
        source: "ads_negatives",
        reason: `Found negative exact in ads_negatives${pulledSuffix(n.snapshot_at ?? pulled)}.`,
        note: null,
      };
    }
    if (summary?.missing) {
      return { ...empty, note: summary.warning };
    }
    if (!cover.hasNegatives && !cover.hasKeywords) {
      return {
        ...empty,
        note: "No keyword or negative snapshot rows for this campaign. Cannot confirm Ads state — verify in Ads before acting.",
      };
    }
    return empty;
  }

  const kwText = row.keyword || row.search_term;
  let sawEnabledExact = false;
  for (const k of keywords) {
    if (!bleeders10CampaignMatches(row, k, nameToId)) continue;
    if (!isExactKeywordMatch(k.match_type)) continue;
    if (!bleeders10TermsEqual(kwText, k.keyword_text)) continue;
    if (!adGroupScoped(row.ad_group_id, k.ad_group_id)) continue;
    if (isPausedOrArchived(k.state)) {
      return {
        applied: true,
        source: "ads_keyword_targets",
        reason: `Keyword ${upper(k.state).toLowerCase()} in ads_keyword_targets${pulledSuffix(k.snapshot_at ?? pulled)}.`,
        note: null,
      };
    }
    if (isEnabledState(k.state)) sawEnabledExact = true;
  }
  if (summary?.missing) {
    return { ...empty, note: summary.warning };
  }
  if (!cover.hasKeywords && !cover.hasNegatives) {
    return {
      ...empty,
      note: "No keyword or negative snapshot rows for this campaign. Cannot confirm Ads state — verify in Ads before acting.",
    };
  }
  if (!sawEnabledExact && cover.hasKeywords) {
    return {
      ...empty,
      note: `Exact keyword "${kwText}" not found in ads_keyword_targets for this campaign (archived keywords may be missing from the snapshot). Confirm in Ads — do not invent a pause.`,
    };
  }
  return empty;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function opt(v: unknown): string | null {
  const s = str(v).trim();
  return s ? s : null;
}

/** Map warehouse rows onto the reconcile snapshot. */
export function adsSnapshotFromWarehouse(input: {
  negatives?: Array<Record<string, unknown>>;
  keywords?: Array<Record<string, unknown>>;
  campaigns?: Array<Record<string, unknown>>;
  now?: Date | string;
}): Bleeders10AdsSnapshot {
  return {
    now: input.now,
    campaigns: (input.campaigns ?? []).map((r) => ({
      campaign_id: opt(r.campaign_id),
      campaign_name: str(r.campaign_name),
    })),
    negatives: (input.negatives ?? []).map((r) => ({
      campaign_id: opt(r.campaign_id),
      campaign_name: str(r.campaign_name),
      ad_group_id: opt(r.ad_group_id),
      keyword: str(r.keyword),
      match_type: opt(r.match_type),
      state: opt(r.state),
      level: opt(r.level),
      snapshot_at: opt(r.snapshot_at),
    })),
    keywords: (input.keywords ?? []).map((r) => ({
      campaign_id: opt(r.campaign_id),
      campaign_name: str(r.campaign_name),
      ad_group_id: opt(r.ad_group_id),
      keyword_text: str(r.keyword_text ?? r.keyword),
      match_type: opt(r.match_type),
      state: opt(r.state),
      snapshot_at: opt(r.snapshot_at),
    })),
  };
}
