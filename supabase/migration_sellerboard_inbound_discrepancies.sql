-- Sellerboard CLOSED inbound shorts → Needs case (durable source).
--
-- SP-API inventory_inbound_shipments only keeps ~10 live
-- WORKING / IN_TRANSIT / RECEIVING rows — zero CLOSED history.
-- Dana upserts Sellerboard CLOSED shipped−received shorts via MCP
-- (not Vercel; no Sellerboard OAuth on the dashboard runtime).
-- Mini reimbursements-case-sync merges this table into fba_case_events
-- with source sellerboard_inbound and real FBA* shipment_ids.
-- Dashboard UI reads fba_case_events only (warehouse SoT).
--
-- Do NOT apply migration_rls_lockdown.sql for this work.
-- Do NOT call Sellerboard from Next.js / Vercel.

CREATE TABLE IF NOT EXISTS sellerboard_inbound_discrepancies (
    shipment_id         text NOT NULL,
    sku                 text NOT NULL,
    asin                text,
    fulfillment_center  text,
    quantity_shipped    integer NOT NULL DEFAULT 0,
    quantity_received   integer NOT NULL DEFAULT 0,
    quantity_short      integer NOT NULL DEFAULT 0,
    shipment_status     text NOT NULL DEFAULT 'CLOSED',
    closed_at           date,
    event_date          date,
    last_updated_at     timestamptz,
    raw                 jsonb,
    synced_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (shipment_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_sb_inbound_status
    ON sellerboard_inbound_discrepancies (shipment_status);
CREATE INDEX IF NOT EXISTS idx_sb_inbound_event
    ON sellerboard_inbound_discrepancies (event_date DESC);

COMMENT ON TABLE public.sellerboard_inbound_discrepancies IS
    'Dana MCP upserts Sellerboard CLOSED inbound shorts (FBA shipment_id + SKU). '
    'Not written by Vercel. Mini merges into fba_case_events as source sellerboard_inbound.';

ALTER TABLE IF EXISTS public.fba_case_events
    ADD COLUMN IF NOT EXISTS quantity_shipped integer,
    ADD COLUMN IF NOT EXISTS quantity_received integer,
    ADD COLUMN IF NOT EXISTS dismissed_at timestamptz,
    ADD COLUMN IF NOT EXISTS dismissed_note text;

COMMENT ON COLUMN public.fba_case_events.quantity_shipped IS
    'Inbound units shipped (Sellerboard CLOSED or SP-API inbound item).';
COMMENT ON COLUMN public.fba_case_events.quantity_received IS
    'Inbound units received. Short qty is quantity (shipped − received).';
COMMENT ON COLUMN public.fba_case_events.dismissed_at IS
    'When Dave cleared the Overview / Needs-case alert after filing. '
    'status=case_submitted keeps the row as evidence.';
COMMENT ON COLUMN public.fba_case_events.source IS
    'ledger_adjustment | inbound_discrepancy (SP-API) | sellerboard_inbound. '
    'Dana may upsert sellerboard_inbound rows with real FBA* shipment_ids.';

ALTER TABLE IF EXISTS public.sellerboard_inbound_discrepancies ENABLE ROW LEVEL SECURITY;
