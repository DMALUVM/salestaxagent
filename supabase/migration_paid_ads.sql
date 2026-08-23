-- Shopify / paid-social ads (Google + Meta).
-- Fed by Ads Ops structured payloads — NOT by scraping Ads Manager UIs.
-- Amazon PPC tables (ads_campaigns_daily, ads_search_terms_daily, …) are
-- intentionally untouched. Do not mix amazon PPC rows into these tables.
--
-- Run in Supabase Dashboard > SQL Editor.
-- Reads go through dashboard service-role routes (/api/paid-ads).
-- This file does NOT enable RLS and does NOT apply migration_rls_lockdown.sql.

CREATE TABLE IF NOT EXISTS paid_ads_daily (
  channel text NOT NULL CHECK (channel IN ('google_ads', 'meta_ads')),
  date text NOT NULL,
  spend numeric DEFAULT 0,
  sales_or_conv_value numeric DEFAULT 0,
  clicks integer DEFAULT 0,
  impressions integer DEFAULT 0,
  cpc numeric DEFAULT 0,
  conversions numeric DEFAULT 0,
  roas numeric DEFAULT 0,
  currency text DEFAULT 'USD',
  source text DEFAULT 'ads_ops',
  ingested_at timestamptz DEFAULT now(),
  PRIMARY KEY (channel, date)
);

CREATE TABLE IF NOT EXISTS paid_ads_campaigns_daily (
  channel text NOT NULL CHECK (channel IN ('google_ads', 'meta_ads')),
  date text NOT NULL,
  campaign_id text NOT NULL,
  campaign_name text,
  spend numeric DEFAULT 0,
  sales_or_conv_value numeric DEFAULT 0,
  clicks integer DEFAULT 0,
  impressions integer DEFAULT 0,
  cpc numeric DEFAULT 0,
  conversions numeric DEFAULT 0,
  roas numeric DEFAULT 0,
  ingested_at timestamptz DEFAULT now(),
  PRIMARY KEY (channel, date, campaign_id)
);

-- Window aggregates (1/7/14/30) as sent by Ads Ops. Preferred for KPI
-- cards when present; daily grain is the fallback rollup.
CREATE TABLE IF NOT EXISTS paid_ads_snapshots (
  channel text NOT NULL CHECK (channel IN ('google_ads', 'meta_ads')),
  as_of text NOT NULL,
  window_days integer NOT NULL CHECK (window_days IN (1, 7, 14, 30)),
  spend numeric DEFAULT 0,
  sales_or_conv_value numeric DEFAULT 0,
  clicks integer DEFAULT 0,
  impressions integer DEFAULT 0,
  cpc numeric DEFAULT 0,
  conversions numeric DEFAULT 0,
  roas numeric DEFAULT 0,
  currency text DEFAULT 'USD',
  metrics jsonb DEFAULT '{}'::jsonb,
  source text DEFAULT 'ads_ops',
  ingested_at timestamptz DEFAULT now(),
  PRIMARY KEY (channel, as_of, window_days)
);

CREATE INDEX IF NOT EXISTS idx_paid_ads_daily_date
  ON paid_ads_daily (channel, date DESC);
CREATE INDEX IF NOT EXISTS idx_paid_ads_campaigns_date
  ON paid_ads_campaigns_daily (channel, date DESC);
CREATE INDEX IF NOT EXISTS idx_paid_ads_snapshots_as_of
  ON paid_ads_snapshots (channel, as_of DESC, window_days);
