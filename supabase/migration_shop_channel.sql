-- Add shopify_shop channel to sales_by_state CHECK constraint.
-- shopify_shop = Shop channel orders where Shopify remits tax (since 2025-01-01).
-- Run in Supabase Dashboard > SQL Editor.

ALTER TABLE sales_by_state DROP CONSTRAINT IF EXISTS sales_by_state_channel_check;
ALTER TABLE sales_by_state ADD CONSTRAINT sales_by_state_channel_check
  CHECK (channel IN ('shopify', 'shopify_shop', 'shopify_sub', 'amazon', 'other'));
