-- Add account_number to nexus_status for per-state tax account storage.
-- Run in Supabase Dashboard > SQL Editor.
ALTER TABLE nexus_status
  ADD COLUMN IF NOT EXISTS account_number text;

-- Verify
SELECT state_code, account_number FROM nexus_status WHERE is_registered = true LIMIT 5;
