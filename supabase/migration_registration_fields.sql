-- Add registration permit fields to nexus_status.
-- Run in Supabase Dashboard > SQL Editor.

ALTER TABLE nexus_status ADD COLUMN IF NOT EXISTS registration_number text;
ALTER TABLE nexus_status ADD COLUMN IF NOT EXISTS registration_source text;
