-- ============================================================
-- SoldScope Rank Tracker — child ASIN that holds the organic slot
--
-- phrases/v2 SoT: organicAsin on the current phrase row.
-- Heatmap r_YYYY-MM-DD objects may include asin / amazon_choice —
-- ingest when SoldScope sends them, never invent.
--
-- Observe-only: existing Rank Tracker groups only. Safe to re-run.
-- Apply in the Supabase SQL editor after migration_soldscope.sql
-- and migration_soldscope_rank_sfr.sql.
-- ============================================================

alter table if exists public.soldscope_rank_snapshots
    add column if not exists organic_asin text,
    add column if not exists amazon_choice boolean;

comment on column public.soldscope_rank_snapshots.organic_asin is
    'Child ASIN holding the organic rank slot (phrases/v2 organicAsin, or r_YYYY-MM-DD.asin when SoldScope sends it). Never invented.';
comment on column public.soldscope_rank_snapshots.amazon_choice is
    'Amazon''s Choice flag from phrases/v2 or heatmap day object when present. Null means SoldScope omitted it.';
