import fs from "fs";
import path from "path";
import zlib from "zlib";
import type { SupabaseClient } from "@supabase/supabase-js";

export const SNAPSHOT_FORMAT = "sales_tax_agent_warehouse_snapshot";
export const SUPPORTED_VERSIONS = new Set([1]);

export interface TableSpec {
  name: string;
  on_conflict: string;
  restore_order: number;
}

export interface SnapshotMeta {
  format: string;
  version: number;
  exported_at: string;
  table_meta: Record<string, { row_count: number; status: string; error?: string }>;
  errors: Array<{ table: string; error: string }>;
}

export interface WarehouseSnapshot extends SnapshotMeta {
  tables: Record<string, Record<string, unknown>[]>;
}

export interface RestoreTableResult {
  table: string;
  rows_in_backup: number;
  upserted: number;
  status: string;
  error?: string;
  on_conflict?: string;
}

export interface RestoreSummary {
  dry_run: boolean;
  exported_at?: string;
  tables_processed: number;
  total_upserted: number;
  unknown_tables: string[];
  errors: Array<{ table: string; error: string }>;
  tables: RestoreTableResult[];
}

function configFilePath(): string {
  const candidates = [
    path.join(process.cwd(), "../config/warehouse_snapshot_tables.json"),
    path.join(process.cwd(), "config/warehouse_snapshot_tables.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("warehouse_snapshot_tables.json not found");
}

export function loadTableSpecs(): TableSpec[] {
  const raw = fs.readFileSync(configFilePath(), "utf-8");
  const cfg = JSON.parse(raw) as { tables: TableSpec[] };
  return [...cfg.tables].sort(
    (a, b) => a.restore_order - b.restore_order || a.name.localeCompare(b.name),
  );
}

export function validateSnapshot(snapshot: WarehouseSnapshot): void {
  if (snapshot.format !== SNAPSHOT_FORMAT) {
    throw new Error(`Unknown snapshot format: ${snapshot.format}`);
  }
  if (!SUPPORTED_VERSIONS.has(snapshot.version)) {
    throw new Error(`Unsupported snapshot version: ${snapshot.version}`);
  }
}

export async function fetchAllRows(
  sb: SupabaseClient,
  table: string,
): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const all: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb.from(table).select("*").range(offset, offset + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const page = data ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

export async function exportWarehouseSnapshot(sb: SupabaseClient): Promise<WarehouseSnapshot> {
  const specs = loadTableSpecs();
  const exported_at = new Date().toISOString();
  const tables: Record<string, Record<string, unknown>[]> = {};
  const table_meta: SnapshotMeta["table_meta"] = {};
  const errors: SnapshotMeta["errors"] = [];

  for (const spec of specs) {
    try {
      const rows = await fetchAllRows(sb, spec.name);
      tables[spec.name] = rows;
      table_meta[spec.name] = { row_count: rows.length, status: "ok" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      tables[spec.name] = [];
      table_meta[spec.name] = { row_count: 0, status: "error", error: msg.slice(0, 500) };
      errors.push({ table: spec.name, error: msg.slice(0, 500) });
    }
  }

  const cfg = JSON.parse(fs.readFileSync(configFilePath(), "utf-8")) as { version: number };

  return {
    format: SNAPSHOT_FORMAT,
    version: cfg.version ?? 1,
    exported_at,
    table_meta,
    errors,
    tables,
  };
}

export function gzipSnapshot(snapshot: WarehouseSnapshot): Buffer {
  const json = JSON.stringify(snapshot);
  return zlib.gzipSync(Buffer.from(json, "utf-8"));
}

export function parseSnapshotBytes(data: Buffer): WarehouseSnapshot {
  let text: string;
  if (data[0] === 0x1f && data[1] === 0x8b) {
    text = zlib.gunzipSync(data).toString("utf-8");
  } else {
    text = data.toString("utf-8");
  }
  return JSON.parse(text) as WarehouseSnapshot;
}

export async function restoreWarehouseSnapshot(
  sb: SupabaseClient,
  snapshot: WarehouseSnapshot,
  dryRun = false,
): Promise<RestoreSummary> {
  validateSnapshot(snapshot);
  const specs = loadTableSpecs();
  const specByName = new Map(specs.map((s) => [s.name, s]));
  const tablesData = snapshot.tables ?? {};

  const results: RestoreTableResult[] = [];
  let totalUpserted = 0;
  const errors: RestoreSummary["errors"] = [];

  for (const spec of specs) {
    const rows = tablesData[spec.name];
    if (rows === undefined) continue;
    if (!rows.length) {
      results.push({ table: spec.name, rows_in_backup: 0, upserted: 0, status: "empty" });
      continue;
    }

    if (dryRun) {
      results.push({
        table: spec.name,
        rows_in_backup: rows.length,
        upserted: 0,
        status: "dry_run",
        on_conflict: spec.on_conflict,
      });
      continue;
    }

    try {
      const { error } = await sb.from(spec.name).upsert(rows, { onConflict: spec.on_conflict });
      if (error) throw new Error(error.message);
      totalUpserted += rows.length;
      results.push({
        table: spec.name,
        rows_in_backup: rows.length,
        upserted: rows.length,
        status: "ok",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ table: spec.name, error: msg.slice(0, 500) });
      results.push({
        table: spec.name,
        rows_in_backup: rows.length,
        upserted: 0,
        status: "error",
        error: msg.slice(0, 500),
      });
    }
  }

  const unknownTables = Object.keys(tablesData).filter((t) => !specByName.has(t));

  return {
    dry_run: dryRun,
    exported_at: snapshot.exported_at,
    tables_processed: results.length,
    total_upserted: totalUpserted,
    unknown_tables: unknownTables,
    errors,
    tables: results,
  };
}
