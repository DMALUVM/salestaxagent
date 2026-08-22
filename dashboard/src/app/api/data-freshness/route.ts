import { getServerSupabase } from "@/lib/supabase-server";
import { summarizeFreshness } from "@/lib/data-freshness";

/**
 * GET /api/data-freshness
 *
 * Lightweight read of sales_daily max + latest ingestion stamps.
 * Used by the layout "Data as of …" strip. Service-role, read-only.
 */
export async function GET() {
  try {
    const sb = getServerSupabase();

    const [salesRes, ingestRes] = await Promise.all([
      sb
        .from("sales_daily")
        .select("sale_date, channel")
        .order("sale_date", { ascending: false })
        .limit(2000),
      sb
        .from("ingestion_log")
        .select("ingested_at, file_type")
        .order("ingested_at", { ascending: false })
        .limit(50),
    ]);

    if (salesRes.error) {
      return Response.json({ error: salesRes.error.message }, { status: 500 });
    }

    const summary = summarizeFreshness(
      salesRes.data ?? [],
      ingestRes.error ? [] : (ingestRes.data ?? []),
    );
    return Response.json(summary);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
