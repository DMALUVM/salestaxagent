-- ============================================================
-- SoldScope Rank Tracker — per-child variation ranks
--
-- phrases/v2 stores one winning organicAsin per hero×keyword×day.
-- GET .../products/{id}/variations + .../phrases/{id}/variations-heatmap
-- expose every tracked child ASIN's rank for that keyword×day.
--
-- Rank mapping (SoldScope → warehouse):
--   integer > 0  → organic_position (real rank)
--   0            → not found; omitted (never stored as #0)
--   null / blank → omitted (never invented)
--
-- Observe-only: existing Rank Tracker groups / already-tracked
-- variations only. Never create groups, phrases, or track toggles.
-- Safe to re-run.
--
-- Apply after migration_soldscope.sql (and organic_asin / SFR
-- extensions). Dana can apply via Supabase MCP after merge.
-- ============================================================

create table if not exists public.soldscope_rank_variation_snapshots (
    asin               text not null,
    marketplace        text not null default 'US',
    group_id           integer not null,
    product_id         integer,
    phrase_id          integer,
    phrase             text not null,
    variation_asin     text not null,
    theme              text,
    organic_position   integer,
    amazon_choice      boolean,
    as_of              date not null,
    pulled_at          timestamptz not null default now(),
    raw                jsonb,
    primary key (asin, marketplace, group_id, phrase, variation_asin, as_of)
);

create index if not exists idx_soldscope_rank_variation_as_of
    on public.soldscope_rank_variation_snapshots (as_of desc, asin, variation_asin);

create index if not exists idx_soldscope_rank_variation_phrase
    on public.soldscope_rank_variation_snapshots (asin, phrase, as_of desc);

comment on table public.soldscope_rank_variation_snapshots is
    'SoldScope Rank Tracker per-child organic ranks (variations-heatmap). 0 from SoldScope = not found and is stored as omitted/null, never as rank 0. Observe-only.';

comment on column public.soldscope_rank_variation_snapshots.asin is
    'Hero parent ASIN (lip/balm/deo group primary).';
comment on column public.soldscope_rank_variation_snapshots.variation_asin is
    'Child ASIN from GET .../variations. Never invented.';
comment on column public.soldscope_rank_variation_snapshots.theme is
    'Short SoldScope variation theme (Peppermint, Assorted, …) when sent. Empty stays null.';
comment on column public.soldscope_rank_variation_snapshots.organic_position is
    'Organic rank for this child×phrase×day. SoldScope 0 (not found) is omitted — never persisted as 0.';
comment on column public.soldscope_rank_variation_snapshots.amazon_choice is
    'Amazon''s Choice on that child×day when SoldScope sent it. Null means omitted.';

alter table if exists public.soldscope_rank_variation_snapshots
    enable row level security;
