-- GNO PPC Watch — export acknowledgement + Dave/Grok decision ledger.
--
-- Observe only. Neither table writes to Amazon. Export state lets /ppc/gno
-- know WHEN a pack is due (P0 / 48h review / optional morning digest) instead
-- of relying on Dave to re-read a how-to. The ledger is pastes and row marks
-- so harvest/junk tags can down-rank from Dave's skips — still no auto-negate.
--
-- Run once in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS gno_export_state (
  id                    text PRIMARY KEY DEFAULT 'default',
  last_export_at        timestamptz,
  last_export_reason    text,          -- P0 | REVIEW | DIGEST | MANUAL
  last_export_filename  text,
  acked_p0_keys         jsonb NOT NULL DEFAULT '[]'::jsonb,
  acked_p1_keys         jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at            timestamptz DEFAULT now()
);

INSERT INTO gno_export_state (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE gno_export_state IS
  'Single-row GNO pack acknowledgement. Export never writes to Amazon.';

CREATE TABLE IF NOT EXISTS gno_decision_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz DEFAULT now(),
  pack_date       text,                -- LA as-of / pack date
  campaign_name   text,
  search_term     text,
  term_family     text,                -- normalized token family
  proposed_tag    text,                -- HARVEST_CANDIDATE | JUNK_CANDIDATE | NEW_EXACT | KEEP
  dave_action     text NOT NULL
                    CHECK (dave_action IN (
                      'hold', 'bid_down', 'bid_up',
                      'approve_harvest_neg', 'skip'
                    )),
  source          text DEFAULT 'ui',   -- ui | paste
  notes           text
);

CREATE INDEX IF NOT EXISTS idx_gno_ledger_family
  ON gno_decision_ledger (term_family);
CREATE INDEX IF NOT EXISTS idx_gno_ledger_campaign
  ON gno_decision_ledger (campaign_name);
CREATE INDEX IF NOT EXISTS idx_gno_ledger_action
  ON gno_decision_ledger (dave_action);
CREATE INDEX IF NOT EXISTS idx_gno_ledger_created
  ON gno_decision_ledger (created_at DESC);

COMMENT ON TABLE gno_decision_ledger IS
  'Dave/Grok outcomes for GNO Watch learning v1. Observe only — never auto-negates.';

ALTER TABLE IF EXISTS public.gno_export_state     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.gno_decision_ledger  ENABLE ROW LEVEL SECURITY;
