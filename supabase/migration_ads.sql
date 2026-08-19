-- Amazon Ads PPC tables.
-- Run in Supabase Dashboard > SQL Editor.

CREATE TABLE IF NOT EXISTS ads_campaigns_daily (
  date text NOT NULL,
  campaign_id text NOT NULL,
  campaign_name text,
  campaign_type text DEFAULT 'SP',
  campaign_status text,
  budget numeric,
  spend numeric DEFAULT 0,
  sales_14d numeric DEFAULT 0,
  orders_14d integer DEFAULT 0,
  clicks integer DEFAULT 0,
  impressions integer DEFAULT 0,
  cpc numeric DEFAULT 0,
  acos numeric DEFAULT 0,
  roas numeric DEFAULT 0,
  ctr numeric DEFAULT 0,
  cvr numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (date, campaign_id)
);

CREATE TABLE IF NOT EXISTS ads_search_terms_daily (
  date text NOT NULL,
  search_term text NOT NULL,
  campaign_id text NOT NULL,
  campaign_name text,
  ad_group_id text NOT NULL,
  ad_group_name text,
  keyword text,
  keyword_id text,
  match_type text,
  spend numeric DEFAULT 0,
  sales_14d numeric DEFAULT 0,
  orders_14d integer DEFAULT 0,
  clicks integer DEFAULT 0,
  impressions integer DEFAULT 0,
  cpc numeric DEFAULT 0,
  acos numeric DEFAULT 0,
  roas numeric DEFAULT 0,
  ctr numeric DEFAULT 0,
  cvr numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (date, search_term, campaign_id, ad_group_id)
);

CREATE TABLE IF NOT EXISTS ads_recommendations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  type text NOT NULL,
  priority text DEFAULT 'P1',
  impact_estimate numeric DEFAULT 0,
  entity_type text,
  entity_name text NOT NULL,
  campaign_name text,
  campaign_id text,
  ad_group_id text,
  evidence jsonb,
  suggested_action text,
  status text DEFAULT 'open',
  created_at timestamptz DEFAULT now(),
  UNIQUE (type, entity_name, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_ads_campaigns_date ON ads_campaigns_daily (date DESC);
CREATE INDEX IF NOT EXISTS idx_ads_search_terms_date ON ads_search_terms_daily (date DESC);
CREATE INDEX IF NOT EXISTS idx_ads_recs_status ON ads_recommendations (status);
