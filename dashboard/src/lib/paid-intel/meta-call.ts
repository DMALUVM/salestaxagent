/**
 * Weekly Meta Ads Manager call sheet.
 *
 * Ranked keep / kill / scale / refresh asks from official meta_ads_*
 * grains. Never invent spend, ROAS, CPA, or CTR. Never move Meta budget
 * onto Brand Search. Win/lose only where spend ≥ $1.
 */
import { shiftDays } from "../as-of";
import { deriveRoas, round2 } from "./csv";
import { filterCampaigns, inRange, priorWindow, rangeStart } from "./window";
import type {
  CampaignDaily, MetaCallItem, MetaCallSheet, MetaGrainRow,
} from "./types";

const MATERIAL = 1;
const KILL_SPEND = 15;
const CUT_SPEND = 25;
const SCALE_SPEND = 15;
const REFRESH_SPEND = 10;
const MAX_ITEMS = 6;

type Kind = MetaCallItem["entity_kind"];

interface Agg {
  kind: Kind;
  name: string;
  campaign: string;
  spend: number;
  value: number;
  conversions: number;
  clicks: number;
  impressions: number;
  freqPeak: number | null;
  ctrNum: number;
  ctrDen: number;
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function cpaOf(spend: number, conversions: number): number | null {
  if (!(conversions > 0)) return null;
  return round2(spend / conversions);
}

function ctrOf(a: Agg): number | null {
  if (a.ctrDen > 0) return a.ctrNum / a.ctrDen;
  if (a.impressions > 0) return (a.clicks / a.impressions) * 100;
  return null;
}

function addGrain(map: Map<string, Agg>, row: MetaGrainRow, kind: Kind) {
  if (row.spend < 0) return;
  const key = `${kind}|${row.campaign_name}|${row.entity_name}`;
  const cur = map.get(key) ?? {
    kind, name: row.entity_name, campaign: row.campaign_name,
    spend: 0, value: 0, conversions: 0, clicks: 0, impressions: 0,
    freqPeak: null, ctrNum: 0, ctrDen: 0,
  };
  cur.spend += row.spend;
  cur.value += row.conv_value;
  cur.conversions += row.conversions;
  cur.clicks += row.clicks;
  cur.impressions += row.impressions;
  if (row.frequency != null) cur.freqPeak = Math.max(cur.freqPeak ?? 0, row.frequency);
  if (row.ctr != null && row.impressions > 0) {
    cur.ctrNum += row.ctr * row.impressions;
    cur.ctrDen += row.impressions;
  }
  map.set(key, cur);
}

function addCampaign(map: Map<string, Agg>, row: CampaignDaily) {
  if (row.platform !== "meta") return;
  const key = `campaign|${row.campaign_name}|${row.campaign_name}`;
  const cur = map.get(key) ?? {
    kind: "campaign" as const, name: row.campaign_name, campaign: row.campaign_name,
    spend: 0, value: 0, conversions: 0, clicks: 0, impressions: 0,
    freqPeak: null, ctrNum: 0, ctrDen: 0,
  };
  cur.spend += row.spend;
  cur.value += row.conv_value;
  cur.conversions += row.conversions;
  cur.clicks += row.clicks;
  cur.impressions += row.impressions;
  const peak = row.frequency_peak ?? row.frequency;
  if (peak != null) cur.freqPeak = Math.max(cur.freqPeak ?? 0, peak);
  map.set(key, cur);
}

function windowGrains(rows: MetaGrainRow[], start: string, end: string): MetaGrainRow[] {
  return rows.filter((r) => inRange(r.date, start, end));
}

function classify(
  last: Agg,
  prior: Agg | undefined,
): Omit<MetaCallItem, "rank"> | null {
  const spend = round2(last.spend);
  if (spend < MATERIAL) return null;
  const roas = deriveRoas(last.spend, last.value);
  const priorRoas = prior && prior.spend >= MATERIAL
    ? deriveRoas(prior.spend, prior.value) : null;
  const cpa = cpaOf(last.spend, last.conversions);
  const priorSpend = prior && prior.spend >= MATERIAL ? round2(prior.spend) : null;
  const ctr = ctrOf(last);
  const priorCtr = prior ? ctrOf(prior) : null;
  const label = last.kind === "campaign" ? last.name
    : last.kind === "adset" ? `${last.name} ad set`
    : `${last.name} ad`;
  const base = {
    entity_kind: last.kind,
    entity_name: last.name,
    campaign_name: last.campaign,
    spend,
    conv_value: round2(last.value),
    conversions: round2(last.conversions),
    roas,
    cpa,
    prior_spend: priorSpend,
    prior_roas: priorRoas,
  };

  if (spend >= SCALE_SPEND && roas >= 1.5 && last.conversions > 0
    && (priorRoas == null || roas >= priorRoas * 0.9)) {
    return {
      ...base,
      action: "scale",
      say: `Scale ${label} — raise budget ~20%. Do not move this onto Brand Search.`,
      why: `${money(spend)} at ${roas.toFixed(2)}x`
        + (cpa != null ? ` · CPA ${money(cpa)}` : "")
        + (priorRoas != null ? ` · prior ${priorRoas.toFixed(2)}x` : ""),
    };
  }

  if (spend >= KILL_SPEND && last.value < 1 && last.conversions < 0.5) {
    return {
      ...base,
      action: "kill",
      say: `Pause ${label}.`,
      why: `${money(spend)} / ${last.conversions} conv / ${money(last.value)}`
        + (priorSpend != null ? ` · prior ${money(priorSpend)}` : ""),
    };
  }

  if (spend >= CUT_SPEND && roas < 1 && last.value >= 1) {
    return {
      ...base,
      action: "cut",
      say: `Cut budget on ${label} 30%. Do not send the leftover to Brand Search.`,
      why: `${money(spend)} at ${roas.toFixed(2)}x`
        + (cpa != null ? ` · CPA ${money(cpa)}` : "")
        + (priorRoas != null ? ` · prior ${priorRoas.toFixed(2)}x` : ""),
    };
  }

  const ctrCollapsed = priorCtr != null && ctr != null
    && priorCtr >= 0.5 && ctr < priorCtr * 0.6;
  const tired = (last.freqPeak ?? 0) >= 2.4;
  if (last.kind === "ad" && spend >= REFRESH_SPEND && (ctrCollapsed || tired)) {
    const why = ctrCollapsed && priorCtr != null && ctr != null
      ? `CTR ${priorCtr.toFixed(1)}% → ${ctr.toFixed(1)}%`
      : `frequency ${last.freqPeak!.toFixed(2)}`;
    return {
      ...base,
      action: "refresh",
      say: ctrCollapsed
        ? `Creative refresh on ${label} — CTR collapsed.`
        : `Creative refresh on ${label} — frequency ${last.freqPeak!.toFixed(2)}.`,
      why: `${money(spend)} · ${why}. Do not raise spend.`,
    };
  }

  if (spend >= MATERIAL && roas >= 1.5 && last.conversions > 0) {
    return {
      ...base,
      action: "keep",
      say: `Keep ${label} — do not cut it and do not move this onto Brand Search.`,
      why: `${money(spend)} at ${roas.toFixed(2)}x`
        + (cpa != null ? ` · CPA ${money(cpa)}` : "")
        + (priorRoas != null ? ` · prior ${priorRoas.toFixed(2)}x` : ""),
    };
  }

  return null;
}

function stake(item: Omit<MetaCallItem, "rank">): number {
  if (item.action === "kill") return item.spend;
  if (item.action === "cut") return round2(item.spend * 0.3);
  if (item.action === "refresh") return round2(item.spend * 0.25);
  if (item.action === "scale") return round2(item.spend * 0.2);
  return 0;
}

function covers(child: Omit<MetaCallItem, "rank">, parent: Omit<MetaCallItem, "rank">): boolean {
  if (child.campaign_name !== parent.campaign_name) return false;
  if (parent.entity_kind === "campaign" && child.entity_kind !== "campaign") {
    return child.spend >= parent.spend * 0.5;
  }
  if (parent.entity_kind === "adset" && child.entity_kind === "ad") {
    return child.entity_name !== parent.entity_name && child.spend >= parent.spend * 0.5;
  }
  return false;
}

export function buildMetaCallSheet(opts: {
  campaigns: CampaignDaily[];
  adsets?: MetaGrainRow[];
  ads?: MetaGrainRow[];
  asOf: string | null;
}): MetaCallSheet {
  const asOf = opts.asOf;
  if (!asOf) return { as_of: null, items: [] };
  const last = filterCampaigns(opts.campaigns, asOf, 7, "meta");
  const prior = priorWindow(opts.campaigns, asOf, 7, "meta");
  const lastStart = rangeStart(asOf, 7);
  const priorEnd = shiftDays(asOf, -7);
  const priorStart = rangeStart(priorEnd, 7);

  const lastMap = new Map<string, Agg>();
  const priorMap = new Map<string, Agg>();
  for (const row of last) addCampaign(lastMap, row);
  for (const row of prior) addCampaign(priorMap, row);
  for (const row of windowGrains(opts.adsets ?? [], lastStart, asOf)) {
    addGrain(lastMap, row, "adset");
  }
  for (const row of windowGrains(opts.ads ?? [], lastStart, asOf)) {
    addGrain(lastMap, row, "ad");
  }
  for (const row of windowGrains(opts.adsets ?? [], priorStart, priorEnd)) {
    addGrain(priorMap, row, "adset");
  }
  for (const row of windowGrains(opts.ads ?? [], priorStart, priorEnd)) {
    addGrain(priorMap, row, "ad");
  }

  const raw: Array<Omit<MetaCallItem, "rank">> = [];
  for (const [key, agg] of lastMap) {
    const item = classify(agg, priorMap.get(key));
    if (item) raw.push(item);
  }

  raw.sort((a, b) => stake(b) - stake(a)
    || a.entity_name.localeCompare(b.entity_name));

  const kept: Array<Omit<MetaCallItem, "rank">> = [];
  for (const item of raw) {
    const hiddenByChild = kept.some((c) => covers(c, item));
    if (hiddenByChild) continue;
    // Drop a parent we already listed if this child covers it.
    const idx = kept.findIndex((p) => covers(item, p));
    if (idx >= 0) kept.splice(idx, 1);
    kept.push(item);
    if (kept.length >= MAX_ITEMS) break;
  }

  return {
    as_of: asOf,
    items: kept
      .sort((a, b) => stake(b) - stake(a) || a.entity_name.localeCompare(b.entity_name))
      .slice(0, MAX_ITEMS)
      .map((item, i) => ({ ...item, rank: i + 1 })),
  };
}

/** Digest one-liners from locked-day Meta campaign rows. Never invent. */
export function metaDigestActions(
  rows: Array<Record<string, unknown>>,
  date: string,
  limit = 3,
): Array<{ campaign_name: string; spend: number; conversions: number | null; say: string }> {
  const day = rows.filter((r) => String(r.metric_date ?? "").slice(0, 10) === date);
  const out: Array<{ campaign_name: string; spend: number; conversions: number | null; say: string }> = [];
  for (const r of day) {
    const name = String(r.campaign_name ?? "").trim();
    const spend = Number(r.spend);
    if (!name || !Number.isFinite(spend) || spend < 5) continue;
    const conv = r.conversions == null || r.conversions === ""
      ? null : Number(r.conversions);
    if (conv == null) continue;
    if (conv < 0.5) {
      out.push({
        campaign_name: name,
        spend: round2(spend),
        conversions: conv,
        say: `Pause ${name}.`,
      });
    }
  }
  return out
    .sort((a, b) => b.spend - a.spend || a.campaign_name.localeCompare(b.campaign_name))
    .slice(0, limit);
}
