-- Holiday forecast series (weekly, per SKU, multiple scenarios).
-- Run in Supabase Dashboard > SQL Editor.

CREATE TABLE IF NOT EXISTS forecast_weekly (
    sku         text NOT NULL,
    week_start  date NOT NULL,
    scenario    text NOT NULL CHECK (scenario IN ('optimistic', 'actual_2025', 'correction_factor')),
    units       numeric(10,1) NOT NULL DEFAULT 0,
    source_file text,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sku, week_start, scenario)
);
ALTER TABLE forecast_weekly DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_forecast_sku ON forecast_weekly (sku);
