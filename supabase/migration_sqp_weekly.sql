-- ============================================================
-- SQP WEEKLY FUNNEL (branded market-share tracker)
--
-- keyword_organic_rank stores only what the PPC bid gate needs (a derived rank
-- band). This table keeps the full per-query funnel SQP publishes, which is
-- what the branded-vs-non-branded rollups need: our counts AND the market
-- denominators.
--
-- SCOPE GAP, on purpose: SP-API SQP is the ASIN view. It covers queries where
-- OUR ASINs appeared. Brand View (the Seller Central UI the manual tracker
-- pastes from) also shows queries where the brand has no impressions at all.
-- So "market share" here is share-of-queries-we-appear-in, not true category
-- share. Do not present it as Brand View parity.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================

create table if not exists sqp_weekly (
    id                      uuid primary key default uuid_generate_v4(),

    asin                    text not null default '',
    search_query            text not null,
    query_normalized        text not null,

    -- Sunday of the SQP reporting week (period start).
    week_start              date not null,
    week_end                date not null,
    report_period           text not null default 'WEEK',

    -- Classification, stored so a rules change is auditable against history
    -- rather than silently restating past weeks.
    is_branded              boolean not null default false,
    brand_rule              text,

    -- Market denominators (whole marketplace for this query)
    total_impressions       bigint,
    total_clicks            bigint,
    total_purchases         bigint,
    search_query_volume     bigint,

    -- Our slice
    asin_impressions        bigint,
    asin_clicks             bigint,
    asin_purchases          bigint,

    -- Shares as reported (0..1)
    impression_share        numeric,
    click_share             numeric,
    purchase_share          numeric,

    source                  text not null default 'sqp_spapi',
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now(),

    constraint uq_sqp_weekly unique (asin, query_normalized, week_start, source)
);

create index if not exists idx_sqp_weekly_week on sqp_weekly(week_start);
create index if not exists idx_sqp_weekly_branded on sqp_weekly(is_branded);
create index if not exists idx_sqp_weekly_query on sqp_weekly(query_normalized);

comment on table sqp_weekly is
    'Per-query weekly SQP funnel from SP-API (ASIN view). Denominators are marketplace-wide for queries our ASINs appeared in — NOT full Brand View category coverage.';
