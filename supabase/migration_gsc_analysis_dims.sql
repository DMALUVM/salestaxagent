-- GSC analysis enrichments — additive Search Analytics dimensions + PDP inspect.
--
-- WHY THIS EXISTS
-- gsc_query_daily / gsc_page_daily stay the source of truth for query/page
-- totals (Iris / Nora / paid-ads consumers). Mini gsc-sync now also stores
-- cheap, stable Search Analytics dimensions Google exposes:
--   * query × device and page × device (same grain as ga4_landing_daily)
--   * site-wide device / country / search_appearance in one dim table
--     (ga4_sessions_daily split_kind / split_value pattern)
-- searchAppearance is site-wide only — Google forbids grouping it with
-- any other dimension, including date. Day-bound startDate/endDate and
-- stamp metric_date from the request window. query×appearance is also
-- forbidden and would explode quota.
--
-- URL Inspection is a tiny hardcoded tallowbourn.com PDP allowlist
-- (latest row per URL). Not a crawl. Fail closed: log + continue.
-- Merchant / structured-data / rich-result *issue lists* are still not
-- in the API — Ellis mail owns those. Do not invent an issues poll.
--
-- ADDITIVE / SIDE TABLES
-- Nothing here feeds nexus, liability, Pulse sales, or contribution P&L.
-- Distinct from CSV intel (`paid_search_query_daily`). Safe to re-run.
--
-- RLS
-- Enable RLS, no anon/authenticated policies. service_role bypasses RLS
-- (Python Mini + dashboard API routes). Do not write these from the
-- browser anon key. Do not apply migration_rls_lockdown.sql for this.

-- ── query × device / page × device ──────────────────────────────────────

create table if not exists gsc_query_device_daily (
  metric_date         date        not null,
  query               text        not null,
  device              text        not null,
  clicks              integer,
  impressions         integer,
  ctr                 numeric(8,6),
  position            numeric(8,3),
  source              text        not null default 'gsc_api',
  fetched_at          timestamptz not null default now(),
  primary key (metric_date, query, device)
);

create index if not exists gsc_query_device_daily_date_idx
  on gsc_query_device_daily (metric_date);

comment on table gsc_query_device_daily is
  'Daily Search Console API query × device. Official API only. '
  'Analytics only — never feeds nexus or P&L. Totals stay on gsc_query_daily.';

create table if not exists gsc_page_device_daily (
  metric_date         date        not null,
  page                text        not null,
  device              text        not null,
  clicks              integer,
  impressions         integer,
  ctr                 numeric(8,6),
  position            numeric(8,3),
  source              text        not null default 'gsc_api',
  fetched_at          timestamptz not null default now(),
  primary key (metric_date, page, device)
);

create index if not exists gsc_page_device_daily_date_idx
  on gsc_page_device_daily (metric_date);

comment on table gsc_page_device_daily is
  'Daily Search Console API page × device. Official API only. '
  'Analytics only — never feeds nexus or P&L. Totals stay on gsc_page_daily.';

-- ── site-wide dims (device / country / search_appearance) ───────────────

create table if not exists gsc_dim_daily (
  metric_date         date        not null,
  -- device | country | search_appearance. Never invent a kind.
  dim_kind            text        not null,
  dim_value           text        not null,
  clicks              integer,
  impressions         integer,
  ctr                 numeric(8,6),
  position            numeric(8,3),
  source              text        not null default 'gsc_api',
  fetched_at          timestamptz not null default now(),
  primary key (metric_date, dim_kind, dim_value),
  constraint gsc_dim_daily_kind_chk
    check (dim_kind in ('device', 'country', 'search_appearance'))
);

create index if not exists gsc_dim_daily_date_kind_idx
  on gsc_dim_daily (metric_date, dim_kind);

comment on table gsc_dim_daily is
  'Daily Search Console API site-wide dimensions (device, country, '
  'search_appearance). search_appearance is not crossed with query/page. '
  'Official API only. Analytics only.';

-- ── URL Inspection (latest per allowlisted PDP) ─────────────────────────

create table if not exists gsc_url_inspection (
  inspection_url              text        primary key,
  site_url                    text        not null,
  inspected_at                timestamptz not null default now(),
  verdict                     text,
  coverage_state              text,
  robots_txt_state            text,
  indexing_state              text,
  last_crawl_time             timestamptz,
  page_fetch_state            text,
  google_canonical            text,
  user_canonical              text,
  crawled_as                  text,
  referring_urls              text[],
  mobile_usability_verdict    text,
  rich_results_verdict        text,
  inspection_result_link      text,
  -- Slim official fields only. Never stores issue / detectedItems lists.
  raw                         jsonb,
  error                       text,
  source                      text        not null default 'gsc_url_inspection_api'
);

comment on table gsc_url_inspection is
  'Latest URL Inspection API result for a tiny hardcoded PDP allowlist. '
  'Read-only. Not a crawl. Verdicts only — no rich-result issue lists. '
  'Ellis mail owns Merchant / structured-data / rich-result issue alerts.';

alter table gsc_query_device_daily  enable row level security;
alter table gsc_page_device_daily   enable row level security;
alter table gsc_dim_daily           enable row level security;
alter table gsc_url_inspection      enable row level security;

-- Deny-by-default for anon / authenticated: no permissive policies.
-- service_role (Mini + dashboard API) bypasses RLS.
