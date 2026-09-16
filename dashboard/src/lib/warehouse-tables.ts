/**
 * Tables the dashboard may read through GET /api/warehouse.
 *
 * Allowlist only — this is not a generic PostgREST proxy. Matches the
 * tables still queried via useSupabaseQuery (Tax / Overview / Calendar /
 * Compliance / Registrations / nav, plus sku_costs for SKU economics).
 */
export const WAREHOUSE_TABLES = [
  "admin_rulings",
  "court_rulings",
  "filing_calendar",
  "franchise_tax_flags",
  "ingestion_log",
  "nexus_rules",
  "nexus_status",
  "research_tasks",
  "sales_by_sku",
  "sales_by_state",
  "sku_costs",
  "state_rules",
] as const;

export type WarehouseTable = (typeof WAREHOUSE_TABLES)[number];

const TABLE_SET = new Set<string>(WAREHOUSE_TABLES);

export function isWarehouseTable(name: string): name is WarehouseTable {
  return TABLE_SET.has(name);
}

/** PostgREST column / order ident — reject anything that is not a simple name. */
export function isSafeIdent(name: string): boolean {
  return /^[a-z_][a-z0-9_]*$/i.test(name);
}
