-- Allow ledger-summary + SQP audit rows in ingestion_log.
--
-- fetch_ledger_summary writes file_type='amazon_ledger_summary'
-- (src/amazon_sp/ledger_summary.py). SQP sync writes 'brand_analytics_sqp'
-- (src/main.py). Both were rejected by ingestion_log_file_type_check —
-- same class of bug as amazon_reimbursements (#146).
--
-- log_ingestion() already swallows the failure so sync continues; this
-- restores the audit trail. Safe to re-run: drop IF EXISTS then recreate.
-- Applied live 2026-09-19 via Supabase MCP
-- (ingestion_log_allow_ledger_summary_and_sqp).

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
        'amazon_ledger_summary',
        'brand_analytics_sqp',
        'shopify_orders',
        'shopify_api',
        'registrations',
        'other'
    ));
