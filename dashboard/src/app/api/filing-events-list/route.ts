import { getServerSupabase } from "@/lib/supabase-server";

/** GET /api/filing-events-list — all filing events, newest first. */
export async function GET() {
  try {
    const sb = getServerSupabase();
    const { data, error } = await sb
      .from("filing_events")
      .select("*")
      .order("filed_at", { ascending: false })
      .limit(200);
    if (error) {
      if (error.code === "PGRST205") return Response.json([]);
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json(data ?? []);
  } catch (e) {
    return Response.json([], { status: 200 }); // graceful if table missing
  }
}
