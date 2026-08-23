-- Shopify / paid-social ads (Google + Meta).
-- Fed by Ads Ops structured payloads — NOT by scraping Ads Manager UIs.
-- Amazon PPC tables (ads_campaigns_daily, ads_search_terms_daily, …) are
-- intentionally untouched.
--
-- Production already has these tables with live google_ads rows
-- (as_of 2026-08-22). This file is IF NOT EXISTS / additive only.
-- Do NOT DROP these tables. Do NOT truncate. Do NOT apply
-- migration_rls_lockdown.sql here.
--
-- Unique keys the dashboard upserts:
--   paid_ads_snapshots          (channel, as_of, window_days)
--   paid_ads_campaigns_window   (channel, as_of, window_days, campaign_name)
-- Channel check: google_ads | meta_ads. Windows: 1 / 7 / 14 / 30.

CREATE TABLE IF NOT EXISTS paid_ads_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('google_ads', 'meta_ads')),
  as_of date NOT NULL,
  window_days integer NOT NULL CHECK (window_days IN (1, 7, 14, 30)),
  window_start date,
  window_end date,
  account_label text,
  spend numeric NOT NULL DEFAULT 0,
  conv_value numeric NOT NULL DEFAULT 0,
  roas numeric,
  clicks numeric NOT NULL DEFAULT 0,
  impressions numeric NOT NULL DEFAULT 0,
  conversions numeric NOT NULL DEFAULT 0,
  cpc numeric,
  currency text NOT NULL DEFAULT 'USD',
  source text,
  notes jsonb DEFAULT '[]'::jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, as_of, window_days)
);

CREATE TABLE IF NOT EXISTS paid_ads_campaigns_window (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text NOT NULL CHECK (channel IN ('google_ads', 'meta_ads')),
  as_of date NOT NULL,
  window_days integer NOT NULL CHECK (window_days IN (1, 7, 14, 30)),
  campaign_id text,
  campaign_name text NOT NULL,
  spend numeric NOT NULL DEFAULT 0,
  conv_value numeric,
  roas numeric,
  clicks numeric,
  impressions numeric,
  conversions numeric,
  cpc numeric,
  status text,
  note text,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, as_of, window_days, campaign_name)
);

-- Forward-add columns if an older draft created a thinner table.
-- Safe on production (columns already exist). Never drops or retypes.
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS window_start date;
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS window_end date;
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS account_label text;
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS conv_value numeric NOT NULL DEFAULT 0;
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS roas numeric;
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS clicks numeric NOT NULL DEFAULT 0;
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS impressions numeric NOT NULL DEFAULT 0;
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS conversions numeric NOT NULL DEFAULT 0;
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS cpc numeric;
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS notes jsonb DEFAULT '[]'::jsonb;
ALTER TABLE paid_ads_snapshots ADD COLUMN IF NOT EXISTS ingested_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE paid_ads_campaigns_window ADD COLUMN IF NOT EXISTS campaign_id text;
ALTER TABLE paid_ads_campaigns_window ADD COLUMN IF NOT EXISTS conv_value numeric;
ALTER TABLE paid_ads_campaigns_window ADD COLUMN IF NOT EXISTS roas numeric;
ALTER TABLE paid_ads_campaigns_window ADD COLUMN IF NOT EXISTS clicks numeric;
ALTER TABLE paid_ads_campaigns_window ADD COLUMN IF NOT EXISTS impressions numeric;
ALTER TABLE paid_ads_campaigns_window ADD COLUMN IF NOT EXISTS conversions numeric;
ALTER TABLE paid_ads_campaigns_window ADD COLUMN IF NOT EXISTS cpc numeric;
ALTER TABLE paid_ads_campaigns_window ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE paid_ads_campaigns_window ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE paid_ads_campaigns_window ADD COLUMN IF NOT EXISTS ingested_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS paid_ads_snapshots_channel_asof_idx
  ON paid_ads_snapshots (channel, as_of DESC);
CREATE INDEX IF NOT EXISTS paid_ads_campaigns_window_channel_asof_idx
  ON paid_ads_campaigns_window (channel, as_of DESC, spend DESC);
