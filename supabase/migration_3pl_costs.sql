-- 3PL cost tracking tables.
-- Run in Supabase Dashboard > SQL Editor.

-- Monthly summary (one row per month)
CREATE TABLE IF NOT EXISTS tpl_cost_monthly (
  month text PRIMARY KEY,
  shipping numeric DEFAULT 0,
  pick numeric DEFAULT 0,
  order_fee numeric DEFAULT 0,
  packaging numeric DEFAULT 0,
  storage_shelf numeric DEFAULT 0,
  storage_bin_med numeric DEFAULT 0,
  storage_pallet numeric DEFAULT 0,
  storage_bin_sm numeric DEFAULT 0,
  account_mgmt numeric DEFAULT 0,
  adhoc numeric DEFAULT 0,
  total numeric DEFAULT 0,
  source_file text,
  updated_at timestamptz DEFAULT now()
);

-- Packaging and ad-hoc fee breakdown by month
CREATE TABLE IF NOT EXISTS tpl_cost_fees (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  month text NOT NULL,
  section text NOT NULL,  -- 'packaging' or 'adhoc'
  fee_name text NOT NULL,
  qty numeric DEFAULT 0,
  amount numeric DEFAULT 0,
  source_file text,
  updated_at timestamptz DEFAULT now(),
  UNIQUE (month, section, fee_name)
);

-- Line-level detail
CREATE TABLE IF NOT EXISTS tpl_cost_detail (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  date text,
  period_start text,
  period_end text,
  month text NOT NULL,
  entry text,
  category text,
  fee_name text,
  reference text,
  order_id text,
  qty numeric,
  amount numeric DEFAULT 0,
  line_hash text NOT NULL UNIQUE,  -- dedup key
  source_file text,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tpl_detail_month ON tpl_cost_detail (month);
CREATE INDEX IF NOT EXISTS idx_tpl_detail_category ON tpl_cost_detail (category);
