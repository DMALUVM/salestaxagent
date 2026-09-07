import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { parseSqpCsv } from "@/lib/gno-sqp";

/**
 * POST /api/ppc/gno-sqp — manual Brand Analytics SQP CSV drop.
 *
 * Writes:
 *   - sqp_weekly (Brand View funnel; source=sqp_brand_csv)
 *   - keyword_organic_rank when a rank or click-share band can be established
 *
 * Never invents impression/purchase/click share.
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
    if (!parsed.rows.length && !parsed.weekly.length) {
      return Response.json({
        ok: false,
        written: 0,
        sqpWeeklyWritten: 0,
        keywordRankWritten: 0,
        skipped: parsed.skipped,
        week_start: parsed.weekStart,
        week_end: parsed.weekEnd,
        warnings: parsed.warnings,
        error: parsed.warnings[0] ?? "No SQP rows. Shares are never invented.",
      }, { status: 400 });
    }

    const sb = getServerSupabase();
    let keywordRankWritten = 0;
    let sqpWeeklyWritten = 0;
    const warnings = [...parsed.warnings];

    if (parsed.weekly.length) {
      const { error } = await sb.from("sqp_weekly").upsert(parsed.weekly, {
        onConflict: "asin,query_normalized,week_start,source",
      });
      if (error) {
        const missing = /sqp_weekly/.test(error.message ?? "");
        return Response.json({
          ok: false,
          error: error.message,
          hint: missing
            ? "Run supabase/migration_sqp_weekly.sql if the table is missing."
            : undefined,
          week_start: parsed.weekStart,
          week_end: parsed.weekEnd,
          warnings,
        }, { status: 500 });
      }
      sqpWeeklyWritten = parsed.weekly.length;
    }

    if (parsed.rows.length) {
      const { error } = await sb.from("keyword_organic_rank").upsert(parsed.rows, {
        onConflict: "asin,keyword_normalized,source,as_of",
      });
      if (error) {
        // Weekly may already have landed — report partial success.
        const missing = /keyword_organic_rank/.test(error.message ?? "");
        return Response.json({
          ok: sqpWeeklyWritten > 0,
          error: error.message,
          hint: missing
            ? "Run supabase/migration_organic_rank.sql if the table is missing."
            : undefined,
          written: sqpWeeklyWritten,
          sqpWeeklyWritten,
          keywordRankWritten: 0,
          week_start: parsed.weekStart,
          week_end: parsed.weekEnd,
          warnings: [...warnings, `keyword_organic_rank upsert failed: ${error.message}`],
        }, { status: sqpWeeklyWritten > 0 ? 200 : 500 });
      }
      keywordRankWritten = parsed.rows.length;
    } else {
      warnings.push(
        "No rank-bearing rows (missing click share / rank) — sqp_weekly only. Shares are never invented.",
      );
    }

    return Response.json({
      ok: true,
      written: sqpWeeklyWritten + keywordRankWritten,
      sqpWeeklyWritten,
      keywordRankWritten,
      skipped: parsed.skipped,
      week_start: parsed.weekStart,
      week_end: parsed.weekEnd,
      warnings,
    });
  } catch (e) {
    return Response.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }
}
