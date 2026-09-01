-- Daily Amazon destination (ship-to) sales.
--
-- Why this exists: sales_by_state is monthly, unique on
-- (state_code, channel, period_start, period_end). Nightly SP-API orders
-- used to aggregate a ~7 day lookback into that monthly key and REPLACE
-- the whole current month. Persist days here, then rebuild the month
-- from ALL stored dest-daily rows. Closed months are not rewritten.
-- Shopify is never written to this table.
--
-- Run in the Supabase SQL editor. Safe to re-run.

create table if not exists sales_by_state_daily (
    id              uuid primary key default uuid_generate_v4(),
    state_code      text not null,
    channel         text not null check (channel in (
                        'shopify', 'shopify_shop', 'shopify_sub', 'amazon', 'other'
                    )),
    sale_date       date not null,
    order_count     integer not null default 0,
    gross_sales     numeric not null default 0,
    net_sales       numeric not null default 0,
    tax_collected   numeric not null default 0,
    source          text,
    ingested_at     timestamptz not null default now(),
    constraint uq_sales_by_state_daily
        unique (state_code, channel, sale_date, source)
);

create index if not exists idx_sales_by_state_daily_date
    on sales_by_state_daily (sale_date);
create index if not exists idx_sales_by_state_daily_channel_date
    on sales_by_state_daily (channel, sale_date);

alter table sales_by_state_daily enable row level security;

comment on table sales_by_state_daily is
    'Daily ship-to dest sales. Amazon SP-API lookbacks upsert days here; '
    'monthly sales_by_state is rebuilt from all stored days in the month. '
    'Tax SoT for /sales-map remains sales_by_state.';
