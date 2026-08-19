-- Forecast learning / calibration tables.
-- Run in Supabase Dashboard > SQL Editor.

-- Logged forecast runs
CREATE TABLE IF NOT EXISTS forecast_runs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  sku text NOT NULL,
  asin text,
  start_date date NOT NULL,
  end_date date NOT NULL,
  safety_pct numeric,
  expected_units numeric,
  coverage_units numeric,
  low_units numeric,
  high_units numeric,
  method_a_units numeric,
  method_b_units numeric,
  method_c_units numeric,
  primary_method text DEFAULT 'B_seasonal',
  velocity_upd numeric,
  sns_subs numeric,
  sns_shipped_wk numeric,
  return_rate numeric,
  model_version text,
  source text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_forecast_runs_sku ON forecast_runs (sku, created_at DESC);

-- Weekly predictions per run
CREATE TABLE IF NOT EXISTS forecast_run_weeks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id uuid REFERENCES forecast_runs(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  predicted_units numeric,
  method_a numeric,
  method_b numeric,
  method_c numeric,
  UNIQUE (run_id, week_start)
);

-- Actual weekly units (ground truth)
CREATE TABLE IF NOT EXISTS forecast_actuals_weekly (
  sku text NOT NULL,
  week_start date NOT NULL,
  actual_units numeric NOT NULL,
  source text DEFAULT 'amazon_spapi',
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (sku, week_start)
);

-- Per-SKU accuracy metrics (rolling windows)
CREATE TABLE IF NOT EXISTS forecast_accuracy (
  sku text NOT NULL,
  window_days integer NOT NULL,
  mape numeric,
  bias numeric,
  n_weeks integer,
  best_method text,
  method_weights jsonb,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (sku, window_days)
);

-- Calibrated model state (per-SKU or global '*')
CREATE TABLE IF NOT EXISTS forecast_model_state (
  sku text PRIMARY KEY,
  weights jsonb NOT NULL DEFAULT '{"a":0.15,"b":0.60,"c":0.25}',
  seasonal_factors jsonb,
  model_version text,
  updated_at timestamptz DEFAULT now()
);

-- Seed global default weights
INSERT INTO forecast_model_state (sku, weights, model_version)
VALUES ('*', '{"a":0.15,"b":0.60,"c":0.25}', 'default')
ON CONFLICT (sku) DO NOTHING;
