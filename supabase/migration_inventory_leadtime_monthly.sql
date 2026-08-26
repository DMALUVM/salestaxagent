-- Monthly p75 inbound / AWD→FBA history so lead times learn YoY seasonality.
CREATE TABLE IF NOT EXISTS inventory_leadtime_monthly (
    year_month      text PRIMARY KEY,
    inbound_p50     integer,
    inbound_p75     integer,
    inbound_n       integer NOT NULL DEFAULT 0,
    replenish_p50   integer,
    replenish_p75   integer,
    replenish_n     integer NOT NULL DEFAULT 0,
    recv_p75        integer,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory_leadtime_monthly ENABLE ROW LEVEL SECURITY;
