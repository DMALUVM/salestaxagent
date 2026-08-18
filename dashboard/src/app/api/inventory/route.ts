import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/inventory
 *
 * Returns inventory data from multiple tables using service-role key
 * (bypasses RLS). Combines snapshots, velocity, restock, and settings.
 */
export async function GET() {
  try {
    const sb = getServerSupabase();

    const [snapshots, velocity, restock, planning, settings, seasonality, tpl, awd, capacity, forecast] =
      await Promise.all([
        sb.from("inventory_snapshots").select("*").then((r) => r.data ?? []),
        sb.from("sku_velocity").select("*").then((r) => r.data ?? []),
        sb.from("inventory_restock").select("*").then((r) => r.data ?? []),
        sb.from("inventory_planning").select("*").then((r) => r.data ?? []),
        sb
          .from("inventory_settings")
          .select("*")
          .limit(1)
          .then((r) => r.data?.[0] ?? null),
        sb
          .from("seasonality_weekly")
          .select("*")
          .eq("sku", "_account_")
          .eq("year", 0)
          .then((r) => r.data ?? []),
        sb.from("inventory_3pl_snapshots").select("*").then((r) => r.data ?? []),
        sb.from("inventory_awd").select("*").then((r) => r.data ?? []),
        sb.from("fba_capacity_limits").select("*").order("month").then((r) => r.data ?? []),
        sb.from("forecast_weekly").select("*").order("week_start").then((r) => r.data ?? []),
      ]);

    return Response.json({
      snapshots,
      velocity,
      restock,
      planning,
      settings,
      seasonality,
      tpl,
      awd,
      capacity,
      forecast,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/inventory
 *
 * Update inventory settings (target_cover_days, lead_time_days, etc.)
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const sb = getServerSupabase();

    const { error } = await sb
      .from("inventory_settings")
      .update({
        target_cover_days: body.target_cover_days,
        lead_time_days: body.lead_time_days,
        holiday_mode: body.holiday_mode,
        include_inbound: body.include_inbound,
        include_3pl: body.include_3pl,
      })
      .eq("id", 1);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ ok: true });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
