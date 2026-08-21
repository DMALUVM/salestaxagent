-- ============================================================
-- ORGANIC SEARCH RANK (for PPC cannibalization gating)
--
-- Amazon's Advertising API does NOT expose organic SERP rank. Rows here come
-- from Brand Analytics Search Query Performance, a manual override, or an
-- external rank tracker — never inferred from ads metrics.
--
-- Used to restrain BID INCREASES on queries we already win organically.
-- Never used to block negatives, pauses or bid decreases.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================

create table if not exists keyword_organic_rank (
    id                        uuid primary key default uuid_generate_v4(),

    asin                      text not null default '',
    -- Lowercased, trimmed, whitespace-collapsed. Join key against PPC search
    -- terms, which are stored raw and normalised at lookup time.
    keyword_normalized        text not null,
    keyword_raw               text,

    -- Nullable: "we know page 2 but not the exact position" is a real state,
    -- and is more useful than a fabricated number.
    organic_rank              int,
    page                      int,

    -- 'sqp' = hand-imported Brand Analytics CSV, 'sqp_spapi' = automated
    -- SP-API pull. Omitting sqp_spapi here rejected every automated row with
    -- a 23514 CHECK violation; see migration_organic_rank_source.sql.
    source                    text not null check (source in ('sqp','sqp_spapi','manual','helium','other')),
    as_of                     date not null,

    -- SQP reports share-of-clicks, not rank. Kept when present because it is
    -- the closest official proxy Amazon publishes.
    impression_share_organic  numeric,
    raw                       jsonb,

    created_at                timestamptz not null default now(),
    updated_at                timestamptz not null default now(),

    -- Source and date are part of the key so a manual override and a weekly
    -- SQP row can coexist; the freshest wins at read time.
    constraint uq_keyword_organic_rank
        unique (asin, keyword_normalized, source, as_of)
);

create index if not exists idx_organic_rank_lookup
    on keyword_organic_rank(asin, keyword_normalized);
create index if not exists idx_organic_rank_as_of
    on keyword_organic_rank(as_of);

comment on table keyword_organic_rank is
    'Organic SERP rank per (ASIN, query). Source is SQP / manual / external tracker — never the Ads API. Drives PPC bid-increase gating only.';
