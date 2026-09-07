/**
 * Supabase helpers for GNO export state + decision ledger.
 * Missing tables are non-fatal — the desk still renders (due stays conservative).
 * Observe only. Never writes to Amazon.
 */

import { getServerSupabase } from "@/lib/supabase-server";
import {
  type DaveAction,
  type GnoLedgerRow,
  isDaveAction,
  ledgerInsertRow,
} from "./gno-learning";
import type { GnoExportStateRow } from "./gno-export-state";

export const GNO_EXPORT_TABLE = "gno_export_state";
export const GNO_LEDGER_TABLE = "gno_decision_ledger";
export const GNO_EXPORT_ROW_ID = "default";

function tableMissing(message: string | undefined, table: string): boolean {
  const m = message ?? "";
  return /does not exist|schema cache|Could not find the table/i.test(m)
    && (m.includes(table) || /relation/i.test(m));
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [];
}

export async function loadGnoExportState(
  sb: ReturnType<typeof getServerSupabase> = getServerSupabase(),
): Promise<GnoExportStateRow | null> {
  try {
    const r = await sb.from(GNO_EXPORT_TABLE)
      .select("id,last_export_at,last_export_reason,last_export_filename,acked_p0_keys,acked_p1_keys,updated_at")
      .eq("id", GNO_EXPORT_ROW_ID)
      .maybeSingle();
    if (r.error) {
      if (tableMissing(r.error.message, GNO_EXPORT_TABLE)) return null;
      return null;
    }
    const row = r.data as Record<string, unknown> | null;
    if (!row) return null;
    return {
      id: String(row.id ?? GNO_EXPORT_ROW_ID),
      last_export_at: row.last_export_at ? String(row.last_export_at) : null,
      last_export_reason: row.last_export_reason ? String(row.last_export_reason) : null,
      last_export_filename: row.last_export_filename ? String(row.last_export_filename) : null,
      acked_p0_keys: asStringArray(row.acked_p0_keys),
      acked_p1_keys: asStringArray(row.acked_p1_keys),
      updated_at: row.updated_at ? String(row.updated_at) : null,
    };
  } catch {
    return null;
  }
}

export async function saveGnoExportAck(
  payload: {
    last_export_at: string;
    last_export_reason: string;
    last_export_filename: string;
    acked_p0_keys: string[];
    acked_p1_keys: string[];
    updated_at: string;
  },
  sb: ReturnType<typeof getServerSupabase> = getServerSupabase(),
): Promise<{ ok: boolean; hint?: string }> {
  try {
    const r = await sb.from(GNO_EXPORT_TABLE).upsert({
      id: GNO_EXPORT_ROW_ID,
      ...payload,
    }, { onConflict: "id" });
    if (r.error) {
      return {
        ok: false,
        hint: tableMissing(r.error.message, GNO_EXPORT_TABLE)
          ? "Run supabase/migration_gno_watch.sql so last-export can persist."
          : r.error.message,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, hint: e instanceof Error ? e.message : String(e) };
  }
}

export async function loadGnoLedger(
  sb: ReturnType<typeof getServerSupabase> = getServerSupabase(),
  limit = 500,
): Promise<GnoLedgerRow[]> {
  try {
    const r = await sb.from(GNO_LEDGER_TABLE)
      .select("id,created_at,pack_date,campaign_name,search_term,term_family,proposed_tag,dave_action,source,notes")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (r.error) return [];
    return (r.data ?? [])
      .filter((row) => isDaveAction(String((row as { dave_action?: string }).dave_action ?? "")))
      .map((row) => {
        const d = row as Record<string, unknown>;
        return {
          id: d.id ? String(d.id) : undefined,
          created_at: d.created_at ? String(d.created_at) : undefined,
          pack_date: d.pack_date ? String(d.pack_date) : null,
          campaign_name: d.campaign_name ? String(d.campaign_name) : null,
          search_term: d.search_term ? String(d.search_term) : null,
          term_family: d.term_family ? String(d.term_family) : null,
          proposed_tag: d.proposed_tag ? String(d.proposed_tag) : null,
          dave_action: String(d.dave_action) as DaveAction,
          source: d.source ? String(d.source) : null,
          notes: d.notes ? String(d.notes) : null,
        };
      });
  } catch {
    return [];
  }
}

export async function insertGnoLedger(
  entries: Array<{
    dave_action: DaveAction;
    campaign_name?: string | null;
    search_term?: string | null;
    proposed_tag?: string | null;
    pack_date?: string | null;
    source?: string | null;
    notes?: string | null;
  }>,
  sb: ReturnType<typeof getServerSupabase> = getServerSupabase(),
): Promise<{ ok: boolean; written: number; error?: string; hint?: string }> {
  if (!entries.length) return { ok: true, written: 0 };
  const rows = entries.map(ledgerInsertRow);
  try {
    const r = await sb.from(GNO_LEDGER_TABLE).insert(rows);
    if (r.error) {
      return {
        ok: false,
        written: 0,
        error: r.error.message,
        hint: tableMissing(r.error.message, GNO_LEDGER_TABLE)
          ? "Run supabase/migration_gno_watch.sql to store Grok outcomes."
          : undefined,
      };
    }
    return { ok: true, written: rows.length };
  } catch (e) {
    return { ok: false, written: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
