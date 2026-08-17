import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/sales-daily
 *
 * Returns all rows from the sales_daily table, paginating past the
 * PostgREST 1,000-row default.  Ordered by sale_date ascending.
 */
export async function GET() {
  const sb = getServerSupabase();
  const PAGE = 1000;
  const all: Record<string, unknown>[] = [];
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

    const page = data ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }

  return Response.json(all);
}
