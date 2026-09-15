-- Needs-case classification version (ledger-legend-2026-09-15).
-- Additive only. Do NOT apply migration_rls_lockdown.sql for this change.
-- After apply, Mini must:
--   python -m src.main reimbursements-case-sync --days 90

ALTER TABLE IF EXISTS public.fba_case_events
  ADD COLUMN IF NOT EXISTS classification_version text;

COMMENT ON COLUMN public.fba_case_events.classification_version IS
  'Ledger reason-legend version stamped at sync. Packets unverified if missing or outdated.';
