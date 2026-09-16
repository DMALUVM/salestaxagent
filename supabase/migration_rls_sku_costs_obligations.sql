-- ============================================================
-- Remaining RLS lockdown — sku_costs + compliance_obligations
-- ============================================================
-- INTENT:
--   The prior ops-table lockdown already ENABLE ROW LEVEL SECURITY on the
--   ~56 service-role-only tables (ads, inventory, reimbursements, SoldScope,
--   sales_daily, …). Do not DISABLE RLS on those tables here.
--
--   After Tax / Overview / Calendar / Compliance / Registrations (and the
--   remaining sku_costs / compliance_obligations writers) moved onto
--   dashboard API routes that use SUPABASE_SERVICE_KEY, these two tables
--   no longer need anon access.
--
--   Enable RLS with no anon / authenticated / public policies. service_role
--   bypasses RLS and continues to serve the Python agent + dashboard APIs.
--
-- Apply in the Supabase SQL editor after the dashboard routes are deployed.
-- Do not run from CI without a human gate.
--
-- Rollback (these two tables only):
--   ALTER TABLE public.sku_costs DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.compliance_obligations DISABLE ROW LEVEL SECURITY;
-- ============================================================

DROP POLICY IF EXISTS "Service role full access" ON public.sku_costs;
DROP POLICY IF EXISTS "Service role full access" ON public.compliance_obligations;

ALTER TABLE public.sku_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_obligations ENABLE ROW LEVEL SECURITY;

-- No CREATE POLICY for anon / authenticated / public on purpose.
-- Deny-by-default: RLS on + zero permissive policies = no access for those roles.
