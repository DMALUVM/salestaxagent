/** Daily warehouse + intel types for Shopify paid ads (Google / Meta / GSC / GA4). */

export const PAID_PLATFORMS = ["google", "meta"] as const;
export type PaidPlatform = (typeof PAID_PLATFORMS)[number];

export const INTEL_RANGES = [7, 14, 30, 90, 365, 0] as const;
export type IntelRangeDays = (typeof INTEL_RANGES)[number];

export const INTEL_FILTERS = ["all", "google", "meta"] as const;
export type IntelFilter = (typeof INTEL_FILTERS)[number];

export type CampaignType = "Search" | "Shopping" | "PMax" | "DemandGen" | "Other";
export type ProductLine = "deodorant" | "balm" | "soap" | "lip" | "other";
export type Audience = "prospect" | "retarget" | "unknown";
export type SearchKind = "query" | "page" | "chart";

export interface CampaignDaily {
  platform: PaidPlatform;
  date: string;
  campaign_name: string;
  campaign_type: CampaignType;
  product: ProductLine;
  is_brand: boolean;
  audience: Audience;
  spend: number;
  conv_value: number;
  clicks: number;
  impressions: number;
  conversions: number;
  lost_is_budget: number | null;
  lost_is_rank: number | null;
  frequency: number | null;
  status: string | null;
}

export interface SearchQueryDaily {
  kind: SearchKind;
  date: string; // "" for Queries.csv / Pages.csv snapshots
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface GaDaily {
  date: string;
  channel_group: string;
  landing_page: string;
  device: string;
  sessions: number;
  active_users: number;
  key_events: number;
  revenue: number;
  bounce_rate: number | null;
}

export interface AcceptedFile {
  name: string;
  kind: string;
  rows: number;
  min_date: string | null;
  max_date: string | null;
}

export interface ParsedFiles {
  campaigns: CampaignDaily[];
  queries: SearchQueryDaily[];
  ga: GaDaily[];
  sources: string[];
  skipped: string[];
  warnings: string[];
  /** One entry per file the parser actually understood — the upload receipt. */
  accepted: AcceptedFile[];
}

export interface SourceFreshness {
  source: "paid" | "gsc" | "ga4";
  label: string;
  max_date: string | null;
  days_behind: number | null;
  stale: boolean;
}

export interface IntelFreshness {
  today: string;
  /** Days between today and the newest paid row. Null when nothing is loaded. */
  days_behind: number | null;
  stale: boolean;
  stale_after_days: number;
  sources: SourceFreshness[];
}

export interface CampaignAgg {
  platform: PaidPlatform;
  campaign_name: string;
  campaign_type: CampaignType;
  product: ProductLine;
  is_brand: boolean;
  audience: Audience;
  spend: number;
  conv_value: number;
  clicks: number;
  impressions: number;
  conversions: number;
  roas: number;
  cpc: number;
  lost_is_budget: number | null;
  frequency: number | null;
  status: string | null;
  days_live: number;
}

export interface PlatformKpis {
  platform: PaidPlatform | "blended";
  spend: number;
  conv_value: number;
  clicks: number;
  impressions: number;
  conversions: number;
  roas: number;
  cpc: number;
  days: number;
}

export interface ProductAgg {
  product: ProductLine;
  spend: number;
  conv_value: number;
  roas: number;
  conversions: number;
}

export type IntelOwner = "ads" | "site";

export const DECISION_STATUSES = ["applied", "dismissed", "open"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface IntelDecision {
  card_id: string;
  as_of: string;
  status: DecisionStatus;
  note: string | null;
  applied_at: string | null;
  dismissed_at: string | null;
}

export interface IntelCard {
  id: string;
  owner: IntelOwner;
  severity: "critical" | "warn" | "info";
  title: string;
  body: string;
  doThis: string;
  ifItWorks: string;
  evidence: string;
  stake: number;
  metric: string;
  action: "kill" | "keep" | "shift" | "fix";
  /** Self-contained prompt for one card — paste straight into an agent. */
  prompt: string;
  /** Implementation status for this as-of week. */
  status: DecisionStatus;
  decided_at: string | null;
}

export interface IntelBrief {
  headline: string;
  ads: string;
  site: string;
}

export interface WinLoseRow {
  platform: PaidPlatform;
  campaign_name: string;
  spend: number;
  conv_value: number;
  roas: number;
  conversions: number;
  verdict: "win" | "lose" | "hold";
}

export interface DailyPoint {
  date: string;
  google_spend: number;
  google_revenue: number;
  meta_spend: number;
  meta_revenue: number;
}

export interface GrokSnapshot {
  kpis: {
    as_of: string;
    range_days: number;
    google: PlatformKpis;
    meta: PlatformKpis;
    blended_ads_roas: number;
    ga4_paid_revenue: number;
    ga4_last_click_roas: number | null;
  };
  campaigns: Array<{
    platform: string;
    name: string;
    type: string;
    brand: boolean;
    spend: number;
    conv_value: number;
    roas: number;
    conversions: number;
  }>;
  products: ProductAgg[];
  searchTop: Array<{ query: string; clicks: number; impressions: number; ctr: number | null; position: number | null }>;
  landings: Array<{ page: string; sessions: number; revenue: number; bounce: number | null; key_events: number }>;
  ga4Channels: Array<{ channel: string; sessions: number; revenue: number; key_events: number }>;
}

export interface IntelBundle {
  as_of: string | null;
  range_days: number;
  filter: IntelFilter;
  kpis: { google: PlatformKpis; meta: PlatformKpis; blended: PlatformKpis };
  wow: { last: PlatformKpis; prior: PlatformKpis };
  brief: IntelBrief;
  freshness: IntelFreshness;
  campaigns: CampaignAgg[];
  products: ProductAgg[];
  /** Open recommendations only — max 6 per desk. */
  cards: IntelCard[];
  /** Applied / dismissed cards for this as-of week. Never counted as recommendations. */
  log: IntelCard[];
  wins: WinLoseRow[];
  losses: WinLoseRow[];
  daily: DailyPoint[];
  gsc: {
    hidden: boolean;
    queries: SearchQueryDaily[];
    pages: SearchQueryDaily[];
    chart: SearchQueryDaily[];
  };
  ga4: {
    channels: Array<{ channel: string; sessions: number; revenue: number; key_events: number; bounce: number | null }>;
    devices: Array<{ device: string; sessions: number; key_events: number; revenue: number; cvr: number }>;
    landings: Array<{ page: string; sessions: number; revenue: number; bounce: number | null; key_events: number }>;
    unassigned_share: number;
    paid_social_sessions: number;
    paid_search_sessions: number;
    cross_network_sessions: number;
    paid_revenue: number;
  };
  grok: { markdown: string; snapshot: GrokSnapshot; adsDesk: string; siteDesk: string };
  sources: { campaigns: number; queries: number; ga: number };
}
