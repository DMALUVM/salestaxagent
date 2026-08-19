import { getServerSupabase } from "@/lib/supabase-server";

/** GET /api/pnl — Daily P&L data. */
export async function GET() {
  try {
    const sb = getServerSupabase();
    let daily: unknown[] = [];
    try {
      const r = await sb.from("pnl_daily").select("*").eq("grain", "account")
        .order("date", { ascending: false }).limit(90);
      daily = r.data ?? [];
    } catch { /* table may not exist */ }
    return Response.json({ daily });
  } catch {
    return Response.json({ daily: [] });
  }
}
