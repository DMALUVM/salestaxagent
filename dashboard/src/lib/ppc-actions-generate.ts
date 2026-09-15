/**
 * Live PPC recommendation scoring — keep in sync with
 * `src/amazon_ads/actions_engine.py` (`score_search_term_actions`).
 *
 * The dashboard generate endpoint cannot call Python, so this copy must emit
 * the same closed-day window, the same orders_14d attribution, the same
 * pause-vs-negate lever, and the same stale-warehouse guard.
 *
 * Nothing here writes to Amazon.
 */

export const ATTRIBUTION_FIELD = "orders_14d";
export const ATTRIBUTION_NOTE =
  "Amazon Ads 14-day click attribution from ads_search_terms_daily.orders_14d";

export const MIN_SPEND_NEGATE = 5;
export const MIN_SPEND_HARVEST = 3;
export const MIN_SPEND_REDUCE = 5;
export const MIN_CLICKS_REDUCE = 5;
export const MIN_ORDERS_HARVEST = 1;
export const MIN_WASTE_ROLLUP = 5;
export const MAX_WASTE_ROLLUPS = 5;
export const MIN_BID = 0.02;

export type SearchTermRow = {
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
};

export type RecDraft = {
  type: string;
  priority: string;
  impact_estimate: number;
  entity_type: string;
  entity_name: string;
  campaign_name: string;
  campaign_id: string;
  ad_group_id: string;
  evidence: Record<string, unknown>;
  suggested_action: string;
  status: "open";
};

export type ClosedWindow = {
  start: string;
  end: string;
  days: number;
  as_of: string;
  timezone: "America/Los_Angeles";
  closed_days_only: true;
  attribution: typeof ATTRIBUTION_FIELD;
  attribution_note: typeof ATTRIBUTION_NOTE;
  from: string;
};

export function normalizeTerm(text: string | null | undefined): string {
  return String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function termsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeTerm(a);
  const nb = normalizeTerm(b);
  return na.length > 0 && na === nb;
}

export function closedLookbackWindow(asOf: string, lookbackDays: number): ClosedWindow {
  const start = shiftDays(asOf, -(lookbackDays - 1));
  return {
    start,
    end: asOf,
    days: lookbackDays,
    as_of: asOf,
    timezone: "America/Los_Angeles",
    closed_days_only: true,
    attribution: ATTRIBUTION_FIELD,
    attribution_note: ATTRIBUTION_NOTE,
    from: start,
  };
}

export function filterClosedWindow(rows: SearchTermRow[], start: string, end: string): SearchTermRow[] {
  return rows.filter((st) => {
    const d = String(st.date ?? "");
    return d !== "" && d >= start && d <= end;
  });
}

export function warehouseFreshness(rows: SearchTermRow[], expectedEnd: string): {
  st_fresh_through: string | null;
  st_min: string | null;
  st_stale: boolean;
} {
  const dates = rows.map((st) => String(st.date ?? "")).filter(Boolean);
  const freshThrough = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  return {
    st_fresh_through: freshThrough,
    st_min: dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null,
    st_stale: freshThrough === null || freshThrough < expectedEnd,
  };
}

/** pause_keyword when Exact KW equals the search term; else negate_exact. */
export function resolveZeroOrderLever(
  keyword: string | null | undefined,
  searchTerm: string | null | undefined,
  matchTypes: Iterable<string>,
): "pause_keyword" | "negate_exact" {
  const types = new Set([...matchTypes].map((m) => String(m).toLowerCase()));
  if (types.has("exact") && termsEqual(keyword, searchTerm)) return "pause_keyword";
  return "negate_exact";
}

