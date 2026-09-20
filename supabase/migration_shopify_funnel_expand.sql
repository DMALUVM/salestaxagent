-- Shopper-funnel EXPAND (follow-up to migration_shopify_funnel.sql).
-- Additive. Does not change Pulse sales, nexus, or P&L.
--
-- LIVE TOKEN (shop b7905e-3 custom app "Sales Tax Agent", 2026-09-20 probe):
--   HAS:  read_all_orders, read_draft_orders, read_orders, read_products
--   WORKS: abandonedCheckouts (GraphQL)
--   DENIED: shopifyqlQuery — Dave must grant read_reports + Protected
--           customer data Level 2 in the Admin UI. Do not invent sessions.
--
-- FRICTION (Admin GraphQL AbandonedCheckout, 2025-10):
--   Exposed: shippingAddress (null = not started), billingAddress,
--            discountCodes, totalDiscountSet, completedAt (recovery).
--   NOT exposed: shippingLine / shipping rate, payment attempt.
--   Those two columns stay NULL. We do not scrape Admin UI or use REST
--   shipping_lines to fake them. No abandonedCheckoutUrl, no address PII.
--
-- PRODUCT / KIT LEAK
--   ShopifyQL `sessions` has no product-handle closed funnel.
--   Kit vs stick is derived from abandoned line-item title/handle tokens.
--   Labeled as abandon mix, not invented ATC→checkout session counts.
--
-- CHANNEL
--   Cheap when read_reports lands: FROM sessions GROUP BY referring_channel
--   stored as shopify_funnel_daily.split_kind = 'channel'.
--
-- KLAVIYO
--   klaviyo_abandon_flow_daily is a read-only stub. Seeded from Kit's
--   2026-09-19 flow report. Do not call Klaviyo from this job.
--   Kit refresh (not Mini): get_flow_report
--     filters contains-any(flow_id,[WcDdsx,SQa2Yy]),
--     conversion_metric_id UG4R5c, flow_aggregation rows.
--
-- Phase 2 connectors are out of this migration.

alter table shopify_abandoned_checkouts
  add column if not exists shipping_address_started boolean,
  add column if not exists billing_address_started boolean,
  add column if not exists has_discount boolean,
  add column if not exists discount_codes text[] not null default '{}',
  add column if not exists discount_amount numeric(12,2),
  add column if not exists has_shipping_rate boolean,
  add column if not exists payment_attempted boolean,
  add column if not exists recovery_status text;

comment on column shopify_abandoned_checkouts.shipping_address_started is
  'True when Admin returned a shippingAddress object. Address fields are not stored.';
comment on column shopify_abandoned_checkouts.billing_address_started is
  'True when Admin returned a billingAddress object. Address fields are not stored.';
comment on column shopify_abandoned_checkouts.has_discount is
  'True when discountCodes is non-empty or totalDiscountSet > 0.';
comment on column shopify_abandoned_checkouts.has_shipping_rate is
  'Always null: AbandonedCheckout GraphQL has no shippingLine (2025-10).';
comment on column shopify_abandoned_checkouts.payment_attempted is
  'Always null: AbandonedCheckout GraphQL has no payment-attempt field.';
comment on column shopify_abandoned_checkouts.recovery_status is
  'recovered when completedAt is set, else open. Admin recovery_state filter.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'shopify_abandoned_recovery_chk'
  ) then
    alter table shopify_abandoned_checkouts
      add constraint shopify_abandoned_recovery_chk
      check (recovery_status is null
             or recovery_status in ('open', 'recovered'));
  end if;
end $$;


create table if not exists klaviyo_abandon_flow_daily (
  as_of                  date        not null,
  window_days            integer     not null,
  flow_id                text        not null,
  flow_name              text,
  trigger_metric         text,
  conversion_metric_id   text,
  conversion_metric_name text,
  recipients             integer,
  unique_conversions     integer,
  conversion_rate        numeric(8,4),
  revenue                numeric(12,2),
  rpr                    numeric(12,4),
  unique_clicks          integer,
  source                 text        not null default 'kit_seed',
  notes                  text,
  fetched_at             timestamptz not null default now(),
  primary key (as_of, window_days, flow_id),
  constraint klaviyo_abandon_window_chk check (window_days in (30, 90))
);

comment on table klaviyo_abandon_flow_daily is
  'Read-only Klaviyo abandoned-cart / checkout flow metrics. Seeded from Kit. '
  'This job never writes to Klaviyo. Kit can refresh rows later.';

-- Kit Email Phase-1 facts (2026-09-19). Conversion metric Placed Order UG4R5c.
insert into klaviyo_abandon_flow_daily (
  as_of, window_days, flow_id, flow_name, trigger_metric,
  conversion_metric_id, conversion_metric_name,
  recipients, unique_conversions, conversion_rate, revenue, rpr,
  unique_clicks, source, notes
) values
  ('2026-09-19', 90, 'WcDdsx', 'Abandoned Checkout', 'Checkout Started VRtFX4',
   'UG4R5c', 'Placed Order', 282, 4, 0.0143, 180.03, 0.64, null,
   'kit_seed', 'Checkout Email 3 W3nGKK (10% off) = $125.98 of this recovery'),
  ('2026-09-19', 90, 'SQa2Yy', 'Abandoned Cart', 'Added to Cart VLb9JV',
   'UG4R5c', 'Placed Order', 112, 1, 0.0089, 20.81, 0.19, null,
   'kit_seed', null),
  ('2026-09-19', 30, 'WcDdsx', 'Abandoned Checkout', 'Checkout Started VRtFX4',
   'UG4R5c', 'Placed Order', 103, null, 0.0098, 32.55, null, 0,
   'kit_seed', 'unique clicks 0 — flag only; opens still happen'),
  ('2026-09-19', 30, 'SQa2Yy', 'Abandoned Cart', 'Added to Cart VLb9JV',
   'UG4R5c', 'Placed Order', 44, null, 0.0227, 20.81, null, 0,
   'kit_seed', 'unique clicks 0 — flag only; opens still happen')
on conflict (as_of, window_days, flow_id) do nothing;

alter table klaviyo_abandon_flow_daily enable row level security;
-- no permissive policies. service_role (Mini + dashboard API) bypasses RLS.
