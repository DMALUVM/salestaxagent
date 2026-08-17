-- Inventory management tables for FBA restock planning.
-- Run in Supabase Dashboard > SQL Editor.

-- Live FBA stock snapshots (fulfillable, inbound, reserved, unfulfillable)
CREATE TABLE IF NOT EXISTS inventory_snapshots (
    sku             text NOT NULL,
    asin            text,
    fnsku           text,
    snapshot_at     timestamptz NOT NULL DEFAULT now(),
    fulfillable     integer NOT NULL DEFAULT 0,
    inbound_working integer NOT NULL DEFAULT 0,
    inbound_shipped integer NOT NULL DEFAULT 0,
    inbound_receiving integer NOT NULL DEFAULT 0,
    reserved        integer NOT NULL DEFAULT 0,
    unfulfillable   integer NOT NULL DEFAULT 0,
    source          text NOT NULL DEFAULT 'fba_inventory',
    PRIMARY KEY (sku)
);

-- Amazon restock recommendations (from GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT)
CREATE TABLE IF NOT EXISTS inventory_restock (
    sku                     text NOT NULL,
    asin                    text,
    product_name            text,
    recommended_qty         integer NOT NULL DEFAULT 0,
    recommended_ship_date   date,
    days_of_supply          numeric(8,1),
    units_sold_30           integer NOT NULL DEFAULT 0,
    available               integer NOT NULL DEFAULT 0,
    inbound                 integer NOT NULL DEFAULT 0,
    alert                   text,
    raw                     jsonb,
    pulled_at               timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sku)
);

-- Amazon inventory planning data (from GET_FBA_INVENTORY_PLANNING_DATA)
CREATE TABLE IF NOT EXISTS inventory_planning (
    sku                 text NOT NULL,
    asin                text,
    product_name        text,
    condition_type      text,
    available           integer NOT NULL DEFAULT 0,
    days_of_supply      numeric(8,1),
    sell_through        numeric(8,4),
    inv_age_0_90        integer NOT NULL DEFAULT 0,
    inv_age_91_180      integer NOT NULL DEFAULT 0,
    inv_age_181_270     integer NOT NULL DEFAULT 0,
    inv_age_271_365     integer NOT NULL DEFAULT 0,
    inv_age_365_plus    integer NOT NULL DEFAULT 0,
    estimated_storage_cost numeric(10,2),
    raw                 jsonb,
    pulled_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sku)
);

-- SKU velocity (unit-based, multi-channel)
CREATE TABLE IF NOT EXISTS sku_velocity (
    sku               text NOT NULL,
    asin              text,
    product_name      text,
    as_of_date        date NOT NULL DEFAULT CURRENT_DATE,
    amazon_u_7        numeric(10,2) NOT NULL DEFAULT 0,
    amazon_u_14       numeric(10,2) NOT NULL DEFAULT 0,
    amazon_u_30       numeric(10,2) NOT NULL DEFAULT 0,
    amazon_u_90       numeric(10,2) NOT NULL DEFAULT 0,
    shopify_u_7       numeric(10,2) NOT NULL DEFAULT 0,
    shopify_u_14      numeric(10,2) NOT NULL DEFAULT 0,
    shopify_u_30      numeric(10,2) NOT NULL DEFAULT 0,
    shopify_u_90      numeric(10,2) NOT NULL DEFAULT 0,
    total_u_7         numeric(10,2) NOT NULL DEFAULT 0,
    total_u_14        numeric(10,2) NOT NULL DEFAULT 0,
    total_u_30        numeric(10,2) NOT NULL DEFAULT 0,
    total_u_90        numeric(10,2) NOT NULL DEFAULT 0,
    seasonality_mult  numeric(6,3) NOT NULL DEFAULT 1.000,
    seasonal_total_u_30 numeric(10,2) NOT NULL DEFAULT 0,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sku)
);

-- Weekly seasonality index (account-level and per-SKU)
CREATE TABLE IF NOT EXISTS seasonality_weekly (
    year            integer NOT NULL,
    week            integer NOT NULL,
    sku             text,
    multiplier      numeric(6,3) NOT NULL DEFAULT 1.000,
    units_actual    numeric(10,1) NOT NULL DEFAULT 0,
    baseline_units  numeric(10,1) NOT NULL DEFAULT 0,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (year, week, sku)
);

-- SKU mapping between Amazon and Shopify
CREATE TABLE IF NOT EXISTS inventory_sku_map (
    amazon_sku      text NOT NULL,
    shopify_sku     text NOT NULL,
    asin            text,
    notes           text,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (amazon_sku, shopify_sku)
);

-- Global inventory settings
CREATE TABLE IF NOT EXISTS inventory_settings (
    id                  integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    target_cover_days   integer NOT NULL DEFAULT 60,
    lead_time_days      integer NOT NULL DEFAULT 35,
    holiday_mode        boolean NOT NULL DEFAULT false,
    include_inbound     boolean NOT NULL DEFAULT true,
    updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO inventory_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_sku_velocity_sku ON sku_velocity (sku);
CREATE INDEX IF NOT EXISTS idx_seasonality_week ON seasonality_weekly (week);
CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_asin ON inventory_snapshots (asin);
