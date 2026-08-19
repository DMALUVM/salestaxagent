-- Allow SP-API ingestion rows in the audit log.
--
-- ingestion_log.file_type carries a CHECK constraint that predates the SP-API
-- integration, so every scheduled `spapi_refresh` run tried to write
-- file_type='amazon_spapi' and got rejected with:
--
--   new row for relation "ingestion_log" violates check constraint
--   "ingestion_log_file_type_check"
--
-- src/db.py:log_ingestion() now swallows that failure so it can never abort the
-- sync mid-run, but the audit rows are still being dropped. Run this once in
-- the Supabase SQL editor to record them properly.
--
-- Safe to re-run: the constraint is dropped IF EXISTS before being recreated.

ALTER TABLE ingestion_log
    DROP CONSTRAINT IF EXISTS ingestion_log_file_type_check;

ALTER TABLE ingestion_log
    ADD CONSTRAINT ingestion_log_file_type_check
    CHECK (file_type IN (
        'amazon_inventory',
        'amazon_sales',
        'amazon_spapi',
        'amazon_ads',
        'shopify_orders',
        'shopify_api',
        'registrations',
        'other'
    ));
