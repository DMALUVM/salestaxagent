import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/sales-daily
 *
 * Returns all sales_daily rows using the service-role key
 * (bypasses RLS which blocks the anon key on this table).
 */
export async function GET() {
  try {
    const sb = getServerSupabase();
    const all: Record<string, unknown>[] = [];
    const PAGE = 1000;
    let offset = 0;

    while (true) {
      const { data, error } = await sb
        .from("sales_daily")
        .select("*")
        .order("sale_date", { ascending: true })
        .range(offset, offset + PAGE - 1);

      if (error) {
        return Response.json({ error: error.message }, { status: 500 });
      }
      const rows = data ?? [];
      all.push(...rows);
      if (rows.length < PAGE) break;
      offset += PAGE;
    }

    return Response.json(all);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
