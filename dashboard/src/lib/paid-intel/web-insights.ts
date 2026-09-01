/** Site half of a /paid-ads upload. Reads only paid_ga_daily / paid_search_query_daily / paid_campaign_daily columns. */

import { productOf, productOfPath } from "./classify";
import type {
  CampaignDaily, GaDaily, IntelRangeDays, PaidPlatform, SearchQueryDaily,
  WebInsights, WebInsightsChannelGap, WebInsightsGscPage, WebInsightsGscQuery,
  WebInsightsLanding, WebInsightsWindow,
} from "./types";

/** GSC Pages.csv: "high impressions" that still fail to earn the click. 836 in the lock upload qualifies. */
const HIGH_IMPR = 400;
/** CTR is stored 0–100, same as Queries.csv / Pages.csv. */
const LOW_CTR_PCT = 1;
/** Positions 1–10 are page one. */
const OFF_PAGE_1 = 10;
const POS1_MAX = 1.5;
const MIN_QUERY_IMPR = 40;

const PAID_CHANNELS = /^(paid search|paid social|cross-network|display|paid other|paid shopping)$/i;
const PAID_SEARCH = /^paid search$/i;
const PAID_SOCIAL = /^paid social$/i;
const BRAND_QUERY = /\b(tallowbourn|tallow bourn|tallowbourne)\b/i;

const LIVE_URL_GUARD =
  "do not 404, unpublish, or retarget the live tallowbourn.com handle";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function emptyWebInsights(): WebInsights {
  return {
    present: false,
    windows: { ga4: null, campaigns: null, gsc_pages: null, gsc_queries: null, gsc_chart: null },
    gaps: [],
    converting_landings: [],
    ad_landings: [],
    low_ctr_pages: [],
    money_queries: [],
    channel_gaps: [],
    site_vs_ad: "",
  };
}

export function pagePath(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^https?:\/\/[^/]+/i, "") || "/";
}

export function isMoneyQuery(query: string): boolean {
  return productOf(query) !== "other";
}

export function isBrandQuery(query: string): boolean {
  return BRAND_QUERY.test(query);
}

function datedWindow(dates: string[]): WebInsightsWindow | null {
  const dated = dates.filter((d) => Boolean(d)).sort();
  if (!dated.length) return null;
  const start = dated[0];
  const end = dated[dated.length - 1];
  return { start, end, label: start === end ? start : `${start}..${end}` };
}

function snapshotWindow(rows: SearchQueryDaily[]): WebInsightsWindow | null {
  if (!rows.length) return null;
  const dated = datedWindow(rows.map((r) => r.date));
  if (dated) return dated;
  return { start: null, end: null, label: "Last-7 undated" };
}

function landingRollup(rows: GaDaily[]): WebInsightsLanding[] {
  const by = new Map<string, { sessions: number; key_events: number; revenue: number }>();
  for (const r of rows) {
    const page = r.landing_page || "/";
    const cur = by.get(page) ?? { sessions: 0, key_events: 0, revenue: 0 };
    cur.sessions += r.sessions;
    cur.key_events += r.key_events;
    cur.revenue += r.revenue;
    by.set(page, cur);
  }
  return [...by.entries()]
    .map(([page, v]) => ({
      page,
      sessions: v.sessions,
      key_events: v.key_events,
      revenue: round2(v.revenue),
    }))
    .sort((a, b) => b.key_events - a.key_events || b.revenue - a.revenue || b.sessions - a.sessions);
}

function pageCtr(row: SearchQueryDaily): number | null {
  if (row.ctr != null) return row.ctr;
  if (row.impressions > 0) return round2((row.clicks / row.impressions) * 100);
  return null;
}

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}

function channelRollup(ga: GaDaily[], re: RegExp) {
  let sessions = 0, key_events = 0, revenue = 0;
  for (const r of ga) {
    if (!re.test(r.channel_group)) continue;
    sessions += r.sessions;
    key_events += r.key_events;
    revenue += r.revenue;
  }
  return { sessions, key_events, revenue: round2(revenue) };
}

function spendOf(campaigns: CampaignDaily[], platform: PaidPlatform): number {
  return round2(campaigns.filter((c) => c.platform === platform).reduce((s, c) => s + c.spend, 0));
}

