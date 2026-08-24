import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { ingestAdsMonthlyCsv, type AdsMonthlyPersistResult } from "@/lib/ads-monthly-ingest";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB per file
const MAX_FILES = 24;

/**
 * POST /api/upload/ads-monthly
 * Multi-file SKU Economics / Ads Console CSV → ads_monthly_spend.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const entries = formData.getAll("files").filter((v): v is File => v instanceof File);
    if (!entries.length) {
      const single = formData.get("file");
      if (single instanceof File) entries.push(single);
    }
    if (!entries.length) {
      return Response.json({ ok: false, error: "No files provided" }, { status: 400 });
    }
    if (entries.length > MAX_FILES) {
      return Response.json({
        ok: false,
        error: `Too many files (${entries.length}). Max ${MAX_FILES} per upload.`,
      }, { status: 400 });
    }

    const sb = getServerSupabase();
    const results: AdsMonthlyPersistResult[] = [];
    const warnings: string[] = [];

    for (const file of entries) {
      if (file.size > MAX_FILE_SIZE) {
        results.push({
          ok: false,
          filename: file.name,
          kind: null,
          months: 0,
          month_starts: [],
          total_spend: 0,
          rows_inserted: 0,
          rows_parsed: 0,
          rows_skipped: 0,
          warnings: [],
          error: "File too large (max 50 MB).",
        });
        continue;
      }
      const content = await file.text();
      const result = await ingestAdsMonthlyCsv(sb, file.name, content);
      results.push(result);
      if (result.warnings.length) warnings.push(...result.warnings.map((w) => `${file.name}: ${w}`));
    }

    const okFiles = results.filter((r) => r.ok);
    const monthSet = new Set<string>();
    let totalSpend = 0;
    for (const r of okFiles) {
      for (const m of r.month_starts) monthSet.add(m);
      totalSpend += r.total_spend;
    }

    if (!okFiles.length) {
      return Response.json({
        ok: false,
        error: results.find((r) => r.error)?.error ?? "No files were imported",
        files: results,
        warnings,
      }, { status: 400 });
    }

    return Response.json({
      ok: true,
      files_received: entries.length,
      files_ok: okFiles.length,
      files_failed: results.length - okFiles.length,
      months_upserted: monthSet.size,
      month_starts: [...monthSet].sort(),
      total_spend: Math.round(totalSpend * 100) / 100,
      files: results,
      warnings,
    });
  } catch (e) {
    return Response.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }
}
