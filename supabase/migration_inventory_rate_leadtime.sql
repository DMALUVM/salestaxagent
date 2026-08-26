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
    shipped_at          timestamptz,
    received_at         timestamptz,
    prime_eligible_at   timestamptz,
    closed_at           timestamptz,
    receive_days        integer,
    receive_days_basis  text,
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
    measured_replenish_days   integer,
    replenish_sample_n        integer NOT NULL DEFAULT 0,
    configured_awd_to_fba_days integer,
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- AWD replenishment orders (SP-API AWD v2024-05-09).
CREATE TABLE IF NOT EXISTS inventory_awd_replenishments (
    order_id                text PRIMARY KEY,
    order_status            text,
    created_at              timestamptz,
    confirmed_at            timestamptz,
    shipped_at              timestamptz,
    completed_at            timestamptz,
    replenish_days          integer,
    replenish_days_basis    text,
    outbound_shipment_ids   text[],
    outbound_fc_count       integer NOT NULL DEFAULT 0,
    units_requested         integer NOT NULL DEFAULT 0,
    units_shipped           integer NOT NULL DEFAULT 0,
    raw                     jsonb,
    synced_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_awd_replen_confirmed ON inventory_awd_replenishments (confirmed_at);

CREATE TABLE IF NOT EXISTS inventory_awd_replenishment_items (
    order_id            text NOT NULL REFERENCES inventory_awd_replenishments (order_id) ON DELETE CASCADE,
    sku                 text NOT NULL,
    quantity_requested  integer NOT NULL DEFAULT 0,
    quantity_shipped    integer NOT NULL DEFAULT 0,
    PRIMARY KEY (order_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_awd_replen_items_sku ON inventory_awd_replenishment_items (sku);

-- Account-level comparison: FBA direct vs optimized multi-FC vs AWD→Prime.
CREATE TABLE IF NOT EXISTS inventory_leadtime_summary (
    as_of_date                      date PRIMARY KEY,
    fba_receive_median              integer,
    fba_receive_n                   integer NOT NULL DEFAULT 0,
    fba_optimized_receive_median    integer,
    fba_optimized_receive_n         integer NOT NULL DEFAULT 0,
    fba_single_receive_median       integer,
    fba_single_receive_n            integer NOT NULL DEFAULT 0,
    awd_replenish_median            integer,
    awd_replenish_n                 integer NOT NULL DEFAULT 0,
    configured_awd_to_fba_days      integer,
    updated_at                      timestamptz NOT NULL DEFAULT now()
);

-- Safe upgrades when table already existed from an earlier migration run.
ALTER TABLE inventory_inbound_shipments
    ADD COLUMN IF NOT EXISTS shipped_at timestamptz,
    ADD COLUMN IF NOT EXISTS received_at timestamptz,
    ADD COLUMN IF NOT EXISTS prime_eligible_at timestamptz,
    ADD COLUMN IF NOT EXISTS receive_days_basis text,
    ADD COLUMN IF NOT EXISTS raw jsonb;

ALTER TABLE inventory_awd_replenishments
    ADD COLUMN IF NOT EXISTS shipped_at timestamptz,
    ADD COLUMN IF NOT EXISTS replenish_days_basis text;

-- AWD on-hand snapshots (SP-API AWD v2024-05-09 /inventory).
CREATE TABLE IF NOT EXISTS inventory_awd (
    sku                     text PRIMARY KEY,
    awd_on_hand             integer NOT NULL DEFAULT 0,
    awd_inbound             integer NOT NULL DEFAULT 0,
    awd_to_fba_in_transit   integer NOT NULL DEFAULT 0,
    synced_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory_awd
    ADD COLUMN IF NOT EXISTS awd_to_fba_in_transit integer NOT NULL DEFAULT 0;

-- AWD inbound shipments (warehouse → AWD).
CREATE TABLE IF NOT EXISTS inventory_awd_inbound_shipments (
    shipment_id         text PRIMARY KEY,
    order_id            text,
    shipment_status     text,
    created_at          timestamptz,
    shipped_at          timestamptz,
    received_at         timestamptz,
    closed_at           timestamptz,
    receive_days        integer,
    receive_days_basis  text,
    last_updated_at     timestamptz,
    raw                 jsonb,
    synced_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_awd_inbound_closed ON inventory_awd_inbound_shipments (closed_at);
