/**
 * Bleeders 1.0 live triage — server-only (reads brand_terms.json).
 *
 * Flag: clicks>=6 AND sales=$0 (orders=$0). Enabled SP campaigns only.
 * Skip branded $0. Sort by spend then clicks — pull order, not Blake rank.
 * This week stays buildBlake63dList. Do not import this from a client
 * component (node:fs). Nothing writes to Amazon.
 */

import { isBranded } from "./brand-terms";
import { cvrPct } from "./ppc-weekly";
import {
  BLEEDERS_10_CLICK_FLOOR,
  emptyBleeders10,
  inclusiveDays,
  isBleeders10Hit,
  recTypeOfBleeders10,
  resolveBleeders10Action,
  suggestedActionOf10,
  title10,
  windowLabel10,
  type Bleeders10Action,
  type Bleeders10CampaignRow,
  type Bleeders10Decision,
  type Bleeders10Payload,
  type Bleeders10Row,
  type Bleeders10TermRow,
} from "./ppc-bleeders-10";

export type { Bleeders10CampaignRow, Bleeders10TermRow };

function norm(s: string | null | undefined): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function storedWindow(termRows: Bleeders10TermRow[]): {
  start: string; end: string; days: number; daysWithRows: number;
} | null {
  const dates: string[] = [];
  const distinct = new Set<string>();
  for (const r of termRows) {
    const d = String(r.date ?? "");
    if (!d) continue;
    dates.push(d);
    distinct.add(d);
  }
  if (dates.length === 0) return null;
  dates.sort();
  const start = dates[0];
  const end = dates[dates.length - 1];
  return {
    start,
    end,
    days: inclusiveDays(start, end),
    daysWithRows: distinct.size,
  };
}

