import { deriveRoas } from "./csv";
import type {
  CampaignAgg, GrokSnapshot, IntelCard, IntelRangeDays, PlatformKpis,
  ProductAgg, SearchQueryDaily,
} from "./types";

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function buildGrok(opts: {
  asOf: string;
  range: IntelRangeDays;
  google: PlatformKpis;
  meta: PlatformKpis;
  blended: PlatformKpis;
  wow?: { last: PlatformKpis; prior: PlatformKpis };
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
}): { markdown: string; snapshot: GrokSnapshot } {
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
  lines.push(
    "",
    "## Stack (ranked by $ at stake)",
  );
  if (!opts.cards.length) lines.push("1. No keep/kill cards — upload a Google or Meta CSV.");
  opts.cards.forEach((c, i) => {
    lines.push(`${i + 1}. [${c.action.toUpperCase()} · ${money(c.stake)}] ${c.title}`);
    lines.push(`   Metric: ${c.metric}`);
    lines.push(`   ${c.body}`);
    lines.push(`   Do this (7 days): ${c.doThis}`);
    lines.push(`   If it works: ${c.ifItWorks}`);
    lines.push(`   Evidence: ${c.evidence}`);
  });
  lines.push("", "## JSON snapshot", "```json", JSON.stringify(snapshot, null, 2), "```", "");
  return { markdown: lines.join("\n"), snapshot };
}
