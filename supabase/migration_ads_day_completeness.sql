-- Prior-day Amazon ads completeness for Iris Morning Brief CLEAR/HOLD.
-- One row per closed Amazon reporting day (America/Los_Angeles as-of).
--
-- Iris query (do not chase CoS / job_runs):
--   select date, has_sp, has_sb, has_sd, status, reason, updated_at
--   from ads_day_completeness
--   where date = '<amazon_as_of>';
-- CLEAR = prior-day SP+SB+SD present. HOLD = incomplete (or lease-busy skip).
--
-- Run in Supabase SQL editor. service_role writes; RLS deny-by-default.

CREATE TABLE IF NOT EXISTS ads_day_completeness (
  date        text PRIMARY KEY,
  has_sp      boolean NOT NULL DEFAULT false,
  has_sb      boolean NOT NULL DEFAULT false,
  has_sd      boolean NOT NULL DEFAULT false,
  status      text NOT NULL CHECK (status IN ('CLEAR', 'HOLD')),
  reason      text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ads_day_completeness IS
  'Prior-day SP/SB/SD completeness. Iris Morning Brief: SELECT status FROM ads_day_completeness WHERE date = amazon_as_of. CLEAR = use the day; HOLD = incomplete.';

CREATE INDEX IF NOT EXISTS idx_ads_day_completeness_status
  ON ads_day_completeness (status, date DESC);

ALTER TABLE ads_day_completeness ENABLE ROW LEVEL SECURITY;