function latestCampaigns(rows: Bleeders10CampaignRow[]): Map<string, {
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

function campaignWindowTotals(rows: Bleeders10CampaignRow[], start: string, end: string): {
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

function aggKey(r: Bleeders10TermRow): string {
  return [
    norm(r.search_term),
    String(r.campaign_id ?? ""),
    String(r.ad_group_id ?? ""),
    String(r.match_type ?? "").toUpperCase(),
  ].join("\u241F");
}

function checklistId(parts: {
  windowEnd: string;
  campaignId: string;
  adGroupId: string;
  termKey: string;
  matchType: string;
  action: string;
}): string {
  return [
    "b10",
    parts.windowEnd,
    parts.campaignId,
    parts.adGroupId,
    parts.termKey,
    parts.matchType.toUpperCase(),
    parts.action,
  ].join("|");
}

function decisionFor(
  row: { checklist_id: string; campaign_id: string; search_term: string; action: Bleeders10Action },
  decisions: Bleeders10Decision[],
): Bleeders10Decision | undefined {
  const byId = decisions.find((d) => String(d.entity_name ?? "") === row.checklist_id);
  if (byId) return byId;
  const rec = recTypeOfBleeders10(row.action);
  return decisions.find((d) => {
    const rt = String(d.rec_type ?? "");
    if (rt && rt !== rec) return false;
    if (norm(d.search_term) !== norm(row.search_term)) return false;
    if (String(d.action_type ?? "") !== row.action) return false;
    const cid = String(d.campaign_id ?? "");
    return !cid || cid === row.campaign_id;
  });
}

function statusOf(d: Bleeders10Decision | undefined): Bleeders10Row["status"] {
  const s = String(d?.status ?? "");
  if (s === "applied") return "done";
  if (s === "dismissed") return "skipped";
  return "open";
}

export function buildBleeders10(input: {
  termRows?: Bleeders10TermRow[];
  campaignRows?: Bleeders10CampaignRow[];
  decisions?: Bleeders10Decision[];
} = {}): Bleeders10Payload {
  const termRows = input.termRows ?? [];
  const campaignRows = input.campaignRows ?? [];
  const decisions = input.decisions ?? [];

  const window = storedWindow(termRows);
  if (!window) return emptyBleeders10();

  const { start: windowStart, end: windowEnd, days: windowDays, daysWithRows } = window;
  const campTotals = campaignWindowTotals(campaignRows, windowStart, windowEnd);
  const accountCvr = round2(cvrPct(campTotals.orders, campTotals.clicks) ?? 0);

  let nonOrders = 0;
  let nonClicks = 0;
  for (const r of termRows) {
    const d = String(r.date ?? "");
    if (!d || d < windowStart || d > windowEnd) continue;
    if (isBranded(String(r.search_term ?? ""))) continue;
    nonOrders += Number(r.orders_14d ?? 0);
    nonClicks += Number(r.clicks ?? 0);
  }
  const nonCvrRaw = cvrPct(nonOrders, nonClicks);
  const nonCvr = nonCvrRaw === null ? null : round2(nonCvrRaw);

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

  const flagged: Omit<Bleeders10Row, "rank">[] = [];
  for (const e of byKey.values()) {
    if (!isBleeders10Hit(e.clicks, e.sales, e.orders)) continue;
    if (isBranded(e.search_term)) continue;

    const camp = latest.get(e.campaign_id);
    if (!camp) continue;
    if (camp.status && camp.status !== "ENABLED") continue;
    if (camp.type !== "SP") continue;

    const action = resolveBleeders10Action(e.match_type, e.search_term, e.keyword);
    if (!action) continue;

    const termCvr = round2(cvrPct(e.orders, e.clicks) ?? 0);
    const id = checklistId({
      windowEnd,
      campaignId: e.campaign_id,
      adGroupId: e.ad_group_id,
      termKey: norm(e.search_term),
      matchType: e.match_type,
      action,
    });
    const draft = {
      action,
      campaign_name: e.campaign_name || camp.name,
      ad_group_name: e.ad_group_name,
      search_term: e.search_term,
      keyword: e.keyword || null,
    };
    const decision = decisionFor({
      checklist_id: id,
      campaign_id: e.campaign_id,
      search_term: e.search_term,
      action,
    }, decisions);

    flagged.push({
      checklist_id: id,
      action,
      campaign_name: draft.campaign_name,
      campaign_id: e.campaign_id,
      ad_group_name: e.ad_group_name,
      ad_group_id: e.ad_group_id,
      search_term: e.search_term,
      keyword: draft.keyword,
      match_type: e.match_type,
      clicks: e.clicks,
      spend: round2(e.spend),
      sales_14d: round2(e.sales),
      orders: e.orders,
      term_cvr: termCvr,
      account_cvr: accountCvr,
      click_floor: BLEEDERS_10_CLICK_FLOOR,
      why: [
        `${e.clicks} clicks / ${usd(round2(e.spend))} / $0 over ${windowStart}→${windowEnd}`,
        `(${windowDays}d stored, ${daysWithRows} days with rows — not 90d).`,
        `Account CVR ${accountCvr}%. Floor 6 (1.0 triage; GNO 10/$0 not used).`,
        "Blake ranks this pull.",
      ].join(" "),
      suggested_action: suggestedActionOf10(draft),
      status: statusOf(decision),
      decision_id: decision?.id ? String(decision.id) : null,
    });
  }

  flagged.sort((a, b) => b.spend - a.spend || b.clicks - a.clicks);
  const rows: Bleeders10Row[] = flagged.map((r, i) => ({ ...r, rank: i + 1 }));

  const done_count = rows.filter((r) => r.status === "done").length;
  const skipped_count = rows.filter((r) => r.status === "skipped").length;

  return {
    version: "1.0",
    kind: "triage",
    title: title10(windowStart, windowEnd, accountCvr),
    window: {
      as_of: windowEnd,
      window_start: windowStart,
      window_end: windowEnd,
      window_days: windowDays,
      days_with_rows: daysWithRows,
      label: windowLabel10(windowStart, windowEnd, windowDays, daysWithRows),
    },
    account_cvr: accountCvr,
    account_cvr_source: "ads_campaigns_daily",
    account_cvr_nonbranded: nonCvr,
    click_floor: BLEEDERS_10_CLICK_FLOOR,
    gno_floor_overridden: true,
    open_count: rows.length - done_count - skipped_count,
    done_count,
    skipped_count,
    search_term_coverage: "SP-only",
    notes: [
      "Bleeders 1.0 is a live triage flag list (clicks>=6 AND sales=$0). Not This week. Not an execute list.",
      "Blake ranks this Dashboard pull. Dana loads This week (Blake 63d). Do not invent a ranked This week.",
      `Window ${windowStart} → ${windowEnd} is stored ads_search_terms_daily min/max (${windowDays}d inclusive, ${daysWithRows} days with rows, sparse). Not 90d.`,
      `Account CVR ${accountCvr}% is ads_campaigns_daily orders/clicks over that stored window — not a hardcoded 25%. Floor 6 overrides GNO clickFloor() for this list only.`,
      "Enabled SP campaigns only. Branded $0 skipped via brand_terms.json. pause_keyword iff term = exact KW; else negative_exact. Nothing writes to Amazon.",
    ],
    rows,
  };
}
