-- Store ledger Reference ID on inventory_events (FBA* for Receipts).
-- Enables Needs-case receipt-cover by shipment without SKU-qty heuristics.
ALTER TABLE IF EXISTS public.inventory_events
  ADD COLUMN IF NOT EXISTS reference_id text;

CREATE INDEX IF NOT EXISTS idx_inventory_events_reference_id
  ON public.inventory_events (reference_id)
  WHERE reference_id IS NOT NULL;
