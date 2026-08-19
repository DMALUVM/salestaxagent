-- SKU Costs (COGS) table — may already exist from migration_pnl.sql.
-- Run in Supabase Dashboard > SQL Editor. Safe to re-run.

CREATE TABLE IF NOT EXISTS sku_costs (
  sku text PRIMARY KEY,
  cogs_per_unit numeric(12,4) NOT NULL DEFAULT 0 CHECK (cogs_per_unit >= 0),
  source text DEFAULT 'manual',
  notes text,
  updated_at timestamptz DEFAULT now()
);

-- Add columns that may be missing from earlier migration
ALTER TABLE sku_costs ADD COLUMN IF NOT EXISTS product_name text;
ALTER TABLE sku_costs ADD COLUMN IF NOT EXISTS asin text;
