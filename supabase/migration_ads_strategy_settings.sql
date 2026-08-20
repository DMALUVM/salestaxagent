-- Editable PPC strategy targets.
--
-- Single-row settings document. Anything stored here is an OVERRIDE that is
-- deep-merged over config/ads_strategy.json at read time, so a key that is
-- absent (or the whole row, or the whole table) falls back to the file and
-- nothing breaks. That keeps the file as the documented default and the DB as
-- "what the operator tuned".
--
-- Scope is deliberately narrow: the settings API only accepts `roles.targets`.
-- Storing a key that no reader honours would be a silent trap, so the writer
-- rejects anything else.
--
-- Run once in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS ads_strategy_settings (
  id          text PRIMARY KEY DEFAULT 'default',
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz DEFAULT now(),
  updated_by  text
);

-- Seed the single row so writers can upsert without a race.
INSERT INTO ads_strategy_settings (id, settings)
VALUES ('default', '{}'::jsonb)
ON CONFLICT (id) DO NOTHING;
