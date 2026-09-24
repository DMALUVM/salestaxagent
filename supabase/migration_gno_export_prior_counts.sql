-- Last GNO pack row counts, so the next export can print prior deltas.
-- Observe only. Nothing here writes to Amazon Ads.

ALTER TABLE gno_export_state
  ADD COLUMN IF NOT EXISTS last_row_counts jsonb;

COMMENT ON COLUMN gno_export_state.last_row_counts IS
  'auto_loose / broad_m / watch / sqp row counts from the last export. Next pack reads these as prior deltas. Observe only.';
