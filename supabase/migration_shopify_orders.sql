-- Per-order Shopify history, for AOV / LTV / repeat / cohort analysis.
--
-- WHY THIS EXISTS
-- Until now the Shopify pipeline fetched orders, aggregated them in memory into
-- (state, channel, month) buckets, wrote sales_by_state + sales_daily, and threw
-- the orders away. It never even ASKED the API for the customer object — the
-- `fields` list stopped at shipping_address. So there was no order-level row and
-- no customer identity anywhere in the database, and every person-level metric
-- (repeat rate, LTV, cohorts) was unanswerable rather than merely unbuilt.
--
-- This table is additive. Nothing reads it for tax, nexus or liability, and the
-- existing aggregates are untouched — sales_by_state remains the tax source of
-- truth. Treat this as an analytics side-table.
--
-- PII POSTURE
-- Raw email is NOT stored by default. Every metric here needs a stable identity,
-- not a contactable one: `customer_id` alone answers repeat/LTV/cohort. What is
-- stored is `email_hash` = sha256(lower(trim(email))), which stitches guest
-- checkouts belonging to the same person without holding an address book.
-- `shopify-backfill --with-email` will populate `email` if the operator decides
-- they need it; the column exists so that choice does not require a migration.
--
-- IDENTITY, AND WHY customer_key EXISTS
-- Shopify orders can arrive with no customer_id (guest checkout). Dropping those
-- would understate AOV; bucketing them together under NULL would invent a single
-- customer with thousands of orders and destroy the repeat rate. customer_key
-- degrades in three steps, most reliable first:
--     c:<customer_id>   a real Shopify customer
--     h:<email_hash>    guest checkouts sharing an email
--     o:<order_id>      neither — counts once, can never be "repeat"
-- The fallback is deliberately unique per order so an unidentifiable buyer is
-- always a one-order customer rather than a phantom loyal one.

create table if not exists shopify_orders (
  order_id         bigint       primary key,   -- Shopify's id; stable forever
  order_name       text,                       -- "#14923"
  created_at       timestamptz  not null,
  processed_at     timestamptz,
  -- Calendar day in America/New_York (config/business_rules.json →
  -- shopify.timezone), matching how sales_daily buckets Shopify days. Amazon
  -- stays on America/Los_Angeles; the two are different rules on purpose.
  order_date       date         not null,

  customer_id      bigint,                     -- null on guest checkout
  email_hash       text,                       -- sha256(lower(trim(email)))
  email            text,                       -- only with --with-email
  customer_key     text         not null,      -- see note above

  currency         text,
  -- subtotal_price = line items after discounts, BEFORE tax and shipping. This
  -- is the same figure the existing pipeline writes as sales_by_state.gross_sales,
  -- so revenue here reconciles with the tax aggregates rather than competing.
  subtotal_price   numeric(12,2),
  total_price      numeric(12,2),
  total_discounts  numeric(12,2),
  total_tax        numeric(12,2),
  refunded_amount  numeric(12,2) default 0,

  financial_status text,
  cancelled_at     timestamptz,
  is_test          boolean      default false,

  source_name      text,                       -- "web", app id, "shopify_draft_order"
  channel          text,                       -- src/channels.classify_shopify_order
  state_code       text,
  country_code     text,

  first_seen_at    timestamptz  default now(),
  updated_at       timestamptz  default now()
);

-- LTV and repeat scan by customer; cohorts and AOV scan by date.
create index if not exists shopify_orders_customer_idx on shopify_orders (customer_key);
create index if not exists shopify_orders_date_idx     on shopify_orders (order_date);
create index if not exists shopify_orders_customer_date_idx
  on shopify_orders (customer_key, order_date);

comment on table shopify_orders is
  'Per-order Shopify history for AOV/LTV/repeat/cohort. Analytics only — never '
  'feeds nexus, liability or filing. sales_by_state remains the tax source of truth.';

comment on column shopify_orders.customer_key is
  'Stable identity: c:<customer_id> > h:<email_hash> > o:<order_id>. The last '
  'fallback is unique per order so an unidentifiable buyer counts once and can '
  'never appear as a repeat customer.';

comment on column shopify_orders.subtotal_price is
  'After discounts, before tax and shipping. Same basis as sales_by_state.gross_sales.';

comment on column shopify_orders.refunded_amount is
  'Sum of refund transaction amounts. MAY include refunded tax, so net revenue '
  'derived from it is a slight under-estimate. Stated rather than hidden.';

comment on column shopify_orders.email is
  'Empty unless the backfill was run with --with-email. Metrics never read it.';
