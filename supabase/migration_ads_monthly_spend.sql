-- Monthly Amazon ad spend imported from Seller Central SKU Economics
-- or an Ads Console campaign export. Months before the Ads API 95-day
-- floor (~2026-05-21) have no ads_campaigns_daily rows; this table is
-- the override Month/Year on /profit read first.

CREATE TABLE IF NOT EXISTS ads_monthly_spend (
  period_start text NOT NULL PRIMARY KEY,
  period_end text NOT NULL,
  spend numeric NOT NULL DEFAULT 0,
  source text NOT NULL,
  filename text,
  ingested_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ads_monthly_spend IS
  'Account-level Amazon ad spend by calendar month. Imported CSVs beat ads_campaigns_daily for that month so a full-month SKU Economics file does not double-count the API days.';
