-- Daily sales totals by channel (shopify / amazon).
-- Used by daily_digest for accurate Yesterday / MTD / YoY.
-- Run in Supabase Dashboard > SQL Editor.

CREATE TABLE IF NOT EXISTS sales_daily (
    sale_date   date    NOT NULL,
    channel     text    NOT NULL CHECK (channel IN ('shopify', 'amazon')),
    gross_sales numeric(14,2) NOT NULL DEFAULT 0,
    order_count integer NOT NULL DEFAULT 0,
    source      text    NOT NULL DEFAULT '',
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sale_date, channel)
);

CREATE INDEX IF NOT EXISTS idx_sales_daily_date ON sales_daily (sale_date);
