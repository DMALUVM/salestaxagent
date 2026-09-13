-- Widen paid_search_query_daily.kind for GSC Search Appearance.csv
-- and keep Google Search impr. share / top IS on paid_campaign_daily.
-- Additive. Leaves existing tables in place. Does not enable RLS.
-- Safe to re-run.

ALTER TABLE paid_search_query_daily
  DROP CONSTRAINT IF EXISTS paid_search_query_daily_kind_check;

ALTER TABLE paid_search_query_daily
  ADD CONSTRAINT paid_search_query_daily_kind_check
  CHECK (kind IN ('query', 'page', 'chart', 'appearance'));

ALTER TABLE paid_campaign_daily
  ADD COLUMN IF NOT EXISTS search_impr_share numeric,
  ADD COLUMN IF NOT EXISTS search_top_is numeric;

COMMENT ON COLUMN paid_campaign_daily.search_impr_share IS
  'Google Search/Shopping/PMax impression share 0–100 from the dominant typed prefix (Search_Search impr. share and equivalents).';
COMMENT ON COLUMN paid_campaign_daily.search_top_is IS
  'Google Search top impression share 0–100 from the dominant typed prefix (Search_Search top IS and equivalents).';
