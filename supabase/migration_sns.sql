-- Subscribe & Save (Replenishment API) tables.
-- Run in Supabase Dashboard > SQL Editor.

-- Seller-level weekly SnS metrics
CREATE TABLE IF NOT EXISTS sns_seller_metrics (
  week_start text NOT NULL,
  week_end text NOT NULL,
  active_subscriptions integer DEFAULT 0,
  shipped_units integer DEFAULT 0,
  total_revenue numeric DEFAULT 0,
  revenue_penetration numeric DEFAULT 0,
  not_delivered_oos integer DEFAULT 0,
  lost_revenue_oos numeric DEFAULT 0,
  coupon_share numeric DEFAULT 0,
  currency text DEFAULT 'USD',
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (week_start)
);

-- Per-ASIN weekly SnS metrics
CREATE TABLE IF NOT EXISTS sns_offer_metrics (
  asin text NOT NULL,
  sku text,
  week_start text NOT NULL,
  week_end text NOT NULL,
  active_subscriptions integer DEFAULT 0,
  shipped_units integer DEFAULT 0,
  total_revenue numeric DEFAULT 0,
  revenue_penetration numeric DEFAULT 0,
  not_delivered_oos integer DEFAULT 0,
  lost_revenue_oos numeric DEFAULT 0,
  coupon_share numeric DEFAULT 0,
  currency text DEFAULT 'USD',
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (asin, week_start)
);

CREATE INDEX IF NOT EXISTS idx_sns_offer_asin ON sns_offer_metrics (asin);
