-- Meta Marketing API enrichments — campaign extras + ad set / ad / breakdowns.
--
-- WHY THIS EXISTS
-- PR #171 landed campaign × day SoT on meta_ads_daily (spend / clicks /
-- impressions / purchase). /paid-ads intel still needed ad-set frequency,
-- creative-level keep/kill, placement waste, and age×gender audience waste
-- — the same bar as GSC device/country/appearance enrichments.
-- Mini meta-ads-sync now GETs ads_read insights at campaign, adset, and ad
-- (time_increment=1) plus two campaign-level breakdowns. Unique metrics
-- (reach / unique_clicks) are stored as Graph returned them and must never
-- be summed across breakdowns.
--
-- WHY EACH TABLE IS KEPT
-- * meta_ads_daily — campaign SoT for KPIs / keep-kill / freshness.
--   Extra columns: reach, frequency, ctr, cpc, cpm, inline_link_clicks,
--   unique clicks, purchase already in conversions/conversion_value,
--   add_to_cart + initiate_checkout counts and values.
-- * meta_ads_adset_daily — fatigue lives at ad set. frequency_peak for
--   the meta-freq card. Never invent Lost inbound / nexus / P&L.
-- * meta_ads_ad_daily — creative keep/kill (which ad is burning spend).
-- * meta_ads_platform_daily — publisher_platform (facebook / instagram /
--   audience_network / messenger). Placement waste, not vanity.
-- * meta_ads_demo_daily — age × gender at campaign. Audience waste
--   (e.g. 65+). Not crossed with platform (row explosion).
--
-- SKIPPED (vanity / explosion / no dashboard consumer)
-- country, region, dma, impression_device, hourly, product_id,
-- video play metrics, website_purchase_roas (derivable from spend + value).
--
-- ADDITIVE
-- ALTER existing meta_ads_daily only (no DROP, no PK change). New side
-- tables. Nothing here feeds nexus, Pulse sales, or contribution P&L.
-- Distinct from retired Meta CSV (`paid_campaign_daily` platform=meta).
-- Safe to re-run. Dana applies in Supabase SQL editor (service_role).
-- Do not apply migration_rls_lockdown.sql for this.
--
-- RLS
-- Enable RLS, no anon/authenticated policies. service_role bypasses RLS
-- (Python Mini + dashboard API routes).

-- ── campaign extras (additive columns) ──────────────────────────────────

alter table if exists meta_ads_daily
  add column if not exists reach integer,
  add column if not exists frequency numeric(8,4),
  add column if not exists ctr numeric(10,6),
  add column if not exists cpc numeric(12,4),
  add column if not exists cpm numeric(12,4),
  add column if not exists inline_link_clicks integer,
  add column if not exists unique_clicks integer,
  add column if not exists unique_inline_link_clicks integer,
  add column if not exists add_to_cart numeric(12,4),
  add column if not exists add_to_cart_value numeric(12,2),
  add column if not exists initiate_checkout numeric(12,4),
  add column if not exists initiate_checkout_value numeric(12,2);

comment on table meta_ads_daily is
  'Daily Meta Marketing API campaign insights (ads_read GET). '
  'conversions/conversion_value = first matching purchase action. '
  'Analytics only — never feeds nexus or contribution P&L. API is SoT; '
  'Meta CSV (paid_campaign_daily platform=meta) is retired.';

-- ── ad set daily ────────────────────────────────────────────────────────

create table if not exists meta_ads_adset_daily (
  metric_date                 date        not null,
  adset_id                    text        not null,
  adset_name                  text,
  campaign_id                 text,
  campaign_name               text,
  spend                       numeric(12,2),
  clicks                      integer,
  impressions                 integer,
  reach                       integer,
  frequency                   numeric(8,4),
  ctr                         numeric(10,6),
  cpc                         numeric(12,4),
  cpm                         numeric(12,4),
  inline_link_clicks          integer,
  unique_clicks               integer,
  unique_inline_link_clicks   integer,
  conversions                 numeric(12,4),
  conversion_value            numeric(12,2),
  add_to_cart                 numeric(12,4),
  add_to_cart_value           numeric(12,2),
  initiate_checkout           numeric(12,4),
  initiate_checkout_value     numeric(12,2),
  source                      text        not null default 'meta_marketing_api',
  fetched_at                  timestamptz not null default now(),
  primary key (metric_date, adset_id)
);

create index if not exists meta_ads_adset_daily_date_idx
  on meta_ads_adset_daily (metric_date);

create index if not exists meta_ads_adset_daily_campaign_idx
  on meta_ads_adset_daily (metric_date, campaign_id);

