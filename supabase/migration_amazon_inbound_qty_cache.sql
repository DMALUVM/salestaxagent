-- Last-known-good Amazon inbound qty (getShipmentItems) per shipment + SKU.
--
-- Needs-case reconcile calls getShipments / getShipmentItems in batches of 5.
-- A failed batch used to drop that shipment for the day, leave Sellerboard's
-- 0 received in place, and let an unreferenced same-SKU receipt clear the row.
-- Mini upserts this cache only after a successful item parse and reads it
-- back when a later fetch fails. Not Sellerboard. Not a case status.
--
-- Do NOT apply migration_rls_lockdown.sql for this change.
-- Service role bypasses RLS; anon / authenticated stay denied.

CREATE TABLE IF NOT EXISTS amazon_inbound_qty_cache (
    shipment_id         text NOT NULL,
    sku                 text NOT NULL,
    quantity_shipped    integer,
    quantity_received   integer,
    fetched_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (shipment_id, sku)
);

COMMENT ON TABLE public.amazon_inbound_qty_cache IS
    'Last successful Amazon FBA inbound v0 shipped/received qty by shipment_id + SKU. '
    'Needs-case sync falls back here when getShipments/getShipmentItems fails.';

ALTER TABLE IF EXISTS public.amazon_inbound_qty_cache ENABLE ROW LEVEL SECURITY;