function buildChannelGaps(
  campaigns: CampaignDaily[],
  ga: GaDaily[],
  gaPresent: boolean,
): WebInsightsChannelGap[] {
  if (!campaigns.length) return [];
  const meta = spendOf(campaigns, "meta");
  const google = spendOf(campaigns, "google");
  const social = channelRollup(ga, PAID_SOCIAL);
  const search = channelRollup(ga, PAID_SEARCH);
  const out: WebInsightsChannelGap[] = [];
  if (meta > 0) {
    out.push({
      platform: "meta",
      spend: meta,
      ga_channel: "Paid Social",
      sessions: gaPresent ? social.sessions : null,
      key_events: gaPresent ? social.key_events : null,
      revenue: gaPresent ? social.revenue : null,
    });
  }
  if (google > 0) {
    out.push({
      platform: "google",
      spend: google,
      ga_channel: "Paid Search",
      sessions: gaPresent ? search.sessions : null,
      key_events: gaPresent ? search.key_events : null,
      revenue: gaPresent ? search.revenue : null,
    });
  }
  return out;
}

function buildSiteVsAd(opts: {
  converting: WebInsightsLanding[];
  adLandings: WebInsightsLanding[];
  lowCtr: WebInsightsGscPage[];
  moneyQueries: WebInsightsGscQuery[];
  channelGaps: WebInsightsChannelGap[];
  campaignProducts: Array<{ product: string; spend: number }>;
}): string {
  const site: string[] = [];
  const ads: string[] = [];
  const top = opts.converting[0];
  const paidTop = opts.adLandings[0];
  if (top) {
    site.push(
      `protect ${top.page} (${fmtInt(top.sessions)} sess / ${fmtInt(top.key_events)} key ev / ${money(top.revenue)}) — ${LIVE_URL_GUARD}`,
    );
  }
  if (top && paidTop && paidTop.page !== top.page) {
    site.push(
      `paid GA4 sends ${paidTop.page}; conversions happen on ${top.page} — do not 404 either live URL`,
    );
  }
  const convertProduct = convertingProduct(top);
  const spendProduct = opts.campaignProducts.find((p) => p.product !== "other" && p.spend > 0);
  if (convertProduct && spendProduct && spendProduct.product !== convertProduct) {
    site.push(
      `campaign_name spend is on ${spendProduct.product}; converting landing is ${convertProduct} — paid_campaign_daily has no landing URL`,
    );
  }
  if (opts.lowCtr.length) {
    const bits = opts.lowCtr.slice(0, 3).map((p) =>
      `${p.path} ${fmtInt(p.impressions)} impr / ${p.ctr != null ? `${p.ctr.toFixed(1)}%` : "—"} CTR`);
    site.push(`rewrite title/meta on ${bits.join("; ")} — ${LIVE_URL_GUARD}`);
  }
  const off = opts.moneyQueries.filter((q) => q.kind === "off_page_1");
  if (off.length) {
    site.push(
      `climb ${off.slice(0, 3).map((q) => `"${q.query}" pos ${q.position?.toFixed(1)}`).join("; ")} with internal links / on-page — organic only`,
    );
  }
  const branded = opts.moneyQueries.filter((q) => q.kind === "branded_pos1_zero_clicks");
  if (branded.length) {
    site.push(
      `pos-1 branded "${branded[0].query}" has ${branded[0].clicks}/${fmtInt(branded[0].impressions)} clicks — snippet, keep the live URL`,
    );
  }
  for (const g of opts.channelGaps) {
    if (g.sessions == null) continue;
    if (g.spend >= 40 && g.sessions < 15) {
      const who = g.platform === "meta" ? "Meta" : "Google";
      ads.push(
        `${who} ${money(g.spend)} vs ${g.ga_channel} ${fmtInt(g.sessions)} sess is tracking/UTMs, not a PDP rewrite`,
      );
    }
  }
  const siteLine = site.length ? site.join("; ") : "none flagged in this upload";
  const adLine = ads.length
    ? ads.join("; ")
    : "Ads Ops ranks the spend levers — this card does not";
  return `Site fix: ${siteLine}. Ad fix: ${adLine}.`;
}

