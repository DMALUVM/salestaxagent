import { deriveRoas } from "./csv";
import type {
  CampaignAgg, GrokSnapshot, IntelBrief, IntelCard, IntelRangeDays, PlatformKpis,
  ProductAgg, SearchQueryDaily,
} from "./types";

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

const ADS_RULES = [
  "- Never move Meta or PMax budget onto Brand Search.",
  "- Never treat GA4 revenue as Google/Meta ads conversion value.",
  "- Ignore $0 / 0-impression Meta rows.",
  "- Judge a change on 7 days of conversion value, not on one day.",
];

const SITE_RULES = [
  "- Never invent a Δ position from Queries.csv — it is an undated snapshot, so there is no before/after.",
  "- GA4 figures are last-click sessions and revenue, not ad-platform conversion value. Do not reconcile them to ad spend.",
  "- Do not touch ad campaigns, budgets, or bids. That is the paid-media desk's job.",
  "- Do not redesign a page that is already converting. Fix the pages that leak.",
];

export interface SitePromptContext {
  sessions: number;
  key_events: number;
  revenue: number;
  cvr: number;
  mobile: { sessions: number; cvr: number };
  desktop: { sessions: number; cvr: number };
  unassigned_share: number;
  organic_clicks: number | null;
  top_pages: Array<{ page: string; revenue: number; key_events: number }>;
}

