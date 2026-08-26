-- Daily FBA totals + inbound shipment history for rate / lead-time calibration.
-- Run in Supabase SQL Editor.

-- One row per SKU per calendar day (append-only from inventory_sync).
CREATE TABLE IF NOT EXISTS inventory_snapshots_daily (
    sku             text NOT NULL,
    snapshot_date   date NOT NULL,
    total_quantity  integer NOT NULL DEFAULT 0,
    fba_on_hand     integer NOT NULL DEFAULT 0,
    inbound_total   integer NOT NULL DEFAULT 0,
    fulfillable     integer NOT NULL DEFAULT 0,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sku, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_inv_snap_daily_date ON inventory_snapshots_daily (snapshot_date);

-- Inbound FBA shipments (SP-API Fulfillment Inbound v0).
CREATE TABLE IF NOT EXISTS inventory_inbound_shipments (
    shipment_id         text PRIMARY KEY,
    shipment_status     text,
    destination_fc      text,
    units_shipped       integer NOT NULL DEFAULT 0,
    units_received      integer NOT NULL DEFAULT 0,
    created_at          timestamptz,
    closed_at           timestamptz,
    receive_days        integer,
    last_updated_at     timestamptz,
    raw                 jsonb,
    synced_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_inbound_ship_closed ON inventory_inbound_shipments (closed_at);

CREATE TABLE IF NOT EXISTS inventory_inbound_shipment_items (
    shipment_id     text NOT NULL REFERENCES inventory_inbound_shipments (shipment_id) ON DELETE CASCADE,
    sku             text NOT NULL,
    quantity_shipped integer NOT NULL DEFAULT 0,
    quantity_received integer NOT NULL DEFAULT 0,
    PRIMARY KEY (shipment_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_inv_inbound_items_sku ON inventory_inbound_shipment_items (sku);

-- Precomputed per-SKU calibration (written by inventory_sync).
CREATE TABLE IF NOT EXISTS inventory_sku_signals (
    sku                     text PRIMARY KEY,
    as_of_date              date NOT NULL DEFAULT CURRENT_DATE,
    orders_u_7              numeric(10,2) NOT NULL DEFAULT 0,
    orders_u_30             numeric(10,2) NOT NULL DEFAULT 0,
    inventory_u_7           numeric(10,2),
    inventory_u_30          numeric(10,2),
    rate_divergence_pct     numeric(8,1),
    rate_agreement          text,
    measured_receive_days   integer,
    receive_sample_n        integer NOT NULL DEFAULT 0,
    configured_lead_days    integer,
    updated_at              timestamptz NOT NULL DEFAULT now()
);
