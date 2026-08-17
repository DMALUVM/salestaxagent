-- Capacity planning + AWD tables.
-- Run in Supabase Dashboard > SQL Editor.

-- AWD inventory snapshots
CREATE TABLE IF NOT EXISTS inventory_awd (
    sku               text NOT NULL,
    awd_on_hand       integer NOT NULL DEFAULT 0,
    awd_inbound       integer NOT NULL DEFAULT 0,
    pulled_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sku)
);
ALTER TABLE inventory_awd DISABLE ROW LEVEL SECURITY;

-- Monthly FBA capacity limits
CREATE TABLE IF NOT EXISTS fba_capacity_limits (
    month         text NOT NULL,
    limit_ft3     numeric(10,2) NOT NULL DEFAULT 0,
    used_ft3      numeric(10,2) NOT NULL DEFAULT 0,
    source        text NOT NULL DEFAULT 'estimate',
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (month)
);
ALTER TABLE fba_capacity_limits DISABLE ROW LEVEL SECURITY;

-- Per-SKU volume (ft3 per unit)
CREATE TABLE IF NOT EXISTS inventory_sku_volume (
    sku           text NOT NULL,
    ft3_per_unit  numeric(8,4) NOT NULL DEFAULT 0.10,
    source        text NOT NULL DEFAULT 'manual',
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sku)
);
ALTER TABLE inventory_sku_volume DISABLE ROW LEVEL SECURITY;

-- Extended planning settings
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS receiving_days_normal integer NOT NULL DEFAULT 14;
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS receiving_days_peak integer NOT NULL DEFAULT 28;
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS awd_to_fba_days integer NOT NULL DEFAULT 14;
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS production_lead_days integer NOT NULL DEFAULT 45;
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS peak_start_date text DEFAULT '2026-10-01';
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS peak_end_date text DEFAULT '2027-01-15';
ALTER TABLE inventory_settings ADD COLUMN IF NOT EXISTS include_awd boolean NOT NULL DEFAULT true;

-- Seed capacity limits (user's actual data)
INSERT INTO fba_capacity_limits (month, limit_ft3, used_ft3, source)
VALUES
  ('2026-08', 115.33, 63.44, 'confirmed'),
  ('2026-09', 139.08, 0, 'estimate'),
  ('2026-10', 123.61, 0, 'estimate'),
  ('2026-11', 123.61, 0, 'estimate'),
  ('2026-12', 123.61, 0, 'estimate'),
  ('2027-01', 139.08, 0, 'estimate')
ON CONFLICT (month) DO NOTHING;
