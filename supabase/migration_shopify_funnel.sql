-- Shopper drop-off analytics for tallowbourn.com (Shopify Admin only).
--
-- WHY THIS EXISTS
-- Pulse already stores Shopify *orders*. It cannot answer "where did shoppers
-- leave before they paid" — sessions, PDP landings, add-to-cart, checkout
-- started, and abandoned checkouts never landed in the warehouse. This side-
-- table set is additive. Nothing here feeds nexus, liability, Pulse sales, or
-- contribution P&L. sales_by_state remains the tax source of truth.
--
-- SOURCE (do not invent a substitute)
--   * Daily funnel counts: Admin GraphQL `shopifyqlQuery` against the
--     ShopifyQL `sessions` schema (requires `read_reports` + Protected
--     Customer Data Level 2 on the custom app).
--   * Abandoned checkouts: Admin GraphQL `abandonedCheckouts` (requires
--     `read_orders` plus the staff permission manage_abandoned_checkouts).
--   * PDP step is `sessions` WHERE landing_page_type = 'product' — sessions
--     that LANDED on a product page, not mid-session PDP views. ShopifyQL's
--     closed funnel does not expose a first-class "viewed a PDP" count.
--     Collection → ATC is real on this store, so PDP is NOT a nested gate.
--
-- WINDOWS
-- Daily grain supports last-7d / last-28d rollups on the dashboard. Landing-
-- page splits are stored as window snapshots (7 and 28) because a daily
-- top-N would churn the key set.
--
-- PII
-- No email, no recovery URL (abandonedCheckoutUrl carries a secret token),
-- no name, no address. Line items keep title / sku / handle / amounts only.
--
-- RLS
-- Enable RLS, no anon/authenticated policies. service_role bypasses RLS
-- (Python Mini + dashboard API routes). Do not write these tables from the
-- browser anon key.

create table if not exists shopify_funnel_daily (
  metric_date        date        not null,
  -- 'all' = store-wide closed funnel. 'device' = session_device_type split.
  split_kind         text        not null default 'all',
  split_value        text        not null default '',
  sessions           integer,
  -- Sessions whose landing_page_type is product. Null = query failed / not run.
  -- Zero is a real measurement (no product-page landings that day).
  pdp_sessions       integer,
  -- ShopifyQL closed-funnel metrics. Null = not returned. Never inferred.
  add_to_cart        integer,          -- sessions_with_cart_additions
  checkout_started   integer,          -- sessions_that_reached_checkout
  purchases          integer,          -- sessions_that_completed_checkout
  source             text        not null default 'shopifyql',
  fetched_at         timestamptz not null default now(),
  primary key (metric_date, split_kind, split_value)
);

create index if not exists shopify_funnel_daily_date_idx
  on shopify_funnel_daily (metric_date);

comment on table shopify_funnel_daily is
  'Daily ShopifyQL session funnel. Analytics only — never feeds nexus or P&L.';

comment on column shopify_funnel_daily.pdp_sessions is
  'Sessions that landed on a product page (landing_page_type = product). '
  'Not a closed-funnel gate: shoppers can ATC from collections.';

comment on column shopify_funnel_daily.add_to_cart is
  'ShopifyQL sessions_with_cart_additions. Null means the query did not return it.';


create table if not exists shopify_funnel_splits (
  window_days        integer     not null,
  window_end         date        not null,
  split_kind         text        not null,   -- landing_page
  split_value        text        not null,
  sessions           integer,
  pdp_sessions       integer,
  add_to_cart        integer,
  checkout_started   integer,
  purchases          integer,
  source             text        not null default 'shopifyql',
  fetched_at         timestamptz not null default now(),
  primary key (window_days, window_end, split_kind, split_value),
  constraint shopify_funnel_splits_window_chk check (window_days in (7, 28))
);

comment on table shopify_funnel_splits is
  'ShopifyQL landing-page (and similar) window snapshots for 7d / 28d.';


create table if not exists shopify_abandoned_checkouts (
  checkout_id        text        primary key,  -- gid://shopify/AbandonedCheckout/…
  checkout_name      text,
  created_at         timestamptz not null,
  updated_at         timestamptz,
  completed_at       timestamptz,
  -- Calendar day in America/New_York (config/business_rules.json → shopify.timezone).
  checkout_date      date        not null,
  total_price        numeric(12,2),
  subtotal_price     numeric(12,2),
  currency           text,
  recovered          boolean     not null default false,
  line_items         jsonb       not null default '[]',
  line_items_qty     integer,
  -- Stub until Jev is wired. Fail closed: unknown → hold_for_review.
  -- TODO(jev): replace stub_triage_severity() with the Jev classifier after
  -- sync. Do not burn LLM prose every run. Fail closed → hold_for_review.
  triage_severity    text,
  triage_source      text        not null default 'stub',
  triage_note        text,
  synced_at          timestamptz not null default now(),
  constraint shopify_abandoned_triage_chk
    check (triage_severity is null
           or triage_severity in ('hold_for_review', 'needs_eyes', 'noise'))
);

create index if not exists shopify_abandoned_date_idx
  on shopify_abandoned_checkouts (checkout_date);
create index if not exists shopify_abandoned_recovered_idx
  on shopify_abandoned_checkouts (recovered, checkout_date);

comment on table shopify_abandoned_checkouts is
  'Abandoned + recovered Shopify checkouts from Admin GraphQL. No recovery URL, '
  'no email. Analytics only.';

comment on column shopify_abandoned_checkouts.triage_severity is
  'Stub severity until Jev is wired. hold_for_review is the fail-closed default.';


create table if not exists shopify_funnel_status (
  id                 integer     primary key default 1 check (id = 1),
  last_synced_at     timestamptz,
  funnel_ok          boolean,
  abandon_ok         boolean,
  missing_scopes     text[]      not null default '{}',
  last_error         text,
  last_stats         jsonb,
  updated_at         timestamptz not null default now()
);

comment on table shopify_funnel_status is
  'Single-row last-sync outcome for the shopper funnel. Dashboard reads this '
  'to distinguish empty warehouse vs missing Shopify scopes.';

insert into shopify_funnel_status (id)
values (1)
on conflict (id) do nothing;

alter table shopify_funnel_daily          enable row level security;
alter table shopify_funnel_splits         enable row level security;
alter table shopify_abandoned_checkouts   enable row level security;
alter table shopify_funnel_status         enable row level security;

-- Deny-by-default for anon / authenticated: no permissive policies.
-- service_role (Mini + dashboard API) bypasses RLS.
