-- GNO Export pack v2 — Campaigns API snapshot (observe only).
-- State / portfolio / budget / bids / placement modifiers for 0-impression
-- watch campaigns. Reporting v3 omits those rows; this table is the join.

CREATE TABLE IF NOT EXISTS ads_campaign_meta (
  campaign_id text PRIMARY KEY,
  campaign_name text NOT NULL,
  campaign_type text DEFAULT 'SP',
  state text,
  daily_budget numeric,
  portfolio_id text,
  portfolio_name text,
  tos_modifier_pct numeric,
  ros_modifier_pct numeric,
  pp_modifier_pct numeric,
  bidding_strategy text,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ads_portfolios (
  portfolio_id text PRIMARY KEY,
  portfolio_name text NOT NULL,
  state text,
  snapshot_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ads_keyword_targets (
  keyword_id text PRIMARY KEY,
  campaign_id text NOT NULL,
  campaign_name text,
  ad_group_id text,
  keyword_text text NOT NULL,
  match_type text NOT NULL,
  state text,
  bid numeric,
  snapshot_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ads_negatives (
  negative_id text PRIMARY KEY,
  campaign_id text,
  campaign_name text,
  ad_group_id text,
  keyword text NOT NULL,
  match_type text,
  state text,
  level text,
  snapshot_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ads_keyword_targets_text
  ON ads_keyword_targets (lower(trim(keyword_text)), match_type, state);
CREATE INDEX IF NOT EXISTS idx_ads_keyword_targets_campaign
  ON ads_keyword_targets (campaign_id);
CREATE INDEX IF NOT EXISTS idx_ads_negatives_campaign
  ON ads_negatives (campaign_id);
CREATE INDEX IF NOT EXISTS idx_ads_campaign_meta_name
  ON ads_campaign_meta (campaign_name);

ALTER TABLE ads_campaign_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_keyword_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_negatives ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ads_campaign_meta IS
  'SP Campaigns API snapshot for GNO pack v2. Observe only — never writes bids, state, or budgets back to Amazon.';
COMMENT ON TABLE ads_keyword_targets IS
  'Account-wide SP keyword targets from Campaigns API. Used to match Auto Loose search terms to enabled Exact keyword text.';
