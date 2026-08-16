-- Add compliance tracking columns to nexus_status.
-- Run in Supabase Dashboard > SQL Editor.
ALTER TABLE nexus_status
  ADD COLUMN IF NOT EXISTS compliance_resolved boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS compliance_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS compliance_hidden boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS compliance_notes text;
