-- Shopify shipping economics on shopify_orders.
-- Run in Supabase Dashboard > SQL Editor.
--
-- WHY
-- Free-ship threshold decisions need shipping charged vs estimated outbound
-- cost. Until now shopify_orders stored subtotal/total/tax only, so shipping
-- was inferred as total − subtotal − tax and subscriptions via source_name.
--
-- COLUMNS (no PII)
--   shipping_price     — dollars the customer was charged for shipping
--   is_subscription    — recurring / selling-plan order
--   shipping_source    — how shipping_price was produced
--
-- shipping_source values:
--   shipping_lines        — sum of Shopify shipping_lines[].price (sync truth)
--   provisional_residual  — greatest(0, total − subtotal − tax); used only
--                           for rows that have not been re-pulled yet
--
-- SUBSCRIPTION RULE (documented; applied in src/shopify_backfill.py)
--   true when any of:
--     1. source_name ILIKE '%subscription%'  (covers subscription_contract*)
--     2. tags contain "subscription" (case-insensitive)
--     3. any line_item has selling_plan_allocation or selling_plan_id
--   The SQL backfill below can only see (1). Re-pull overwrites with the
--   full rule.
--
-- BACKFILL COVERAGE
--   This UPDATE marks EVERY existing row as provisional_residual immediately.
--   Nightly pnl_sync re-pulls the last 90 Shopify days (America/New_York)
--   through shopify-backfill, which overwrites those rows with shipping_lines
--   + the full subscription rule. Older history stays provisional until
--   `python -m src.main shopify-backfill` (full) or `--since` for a window.
--   No new PII columns.

ALTER TABLE shopify_orders
  ADD COLUMN IF NOT EXISTS shipping_price numeric(12,2),
  ADD COLUMN IF NOT EXISTS is_subscription boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shipping_source text;

COMMENT ON COLUMN shopify_orders.shipping_price IS
  'Customer-charged shipping. Prefer sum(shipping_lines.price); '
  'provisional_residual = greatest(0, total_price − subtotal_price − total_tax) '
  'until the order is re-pulled.';

COMMENT ON COLUMN shopify_orders.is_subscription IS
  'True when source_name / tags / selling plan indicates a subscription. '
  'SQL backfill uses source_name only; sync applies the full rule.';

COMMENT ON COLUMN shopify_orders.shipping_source IS
  'shipping_lines (API sum) or provisional_residual (total − subtotal − tax).';

-- Immediate residual backfill for rows the API has not re-touched.
-- Re-pull (7d poll / 90d nightly / full shopify-backfill) overwrites these.
UPDATE shopify_orders
SET
  shipping_price = GREATEST(
    0,
    COALESCE(total_price, 0) - COALESCE(subtotal_price, 0) - COALESCE(total_tax, 0)
  ),
  is_subscription = (COALESCE(source_name, '') ILIKE '%subscription%'),
  shipping_source = 'provisional_residual'
WHERE shipping_source IS NULL;
