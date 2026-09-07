-- GNO PPC Watch alert Done checkoff.
-- Observe only — checking Done never pauses, negates, or writes to Amazon.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS gno_alert_acks (
  alert_key      text PRIMARY KEY,
  code           text NOT NULL,
  campaign_name  text,
  search_term    text,
  priority       text,
  status         text NOT NULL DEFAULT 'done',  -- done | open
  done_at        timestamptz,
  updated_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gno_alert_acks_status ON gno_alert_acks (status);

ALTER TABLE IF EXISTS public.gno_alert_acks ENABLE ROW LEVEL SECURITY;
