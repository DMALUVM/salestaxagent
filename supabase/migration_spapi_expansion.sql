-- SP-API expansion: Sales & Traffic + Reimbursements.
-- Run in Supabase Dashboard > SQL Editor.

-- Daily Sales & Traffic (from GET_SALES_AND_TRAFFIC_REPORT JSON)
CREATE TABLE IF NOT EXISTS amazon_sales_traffic (
  date text NOT NULL,
  ordered_product_sales numeric DEFAULT 0,
  units_ordered integer DEFAULT 0,
  total_order_items integer DEFAULT 0,
  sessions integer DEFAULT 0,
  page_views integer DEFAULT 0,
  unit_session_pct numeric DEFAULT 0,
  buy_box_pct numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (date)
);

-- Per-ASIN aggregate (period-level from same report)
CREATE TABLE IF NOT EXISTS amazon_asin_traffic (
  parent_asin text NOT NULL,
  child_asin text,
  product_name text,
  units_ordered integer DEFAULT 0,
  ordered_product_sales numeric DEFAULT 0,
  sessions integer DEFAULT 0,
  page_views integer DEFAULT 0,
  unit_session_pct numeric DEFAULT 0,
  buy_box_pct numeric DEFAULT 0,
  period_start text,
  period_end text,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (parent_asin)
);

-- FBA Reimbursements
CREATE TABLE IF NOT EXISTS fba_reimbursements (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  approval_date timestamptz NOT NULL,
  reimbursement_id text NOT NULL,
  case_id text,
  order_id text,
  reason text,
  sku text,
  fnsku text,
  asin text,
  product_name text,
  condition text,
  currency text DEFAULT 'USD',
  amount_per_unit numeric,
  amount_total numeric,
  qty_cash integer DEFAULT 0,
  qty_inventory integer DEFAULT 0,
  qty_total integer DEFAULT 0,
  source_file text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (reimbursement_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_reimbursements_date ON fba_reimbursements (approval_date DESC);
CREATE INDEX IF NOT EXISTS idx_reimbursements_sku ON fba_reimbursements (sku);
