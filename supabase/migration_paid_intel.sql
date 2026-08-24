-- Tallowbourn ads Intel daily warehouse (Shopify Google / Meta / GSC / GA4).
-- Additive. Does NOT drop or truncate paid_ads_snapshots /
-- paid_ads_campaigns_window (Ads Ops window feed stays).
-- Does NOT touch ads_* Amazon PPC tables.
-- Do NOT enable RLS here (same policy as paid_ads_* : service-role API only).

CREATE TABLE IF NOT EXISTS paid_campaign_daily (
  platform text NOT NULL CHECK (platform IN ('google', 'meta')),
  date text NOT NULL,
  campaign_name text NOT NULL,
  campaign_type text NOT NULL DEFAULT 'Other',
  product text NOT NULL DEFAULT 'other',
  is_brand boolean NOT NULL DEFAULT false,
  audience text NOT NULL DEFAULT 'unknown',
  spend numeric NOT NULL DEFAULT 0,
  conv_value numeric NOT NULL DEFAULT 0,
  clicks numeric NOT NULL DEFAULT 0,
  impressions numeric NOT NULL DEFAULT 0,
  conversions numeric NOT NULL DEFAULT 0,
  lost_is_budget numeric,
  lost_is_rank numeric,
  frequency numeric,
  status text,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, date, campaign_name)
);

CREATE TABLE IF NOT EXISTS paid_search_query_daily (
  kind text NOT NULL CHECK (kind IN ('query', 'page', 'chart')),
  date text NOT NULL DEFAULT '',
  query text NOT NULL,
  clicks numeric NOT NULL DEFAULT 0,
  impressions numeric NOT NULL DEFAULT 0,
  ctr numeric,
  position numeric,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, date, query)
);

CREATE TABLE IF NOT EXISTS paid_ga_daily (
  date text NOT NULL,
  channel_group text NOT NULL,
  landing_page text NOT NULL,
  device text NOT NULL,
  sessions numeric NOT NULL DEFAULT 0,
  active_users numeric NOT NULL DEFAULT 0,
  key_events numeric NOT NULL DEFAULT 0,
  revenue numeric NOT NULL DEFAULT 0,
  bounce_rate numeric,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, channel_group, landing_page, device)
);

CREATE INDEX IF NOT EXISTS paid_campaign_daily_date_idx
  ON paid_campaign_daily (date DESC, platform);
CREATE INDEX IF NOT EXISTS paid_search_query_daily_kind_idx
  ON paid_search_query_daily (kind, date);
CREATE INDEX IF NOT EXISTS paid_ga_daily_date_idx
  ON paid_ga_daily (date DESC);
