-- Sales Tax Compliance Agent — Intelligence Layer Schema
-- Run AFTER schema.sql in the Supabase SQL Editor.

-- ============================================================
-- NEXUS RULES (detailed, cited per-state nexus positions)
-- ============================================================
create table if not exists nexus_rules (
    id                  uuid primary key default uuid_generate_v4(),
    state_code          text not null,
    rule_type           text not null check (rule_type in (
        'physical_inventory_fba', 'physical_other', 'economic_threshold',
        'marketplace_facilitator', 'click_through', 'affiliate'
    )),
    position_summary    text not null,
    position_detail     text,
    confidence          text not null check (confidence in ('high', 'medium', 'low', 'contested')),
    conservative_position text,
    aggressive_position   text,
    effective_date      date,
    sunset_date         date,
    primary_sources     jsonb not null default '[]',
    secondary_sources   jsonb not null default '[]',
    related_ruling_ids  jsonb not null default '[]',
    notes               text,
    open_questions      text,
    last_reviewed       date not null,
    reviewed_by         text,
    is_active           boolean not null default true,
    version             integer not null default 1,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_nexus_rules_state on nexus_rules(state_code);
create index if not exists idx_nexus_rules_type on nexus_rules(rule_type);
create index if not exists idx_nexus_rules_confidence on nexus_rules(confidence);

-- ============================================================
-- FRANCHISE / ENTITY RULES (minimum taxes, foreign qualification)
-- ============================================================
create table if not exists franchise_entity_rules (
    id                  uuid primary key default uuid_generate_v4(),
    state_code          text not null,
    rule_type           text not null check (rule_type in (
        'franchise_tax', 'llc_annual_tax', 'gross_receipts_tax',
        'commercial_activity_tax', 'business_occupation_tax',
        'foreign_qualification', 'annual_report'
    )),
    trigger_description text not null,
    fba_inventory_triggers boolean not null default false,
    economic_nexus_triggers boolean not null default false,
    minimum_amount      numeric,
    exemption_threshold numeric,
    due_date_pattern    text,
    filing_required_even_if_exempt boolean not null default false,
    penalty_for_nonfiling text,
    position_summary    text not null,
    confidence          text not null check (confidence in ('high', 'medium', 'low', 'contested')),
    primary_sources     jsonb not null default '[]',
    secondary_sources   jsonb not null default '[]',
    related_ruling_ids  jsonb not null default '[]',
    notes               text,
    open_questions      text,
    last_reviewed       date not null,
    is_active           boolean not null default true,
    version             integer not null default 1,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_franchise_rules_state on franchise_entity_rules(state_code);

-- ============================================================
-- FILING RULES (detailed per-state filing requirements)
-- ============================================================
create table if not exists filing_rules (
    id                  uuid primary key default uuid_generate_v4(),
    state_code          text not null,
    default_frequency   text not null,
    frequency_assignment_method text,
    typical_due_day     integer,
    due_date_notes      text,
    zero_return_required boolean not null default true,
    zero_return_notes   text,
    prepayment_required boolean not null default false,
    prepayment_notes    text,
    discount_available  boolean not null default false,
    discount_notes      text,
    registration_url    text,
    registration_notes  text,
    primary_sources     jsonb not null default '[]',
    notes               text,
    last_reviewed       date not null,
    is_active           boolean not null default true,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_filing_rules_state on filing_rules(state_code);

-- ============================================================
-- COURT RULINGS (judicial decisions)
-- ============================================================
create table if not exists court_rulings (
    id                  uuid primary key default uuid_generate_v4(),
    case_name           text not null,
    citation            text not null,
    court               text not null,
    jurisdiction        text not null,
    decision_date       date not null,
    holding_summary     text not null,
    holding_detail      text,
    relevance_to_fba    text,
    relevance_to_remote_sellers text,
    states_affected     jsonb not null default '[]',
    tax_types_affected  jsonb not null default '[]',
    status              text not null check (status in (
        'good_law', 'limited', 'overruled', 'distinguishable',
        'appealed', 'vacated', 'superseded'
    )),
    status_notes        text,
    opinion_url         text,
    opinion_file_path   text,
    key_quotes          jsonb not null default '[]',
    dissent_summary     text,
    practical_impact    text,
    tags                jsonb not null default '[]',
    last_reviewed       date not null,
    reviewed_by         text,
    is_active           boolean not null default true,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_court_rulings_states on court_rulings using gin(states_affected);
create index if not exists idx_court_rulings_status on court_rulings(status);
create index if not exists idx_court_rulings_date on court_rulings(decision_date);

-- ============================================================
-- ADMINISTRATIVE RULINGS (agency guidance, letter rulings, FAQs)
-- ============================================================
create table if not exists admin_rulings (
    id                  uuid primary key default uuid_generate_v4(),
    title               text not null,
    document_type       text not null check (document_type in (
        'letter_ruling', 'information_bulletin', 'technical_bulletin',
        'faq', 'policy_statement', 'regulation', 'guidance',
        'taxability_matrix', 'memorandum', 'advisory_opinion'
    )),
    issuing_agency      text not null,
    jurisdiction        text not null,
    reference_number    text,
    issue_date          date,
    summary             text not null,
    detail              text,
    relevance_to_fba    text,
    relevance_to_remote_sellers text,
    states_affected     jsonb not null default '[]',
    tax_types_affected  jsonb not null default '[]',
    status              text not null check (status in (
        'current', 'superseded', 'withdrawn', 'expired', 'under_review'
    )),
    status_notes        text,
    document_url        text,
    document_file_path  text,
    practical_impact    text,
    tags                jsonb not null default '[]',
    last_reviewed       date not null,
    reviewed_by         text,
    is_active           boolean not null default true,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_admin_rulings_states on admin_rulings using gin(states_affected);
create index if not exists idx_admin_rulings_type on admin_rulings(document_type);

-- ============================================================
-- SOURCE DOCUMENTS (provenance tracking)
-- ============================================================
create table if not exists source_documents (
    id                  uuid primary key default uuid_generate_v4(),
    title               text not null,
    url                 text,
    file_path           text,
    jurisdiction        text,
    document_type       text not null check (document_type in (
        'statute', 'regulation', 'court_opinion', 'admin_ruling',
        'dor_guidance', 'faq', 'taxability_matrix', 'article',
        'analysis', 'news', 'other'
    )),
    publisher           text,
    publish_date        date,
    retrieved_at        timestamptz not null default now(),
    content_hash        text,
    content_version     text,
    extraction_status   text default 'pending' check (extraction_status in (
        'pending', 'extracted', 'reviewed', 'failed', 'skipped'
    )),
    extracted_data      jsonb,
    review_notes        text,
    is_primary_source   boolean not null default false,
    tags                jsonb not null default '[]',
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_source_docs_jurisdiction on source_documents(jurisdiction);
create index if not exists idx_source_docs_type on source_documents(document_type);

-- ============================================================
-- SOURCE REGISTRY (curated official URLs to monitor)
-- ============================================================
create table if not exists source_registry (
    id                  uuid primary key default uuid_generate_v4(),
    state_code          text not null,
    source_type         text not null check (source_type in (
        'dor_remote_seller', 'dor_economic_nexus', 'dor_marketplace',
        'dor_registration', 'statute', 'regulation', 'sst_matrix',
        'franchise_tax', 'court_opinions', 'other'
    )),
    title               text not null,
    url                 text not null,
    is_primary          boolean not null default true,
    check_frequency     text not null default 'monthly' check (check_frequency in (
        'weekly', 'biweekly', 'monthly', 'quarterly'
    )),
    last_checked        timestamptz,
    last_content_hash   text,
    last_change_detected timestamptz,
    is_active           boolean not null default true,
    notes               text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_source_registry_state on source_registry(state_code);

-- ============================================================
-- MONITORING CHECKS (change detection log)
-- ============================================================
create table if not exists monitoring_checks (
    id                  uuid primary key default uuid_generate_v4(),
    source_registry_id  uuid references source_registry(id),
    url                 text not null,
    state_code          text,
    check_type          text not null check (check_type in (
        'hash_check', 'content_diff', 'rss_feed', 'search_alert', 'manual'
    )),
    previous_hash       text,
    current_hash        text,
    change_detected     boolean not null default false,
    change_summary      text,
    raw_diff            text,
    requires_review     boolean not null default false,
    reviewed            boolean not null default false,
    review_notes        text,
    checked_at          timestamptz not null default now()
);

create index if not exists idx_monitoring_checks_source on monitoring_checks(source_registry_id);
create index if not exists idx_monitoring_checks_change on monitoring_checks(change_detected);

-- ============================================================
-- RULE CHANGELOG (versioned audit trail for rule changes)
-- ============================================================
create table if not exists rule_changelog (
    id                  uuid primary key default uuid_generate_v4(),
    entity_type         text not null check (entity_type in (
        'nexus_rule', 'franchise_rule', 'filing_rule',
        'court_ruling', 'admin_ruling', 'state_rule'
    )),
    entity_id           uuid not null,
    state_code          text,
    change_type         text not null check (change_type in (
        'created', 'updated', 'deactivated', 'reactivated',
        'confidence_changed', 'source_added', 'reviewed'
    )),
    field_changed       text,
    old_value           text,
    new_value           text,
    change_reason       text not null,
    triggered_by        text not null check (triggered_by in (
        'initial_seed', 'manual_update', 'monitoring_alert',
        'document_extraction', 'cpa_review', 'court_decision',
        'legislative_change'
    )),
    changed_by          text not null default 'system',
    created_at          timestamptz not null default now()
);

create index if not exists idx_changelog_entity on rule_changelog(entity_type, entity_id);
create index if not exists idx_changelog_state on rule_changelog(state_code);
create index if not exists idx_changelog_created on rule_changelog(created_at);

-- ============================================================
-- RESEARCH TASKS (flagged items needing human review)
-- ============================================================
create table if not exists research_tasks (
    id                  uuid primary key default uuid_generate_v4(),
    title               text not null,
    description         text not null,
    state_code          text,
    priority            text not null default 'medium' check (priority in (
        'critical', 'high', 'medium', 'low'
    )),
    task_type           text not null check (task_type in (
        'verify_rule', 'review_ruling', 'check_threshold_change',
        'review_source_change', 'research_new_law', 'cpa_consultation',
        'document_extraction', 'other'
    )),
    source_reference    text,
    status              text not null default 'open' check (status in (
        'open', 'in_progress', 'completed', 'deferred', 'dismissed'
    )),
    resolution_notes    text,
    due_date            date,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_research_tasks_status on research_tasks(status);
create index if not exists idx_research_tasks_priority on research_tasks(priority);

-- ============================================================
-- TRIGGERS
-- ============================================================
create trigger trg_nexus_rules_updated before update on nexus_rules
    for each row execute function update_updated_at();
create trigger trg_franchise_entity_rules_updated before update on franchise_entity_rules
    for each row execute function update_updated_at();
create trigger trg_filing_rules_updated before update on filing_rules
    for each row execute function update_updated_at();
create trigger trg_court_rulings_updated before update on court_rulings
    for each row execute function update_updated_at();
create trigger trg_admin_rulings_updated before update on admin_rulings
    for each row execute function update_updated_at();
create trigger trg_source_documents_updated before update on source_documents
    for each row execute function update_updated_at();
create trigger trg_source_registry_updated before update on source_registry
    for each row execute function update_updated_at();
create trigger trg_research_tasks_updated before update on research_tasks
    for each row execute function update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table nexus_rules enable row level security;
alter table franchise_entity_rules enable row level security;
alter table filing_rules enable row level security;
alter table court_rulings enable row level security;
alter table admin_rulings enable row level security;
alter table source_documents enable row level security;
alter table source_registry enable row level security;
alter table monitoring_checks enable row level security;
alter table rule_changelog enable row level security;
alter table research_tasks enable row level security;

create policy "Service role full access" on nexus_rules for all using (true) with check (true);
create policy "Service role full access" on franchise_entity_rules for all using (true) with check (true);
create policy "Service role full access" on filing_rules for all using (true) with check (true);
create policy "Service role full access" on court_rulings for all using (true) with check (true);
create policy "Service role full access" on admin_rulings for all using (true) with check (true);
create policy "Service role full access" on source_documents for all using (true) with check (true);
create policy "Service role full access" on source_registry for all using (true) with check (true);
create policy "Service role full access" on monitoring_checks for all using (true) with check (true);
create policy "Service role full access" on rule_changelog for all using (true) with check (true);
create policy "Service role full access" on research_tasks for all using (true) with check (true);
