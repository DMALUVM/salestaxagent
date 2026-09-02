-- ============================================================
-- RLS lockdown — deny-by-default for anon / authenticated
-- ============================================================
-- INTENT (read before applying in production):
--   * Enable RLS on every public table that may still lack it.
--   * DROP policies named like 'Service role full access' that use
--     USING (true) / WITH CHECK (true). Those policies apply to ALL roles
--     (including anon), so they effectively disable RLS.
--   * Do NOT create replacement policies for anon or authenticated.
--     With RLS enabled and no permissive policies, those roles see nothing.
--   * The Postgres/Supabase **service_role** bypasses RLS entirely — the
--     Python agent and dashboard server routes that use SUPABASE_SERVICE_KEY
--     continue to work without any policy.
--
-- Apply manually in the Supabase SQL editor after confirming service-role
-- credentials are set on Vercel + the Mac Mini worker. Do not run from CI
-- without a human gate.
-- ============================================================

DO $$
DECLARE
  r record;
BEGIN
  -- 1) Drop known-bad "Service role full access" policies on any table.
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname = 'Service role full access'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      r.policyname, r.schemaname, r.tablename
    );
    RAISE NOTICE 'Dropped policy "%" on %.%', r.policyname, r.schemaname, r.tablename;
  END LOOP;

  -- 2) Enable RLS on every ordinary public table (skip views).
  FOR r IN
    SELECT c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'  -- ordinary tables only
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
    RAISE NOTICE 'Enabled RLS on public.%', r.tablename;
  END LOOP;

  -- 3) Force RLS even for table owners (optional hardening). service_role
  --    still bypasses because it is a Supabase superuser-style role.
  FOR r IN
    SELECT c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.tablename);
    RAISE NOTICE 'Forced RLS on public.%', r.tablename;
  END LOOP;
END $$;

-- Explicit enable for tables that historically shipped with the bad policy
-- (idempotent — safe if already enabled above).
ALTER TABLE IF EXISTS public.state_rules              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.inventory_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sales_by_state           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.nexus_status             ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.filing_calendar          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.franchise_tax_flags      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.alerts                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.audit_log                ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ingestion_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.nexus_rules              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.franchise_entity_rules   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.filing_rules             ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.court_rulings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.admin_rulings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.source_documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.source_registry          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.monitoring_checks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rule_changelog           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.research_tasks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.agent_jobs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sales_by_sku             ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ads_campaigns_daily      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ads_search_terms_daily   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ads_recommendations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.filing_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.job_runs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.shopify_orders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.inventory_snapshots      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.pnl_daily                ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sku_costs                ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sqp_weekly               ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.fba_returns              ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sns_seller_metrics       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sns_offer_metrics        ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.amazon_sales_traffic     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.amazon_asin_traffic      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.fba_reimbursements       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.forecast_weekly          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ppc_briefs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.compliance_obligations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.keyword_organic_rank     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ads_strategy_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ads_placement_daily      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ads_action_decisions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ads_action_outcomes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.tpl_cost_monthly         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.tpl_cost_fees            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.tpl_cost_detail          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.inventory_sku_flags      ENABLE ROW LEVEL SECURITY;

-- No CREATE POLICY for anon / authenticated on purpose.
-- Deny-by-default: RLS on + zero permissive policies = no access for those roles.
-- service_role bypasses RLS and continues to serve the agent + dashboard APIs.
