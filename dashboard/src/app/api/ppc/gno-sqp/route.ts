import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { parseSqpCsv } from "@/lib/gno-sqp";

/**
 * POST /api/ppc/gno-sqp — manual Brand Analytics SQP CSV drop.
 * Writes keyword_organic_rank only when a rank or click-share is present.
 * Never invents impression/purchase share.
 */

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "No file provided" }, { status: 400 });
    }
    const content = await file.text();
    const parsed = parseSqpCsv(content);
    if (!parsed.rows.length) {
      return Response.json({
        ok: false,
        written: 0,
        skipped: parsed.skipped,
        warnings: parsed.warnings,
        error: parsed.warnings[0] ?? "No rank-bearing SQP rows. Shares are never invented.",
      }, { status: 400 });
    }
    const sb = getServerSupabase();
    const { error } = await sb.from("keyword_organic_rank").upsert(parsed.rows, {
      onConflict: "asin,keyword_normalized,source,as_of",
    });
    if (error) {
      return Response.json({
        ok: false,
        error: error.message,
        hint: "Run supabase/migration_organic_rank.sql if the table is missing.",
      }, { status: 500 });
    }
    return Response.json({
      ok: true,
      written: parsed.rows.length,
      skipped: parsed.skipped,
      warnings: parsed.warnings,
    });
  } catch (e) {
    return Response.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }
}
