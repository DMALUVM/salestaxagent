-- Item tables had no freshness column, so a successful inventory_sync could
-- rewrite quantities while leaving parents' synced_at as the only clock.
ALTER TABLE IF EXISTS inventory_inbound_shipment_items
    ADD COLUMN IF NOT EXISTS synced_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE IF EXISTS inventory_awd_replenishment_items
    ADD COLUMN IF NOT EXISTS synced_at timestamptz NOT NULL DEFAULT now();
