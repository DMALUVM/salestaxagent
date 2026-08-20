-- PPC action learning foundation: decision log + outcome snapshots.
--
-- WHY TWO TABLES, AND WHY NOT REUSE ads_recommendations
-- ads_recommendations is the live queue: every actions run clears the open rows
-- and writes a fresh set, so it deliberately holds only "what to do now" and
-- cannot be a history. ads_action_decisions is append-only — one row per action
-- per as-of date, with the evidence FROZEN at decision time so a future model
-- trained on it cannot see data that did not exist when the call was made.
--
-- ads_recommendations gains a decision_id so the dashboard's existing
-- apply/dismiss path updates both the queue row and its decision-log row.
-- The dashboard keeps calling the same endpoint; nothing forks.
--
-- Nothing here writes to Amazon. This is an observation log.
--
-- Run once in the Supabase SQL editor.

-- ── 1. Decision log (append-only) ──────────────────────────────
CREATE TABLE IF NOT EXISTS ads_action_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- LA closed day the decision was computed from; the learning key.
  as_of_date        text NOT NULL,
  created_at        timestamptz DEFAULT now(),
  run_id            text,                    -- job_runs.id for provenance

  action_type       text NOT NULL,           -- negate_exact | harvest_exact | reduce_bid | increase_bid | adjust_tos_modifier | review_campaign
  rec_type          text NOT NULL,           -- DB type, e.g. NEGATE_SEARCH_TERM
  priority          text,

  campaign_id       text,
  campaign_name     text,
  ad_group_id       text,
  role              text,                    -- discovery | profit | ranking | defense

  entity_type       text,                    -- search_term | keyword | campaign
  entity_name       text,
  search_term       text,                    -- when the action targets a term
  placement         text,                    -- when the action targets a placement

  suggested_change  jsonb,                   -- direction, suggested_bid, step_pct, target_acos
  evidence          jsonb NOT NULL,          -- FROZEN metrics at decision time
  impact_estimate   numeric,

  status            text DEFAULT 'open',     -- open | applied | dismissed | expired
  applied_at        timestamptz,
  dismissed_at      timestamptz,
  expired_at        timestamptz,

  -- One decision per action per as-of day. Re-running the same day is an
  -- upsert, not a duplicate; a new day is a new decision.
  UNIQUE (as_of_date, rec_type, entity_name, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_ads_decisions_as_of   ON ads_action_decisions (as_of_date DESC);
CREATE INDEX IF NOT EXISTS idx_ads_decisions_status  ON ads_action_decisions (status);
CREATE INDEX IF NOT EXISTS idx_ads_decisions_type    ON ads_action_decisions (action_type);

-- ── 2. Outcome snapshots ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ads_action_outcomes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id     uuid NOT NULL REFERENCES ads_action_decisions(id) ON DELETE CASCADE,
  horizon_days    integer NOT NULL,          -- 7 | 14 | 30 (config-driven)
  captured_at     timestamptz DEFAULT now(),

  -- Post-decision observation window, closed LA days.
  anchor_date     text NOT NULL,             -- applied_at/dismissed_at date, else as_of_date
  window_start    text NOT NULL,
  window_end      text NOT NULL,

  -- Entity performance over the window (search term, keyword or campaign).
  spend           numeric,
  ad_sales        numeric,
  acos            numeric,
  clicks          integer,
  orders          integer,

  -- Context: was the whole account moving, or just this entity?
  account_spend   numeric,
  account_tacos   numeric,
  role_spend      numeric,
  role_tacos      numeric,

  -- P&L for the same window, from the existing contribution rows.
  contribution    numeric,
  gross_sales     numeric,

  meta            jsonb,

  -- Idempotency: one snapshot per decision per horizon, ever.
  UNIQUE (decision_id, horizon_days)
);

CREATE INDEX IF NOT EXISTS idx_ads_outcomes_decision ON ads_action_outcomes (decision_id);
CREATE INDEX IF NOT EXISTS idx_ads_outcomes_horizon  ON ads_action_outcomes (horizon_days);

-- ── 3. Link the live queue to its decision row ─────────────────
ALTER TABLE ads_recommendations
  ADD COLUMN IF NOT EXISTS decision_id uuid;

CREATE INDEX IF NOT EXISTS idx_ads_recs_decision ON ads_recommendations (decision_id);
