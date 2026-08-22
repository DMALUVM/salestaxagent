import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { isQuarantinedSource } from "@/lib/channels";

/**
 * GET /api/export-csv?table=sales_by_state&start=2026-01-01&end=2026-12-31
 *
 * Downloads the requested table as CSV for CPA review.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const table = params.get("table") ?? "sales_by_state";
  const start = params.get("start");
  const end = params.get("end");

  const allowed = ["sales_by_state", "sales_by_sku"];
  if (!allowed.includes(table)) {
    return Response.json({ error: `Table not allowed: ${table}` }, { status: 400 });
  }

  const sb = getServerSupabase();
  let query = sb.from(table).select("*");
  if (start) query = query.gte("period_start", start);
  if (end) query = query.lte("period_start", end);
  query = query.order("period_start", { ascending: true });

  // Paginate
  const all: Record<string, unknown>[] = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await query.range(offset, offset + PAGE - 1);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    all.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) break;
    offset += PAGE;
  }

  const includeQuarantined = params.get("include_quarantined") === "1";
  const rows =
    table === "sales_by_state" && !includeQuarantined
      ? all.filter((r) => !isQuarantinedSource(typeof r.source === "string" ? r.source : null))
      : all;

  if (rows.length === 0) {
    return Response.json({ error: "No data for the selected range" }, { status: 404 });
  }

  // Build CSV
  const keys = Object.keys(rows[0]);
  const lines = [keys.join(",")];
  for (const row of rows) {
    lines.push(
      keys
        .map((k) => {
          const v = row[k];
          if (v == null) return "";
          const s = String(v);
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        })
        .join(","),
    );
  }

  const csv = lines.join("\n");
  const filename = `${table}_${start ?? "all"}_${end ?? "all"}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
