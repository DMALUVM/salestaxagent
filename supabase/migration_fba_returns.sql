-- FBA Customer Returns tracking.
-- Run in Supabase Dashboard > SQL Editor.

CREATE TABLE IF NOT EXISTS fba_returns (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  return_date timestamptz NOT NULL,
  order_id text NOT NULL,
  sku text NOT NULL,
  asin text,
  fnsku text,
  product_name text,
  quantity integer DEFAULT 1,
  fulfillment_center text,
  disposition text,        -- SELLABLE, DEFECTIVE, CUSTOMER_DAMAGED, etc.
  reason text,             -- UNDELIVERABLE_REFUSED, DEFECTIVE, etc.
  status text,
  customer_comments text,
  source_file text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (return_date, order_id, sku, quantity, reason)
);

CREATE INDEX IF NOT EXISTS idx_fba_returns_sku ON fba_returns (sku);
CREATE INDEX IF NOT EXISTS idx_fba_returns_date ON fba_returns (return_date DESC);