export function buildWebInsights(opts: {
  campaigns: CampaignDaily[];
  queries: SearchQueryDaily[];
  ga: GaDaily[];
  /** Same selected range as Ads Ops; windows are labeled from row dates, not invented. */
  range?: IntelRangeDays;
  asOf?: string | null;
}): WebInsights {
  void opts.range;
  void opts.asOf;
  const campaigns = opts.campaigns;
  const ga = opts.ga;
  const pages = opts.queries.filter((q) => q.kind === "page");
  const queryRows = opts.queries.filter((q) => q.kind === "query");
  const chart = opts.queries.filter((q) => q.kind === "chart");
  const present = Boolean(campaigns.length || ga.length || pages.length || queryRows.length);
  if (!present) return emptyWebInsights();

  const gaps: string[] = [];
  if (!ga.length) {
    gaps.push("GA4 Explore not uploaded — converting landings and Paid Search / Paid Social sessions are a gap.");
  }
  if (!pages.length) {
    gaps.push("GSC Pages.csv not uploaded — high-impression / low-CTR URLs are a gap.");
  }
  if (!queryRows.length) {
    gaps.push("GSC Queries.csv not uploaded — money-term ranks are a gap.");
  }
  if (!campaigns.length) {
    gaps.push("Google/Meta campaign days not uploaded — ad spend for the channel gap is a gap.");
  }

  const converting_landings = ga.length
    ? landingRollup(ga).filter((r) => r.key_events > 0 || r.revenue > 0).slice(0, 8)
    : [];
  const ad_landings = ga.length
    ? landingRollup(ga.filter((r) => PAID_CHANNELS.test(r.channel_group))).slice(0, 8)
    : [];

  const low_ctr_pages: WebInsightsGscPage[] = pages
    .map((p) => {
      const ctr = pageCtr(p);
      return {
        url: p.query,
        path: pagePath(p.query),
        clicks: p.clicks,
        impressions: p.impressions,
        ctr,
        position: p.position,
      };
    })
    .filter((p) => p.impressions >= HIGH_IMPR && p.ctr != null && p.ctr < LOW_CTR_PCT)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 8);

  const brandedZero = new Set<string>();
  const money_queries: WebInsightsGscQuery[] = [];
  for (const q of queryRows) {
    if ((q.impressions ?? 0) < MIN_QUERY_IMPR) continue;
    const brandedPos1 = isBrandQuery(q.query)
      && q.position != null && q.position <= POS1_MAX
      && q.clicks === 0;
    if (brandedPos1) {
      brandedZero.add(q.query);
      money_queries.push({
        query: q.query,
        clicks: q.clicks,
        impressions: q.impressions,
        ctr: pageCtr(q),
        position: q.position,
        kind: "branded_pos1_zero_clicks",
      });
    }
  }
  for (const q of queryRows) {
    if (brandedZero.has(q.query)) continue;
    if ((q.impressions ?? 0) < MIN_QUERY_IMPR) continue;
    if (!isMoneyQuery(q.query)) continue;
    if (q.position == null || q.position <= OFF_PAGE_1) continue;
    money_queries.push({
      query: q.query,
      clicks: q.clicks,
      impressions: q.impressions,
      ctr: pageCtr(q),
      position: q.position,
      kind: "off_page_1",
    });
  }
  money_queries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "off_page_1" ? -1 : 1;
    return (b.position ?? 0) - (a.position ?? 0) || b.impressions - a.impressions;
  });

  const channel_gaps = buildChannelGaps(campaigns, ga, ga.length > 0);
  const site_vs_ad = buildSiteVsAd({
    converting: converting_landings,
    adLandings: ad_landings,
    lowCtr: low_ctr_pages,
    moneyQueries: money_queries,
    channelGaps: channel_gaps,
    campaignProducts: campaignProductSpend(campaigns),
  });

  return {
    present: true,
    windows: {
      ga4: datedWindow(ga.map((r) => r.date)),
      campaigns: datedWindow(campaigns.map((r) => r.date)),
      gsc_pages: snapshotWindow(pages),
      gsc_queries: snapshotWindow(queryRows),
      gsc_chart: datedWindow(chart.map((r) => r.date)),
    },
    gaps,
    converting_landings,
    ad_landings,
    low_ctr_pages,
    money_queries,
    channel_gaps,
    site_vs_ad,
  };
}

/** Campaign names carry a product; paid_campaign_daily has no landing URL — do not invent one. */
export function campaignProductSpend(campaigns: CampaignDaily[]): Array<{ product: string; spend: number }> {
  const by = new Map<string, number>();
  for (const c of campaigns) {
    const product = c.product !== "other" ? c.product : productOf(c.campaign_name);
    by.set(product, (by.get(product) ?? 0) + c.spend);
  }
  return [...by.entries()]
    .map(([product, spend]) => ({ product, spend: round2(spend) }))
    .sort((a, b) => b.spend - a.spend);
}

export function convertingProduct(landing: WebInsightsLanding | undefined): string | null {
  if (!landing) return null;
  return productOfPath(landing.page);
}
