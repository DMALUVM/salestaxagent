-- ============================================================
-- WIDEN keyword_organic_rank.source TO ALLOW 'sqp_spapi'
--
-- The original migration declared:
--     check (source in ('sqp','manual','helium','other'))
-- but the automated SP-API path writes source = 'sqp_spapi' to distinguish it
-- from a hand-imported Brand Analytics CSV ('sqp'). Every automated row was
-- rejected with 23514 keyword_organic_rank_source_check, and the calling code
-- mis-reported that as "table missing" — so it looked like a schema gap when
-- the table was fine.
--
-- Additive: only the CHECK is replaced. No column is dropped or retyped.
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================

alter table keyword_organic_rank
    drop constraint if exists keyword_organic_rank_source_check;

alter table keyword_organic_rank
    add constraint keyword_organic_rank_source_check
    check (source in ('sqp', 'sqp_spapi', 'manual', 'helium', 'other'));

comment on column keyword_organic_rank.source is
    'sqp = hand-imported Brand Analytics CSV; sqp_spapi = automated SP-API pull; manual = operator SERP check; helium/other = external tracker.';
