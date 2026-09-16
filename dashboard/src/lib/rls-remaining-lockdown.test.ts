/**
 * Remaining RLS lockdown: Tax / Overview / Calendar / Compliance /
 * Registrations (and related writers) must hit service-role API routes.
 * sku_costs + compliance_obligations get RLS with no anon policies.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isSafeIdent, isWarehouseTable, WAREHOUSE_TABLES } from "./warehouse-tables";

function src(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

function repo(rel: string): string {
  return readFileSync(path.join(process.cwd(), "..", rel), "utf8");
}

describe("warehouse allowlist", () => {
  test("accepts tax / sku_costs tables and rejects unknown names", () => {
    assert.equal(isWarehouseTable("nexus_status"), true);
    assert.equal(isWarehouseTable("filing_calendar"), true);
    assert.equal(isWarehouseTable("state_rules"), true);
    assert.equal(isWarehouseTable("sales_by_state"), true);
    assert.equal(isWarehouseTable("franchise_tax_flags"), true);
    assert.equal(isWarehouseTable("sku_costs"), true);
    assert.equal(isWarehouseTable("compliance_obligations"), false);
    assert.equal(isWarehouseTable("pg_stat_activity"), false);
    assert.ok(WAREHOUSE_TABLES.includes("sku_costs"));
  });

  test("safe idents reject punctuation and qualified names", () => {
    assert.equal(isSafeIdent("due_date"), true);
    assert.equal(isSafeIdent("status"), true);
    assert.equal(isSafeIdent("state_code"), true);
    assert.equal(isSafeIdent("drop table"), false);
    assert.equal(isSafeIdent("foo;bar"), false);
    assert.equal(isSafeIdent("public.nexus_status"), false);
  });
});

describe("reads go through GET /api/warehouse", () => {
  test("useSupabaseQuery fetches the service-role warehouse route", () => {
    const hook = src("src/lib/hooks.ts");
    assert.match(hook, /\/api\/warehouse/);
    assert.match(hook, /getServerSupabase|cache: "no-store"/);
    assert.doesNotMatch(hook, /from "\.\/supabase"/);
    assert.doesNotMatch(hook, /getSupabase\(\)/);
  });

  test("warehouse route uses service role and the allowlist", () => {
    const route = src("src/app/api/warehouse/route.ts");
    assert.match(route, /getServerSupabase/);
    assert.match(route, /isWarehouseTable/);
    assert.match(route, /isSafeIdent/);
    assert.doesNotMatch(route, /NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });
});

describe("tax surfaces no longer write with the browser anon client", () => {
  const pages = [
    "src/app/page.tsx",
    "src/app/calendar/page.tsx",
    "src/app/registrations/page.tsx",
    "src/app/compliance/ComplianceHub.tsx",
    "src/app/compliance/[state]/page.tsx",
    "src/app/liability/page.tsx",
    "src/app/entity/page.tsx",
    "src/components/nav.tsx",
  ];

  test("listed tax / overview / calendar / compliance / registrations pages do not import getSupabase", () => {
    for (const rel of pages) {
      const text = src(rel);
      assert.doesNotMatch(text, /getSupabase/, `${rel} still references getSupabase`);
    }
  });

  test("calendar writes go to POST /api/calendar", () => {
    const page = src("src/app/calendar/page.tsx");
    const route = src("src/app/api/calendar/route.ts");
    assert.match(page, /\/api\/calendar/);
    assert.match(page, /action: "file"/);
    assert.match(page, /action: "undo"/);
    assert.match(page, /action: "not_required"/);
    assert.match(page, /action: "bulk_file"/);
    assert.match(route, /getServerSupabase/);
    assert.match(route, /filing_calendar/);
    assert.match(route, /last_filed_through/);
    assert.match(route, /syncLastFiledThrough/);
  });

  test("registrations persist due day and notes via the existing POST route", () => {
    const page = src("src/app/registrations/page.tsx");
    const route = src("src/app/api/registrations/route.ts");
    assert.match(page, /\/api\/registrations/);
    assert.match(page, /typical_due_day: dueDay/);
    assert.match(route, /typical_due_day/);
    assert.match(route, /state_rules/);
    assert.match(route, /getServerSupabase/);
  });

  test("compliance resolve/hide always hits /api/compliance/resolve", () => {
    const hub = src("src/app/compliance/ComplianceHub.tsx");
    const state = src("src/app/compliance/[state]/page.tsx");
    assert.match(hub, /\/api\/compliance\/resolve/);
    assert.match(state, /\/api\/compliance\/resolve/);
    assert.doesNotMatch(hub, /from\("nexus_status"\)/);
    assert.doesNotMatch(state, /from\("nexus_status"\)/);
  });

  test("entity obligation settle uses PATCH /api/entity-obligations", () => {
    const page = src("src/app/entity/page.tsx");
    const route = src("src/app/api/entity-obligations/route.ts");
    assert.match(page, /method: "PATCH"/);
    assert.match(page, /\/api\/entity-obligations/);
    assert.match(route, /export async function PATCH/);
    assert.match(route, /compliance_obligations/);
    assert.match(route, /getServerSupabase/);
    assert.doesNotMatch(page, /from\("compliance_obligations"\)/);
  });
});

describe("remaining RLS migration is targeted", () => {
  test("enables RLS on sku_costs and compliance_obligations only", () => {
    const remaining = repo("supabase/migration_rls_sku_costs_obligations.sql");
    const executable = remaining
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    assert.match(remaining, /ALTER TABLE public\.sku_costs ENABLE ROW LEVEL SECURITY/);
    assert.match(
      remaining,
      /ALTER TABLE public\.compliance_obligations ENABLE ROW LEVEL SECURITY/,
    );
    assert.match(remaining, /No CREATE POLICY/);
    assert.match(remaining, /Rollback \(these two tables only\)/);
    assert.doesNotMatch(executable, /DISABLE ROW LEVEL SECURITY/);
    assert.doesNotMatch(executable, /CREATE POLICY/);
    assert.doesNotMatch(executable, /USING \(true\)/);
    // Must not rewrite enablement of the already-locked ops tables.
    assert.doesNotMatch(executable, /sales_daily/);
    assert.doesNotMatch(executable, /ads_campaigns_daily/);
    assert.doesNotMatch(executable, /fba_case_events/);
  });

  test("full lockdown file stays idempotent and does not disable the 56", () => {
    const full = repo("supabase/migration_rls_lockdown.sql");
    const executable = full
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    assert.match(full, /migration_rls_sku_costs_obligations\.sql/);
    assert.match(full, /Do not DISABLE RLS on the tables already locked/);
    assert.doesNotMatch(executable, /DISABLE ROW LEVEL SECURITY/);
    assert.match(full, /ALTER TABLE IF EXISTS public\.sku_costs/);
    assert.match(full, /ALTER TABLE IF EXISTS public\.compliance_obligations/);
  });
});
