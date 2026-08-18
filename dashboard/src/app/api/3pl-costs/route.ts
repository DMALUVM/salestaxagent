import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { createHash } from "crypto";

/**
 * GET /api/3pl-costs
 * Returns monthly summary and fee breakdown.
 */
export async function GET() {
  try {
    const sb = getServerSupabase();
    const [monthly, fees] = await Promise.all([
      sb.from("tpl_cost_monthly").select("*").order("month").then((r) => r.data ?? []),
      sb.from("tpl_cost_fees").select("*").order("month").then((r) => r.data ?? []),
    ]);
    return Response.json({ monthly, fees, detail: [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Table doesn't exist yet — return empty instead of error
    if (msg.includes("PGRST") || msg.includes("schema cache")) {
      return Response.json({ monthly: [], fees: [], detail: [], migration_needed: true });
    }
    return Response.json({ error: msg }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/3pl-costs — parse and ingest a 3PL invoice CSV
// ---------------------------------------------------------------------------

function safeFloat(v: string): number {
  try {
    return parseFloat(v.replace(/[$,]/g, "").trim()) || 0;
  } catch {
    return 0;
  }
}

function lineHash(parts: Record<string, string>): string {
  const s = [parts.date, parts.category, parts.fee_name,
    parts.reference, parts.order_id, parts.amount, parts.qty].join("|");
  return createHash("md5").update(s).digest("hex");
}

interface ParsedSection {
  monthly: Record<string, unknown>[];
  fees: Record<string, unknown>[];
  detail: Record<string, unknown>[];
  months: string[];
}

function parseTplCsv(content: string, filename: string): ParsedSection {
  // Split into sections by all-caps header lines
  const sections: Record<string, string[]> = {};
  let curSection: string | null = null;
  let curLines: string[] = [];

  for (const line of content.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped) continue;
    if (/^[A-Z][A-Z &/-]+$/.test(stripped) && stripped.length > 3 && stripped.split(",").length <= 2) {
      if (curSection) sections[curSection] = curLines;
      curSection = stripped;
      curLines = [];
    } else {
      curLines.push(line);
    }
  }
  if (curSection) sections[curSection] = curLines;

  const monthly: Record<string, unknown>[] = [];
  const fees: Record<string, unknown>[] = [];
  const detail: Record<string, unknown>[] = [];

  // ── MONTHLY SUMMARY ──
  const summaryLines = sections["MONTHLY SUMMARY"];
  if (summaryLines?.length) {
    const headerLine = summaryLines[0];
    const headers = headerLine.split(",").map((h) => h.trim());

    const findCol = (...candidates: string[]): number[] => {
      const result: number[] = [];
      for (let i = 0; i < headers.length; i++) {
        const hl = headers[i].toLowerCase();
        if (candidates.some((c) => hl.includes(c.toLowerCase()))) result.push(i);
      }
      return result;
    };

    const getSum = (cols: number[], fields: string[]): number =>
      cols.reduce((s, i) => s + safeFloat(fields[i] ?? "0"), 0);

    const getFirst = (cols: number[], fields: string[]): number =>
      cols.length ? safeFloat(fields[cols[0]] ?? "0") : 0;

    const shippingCols = findCol("shipping");
    const pickCols = findCol("pick");
    const orderFeeCols = findCol("order fee");
    const packagingCols = findCol("packaging");
    const shelfCols = findCol("master carton", "shelf storage");
    const binMedCols = findCol("medium bin");
    const palletCols = findCol("pallet storage");
    const binSmCols = findCol("small bin");
    const acctCols = findCol("account management");
    const adhocCols = findCol("ad-hoc", "adhoc");
    const totalCols = findCol("total");

    for (const line of summaryLines.slice(1)) {
      const fields = line.split(",").map((f) => f.trim());
      const month = fields[0];
      if (!month || !month.match(/^\d{4}-\d{2}$/)) continue;

      monthly.push({
        month,
        shipping: getFirst(shippingCols, fields),
        pick: getFirst(pickCols, fields),
        order_fee: getSum(orderFeeCols, fields),
        packaging: getFirst(packagingCols, fields),
        storage_shelf: getFirst(shelfCols, fields),
        storage_bin_med: getFirst(binMedCols, fields),
        storage_pallet: getFirst(palletCols, fields),
        storage_bin_sm: getFirst(binSmCols, fields),
        account_mgmt: getFirst(acctCols, fields),
        adhoc: getFirst(adhocCols, fields),
        total: getFirst(totalCols, fields),
        source_file: filename,
      });
    }
  }

  // ── PACKAGING / AD-HOC FEES ──
  for (const [sectionName, sectionKey] of [
    ["PACKAGING FEES BY MONTH", "packaging"],
    ["AD-HOC FEES BY MONTH", "adhoc"],
  ] as const) {
    const lines = sections[sectionName];
    if (!lines?.length) continue;
    // Skip header row
    for (const line of lines.slice(1)) {
      const fields = line.split(",").map((f) => f.trim());
      const month = fields[0];
      const feeName = fields[1];
      if (!month || !feeName) continue;
      fees.push({
        month,
        section: sectionKey,
        fee_name: feeName,
        qty: safeFloat(fields[2] ?? "0"),
        amount: safeFloat(fields[3] ?? "0"),
        source_file: filename,
      });
    }
  }

  // ── DETAIL ──
  const detailLines = sections["DETAIL"];
  if (detailLines?.length) {
    for (const line of detailLines.slice(1)) {
      const fields = line.split(",").map((f) => f.trim());
      if (fields.length < 11) continue;
      const month = fields[3];
      if (!month) continue;
      const d: Record<string, string> = {
        date: fields[0], category: fields[5], fee_name: fields[6],
        reference: fields[7], order_id: fields[8],
        amount: fields[10], qty: fields[9],
      };
      detail.push({
        date: fields[0] || null,
        period_start: fields[1] || null,
        period_end: fields[2] || null,
        month,
        entry: fields[4] || null,
        category: fields[5] || null,
        fee_name: fields[6] || null,
        reference: fields[7] || null,
        order_id: fields[8] || null,
        qty: safeFloat(fields[9]) || null,
        amount: safeFloat(fields[10]),
        line_hash: lineHash(d),
        source_file: filename,
      });
    }
  }

  const months = [...new Set(monthly.map((m) => m.month as string))].sort();
  return { monthly, fees, detail, months };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const content = body.content as string;
    const filename = (body.filename as string) || "upload.csv";

    if (!content || content.length < 20) {
      return Response.json({ error: "Empty or invalid CSV content" }, { status: 400 });
    }

    const parsed = parseTplCsv(content, filename);

    if (!parsed.monthly.length) {
      return Response.json({
        error: "No MONTHLY SUMMARY section found in CSV. Is this a Ship Sidekick invoice?",
      }, { status: 400 });
    }

    const sb = getServerSupabase();
    let inserted = 0;
    const errors: string[] = [];

    // Upsert monthly
    {
      const { error } = await sb
        .from("tpl_cost_monthly")
        .upsert(parsed.monthly, { onConflict: "month" });
      if (error) errors.push(`Monthly: ${error.message}`);
      else inserted += parsed.monthly.length;
    }

    // Upsert fees
    if (parsed.fees.length) {
      const { error } = await sb
        .from("tpl_cost_fees")
        .upsert(parsed.fees, { onConflict: "month,section,fee_name" });
      if (error) errors.push(`Fees: ${error.message}`);
      else inserted += parsed.fees.length;
    }

    // Upsert detail in batches
    if (parsed.detail.length) {
      const batchSize = 500;
      for (let i = 0; i < parsed.detail.length; i += batchSize) {
        const batch = parsed.detail.slice(i, i + batchSize);
        const { error } = await sb
          .from("tpl_cost_detail")
          .upsert(batch, { onConflict: "line_hash" });
        if (error) {
          errors.push(`Detail batch ${Math.floor(i / batchSize) + 1}: ${error.message}`);
          break;
        }
        inserted += batch.length;
      }
    }

    if (errors.length) {
      return Response.json({
        success: false,
        error: errors.join("; "),
        months: parsed.months,
        rows_inserted: inserted,
      }, { status: 500 });
    }

    return Response.json({
      success: true,
      months: parsed.months,
      monthly_count: parsed.monthly.length,
      fee_count: parsed.fees.length,
      detail_count: parsed.detail.length,
      rows_inserted: inserted,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("schema cache") || msg.includes("PGRST")) {
      return Response.json({
        error: "3PL cost tables not found. Run supabase/migration_3pl_costs.sql in the SQL Editor first.",
      }, { status: 500 });
    }
    return Response.json({ error: `Upload failed: ${msg}` }, { status: 500 });
  }
}
