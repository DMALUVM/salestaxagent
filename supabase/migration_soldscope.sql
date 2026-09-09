-- ============================================================
-- SoldScope Dashboard v1 — additive Amazon intel warehouse
--
-- Weekly history for the three parent hero ASINs only
-- (B0CLHTF8YN, B0DQFKMJFY, B0HBSZ71XQ). Rank Tracker snapshots
-- are optional and only written when existing groups match.
--
-- Observe-only toward Amazon Ads. Does NOT replace SP-API / Ads
-- sync. Safe to re-run.
--
-- Apply in the Supabase SQL editor. No RLS policies for anon —
-- service_role (agent + dashboard API) bypasses RLS.
-- ============================================================

create table if not exists soldscope_sales_history (
    asin          text not null,
    marketplace   text not null default 'US',
    date          date not null,
    units         integer,
    pulled_at     timestamptz not null default now(),
    primary key (asin, marketplace, date)
);

create table if not exists soldscope_bsr_history (
    asin            text not null,
    marketplace     text not null default 'US',
    date            date not null,
    category_id     bigint not null default 0,
    bsr             integer,
    category_title  text,
    pulled_at       timestamptz not null default now(),
    primary key (asin, marketplace, date, category_id)
);

create table if not exists soldscope_price_history (
    asin          text not null,
    marketplace   text not null default 'US',
    date          date not null,
    price         numeric,
    pulled_at     timestamptz not null default now(),
    primary key (asin, marketplace, date)
);

-- Written only when Rank Tracker already has a group for a hero ASIN.
-- Empty-account (0 groups) is a clean no-op — no placeholder rows.
create table if not exists soldscope_rank_snapshots (
    asin                 text not null,
    marketplace          text not null default 'US',
    group_id             integer not null,
    product_id           integer,
    phrase_id            integer,
    phrase               text not null,
    organic_position     integer,
    sponsored_position   integer,
    search_volume        integer,
    as_of                date not null,
    pulled_at            timestamptz not null default now(),
    raw                  jsonb,
    primary key (asin, marketplace, group_id, phrase, as_of)
);

create index if not exists idx_soldscope_sales_date
    on soldscope_sales_history (date desc, asin);
create index if not exists idx_soldscope_bsr_date
    on soldscope_bsr_history (date desc, asin);
create index if not exists idx_soldscope_price_date
    on soldscope_price_history (date desc, asin);
create index if not exists idx_soldscope_rank_as_of
    on soldscope_rank_snapshots (as_of desc, asin);

comment on table soldscope_sales_history is
    'SoldScope estimated daily units for hero parent ASINs. Weekly pull. Not a sales_daily source.';
comment on table soldscope_bsr_history is
    'SoldScope BSR history for hero parent ASINs. One row per (ASIN, day, category).';
comment on table soldscope_price_history is
    'SoldScope Buy Box price history for hero parent ASINs. Weekly pull.';
comment on table soldscope_rank_snapshots is
    'SoldScope Rank Tracker phrase snapshot when an existing group matches a hero ASIN. Observe-only — never created by this agent.';

-- Latest search-volume snapshot for keywords we already show (GNO / search
-- terms / bleeders). Weekly overwrite. Not a keyword-research desk.
create table if not exists soldscope_search_volume (
    keyword_normalized text not null,
    marketplace        text not null default 'US',
    as_of              date not null,
    search_volume      integer,
    sv30               integer,
    pulled_at          timestamptz not null default now(),
    primary key (keyword_normalized, marketplace)
);

-- Review count + average stars for hero parent ASINs. Not a new page.
create table if not exists soldscope_ratings_history (
    asin          text not null,
    marketplace   text not null default 'US',
    date          date not null,
    rating        numeric,
    ratings_count integer,
    pulled_at     timestamptz not null default now(),
    primary key (asin, marketplace, date)
);

create index if not exists idx_soldscope_sv_as_of
    on soldscope_search_volume (as_of desc);
create index if not exists idx_soldscope_ratings_date
    on soldscope_ratings_history (date desc, asin);

comment on table soldscope_search_volume is
    'SoldScope search volume for keywords already on PPC/GNO surfaces. Capped weekly pull. Never invents queries.';
comment on table soldscope_ratings_history is
    'SoldScope review count and average stars for hero parent ASINs. Enriches Amazon Ops product rows.';

alter table if exists public.soldscope_sales_history    enable row level security;
alter table if exists public.soldscope_bsr_history      enable row level security;
alter table if exists public.soldscope_price_history    enable row level security;
alter table if exists public.soldscope_rank_snapshots   enable row level security;
alter table if exists public.soldscope_search_volume    enable row level security;
alter table if exists public.soldscope_ratings_history  enable row level security;
