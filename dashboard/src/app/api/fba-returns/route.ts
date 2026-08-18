import { getServerSupabase } from "@/lib/supabase-server";

/** GET /api/fba-returns — returns data for dashboard. */
export async function GET() {
  try {
    const sb = getServerSupabase();
    const { data, error } = await sb
      .from("fba_returns")
      .select("*")
      .order("return_date", { ascending: false })
      .limit(500);

    if (error) {
      if (error.code === "PGRST205") return Response.json({ returns: [], migration_needed: true });
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json({ returns: data ?? [] });
  } catch (e) {
    return Response.json({ returns: [] });
  }
}
