-- Add researching, total_quantity, product_name to inventory_snapshots.
-- Run in Supabase Dashboard > SQL Editor.

ALTER TABLE inventory_snapshots ADD COLUMN IF NOT EXISTS researching integer NOT NULL DEFAULT 0;
ALTER TABLE inventory_snapshots ADD COLUMN IF NOT EXISTS total_quantity integer NOT NULL DEFAULT 0;
ALTER TABLE inventory_snapshots ADD COLUMN IF NOT EXISTS product_name text;
