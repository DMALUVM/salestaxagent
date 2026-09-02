-- Operator "not selling" flags. Overview CRITICAL / reorder / rate-check
-- hide only. Does not delete inventory, velocity, or plan data. Does not
-- change Holt / replen qty. Run in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS inventory_sku_flags (
    sku          text PRIMARY KEY,
    not_selling  boolean NOT NULL DEFAULT false,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   text
);

ALTER TABLE inventory_sku_flags ENABLE ROW LEVEL SECURITY;

-- Dave already named Rustic Vanilla as not selling. Toggle works for any SKU.
INSERT INTO inventory_sku_flags (sku, not_selling, updated_by)
VALUES ('DDPE0011Shop', true, 'migration:rustic-vanilla')
ON CONFLICT (sku) DO NOTHING;
