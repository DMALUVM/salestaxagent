-- Phase 2 official-API warehouse for the Iris conversion digest.
--
-- WHY THIS EXISTS
-- Phase 1 (`shopify_funnel_*`) covers Shopify Admin sessions + abandons.
-- The morning email still needs GA4 landings/pathing, Google Ads / Meta
-- site conversions, and Search Console SEO. Those numbers come from the
-- official APIs only (GA4 Data API, Google Ads API, Meta Marketing API,
-- Search Console API). No Ryze, no third-party analytics SaaS, no CSV
-- substitute, no theme / storefront writes.
--
-- ADDITIVE / SIDE TABLES
-- Nothing here feeds nexus, liability, Pulse sales, or contribution P&L.
-- sales_by_state remains the tax source of truth. Do not join these
-- tables into `src/pnl.py`, `src/sales_daily.py`, or Pulse.
-- Distinct from the CSV intel path (`paid_ga_daily`,
-- `paid_search_query_daily`, `paid_campaign_daily`) — do not mix.
--
-- PULLS
-- Mini `ga4-sync` / `gsc-sync` / `google-ads-sync` upsert official-API
-- rows when GOOGLE_* env is present. `meta-ads-sync` stays a stub. A
-- missing metric stays NULL. Zero is a real measurement. Never invent a count.
--
-- RLS
-- Enable RLS, no anon/authenticated policies. service_role bypasses RLS
-- (Python Mini + dashboard API routes). Do not write these tables from
-- the browser anon key.

-- ── GA4 Data API ────────────────────────────────────────────────────────

create table if not exists ga4_sessions_daily (
  metric_date         date        not null,
  -- 'all' = property-wide. 'device' / 'landing' / 'path' = split grain.
  split_kind          text        not null default 'all',
  split_value         text        not null default '',
  sessions            integer,
  engaged_sessions    integer,
  landings            integer,          -- session_start / first-touch landings
  bounce_sessions     integer,
  -- Ecommerce event counts. Null = API did not return the event. Never inferred.
  view_item           integer,
  add_to_cart         integer,
  begin_checkout      integer,
  purchase            integer,
  source              text        not null default 'ga4_data_api',
  fetched_at          timestamptz not null default now(),
  primary key (metric_date, split_kind, split_value)
);

create index if not exists ga4_sessions_daily_date_idx
  on ga4_sessions_daily (metric_date);

comment on table ga4_sessions_daily is
  'Daily GA4 Data API sessions + ecommerce event counts. Analytics only — '
  'never feeds nexus or P&L. Official API only; no Ryze / CSV substitute.';

comment on column ga4_sessions_daily.purchase is
  'GA4 purchase event count. Null means the API did not return it. Never inferred.';


create table if not exists ga4_landing_daily (
  metric_date         date        not null,
  landing_page        text        not null,
  device              text        not null default '',
  sessions            integer,
  engaged_sessions    integer,
  landings            integer,
  view_item           integer,
  add_to_cart         integer,
  begin_checkout      integer,
  purchase            integer,
  source              text        not null default 'ga4_data_api',
  fetched_at          timestamptz not null default now(),
  primary key (metric_date, landing_page, device)
);

create index if not exists ga4_landing_daily_date_idx
  on ga4_landing_daily (metric_date);

comment on table ga4_landing_daily is
  'Daily GA4 landing-page × device pathing. Analytics only — never feeds nexus or P&L.';


-- ── Google Ads API (site conversions, not Amazon PPC) ───────────────────

create table if not exists google_ads_daily (
  metric_date         date        not null,
  campaign_id         text        not null default '',
  campaign_name       text,
  spend               numeric(12,2),
  clicks              integer,
  impressions         integer,
  -- Website conversions attributed to Google Ads. Null = not returned.
  conversions         numeric(12,4),
  conversion_value    numeric(12,2),
  source              text        not null default 'google_ads_api',
  fetched_at          timestamptz not null default now(),
  primary key (metric_date, campaign_id)
);

create index if not exists google_ads_daily_date_idx
  on google_ads_daily (metric_date);

comment on table google_ads_daily is
  'Daily Google Ads API spend / clicks / site conversions. Not Amazon PPC. '
  'Analytics only — never feeds nexus or contribution P&L.';


-- ── Meta Marketing API ──────────────────────────────────────────────────

create table if not exists meta_ads_daily (
  metric_date         date        not null,
  campaign_id         text        not null default '',
  campaign_name       text,
  spend               numeric(12,2),
  clicks              integer,
  impressions         integer,
  conversions         numeric(12,4),
  conversion_value    numeric(12,2),
  source              text        not null default 'meta_marketing_api',
  fetched_at          timestamptz not null default now(),
  primary key (metric_date, campaign_id)
);

create index if not exists meta_ads_daily_date_idx
  on meta_ads_daily (metric_date);

comment on table meta_ads_daily is
  'Daily Meta Marketing API spend / clicks / conversions. Analytics only — '
  'never feeds nexus or contribution P&L.';


-- ── Search Console API ──────────────────────────────────────────────────

create table if not exists gsc_query_daily (
  metric_date         date        not null,
  query               text        not null,
  clicks              integer,
  impressions         integer,
  ctr                 numeric(8,6),
  position            numeric(8,3),
  source              text        not null default 'gsc_api',
  fetched_at          timestamptz not null default now(),
  primary key (metric_date, query)
);

create index if not exists gsc_query_daily_date_idx
  on gsc_query_daily (metric_date);

comment on table gsc_query_daily is
  'Daily Search Console API query grain. Official API only. Analytics only.';


create table if not exists gsc_page_daily (
  metric_date         date        not null,
  page                text        not null,
  clicks              integer,
  impressions         integer,
  ctr                 numeric(8,6),
  position            numeric(8,3),
  source              text        not null default 'gsc_api',
  fetched_at          timestamptz not null default now(),
  primary key (metric_date, page)
);

create index if not exists gsc_page_daily_date_idx
  on gsc_page_daily (metric_date);

comment on table gsc_page_daily is
  'Daily Search Console API page grain. Official API only. Analytics only.';


-- ── Iris digest status (per locked America/New_York day) ────────────────

create table if not exists conversion_digest_status (
  metric_date         date        primary key,
  -- CLEAR = locked-day funnel is sendable. HOLD = Jev/scope hold.
  -- GAP = locked day missing (never substitute an older day).
  status              text        not null,
  jev_decision        text,
  improvements        jsonb       not null default '[]',
  missing_connectors  text[]      not null default '{}',
  last_error          text,
  last_stats          jsonb,
  updated_at          timestamptz not null default now(),
  constraint conversion_digest_status_chk
    check (status in ('CLEAR', 'HOLD', 'GAP')),
  constraint conversion_digest_jev_chk
    check (jev_decision is null
           or jev_decision in ('pursue', 'hold', 'skip'))
);

comment on table conversion_digest_status is
  'Per-day Iris conversion-digest status. Date-locked to America/New_York. '
  'Never substitute an older day. Analytics only.';

comment on column conversion_digest_status.improvements is
  'Jev pursue items (max 3 at read time). Empty array when Jev is unwired.';


alter table ga4_sessions_daily        enable row level security;
alter table ga4_landing_daily         enable row level security;
alter table google_ads_daily          enable row level security;
alter table meta_ads_daily            enable row level security;
alter table gsc_query_daily           enable row level security;
alter table gsc_page_daily            enable row level security;
alter table conversion_digest_status  enable row level security;

-- Deny-by-default for anon / authenticated: no permissive policies.
-- service_role (Mini + dashboard API) bypasses RLS.
