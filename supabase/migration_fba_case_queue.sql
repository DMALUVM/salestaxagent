-- FBA Needs-case queue (Phase 2).
-- Paid cash stays on fba_reimbursements (GET_FBA_REIMBURSEMENTS_DATA).
-- Eligible / open cases are inferred — Amazon has no SP-API for open claims.
--
-- Sources:
--   GET_LEDGER_DETAIL_VIEW_DATA (reportOptions.eventType=Adjustments)
--   inventory_inbound_shipments / items (shipped − received shorts)
-- Deduped against fba_reimbursements. Never auto-files Seller Central cases.
--
-- GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA was deprecated 2023-01-31.

CREATE TABLE IF NOT EXISTS fba_inventory_adjustments (
    event_key           text PRIMARY KEY,
    event_date          date NOT NULL,
    sku                 text,
    asin                text,
    fnsku               text,
    product_name        text,
    event_type          text,
    reference_id        text,
    quantity            integer NOT NULL DEFAULT 0,
    fulfillment_center  text,
    disposition         text,
    reason              text,
    country             text,
    reconciled_qty      integer,
    unreconciled_qty    integer,
    source_file         text NOT NULL DEFAULT 'spapi_ledger_adjustments',
    synced_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fba_adj_date ON fba_inventory_adjustments (event_date DESC);
CREATE INDEX IF NOT EXISTS idx_fba_adj_sku ON fba_inventory_adjustments (sku);
CREATE INDEX IF NOT EXISTS idx_fba_adj_reason ON fba_inventory_adjustments (reason);

CREATE TABLE IF NOT EXISTS fba_case_events (
    event_key                   text PRIMARY KEY,
    source                      text NOT NULL,
    event_date                  date NOT NULL,
    sku                         text,
    asin                        text,
    fnsku                       text,
    product_name                text,
    quantity                    integer NOT NULL DEFAULT 0,
    reason                      text NOT NULL,
    reason_group                text NOT NULL,
    fulfillment_center          text,
    shipment_id                 text,
    reference_id                text,
    disposition                 text,
    estimated_amount            numeric,
    amount_basis                text,
    status                      text NOT NULL,
    matched_reimbursement_id    text,
    matched_reimbursed_qty      integer NOT NULL DEFAULT 0,
    seller_central_url          text,
    seller_central_link_kind    text,
    synced_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fba_case_status_date ON fba_case_events (status, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_fba_case_group ON fba_case_events (reason_group);
CREATE INDEX IF NOT EXISTS idx_fba_case_sku ON fba_case_events (sku);

CREATE TABLE IF NOT EXISTS fba_case_packages (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    target_agent_id     text NOT NULL,
    target_agent_name   text,
    event_keys          text[],
    payload_markdown    text NOT NULL,
    payload_json        jsonb NOT NULL,
    source              text NOT NULL DEFAULT 'dashboard'
);

CREATE INDEX IF NOT EXISTS idx_fba_case_packages_created ON fba_case_packages (created_at DESC);

ALTER TABLE IF EXISTS public.fba_inventory_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.fba_case_events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.fba_case_packages         ENABLE ROW LEVEL SECURITY;
