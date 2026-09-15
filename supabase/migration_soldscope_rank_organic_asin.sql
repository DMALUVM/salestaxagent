-- ============================================================
-- SoldScope Rank Tracker — winning child ASIN
--
-- phrases/v2 SoT: organicAsin (desktop child holding organic rank).
-- mobileOrganicAsin stored when present. Heatmap r_YYYY-MM-DD objects
-- may also carry asin + amazon_choice — ingest only when SoldScope
-- returns them. Never invent. Observe-only / reuse-only RT.
--
-- `asin` on this table stays the hero/parent. `organic_asin` is the
-- child that holds the organic slot that day.
--
-- Apply after migration_soldscope.sql / migration_soldscope_rank_sfr.sql.
-- Safe to re-run.
-- ============================================================

alter table if exists public.soldscope_rank_snapshots
    add column if not exists organic_asin text,
    add column if not exists mobile_organic_asin text,
    add column if not exists amazon_choice boolean;

create index if not exists idx_soldscope_rank_organic_asin
    on public.soldscope_rank_snapshots (organic_asin);

comment on column public.soldscope_rank_snapshots.organic_asin is
    'Child ASIN holding the organic rank. phrases/v2 organicAsin, or heatmap r_YYYY-MM-DD.asin when present. Not the hero/parent.';
comment on column public.soldscope_rank_snapshots.mobile_organic_asin is
    'SoldScope phrases/v2 mobileOrganicAsin when present. Current snapshot only — not invented for heatmap days.';
comment on column public.soldscope_rank_snapshots.amazon_choice is
    'SoldScope heatmap r_YYYY-MM-DD.amazon_choice when present. Null means not returned — not false.';
