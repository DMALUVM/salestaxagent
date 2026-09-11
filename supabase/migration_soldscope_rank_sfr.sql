-- ============================================================
-- SoldScope Rank Tracker — weekly organic rank + ABA SFR
--
-- phrases/v2 SoT keys: organicPosition, organicPreviousPosition,
-- abaSearchFrequencyRank (Brand Analytics SFR), abaTotalClickShare,
-- abaTotalConvShare. Never derive SFR from SoldScope searchVolume.
--
-- Observe-only: existing Rank Tracker groups only. Safe to re-run.
-- Apply in the Supabase SQL editor after migration_soldscope.sql.
-- ============================================================

alter table if exists public.soldscope_rank_snapshots
    add column if not exists organic_previous_position integer,
    add column if not exists aba_search_frequency_rank integer,
    add column if not exists aba_total_click_share numeric,
    add column if not exists aba_total_conv_share numeric,
    add column if not exists organic_page integer;

create index if not exists idx_soldscope_rank_sfr
    on public.soldscope_rank_snapshots (asin, aba_search_frequency_rank);

comment on column public.soldscope_rank_snapshots.organic_previous_position is
    'SoldScope phrases/v2 organicPreviousPosition. WoW fallback when only one weekly snapshot exists.';
comment on column public.soldscope_rank_snapshots.aba_search_frequency_rank is
    'Brand Analytics Search Frequency Rank via SoldScope RT (abaSearchFrequencyRank). SoT for SFR. Never invented from search_volume.';
comment on column public.soldscope_rank_snapshots.aba_total_click_share is
    'Brand Analytics total click share from SoldScope phrases/v2 when present.';
comment on column public.soldscope_rank_snapshots.aba_total_conv_share is
    'Brand Analytics total conversion share from SoldScope phrases/v2 when present.';
comment on column public.soldscope_rank_snapshots.organic_page is
    'SoldScope phrases/v2 organicPage when present.';
