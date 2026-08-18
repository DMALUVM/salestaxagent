-- Wave A migrations — run in Supabase Dashboard > SQL Editor.

-- P0-2: Filing events (records when user marks a period as filed)
CREATE TABLE IF NOT EXISTS filing_events (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  state_code text NOT NULL,
  period_start text NOT NULL,
  period_end text NOT NULL,
  filed_at timestamptz DEFAULT now(),
  confirmation_number text,
  amount_reported numeric,
  notes text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_filing_events_state ON filing_events (state_code);

-- P0-4: Job runs (automation health tracking)
CREATE TABLE IF NOT EXISTS job_runs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  job_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',  -- running | success | fail
  message text,
  stats jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_job_runs_name ON job_runs (job_name);
CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs (started_at DESC);

-- P0-1: Ensure account_number exists (may already be present)
ALTER TABLE nexus_status ADD COLUMN IF NOT EXISTS account_number text;
