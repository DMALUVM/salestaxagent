-- Sponsored Products placement performance, by day and campaign.
--
-- Verified against the Ads API v3 (reportTypeId=spCampaigns,
-- groupBy=["campaignPlacement"], column placementClassification). A 7-day pull
-- returned 2,442 rows across four placements:
--   Top of Search on-Amazon | Detail Page on-Amazon | Other on-Amazon | Off Amazon
--
-- Feeds the "is Top of Search the efficient placement?" question and the TOS
-- bid-modifier recommendation. Run once in the Supabase SQL editor, then:
--   python -m src.main ads-sync --days 14 --placements-only

CREATE TABLE IF NOT EXISTS ads_placement_daily (
  date            text NOT NULL,
  campaign_id     text NOT NULL,
  campaign_name   text,
  placement       text NOT NULL,      -- placementClassification, verbatim
  impressions     integer DEFAULT 0,
  clicks          integer DEFAULT 0,
  spend           numeric DEFAULT 0,
  sales_14d       numeric DEFAULT 0,
  orders_14d      integer DEFAULT 0,
  cpc             numeric DEFAULT 0,
  acos            numeric DEFAULT 0,
  roas            numeric DEFAULT 0,
  ctr             numeric DEFAULT 0,
  cvr             numeric DEFAULT 0,
  updated_at      timestamptz DEFAULT now(),
  PRIMARY KEY (date, campaign_id, placement)
);

CREATE INDEX IF NOT EXISTS idx_ads_placement_date
  ON ads_placement_daily (date DESC);
CREATE INDEX IF NOT EXISTS idx_ads_placement_campaign
  ON ads_placement_daily (campaign_id);
