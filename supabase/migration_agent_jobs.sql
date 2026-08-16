-- Agent jobs queue: dashboard enqueues, Python agent dequeues and executes.
CREATE TABLE IF NOT EXISTS agent_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,           -- 'export_cpa' | 'export_triage' | 'ingest_shopify' etc.
  status text NOT NULL DEFAULT 'pending',  -- pending | running | done | error
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_text text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Index for the worker to claim oldest pending
CREATE INDEX IF NOT EXISTS idx_agent_jobs_pending
  ON agent_jobs (created_at)
  WHERE status = 'pending';

-- RLS: service role can do everything, anon can insert (for dashboard regenerate)
ALTER TABLE agent_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON agent_jobs
  FOR ALL USING (true) WITH CHECK (true);
