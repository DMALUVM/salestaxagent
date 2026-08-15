-- Migration v2: SKU-level sales data
-- Run after schema.sql in Supabase SQL Editor

create table if not exists sales_by_sku (
    id              uuid primary key default uuid_generate_v4(),
    channel         text not null check (channel in ('shopify', 'amazon', 'other')),
    sku             text not null,
    asin            text,
    product_title   text,
    state_code      text not null default 'XX',
    period_start    date not null,
    period_end      date not null,
    units           integer not null default 0,
    gross_sales     numeric not null default 0,
    net_sales       numeric,
    refund_units    integer not null default 0,
    refund_sales    numeric not null default 0,
    order_count     integer,
    source          text,
    ingested_at     timestamptz not null default now(),
    constraint uq_sku_period unique (channel, sku, state_code, period_start, source)
);

create index if not exists idx_sku_channel on sales_by_sku(channel);
create index if not exists idx_sku_period on sales_by_sku(period_start);
create index if not exists idx_sku_sku on sales_by_sku(sku);
create index if not exists idx_sku_state on sales_by_sku(state_code);

alter table sales_by_sku enable row level security;
create policy "Service role full access" on sales_by_sku for all using (true) with check (true);