function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function usd(n: number): string {
  return "$" + n.toFixed(2);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type Agg = {
  search_term: string;
  campaign_id: string;
  campaign_name: string;
  ad_group_ids: Set<string>;
  ad_group_names: Set<string>;
  match_types: Set<string>;
  dates: Set<string>;
  keyword: string;
  spend: number;
  sales: number;
  orders: number;
  clicks: number;
};

export function aggregateTerms(rows: SearchTermRow[]): Map<string, Agg> {
  const agg = new Map<string, Agg>();
  for (const st of rows) {
    const searchTerm = String(st.search_term ?? "");
    const campaignId = String(st.campaign_id ?? "");
    const key = searchTerm + "\u241F" + campaignId;
    const e = agg.get(key) ?? {
      search_term: searchTerm,
      campaign_id: campaignId,
      campaign_name: String(st.campaign_name ?? ""),
      ad_group_ids: new Set<string>(),
      ad_group_names: new Set<string>(),
      match_types: new Set<string>(),
      dates: new Set<string>(),
      keyword: String(st.keyword ?? ""),
      spend: 0,
      sales: 0,
      orders: 0,
      clicks: 0,
    };
    e.spend += Number(st.spend ?? 0);
    e.sales += Number(st.sales_14d ?? 0);
    e.orders += Number(st.orders_14d ?? 0);
    e.clicks += Number(st.clicks ?? 0);
    if (st.date) e.dates.add(String(st.date));
    if (st.ad_group_id) e.ad_group_ids.add(String(st.ad_group_id));
    if (st.ad_group_name) e.ad_group_names.add(String(st.ad_group_name));
    if (st.match_type) e.match_types.add(String(st.match_type).toLowerCase());
    if (!e.keyword && st.keyword) e.keyword = String(st.keyword);
    agg.set(key, e);
  }
  return agg;
}

export function siblingExactConverters(
  agg: Map<string, Agg>,
  searchTerm: string,
  campaignId: string,
): string[] {
  const key = normalizeTerm(searchTerm);
  const names = new Set<string>();
  for (const e of agg.values()) {
    if (e.campaign_id === campaignId) continue;
    if (normalizeTerm(e.search_term) !== key) continue;
    if (e.orders <= 0) continue;
    if (!e.match_types.has("exact")) continue;
    if (e.campaign_name) names.add(e.campaign_name);
  }
  return [...names].sort();
}

function adGroupPhrase(e: Agg): string {
  const names = [...e.ad_group_names].filter(Boolean).sort();
  if (names.length === 1) return `ad group "${names[0]}"`;
  if (names.length > 1) return `each of the ${names.length} ad groups that served it`;
  return "the ad group that served it";
}

function windowPhrase(
  window: ClosedWindow,
  freshness: { st_fresh_through: string | null; st_stale: boolean },
): string {
  let phrase = ` in ${window.start} → ${window.end} (${window.days} closed days, America/Los_Angeles; ${ATTRIBUTION_FIELD} attribution)`;
  const through = freshness.st_fresh_through;
  if (freshness.st_stale) {
    phrase += `. ST warehouse through ${through || "none"} — Ads may show later orders; do not treat 0 ${ATTRIBUTION_FIELD} as gospel`;
  } else if (through && through !== window.end) {
    phrase += `. ST warehouse through ${through}`;
  }
  return phrase;
}

function makeRec(partial: Omit<RecDraft, "status">): RecDraft {
  return { ...partial, status: "open" };
}

export function scoreSearchTermActions(args: {
  rows: SearchTermRow[];
  targetAcos: number;
  lookbackDays: number;
  asOf: string;
  stFreshThrough?: string | null;
}): RecDraft[] {
  const window = closedLookbackWindow(args.asOf, args.lookbackDays);
  const freshness = warehouseFreshness(args.rows, window.end);
  if (args.stFreshThrough) {
    freshness.st_fresh_through = args.stFreshThrough;
    freshness.st_stale = args.stFreshThrough < window.end;
  }
  const windowSuffix = windowPhrase(window, freshness);
  const inWindow = filterClosedWindow(args.rows, window.start, window.end);
  if (!inWindow.length) return [];

  const byTerm = aggregateTerms(inWindow);
  const recs: RecDraft[] = [];

  for (const t of byTerm.values()) {
    const acos = t.sales > 0 ? (t.spend / t.sales) * 100 : 0;
    const cpc = t.clicks > 0 ? t.spend / t.clicks : 0;
    const matchTypes = [...t.match_types].filter(Boolean).sort();
    const adGroupId = [...t.ad_group_ids][0] ?? "";
    const adGroups = [...t.ad_group_names].filter(Boolean).sort();
    const camp = `"${t.campaign_name}"`;
    const term = `"${t.search_term}"`;
    const where = adGroupPhrase(t);
    const scope = `Campaign "${t.campaign_name}" · ${where}`;
    const dates = [...t.dates];
    const termMin = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : null;
    const termMax = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
    const siblings = siblingExactConverters(byTerm, t.search_term, t.campaign_id);
    const evidenceWindow = {
      ...window,
      ...freshness,
      term_date_min: termMin,
      term_date_max: termMax,
      term_days_with_rows: dates.length,
    };

    const waste = zeroOrderRec({
      t, acos, cpc, adGroupId, adGroups, matchTypes, camp, term, where, scope,
      window: evidenceWindow, windowSuffix, freshness, siblings,
    });
    if (waste) recs.push(waste);

    if (t.orders >= MIN_ORDERS_HARVEST && acos > 0 && acos <= args.targetAcos
        && t.spend >= MIN_SPEND_HARVEST && !t.match_types.has("exact")) {
      const startBid = round2(Math.max(cpc, MIN_BID));
      recs.push(makeRec({
        type: "HARVEST_SEARCH_TERM",
        priority: "P1",
        impact_estimate: round2(t.sales),
        entity_type: "search_term",
        entity_name: t.search_term,
        campaign_name: t.campaign_name,
        campaign_id: t.campaign_id,
        ad_group_id: adGroupId,
        evidence: {
          action_type: "harvest_exact",
          why: `${t.orders} order(s)_14d at ${acos.toFixed(0)}% ACOS on ${usd(t.spend)} spend (target ${args.targetAcos}%)` +
            `${windowSuffix}. ${scope}.`,
          spend: round2(t.spend), orders: t.orders, clicks: t.clicks,
          sales: round2(t.sales), acos: round2(acos), cpc: round2(cpc),
          suggested_bid: startBid, target_acos: args.targetAcos,
          match_types: matchTypes, ad_groups: adGroups,
          window: evidenceWindow, verified: !freshness.st_stale,
          attribution: ATTRIBUTION_FIELD,
        },
        suggested_action:
          `Add ${term} as an Exact match keyword in campaign ${camp} → ${where}` +
          ` (or your manual exact campaign), starting near its current CPC of ${usd(startBid)}. ` +
          `Then add it as a Negative exact in ${where}, where it currently serves, so the two do not compete.`,
      }));
    }

    if (acos > args.targetAcos * 1.5 && t.clicks >= MIN_CLICKS_REDUCE
        && t.orders > 0 && t.spend >= MIN_SPEND_REDUCE) {
      const savings = round2(t.spend * (1 - args.targetAcos / Math.max(acos, 1)));
      const newBid = round2(Math.max(cpc * (args.targetAcos / acos), MIN_BID));
      const kw = t.keyword || t.search_term;
      recs.push(makeRec({
        type: "REDUCE_BID",
        priority: "P1",
        impact_estimate: savings,
        entity_type: "keyword",
        entity_name: kw,
        campaign_name: t.campaign_name,
        campaign_id: t.campaign_id,
        ad_group_id: adGroupId,
        evidence: {
          action_type: "reduce_bid",
          why: `ACOS ${acos.toFixed(0)}% vs ${args.targetAcos}% target on ${usd(t.spend)} spend, ` +
            `${t.orders} order(s)_14d, ${t.clicks} clicks${windowSuffix}. ${scope}.`,
          spend: round2(t.spend), orders: t.orders, clicks: t.clicks,
          sales: round2(t.sales), acos: round2(acos), cpc: round2(cpc),
          suggested_bid: newBid, target_acos: args.targetAcos,
          match_types: matchTypes, ad_groups: adGroups,
          window: evidenceWindow, verified: !freshness.st_stale,
          attribution: ATTRIBUTION_FIELD,
        },
        suggested_action:
          `Open campaign ${camp} → ${where} → Keywords, and lower the bid on "${kw}" from about ` +
          `${usd(cpc)} to ${usd(newBid)} to pull it toward the ${args.targetAcos}% ACOS target. ` +
          `Re-check in 7 days before cutting further.`,
      }));
    }
  }

  const campaignWaste = new Map<string, { spend: number; terms: number; campaign_id: string }>();
  for (const t of byTerm.values()) {
    if (t.orders !== 0) continue;
    const e = campaignWaste.get(t.campaign_name) ?? { spend: 0, terms: 0, campaign_id: t.campaign_id };
    e.spend += t.spend;
    e.terms += 1;
    campaignWaste.set(t.campaign_name, e);
  }
  const topWaste = [...campaignWaste.entries()]
    .sort((a, b) => b[1].spend - a[1].spend)
    .slice(0, MAX_WASTE_ROLLUPS)
    .filter(([, w]) => w.spend >= MIN_WASTE_ROLLUP);
  for (const [name, w] of topWaste) {
    recs.push(makeRec({
      type: "WASTED_SPEND_ROLLUP",
      priority: "P1",
      impact_estimate: round2(w.spend),
      entity_type: "campaign",
      entity_name: name,
      campaign_name: name,
      campaign_id: w.campaign_id,
      ad_group_id: "",
      evidence: {
        action_type: "review_campaign",
        why: `${usd(w.spend)} across ${w.terms} search terms with 0 ${ATTRIBUTION_FIELD}${windowSuffix}.`,
        spend: round2(w.spend), orders: 0, zero_order_terms: w.terms,
        window: { ...window, ...freshness },
        verified: !freshness.st_stale,
        attribution: ATTRIBUTION_FIELD,
      },
      suggested_action:
        `Open campaign "${name}" → Search terms report for ${window.start} → ${window.end} ` +
        `(closed days, America/Los_Angeles), sort by Spend, and review the ${w.terms} terms ` +
        `with 0 ${ATTRIBUTION_FIELD} (${usd(w.spend)} of wasted spend). The individual rows ` +
        `list the biggest offenders — pause Exact KW=term, do not negate those.`,
    }));
  }

  const priorityOrder: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
  recs.sort((a, b) =>
    (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9) ||
    b.impact_estimate - a.impact_estimate);
  return recs;
}

function zeroOrderRec(args: {
  t: Agg;
  acos: number;
  cpc: number;
  adGroupId: string;
  adGroups: string[];
  matchTypes: string[];
  camp: string;
  term: string;
  where: string;
  scope: string;
  window: Record<string, unknown>;
  windowSuffix: string;
  freshness: { st_fresh_through: string | null; st_stale: boolean };
  siblings: string[];
}): RecDraft | null {
  const { t, cpc, adGroupId, adGroups, matchTypes, camp, term, where, scope,
    window, windowSuffix, freshness, siblings } = args;
  if (t.spend < MIN_SPEND_NEGATE || t.orders !== 0) return null;

  const lever = resolveZeroOrderLever(t.keyword, t.search_term, t.match_types);
  const siblingNote = siblings.length
    ? ` Converts elsewhere — campaign-scoped only (orders_14d on: ${siblings.join(", ")}).`
    : "";
  const metrics = `Spent ${usd(t.spend)} on ${t.clicks} clicks with 0 ${ATTRIBUTION_FIELD}` +
    `${windowSuffix}. ${scope}.${siblingNote}`;
  const commonEv = {
    spend: round2(t.spend), orders: 0, clicks: t.clicks, sales: 0, acos: null,
    cpc: round2(cpc), match_types: matchTypes, ad_groups: adGroups,
    window, attribution: ATTRIBUTION_FIELD, keyword: t.keyword || "",
    converts_elsewhere: siblings.length > 0, sibling_campaigns: siblings,
    stale: freshness.st_stale, verified: !freshness.st_stale,
    st_fresh_through: freshness.st_fresh_through,
  };

  if (freshness.st_stale) {
    const intended = lever === "pause_keyword" ? "pause the keyword" : "negate";
    return makeRec({
      type: "REVIEW_SEARCH_TERM",
      priority: "P2",
      impact_estimate: round2(t.spend),
      entity_type: "search_term",
      entity_name: t.search_term,
      campaign_name: t.campaign_name,
      campaign_id: t.campaign_id,
      ad_group_id: adGroupId,
      evidence: {
        ...commonEv,
        action_type: "review_campaign",
        intended_lever: lever,
        why: `UNVERIFIED — ST warehouse through ${freshness.st_fresh_through || "none"}, ` +
          `expected closed as-of ${String(window.end)}. ${metrics} Refresh ` +
          `ads_search_terms_daily before any ` +
          `${lever === "pause_keyword" ? "keyword pause" : "negate"}.`,
      },
      suggested_action:
        `Do not ${intended} yet. Search-term warehouse ends ${freshness.st_fresh_through || "none"}; ` +
        `Ads may have later ${ATTRIBUTION_FIELD}. Re-run Ads ST sync through ${String(window.end)}, ` +
        `then regenerate. If the refresh still shows 0 ${ATTRIBUTION_FIELD} on ` +
        `${String(window.start)} → ${String(window.end)} in campaign ${camp} → ${where}, then ` +
        (lever === "pause_keyword" ? `pause keyword ${term}.` : `add ${term} as a Negative exact.`),
    });
  }

  if (lever === "pause_keyword") {
    const kw = t.keyword || t.search_term;
    return makeRec({
      type: "PAUSE_KEYWORD",
      priority: siblings.length ? "P1" : "P0",
      impact_estimate: round2(t.spend),
      entity_type: "keyword",
      entity_name: kw,
      campaign_name: t.campaign_name,
      campaign_id: t.campaign_id,
      ad_group_id: adGroupId,
      evidence: {
        ...commonEv,
        action_type: "pause_keyword",
        why: `${metrics} Exact keyword equals the search term — pause the keyword, do not negate.`,
      },
      suggested_action:
        `In Campaign Manager, open campaign ${camp} → ${where} → Keywords, and pause "${kw}". ` +
        `Do not add a Negative exact — this Exact campaign's keyword is the search term. ` +
        `It has spent ${usd(t.spend)} with 0 ${ATTRIBUTION_FIELD}${windowSuffix}.`,
    });
  }

  return makeRec({
    type: "NEGATE_SEARCH_TERM",
    priority: siblings.length ? "P1" : "P0",
    impact_estimate: round2(t.spend),
    entity_type: "search_term",
    entity_name: t.search_term,
    campaign_name: t.campaign_name,
    campaign_id: t.campaign_id,
    ad_group_id: adGroupId,
    evidence: {
      ...commonEv,
      action_type: "negate_exact",
      why: siblings.length
        ? `${metrics} Negate on this campaign only — the term converts on sibling Exact campaigns.`
        : metrics,
    },
    suggested_action:
      `In Campaign Manager, open campaign ${camp} → ${where} → Negative keywords, and add ${term} ` +
      `as a Negative exact keyword. It has spent ${usd(t.spend)} with 0 ${ATTRIBUTION_FIELD}` +
      `${windowSuffix}.`,
  });
}
