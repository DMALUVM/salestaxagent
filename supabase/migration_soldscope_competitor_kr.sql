-- ============================================================
-- SoldScope competitor reverse-ASIN Keyword Research
--
-- Weekly snapshots of keywords competitor ASINs rank/bid on.
-- Feeds the /ppc/gno outliers strip + GNO export CSV.
-- Observe / recommend only — never writes to Amazon Ads.
-- Never Rank Tracker create. Never Product Research.
--
-- Our 1oz balm B0CLF5B27Y is ours and is not stored here.
-- Apply in the Supabase SQL editor. Safe to re-run.
-- ============================================================

create table if not exists soldscope_competitor_kr (
    competitor_asin            text not null,
    marketplace                text not null default 'US',
    family                     text not null,
    search_id                  integer not null,
    keyword_normalized         text not null,
    keyword                    text not null,
    search_volume              integer,
    aba_search_frequency_rank  integer,
    organic_asin               text,
    organic_rank               integer,
    sponsored_asin             text,
    sponsored_rank             integer,
    sponsored_products         integer,
    opportunity_score          integer,
    cpc                        numeric,
    match_types                text,
    as_of                      date not null,
    pulled_at                  timestamptz not null default now(),
    primary key (competitor_asin, marketplace, keyword_normalized, as_of)
);

create index if not exists idx_soldscope_comp_kr_as_of
    on soldscope_competitor_kr (as_of desc, family);
create index if not exists idx_soldscope_comp_kr_opp
    on soldscope_competitor_kr (family, opportunity_score desc);
create index if not exists idx_soldscope_comp_kr_keyword
    on soldscope_competitor_kr (keyword_normalized, as_of desc);

comment on table soldscope_competitor_kr is
    'Weekly SoldScope single-ASIN KR snapshots for configured competitor ASINs. Observe-only. Feeds GNO competitor outliers. Never Product Research.';

alter table if exists public.soldscope_competitor_kr enable row level security;
