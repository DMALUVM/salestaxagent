-- ============================================================
-- SALES_DAILY PROVENANCE + COMPLETENESS
--
-- Why this exists: sales_daily had an `updated_at` column with NO trigger, so
-- it never moved on UPDATE. Every row in an affected range carried an
-- identical, stale timestamp, which meant there was no way to tell which job
-- last wrote a day — and therefore no way to diagnose why specific days kept
-- regressing after being fixed.
--
-- These columns record who wrote each day and whether the day was closed at
-- the time. The monotonic write guard in src/sales_guard.py is what PREVENTS
-- the regression; this is what makes the next incident explainable.
--
-- Run in the Supabase SQL editor. Safe to re-run.
-- ============================================================

alter table sales_daily
    add column if not exists written_by      text,
    add column if not exists last_written_at timestamptz,
    -- false while the day is still in progress. The Pulse UI must not present
    -- an incomplete day as a final figure.
    add column if not exists is_complete     boolean default true;

create index if not exists idx_sales_daily_written_at
    on sales_daily(last_written_at);

-- Make updated_at mean something. Without this it stays at insert time forever.
create or replace function set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_sales_daily_updated_at on sales_daily;
create trigger trg_sales_daily_updated_at
    before update on sales_daily
    for each row execute function set_updated_at();

comment on column sales_daily.written_by is
    'Job that last wrote this row (sync_amazon_daily, sync_shopify_daily, ...).';
comment on column sales_daily.is_complete is
    'False while the sale_date is still in progress. Partial days are not final.';
