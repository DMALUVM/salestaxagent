-- Per-SKU holiday surge fields for inventory / supply-chain planning.
-- Derived from prior-year Nov–Dec vs Jun–Aug sales (sales_by_sku).

ALTER TABLE public.sku_velocity
  ADD COLUMN IF NOT EXISTS holiday_surge_mult numeric(6,3) NOT NULL DEFAULT 1.000,
  ADD COLUMN IF NOT EXISTS holiday_prior_daily numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS summer_prior_daily numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS yoy_growth_mult numeric(6,3) NOT NULL DEFAULT 1.000,
  ADD COLUMN IF NOT EXISTS planning_u_30 numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS holiday_nov_dec_units integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS holiday_prior_year integer;

COMMENT ON COLUMN public.sku_velocity.holiday_surge_mult IS
  'Prior-year Nov+Dec daily / Jun-Aug daily. >1 = holiday surge SKU.';
COMMENT ON COLUMN public.sku_velocity.planning_u_30 IS
  'Holiday-aware planning velocity (u/day). max(V30, holiday_prior_daily * yoy) when surge>1.';
