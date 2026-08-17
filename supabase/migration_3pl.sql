-- Ship Sidekick 3PL inventory snapshots.
-- Run in Supabase Dashboard > SQL Editor.

CREATE TABLE IF NOT EXISTS inventory_3pl_snapshots (
    sku           text NOT NULL,
    product_name  text,
    available     integer NOT NULL DEFAULT 0,
    committed     integer NOT NULL DEFAULT 0,
    reserved      integer NOT NULL DEFAULT 0,
    incoming      integer NOT NULL DEFAULT 0,
    damaged       integer NOT NULL DEFAULT 0,
    warehouse     text,
    raw           jsonb,
    pulled_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sku)
);
ALTER TABLE inventory_3pl_snapshots DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_3pl_snapshots_sku ON inventory_3pl_snapshots (sku);

-- Add include_3pl setting to inventory_settings
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS include_3pl boolean NOT NULL DEFAULT true;