comment on table meta_ads_adset_daily is
  'Daily Meta Marketing API ad-set insights. Frequency peak for fatigue. '
  'Official ads_read GET only. Analytics only — never nexus or P&L.';

-- ── ad daily ────────────────────────────────────────────────────────────

create table if not exists meta_ads_ad_daily (
  metric_date                 date        not null,
  ad_id                       text        not null,
  ad_name                     text,
  adset_id                    text,
  adset_name                  text,
  campaign_id                 text,
  campaign_name               text,
  spend                       numeric(12,2),
  clicks                      integer,
  impressions                 integer,
  reach                       integer,
  frequency                   numeric(8,4),
  ctr                         numeric(10,6),
  cpc                         numeric(12,4),
  cpm                         numeric(12,4),
  inline_link_clicks          integer,
  unique_clicks               integer,
  unique_inline_link_clicks   integer,
  conversions                 numeric(12,4),
  conversion_value            numeric(12,2),
  add_to_cart                 numeric(12,4),
  add_to_cart_value           numeric(12,2),
  initiate_checkout           numeric(12,4),
  initiate_checkout_value     numeric(12,2),
  source                      text        not null default 'meta_marketing_api',
  fetched_at                  timestamptz not null default now(),
  primary key (metric_date, ad_id)
);

create index if not exists meta_ads_ad_daily_date_idx
  on meta_ads_ad_daily (metric_date);

create index if not exists meta_ads_ad_daily_campaign_idx
  on meta_ads_ad_daily (metric_date, campaign_id);

comment on table meta_ads_ad_daily is
  'Daily Meta Marketing API ad-level insights. Creative keep/kill. '
  'Official ads_read GET only. Analytics only — never nexus or P&L.';

-- ── publisher_platform (campaign × day) ─────────────────────────────────

create table if not exists meta_ads_platform_daily (
  metric_date                 date        not null,
  campaign_id                 text        not null,
  publisher_platform          text        not null,
  campaign_name               text,
  spend                       numeric(12,2),
  clicks                      integer,
  impressions                 integer,
  reach                       integer,
  frequency                   numeric(8,4),
  ctr                         numeric(10,6),
  cpc                         numeric(12,4),
  cpm                         numeric(12,4),
  inline_link_clicks          integer,
  conversions                 numeric(12,4),
  conversion_value            numeric(12,2),
  add_to_cart                 numeric(12,4),
  add_to_cart_value           numeric(12,2),
  initiate_checkout           numeric(12,4),
  initiate_checkout_value     numeric(12,2),
  source                      text        not null default 'meta_marketing_api',
  fetched_at                  timestamptz not null default now(),
  primary key (metric_date, campaign_id, publisher_platform)
);

create index if not exists meta_ads_platform_daily_date_idx
  on meta_ads_platform_daily (metric_date);

comment on table meta_ads_platform_daily is
  'Daily Meta campaign × publisher_platform (facebook / instagram / '
  'audience_network / messenger). Placement waste for keep/kill. '
  'Reach is not additive across platforms. Analytics only.';

-- ── age × gender (campaign × day) ───────────────────────────────────────

create table if not exists meta_ads_demo_daily (
  metric_date                 date        not null,
  campaign_id                 text        not null,
  age                         text        not null,
  gender                      text        not null,
  campaign_name               text,
  spend                       numeric(12,2),
  clicks                      integer,
  impressions                 integer,
  reach                       integer,
  frequency                   numeric(8,4),
  ctr                         numeric(10,6),
  cpc                         numeric(12,4),
  cpm                         numeric(12,4),
  inline_link_clicks          integer,
  conversions                 numeric(12,4),
  conversion_value            numeric(12,2),
  add_to_cart                 numeric(12,4),
  add_to_cart_value           numeric(12,2),
  initiate_checkout           numeric(12,4),
  initiate_checkout_value     numeric(12,2),
  source                      text        not null default 'meta_marketing_api',
  fetched_at                  timestamptz not null default now(),
  primary key (metric_date, campaign_id, age, gender)
);

create index if not exists meta_ads_demo_daily_date_idx
  on meta_ads_demo_daily (metric_date);

comment on table meta_ads_demo_daily is
  'Daily Meta campaign × age × gender. Audience waste (e.g. 65+). '
  'Not crossed with publisher_platform. Reach is not additive. '
  'Official ads_read GET only. Analytics only.';

alter table meta_ads_adset_daily     enable row level security;
alter table meta_ads_ad_daily        enable row level security;
alter table meta_ads_platform_daily  enable row level security;
alter table meta_ads_demo_daily      enable row level security;

-- Deny-by-default for anon / authenticated: no permissive policies.
-- service_role (Mini + dashboard API) bypasses RLS.
