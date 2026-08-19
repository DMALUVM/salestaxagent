-- Net Proceeds / P&L tables.
-- Run in Supabase Dashboard > SQL Editor.

-- Per-SKU costs (COGS)
CREATE TABLE IF NOT EXISTS sku_costs (
  sku text PRIMARY KEY,
  asin text,
  cogs_per_unit numeric NOT NULL DEFAULT 0,
  currency text DEFAULT 'USD',
  effective_from date DEFAULT '2020-01-01',
  source text DEFAULT 'manual',
  notes text,
  updated_at timestamptz DEFAULT now()
);

-- Daily P&L
CREATE TABLE IF NOT EXISTS pnl_daily (
  date text NOT NULL,
  grain text NOT NULL DEFAULT 'account',
  sku text NOT NULL DEFAULT '',
  channel text NOT NULL DEFAULT 'amazon',
  gross_sales numeric DEFAULT 0,
  units integer DEFAULT 0,
  ad_spend numeric DEFAULT 0,
  est_referral_fees numeric DEFAULT 0,
  est_fba_fees numeric DEFAULT 0,
  est_cogs numeric DEFAULT 0,
  est_contribution numeric DEFAULT 0,
  amazon_net_proceeds numeric,
  net_after_ads numeric DEFAULT 0,
  status text DEFAULT 'preliminary',
  meta jsonb,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (date, grain, sku, channel)
);

CREATE INDEX IF NOT EXISTS idx_pnl_date ON pnl_daily (date DESC);
