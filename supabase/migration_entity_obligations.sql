-- ============================================================
-- ENTITY & REMOTE-SELLER COMPLIANCE OBLIGATIONS
--
-- Deliberately a separate table from filing_calendar. These are entity-level
-- filings and fees (secretary-of-state annual reports, franchise/privilege
-- taxes, foreign-qualification certificates, Hawaii's G-49 annual GET return)
-- — NOT sales-tax remittance. Keeping them apart is what stops a $300 annual
-- report rendering as an overdue sales-tax return.
--
-- The row stores the USER'S DECISION (status/notes) and a snapshot of what was
-- computed. Due dates are recomputed from config/seed_entity_obligations.json
-- + config/entity_profile.json on every run, so the rule stays the source of
-- truth and a stale stored date can never outlive a corrected rule.
--
-- Run this in the Supabase SQL editor.
-- ============================================================

create table if not exists compliance_obligations (
    id                  uuid primary key default uuid_generate_v4(),

    state_code          text not null,
    -- entity_annual | franchise_tax | foreign_llc_report | get_excise | other_local
    -- Never 'sales_tax_return' — that lives in filing_calendar.
    obligation_type     text not null check (obligation_type in (
                            'entity_annual', 'franchise_tax', 'foreign_llc_report',
                            'get_excise', 'other_local')),
    form_code           text,
    title               text,

    frequency           text not null default 'annual',
    period_label        text not null,
    -- Nullable on purpose: an obligation whose due date depends on a profile
    -- date the user has not supplied (Oklahoma's anniversary) is tracked with
    -- a null date rather than a guessed one.
    due_date            date,
    due_rule_text       text,

    status              text not null default 'open' check (status in (
                            'open', 'filed', 'not_required', 'dismissed')),
    confidence          text check (confidence in ('high', 'medium', 'low')),

    source_authority    text,
    source_citation     text,
    source_url          text,

    amount_estimate     numeric,
    notes               text,
    user_notes          text,
    filed_date          date,
    last_reviewed       date,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),

    constraint uq_compliance_obligation
        unique (state_code, obligation_type, period_label)
);

create index if not exists idx_compliance_due
    on compliance_obligations(due_date);
create index if not exists idx_compliance_status
    on compliance_obligations(status);
create index if not exists idx_compliance_state
    on compliance_obligations(state_code);

comment on table compliance_obligations is
    'Entity-level and remote-seller obligations that are NOT sales-tax remittance. Monitoring aid only, not legal or tax advice. Sales-tax returns live in filing_calendar.';
