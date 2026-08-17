-- Amazon settlement data (cash/deposit view).
-- Run in Supabase Dashboard > SQL Editor.
CREATE TABLE IF NOT EXISTS amazon_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id text,
  settlement_start date,
  settlement_end date,
  deposit_date date,
  transaction_type text,
  amount_type text,
  amount_description text,
  order_id text,
  sku text,
  amount numeric(12,2) DEFAULT 0,
  marketplace text,
  source text DEFAULT 'amazon_settlement',
  ingested_at timestamptz DEFAULT now()
);

-- Upsert key: one row per settlement + order + amount type + description
CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_settlements_upsert
  ON amazon_settlements (settlement_id, order_id, amount_type, amount_description);

CREATE INDEX IF NOT EXISTS idx_amazon_settlements_dates
  ON amazon_settlements (settlement_start, settlement_end);
