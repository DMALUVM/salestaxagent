-- Per-campaign GNO launch clock.
-- creationDate from Campaigns API (or first snapshot) so NEW_EXACT_ZERO_IMPR
-- does not use the global launched_at midnight. Observe only.

ALTER TABLE IF EXISTS ads_campaign_meta
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

COMMENT ON COLUMN ads_campaign_meta.created_at IS
  'Campaigns API creationDate, else first snapshot_at. Used for hours_since_launch / zero_impr_after_24h. Never inferred from spend days.';
