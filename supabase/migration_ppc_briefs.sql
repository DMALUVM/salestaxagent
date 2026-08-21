-- PPC Command Brief — published copies.
--
-- The brief is built by Python (src/amazon_ads/export_brief.py), which is the
-- single source of truth for its content and for the grade. The dashboard,
-- however, runs on Vercel where there is no interpreter and no repo, so the
-- "Copy full AI brief" button cannot build one itself.
--
-- Rather than reimplement the builder in TypeScript — two implementations of a
-- scoring formula drift, and then the CLI and the dashboard hand the operator
-- two different grades for the same week — the agent publishes each rendered
-- brief here and the dashboard serves the newest row when it cannot reach
-- Python. The stored copy is always stamped with generated_at so a stale brief
-- announces itself instead of passing as live.
--
-- Additive only: no existing table or column is touched.

create table if not exists ppc_briefs (
  id              bigserial primary key,
  generated_at    timestamptz  not null default now(),
  as_of           date         not null,      -- last closed day covered
  window_start    date         not null,
  days            int          not null,
  score           numeric(5,1),               -- 0-100, null if nothing measurable
  letter          text,
  formula_version text         not null,
  grade           jsonb,                      -- full component breakdown
  brief_md        text         not null,      -- the brief alone
  prompt_md       text         not null,      -- wrapper + brief, paste-ready
  chars           int          not null
);

-- The dashboard only ever asks for "the newest brief for this window length".
create index if not exists ppc_briefs_recent_idx
  on ppc_briefs (days, generated_at desc);

comment on table ppc_briefs is
  'Rendered PPC Command Briefs published by `python -m src.main ppc-export --publish`. '
  'Read-only for the dashboard; the CLI is the only writer. A row is a snapshot, '
  'never edited in place — week-over-week history is the point.';

comment on column ppc_briefs.formula_version is
  'From config/ppc_brief.json. Scores from different formula versions are not comparable.';