export interface PromptContext {
  asOf: string;
  google: PlatformKpis;
  meta: PlatformKpis;
  blended: PlatformKpis;
  site?: SitePromptContext;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** Ads desk gets spend/ROAS. Site desk gets sessions/CVR — never the other way round. */
function cardContext(ctx: PromptContext, owner: "ads" | "site"): string[] {
  if (owner === "ads") {
    return [
      `Account as-of (max date in the files): ${ctx.asOf}.`,
      `Last 7 days: Google ${money(ctx.google.spend)} at ${ctx.google.roas.toFixed(2)}x · Meta ${money(ctx.meta.spend)} at ${ctx.meta.roas.toFixed(2)}x · blended ${ctx.blended.roas.toFixed(2)}x.`,
    ];
  }
  const s = ctx.site;
  const lines = [`Storefront as-of (max date in the analytics export): ${ctx.asOf}.`];
  if (s) {
    lines.push(
      `Last 7 days on site: ${s.sessions.toLocaleString()} sessions, ${s.key_events.toLocaleString()} key events (${pct(s.cvr)} of sessions), ${money(s.revenue)} last-click revenue.`,
      `Mobile ${s.mobile.sessions.toLocaleString()} sessions at ${pct(s.mobile.cvr)} vs desktop ${s.desktop.sessions.toLocaleString()} at ${pct(s.desktop.cvr)}.`,
      `${pct(s.unassigned_share)} of sessions have no channel attribution${s.organic_clicks != null ? ` · ${s.organic_clicks.toLocaleString()} organic Search clicks` : ""}.`,
    );
    if (s.top_pages.length) {
      lines.push(
        `Pages that already convert (do not break these): ${s.top_pages.map((p) => `${p.page} ${money(p.revenue)}`).join(" · ")}.`,
      );
    }
  }
  return lines;
}

/** Self-contained prompt for ONE card. Paste into an agent, no other context needed. */
export function buildCardPrompt(card: IntelCard, ctx: PromptContext): string {
  const owner = card.owner === "site" ? "site" : "ads";
  const role = owner === "ads"
    ? "You are the Shopify paid-media agent for Tallowbourn (Google Ads + Meta)."
    : "You are the Shopify storefront agent for Tallowbourn (Shopify theme, product pages, GA4 and Search Console). You do not manage ad campaigns.";
  return [
    `# ${card.title}`,
    "",
    role,
    ...cardContext(ctx, owner),
    "",
    "Hard rules:",
    ...(owner === "ads" ? ADS_RULES : SITE_RULES),
    "",
    `Action: ${card.action.toUpperCase()} · $ at stake: ${money(card.stake)} · Kill/keep metric: ${card.metric}`,
    "",
    "## Situation",
    card.body,
    "",
    "## Do this (7-day test)",
    card.doThis,
    "",
    "## Success criteria",
    card.ifItWorks,
    "",
    "## Evidence",
    card.evidence,
    "",
    "## What to return",
    "1. The exact changes you made (campaign / ad set / URL / template, and the before → after value).",
    "2. Anything you refused to change and why.",
    "3. The one number you will re-check in 7 days.",
    "",
  ].join("\n");
}

/** One desk's whole stack as a single prompt. */
export function buildDeskPrompt(
  label: "ads" | "site",
  cards: IntelCard[],
  ctx: PromptContext,
  brief?: string,
): string {
  const role = label === "ads"
    ? "You are the Shopify paid-media agent for Tallowbourn (Google Ads + Meta)."
    : "You are the Shopify storefront agent for Tallowbourn (Shopify theme, product pages, GA4 and Search Console). You do not manage ad campaigns.";
  const lines = [
    label === "ads" ? "# Tallowbourn paid media — this week" : "# Tallowbourn storefront & conversion — this week",
    "",
    role,
    ...cardContext(ctx, label),
    "",
    "Hard rules:",
    ...(label === "ads" ? ADS_RULES : SITE_RULES),
  ];
  if (brief) lines.push("", brief);
  lines.push("", "## Stack (ranked by $ at stake)");
  if (!cards.length) {
    lines.push("Nothing for this desk in the current window.");
  }
  cards.forEach((c, i) => {
    lines.push("");
    lines.push(`### ${i + 1}. [${c.action.toUpperCase()} · ${money(c.stake)}] ${c.title}`);
    lines.push(`Metric: ${c.metric}`);
    lines.push(c.body);
    lines.push(`Do this (7 days): ${c.doThis}`);
    lines.push(`If it works: ${c.ifItWorks}`);
    lines.push(`Evidence: ${c.evidence}`);
  });
  lines.push(
    "",
    "## What to return",
    "For each item: what you changed (before → after), what you refused and why, and the number you will re-check in 7 days.",
    "",
  );
  return lines.join("\n");
}

export function buildGrok(opts: {
  asOf: string;
  range: IntelRangeDays;
  google: PlatformKpis;
  meta: PlatformKpis;
  blended: PlatformKpis;
  wow?: { last: PlatformKpis; prior: PlatformKpis };
  brief?: IntelBrief;
  site?: SitePromptContext;
  camps: CampaignAgg[];
  products: ProductAgg[];
  cards: IntelCard[];
  queries: SearchQueryDaily[];
  pages: SearchQueryDaily[];
  ga4: {
    channels: Array<{ channel: string; sessions: number; revenue: number; key_events: number }>;
    landings: Array<{ page: string; sessions: number; revenue: number; bounce: number | null; key_events: number }>;
    paid_revenue: number;
  };
}): { markdown: string; snapshot: GrokSnapshot; adsDesk: string; siteDesk: string } {
  const spend = opts.google.spend + opts.meta.spend;
  const snapshot: GrokSnapshot = {
    kpis: {
      as_of: opts.asOf,
      range_days: opts.range || 7,
      google: opts.google,
      meta: opts.meta,
      blended_ads_roas: opts.blended.roas,
      ga4_paid_revenue: opts.ga4.paid_revenue,
      ga4_last_click_roas: spend > 0 ? deriveRoas(spend, opts.ga4.paid_revenue) : null,
    },
    campaigns: opts.camps.slice(0, 24).map((c) => ({
      platform: c.platform,
      name: c.campaign_name,
      type: c.campaign_type,
      brand: c.is_brand,
      spend: c.spend,
      conv_value: c.conv_value,
      roas: c.roas,
      conversions: c.conversions,
    })),
    products: opts.products,
    searchTop: opts.queries.slice(0, 15).map((q) => ({
      query: q.query, clicks: q.clicks, impressions: q.impressions, ctr: q.ctr, position: q.position,
    })),
    landings: opts.ga4.landings.slice(0, 12),
    ga4Channels: opts.ga4.channels.slice(0, 12),
  };

  const lines: string[] = [
    "# Tallowbourn ads — keep / kill",
    "",
    "You are the Shopify paid-ads agent for Tallowbourn (Google + Meta + GSC + GA4).",
    "Hard rules:",
    "- Never move Meta or PMax budget onto Brand Search.",
    "- Never invent a Δ position from Queries.csv (it is a snapshot with no date).",
    "- Never treat GA4 revenue as Google/Meta conversion value.",
    "- Ignore $0 / 0-impression Meta rows. Win/lose tables are spend ≥ $1 only.",
    `- As-of (max date in the files): ${opts.asOf}. Range: ${opts.range || "all"} days.`,
  ];
  if (opts.wow) {
    lines.push(
      `- Last 7 blended ${money(opts.wow.last.spend)} at ${opts.wow.last.roas.toFixed(2)}x vs prior 7 ${money(opts.wow.prior.spend)} at ${opts.wow.prior.roas.toFixed(2)}x.`,
    );
  }
  if (opts.brief?.headline) {
    lines.push("", "## This week", opts.brief.headline, "", opts.brief.ads, opts.brief.site);
  }
  const site = opts.cards.filter((c) => c.owner === "site");
  const ads = opts.cards.filter((c) => c.owner !== "site");
  function dump(title: string, list: IntelCard[], start: number) {
    lines.push("", `## ${title}`);
    if (!list.length) {
      lines.push("None for this filter.");
      return start;
    }
    list.forEach((c, i) => {
      lines.push(`${start + i}. [${c.action.toUpperCase()} · ${c.owner.toUpperCase()} · ${money(c.stake)}] ${c.title}`);
      lines.push(`   Metric: ${c.metric}`);
      lines.push(`   ${c.body}`);
      lines.push(`   Do this (7 days): ${c.doThis}`);
      lines.push(`   If it works: ${c.ifItWorks}`);
      lines.push(`   Evidence: ${c.evidence}`);
    });
    return start + list.length;
  }
  const next = dump("Paid media — ads lead (ranked by $ at stake)", ads, 1);
  dump("Site & conversion — web team (ranked by $ at stake)", site, next);
  if (!opts.cards.length) lines.push("", "1. No keep/kill cards — upload a Google or Meta CSV.");
  lines.push("", "## JSON snapshot", "```json", JSON.stringify(snapshot, null, 2), "```", "");
  const ctx: PromptContext = {
    asOf: opts.asOf, google: opts.google, meta: opts.meta, blended: opts.blended,
    site: opts.site,
  };
  return {
    markdown: lines.join("\n"),
    snapshot,
    adsDesk: buildDeskPrompt("ads", ads, ctx, opts.brief?.adsHeadline || opts.brief?.headline),
    siteDesk: buildDeskPrompt("site", site, ctx, opts.brief?.siteHeadline),
  };
}
