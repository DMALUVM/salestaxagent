-- Allow reimbursements + ledger-adjustments rows in ingestion_log.
--
-- fetch_reimbursements writes file_type='amazon_reimbursements' and
-- fetch_ledger_adjustments writes 'amazon_ledger_adjustments'. Both were
-- rejected by ingestion_log_file_type_check (2026-09-19 ~10:08/10:12Z):
--
--   new row for relation "ingestion_log" violates check constraint
--   "ingestion_log_file_type_check"
--
-- log_ingestion() already swallows the failure so sync continues; this
-- restores the audit trail. Safe to re-run: drop IF EXISTS then recreate.

ALTER TABLE ingestion_log
    DROP CONSTRAINT IF EXISTS ingestion_log_file_type_check;

ALTER TABLE ingestion_log
    ADD CONSTRAINT ingestion_log_file_type_check
    CHECK (file_type IN (
        'amazon_inventory',
        'amazon_sales',
        'amazon_spapi',
        'amazon_ads',
        'amazon_reimbursements',
        'amazon_ledger_adjustments',
        'shopify_orders',
        'shopify_api',
        'registrations',
        'other'
    ));
