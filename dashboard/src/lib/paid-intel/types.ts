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
  /** Worst ad set inside the campaign that day. Only set by ad-set exports. */
  frequency_peak: number | null;
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

export type FreshnessSource = "google" | "meta" | "ga4" | "gsc_trend" | "gsc_snapshot";

export interface SourceFreshness {
  source: FreshnessSource;
  label: string;
  /** What to re-export when this source goes stale. */
  file: string;
  rows: number;
  min_date: string | null;
  max_date: string | null;
  days_behind: number | null;
  stale: boolean;
  /** Undated snapshots (Queries.csv / Pages.csv) have no date to age. */
  dated: boolean;
  /** Distinct days present inside the selected range. */
  days_in_range: number;
  /** Days the selected range asked for (0 = all history). */
  range_days: number;
  /**
   * Days this source could plausibly have, i.e. the window minus its own
   * reporting lag. GSC always trails ~2 days; that is a lag, not a gap.
   */
  expected_days: number;
  /** days_in_range / expected_days, or null for snapshots and the All range. */
  coverage: number | null;
}

export interface IntelFreshness {
  today: string;
  /** Days between today and the newest paid row. Null when nothing is loaded. */
  days_behind: number | null;
  stale: boolean;
  stale_after_days: number;
  /** Windows are built from whatever days exist — this flags a thin window. */
  partial_sources: FreshnessSource[];
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
  frequency_peak: number | null;
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
  /**
   * True when part of this row came from campaigns whose name carries no
   * product (PMax, Brand Search) and was allocated using the GA4 landing-page
   * mix. Ads conversion-value totals are never replaced by GA4 revenue — only
   * their split across products is estimated.
   */
  estimated: boolean;
}

/** Share of paid product demand per line, derived from GA4 product landings. */
export interface ProductWeights {
  weights: Partial<Record<ProductLine, number>>;
  basis: "key_events" | "revenue" | "sessions" | "none";
  sample: number;
}

export type IntelOwner = "ads" | "site";

export const DECISION_STATUSES = ["applied", "dismissed", "open"] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** What a card's success claim reduces to, so it can be re-measured later. */
export const CHECK_KINDS = [
  "campaign_roas",
  "campaign_spend",
  "campaign_lost_is_budget",
  "campaign_frequency",
  "blended_roas",
  "platform_roas",
  "paid_social_sessions",
  "unassigned_share",
  "mobile_cvr",
  "page_bounce",
  "page_key_events",
  "query_ctr",
  "url_ctr",
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export interface IntelCheck {
  kind: CheckKind;
  /** Campaign name, landing path, query, or platform — whatever the kind needs. */
  subject: string | null;
  /** "up" = the number should rise to pass. */
  direction: "up" | "down";
  /** Value that counts as a pass, when the card names one. */
  target: number | null;
  unit: "roas" | "usd" | "pct" | "count" | "ratio";
  label: string;
}

export type OutcomeVerdict = "worked" | "no_change" | "worse" | "too_early" | "unmeasurable";

export interface IntelOutcome {
  verdict: OutcomeVerdict;
  baseline: number | null;
  baseline_as_of: string | null;
  current: number | null;
  target: number | null;
  direction: "up" | "down";
  unit: IntelCheck["unit"];
  label: string;
  /** Human sentence for the card and the export. */
  summary: string;
}

export interface IntelDecision {
  card_id: string;
  as_of: string;
  status: DecisionStatus;
  note: string | null;
  applied_at: string | null;
  dismissed_at: string | null;
  check: IntelCheck | null;
  baseline_value: number | null;
  baseline_as_of: string | null;
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
  note: string | null;
  /** What to re-measure to decide whether this actually worked. */
  check: IntelCheck | null;
  /** The check's value right now — frozen as the baseline when applied. */
  check_value: number | null;
  /** Present once the card was applied in an earlier window and can be graded. */
  outcome: IntelOutcome | null;
}

export interface IntelBrief {
  headline: string;
  ads: string;
  site: string;
  /** Ads-only framing for the paid-media export. */
  adsHeadline: string;
  /** Storefront-only framing — no spend or ROAS. */
  siteHeadline: string;
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

export interface WebInsightsWindow {
  start: string | null;
  end: string | null;
  /** Dated span, or "Last-7 undated" when page/query dates are blank. */
  label: string;
}

export interface WebInsightsLanding {
  page: string;
  sessions: number;
  key_events: number;
  revenue: number;
}

export interface WebInsightsGscPage {
  url: string;
  path: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface WebInsightsGscQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  kind: "off_page_1" | "branded_pos1_zero_clicks";
}

export interface WebInsightsChannelGap {
  platform: PaidPlatform;
  spend: number;
  ga_channel: "Paid Search" | "Paid Social";
  sessions: number | null;
  key_events: number | null;
  revenue: number | null;
}

/** Always-on site half of a /paid-ads upload. Not ranked with Ads Ops cards. */
export interface WebInsights {
  present: boolean;
  windows: {
    ga4: WebInsightsWindow | null;
    campaigns: WebInsightsWindow | null;
    gsc_pages: WebInsightsWindow | null;
    gsc_queries: WebInsightsWindow | null;
    gsc_chart: WebInsightsWindow | null;
  };
  gaps: string[];
  converting_landings: WebInsightsLanding[];
  ad_landings: WebInsightsLanding[];
  low_ctr_pages: WebInsightsGscPage[];
  money_queries: WebInsightsGscQuery[];
  channel_gaps: WebInsightsChannelGap[];
  site_vs_ad: string;
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
  /** Site half — appears from uploads, not from Ads Ops ranking. */
  web_insights: WebInsights;
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
