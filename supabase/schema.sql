-- Sales Tax Compliance Agent — Supabase Schema
-- Run this in the Supabase SQL Editor to create all required tables.

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ============================================================
-- STATE RULES (reference data, seeded from config/state_rules.json)
-- ============================================================
create table if not exists state_rules (
    state_code          text primary key,
    state_name          text not null,
    has_sales_tax       boolean not null default true,
    economic_threshold_amount       numeric,
    economic_threshold_transactions integer,
    threshold_test_type             text not null default 'or' check (threshold_test_type in ('or', 'and')),
    economic_threshold_period       text,
    fba_inventory_creates_nexus     text not null default 'unknown_default_true',
    marketplace_sales_count_toward_threshold boolean not null default false,
    filing_frequency_default        text,
    typical_due_day                 integer,
    franchise_tax_notes             text,
    notes               text,
    last_reviewed       date,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- ============================================================
-- INVENTORY EVENTS (parsed from Amazon reports)
-- ============================================================
create table if not exists inventory_events (
    id                  uuid primary key default uuid_generate_v4(),
    source_file         text not null,
    event_date          date not null,
    fc_code             text not null,
    state_code          text,
    asin                text,
    sku                 text,
    fnsku               text,
    quantity            integer not null default 0,
    event_type          text,
    disposition         text,
    raw_data            jsonb,
    ingested_at         timestamptz not null default now(),
    constraint uq_inventory_event unique (source_file, event_date, fc_code, asin, event_type, quantity)
);

create index if not exists idx_inventory_events_state on inventory_events(state_code);
create index if not exists idx_inventory_events_date on inventory_events(event_date);
create index if not exists idx_inventory_events_fc on inventory_events(fc_code);

-- ============================================================
-- SALES BY STATE (aggregated from Shopify + Amazon)
-- ============================================================
create table if not exists sales_by_state (
    id                  uuid primary key default uuid_generate_v4(),
    state_code          text not null,
    channel             text not null check (channel in ('shopify', 'amazon', 'other')),
    period_start        date not null,
    period_end          date not null,
    order_count         integer not null default 0,
    gross_sales         numeric not null default 0,
    net_sales           numeric not null default 0,
    tax_collected       numeric not null default 0,
    source              text,
    ingested_at         timestamptz not null default now(),
    constraint uq_sales_period unique (state_code, channel, period_start, period_end)
);

create index if not exists idx_sales_state on sales_by_state(state_code);
create index if not exists idx_sales_period on sales_by_state(period_start, period_end);

-- ============================================================
-- NEXUS STATUS (current determination per state)
-- ============================================================
create table if not exists nexus_status (
    state_code          text primary key,
    has_physical_nexus  boolean not null default false,
    physical_nexus_since date,
    physical_nexus_source text,
    has_economic_nexus  boolean not null default false,
    economic_nexus_since date,
    economic_progress_amount numeric not null default 0,
    economic_progress_transactions integer not null default 0,
    economic_progress_percent numeric not null default 0,
    is_registered       boolean not null default false,
    registration_date   date,
    assigned_frequency  text,
    last_filed_through  text,
    requires_action     boolean not null default false,
    action_notes        text,
    confidence          text check (confidence in ('high', 'medium', 'low')),
    last_evaluated      timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- ============================================================
-- FILING CALENDAR (per-state filing obligations)
-- ============================================================
create table if not exists filing_calendar (
    id                  uuid primary key default uuid_generate_v4(),
    state_code          text not null,
    period_type         text not null check (period_type in ('monthly', 'quarterly', 'semi_annual', 'annual')),
    period_label        text not null,
    period_start        date not null,
    period_end          date not null,
    due_date            date not null,
    status              text not null default 'pending' check (status in ('pending', 'filed', 'late', 'not_required')),
    filed_date          date,
    filed_amount        numeric,
    filed_notes         text,
    is_zero_return      boolean not null default false,
    reminder_sent       boolean not null default false,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    constraint uq_filing unique (state_code, period_type, period_label)
);

create index if not exists idx_filing_due on filing_calendar(due_date);
create index if not exists idx_filing_status on filing_calendar(status);

-- ============================================================
-- FRANCHISE TAX FLAGS (entity-level obligations separate from sales tax)
-- ============================================================
create table if not exists franchise_tax_flags (
    id                  uuid primary key default uuid_generate_v4(),
    state_code          text not null,
    flag_type           text not null,
    description         text not null,
    severity            text not null check (severity in ('critical', 'warning', 'info')),
    trigger_reason      text not null,
    recommended_action  text,
    due_date            date,
    status              text not null default 'open' check (status in ('open', 'acknowledged', 'resolved', 'dismissed')),
    resolved_notes      text,
    confidence          text check (confidence in ('high', 'medium', 'low')),
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

-- ============================================================
-- ALERTS (sent notifications log)
-- ============================================================
create table if not exists alerts (
    id                  uuid primary key default uuid_generate_v4(),
    alert_type          text not null,
    channel             text not null check (channel in ('telegram', 'email', 'cli')),
    subject             text not null,
    body                text not null,
    state_code          text,
    severity            text check (severity in ('critical', 'warning', 'info')),
    sent_at             timestamptz not null default now(),
    delivered           boolean not null default true,
    error_message       text
);

create index if not exists idx_alerts_type on alerts(alert_type);
create index if not exists idx_alerts_sent on alerts(sent_at);

-- ============================================================
-- AUDIT LOG (all system actions for traceability)
-- ============================================================
create table if not exists audit_log (
    id                  uuid primary key default uuid_generate_v4(),
    action              text not null,
    category            text not null,
    details             jsonb,
    source_file         text,
    rows_affected       integer,
    state_code          text,
    created_at          timestamptz not null default now()
);

create index if not exists idx_audit_action on audit_log(action);
create index if not exists idx_audit_created on audit_log(created_at);

-- ============================================================
-- INGESTION LOG (track every file processed)
-- ============================================================
create table if not exists ingestion_log (
    id                  uuid primary key default uuid_generate_v4(),
    filename            text not null,
    file_type           text not null check (file_type in ('amazon_inventory', 'amazon_sales', 'shopify_orders', 'shopify_api', 'registrations', 'other')),
    file_hash           text,
    rows_total          integer not null default 0,
    rows_inserted       integer not null default 0,
    rows_skipped        integer not null default 0,
    warnings            jsonb,
    status              text not null default 'success' check (status in ('success', 'partial', 'failed')),
    error_message       text,
    ingested_at         timestamptz not null default now()
);

-- ============================================================
-- AUTO-UPDATE timestamps trigger
-- ============================================================
create or replace function update_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger trg_state_rules_updated before update on state_rules
    for each row execute function update_updated_at();
create trigger trg_nexus_status_updated before update on nexus_status
    for each row execute function update_updated_at();
create trigger trg_filing_calendar_updated before update on filing_calendar
    for each row execute function update_updated_at();
create trigger trg_franchise_tax_updated before update on franchise_tax_flags
    for each row execute function update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY (enable but allow service role full access)
-- ============================================================
alter table state_rules enable row level security;
alter table inventory_events enable row level security;
alter table sales_by_state enable row level security;
alter table nexus_status enable row level security;
alter table filing_calendar enable row level security;
alter table franchise_tax_flags enable row level security;
alter table alerts enable row level security;
alter table audit_log enable row level security;
alter table ingestion_log enable row level security;

create policy "Service role full access" on state_rules for all using (true) with check (true);
create policy "Service role full access" on inventory_events for all using (true) with check (true);
create policy "Service role full access" on sales_by_state for all using (true) with check (true);
create policy "Service role full access" on nexus_status for all using (true) with check (true);
create policy "Service role full access" on filing_calendar for all using (true) with check (true);
create policy "Service role full access" on franchise_tax_flags for all using (true) with check (true);
create policy "Service role full access" on alerts for all using (true) with check (true);
create policy "Service role full access" on audit_log for all using (true) with check (true);
create policy "Service role full access" on ingestion_log for all using (true) with check (true);
