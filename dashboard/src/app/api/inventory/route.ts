import { getServerSupabase } from "@/lib/supabase-server";
import { buildLeadtimeSeasonal } from "@/lib/leadtime-seasonal";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * GET /api/inventory
 *
 * Returns inventory data from multiple tables using service-role key
 * (bypasses RLS). Combines snapshots, velocity, restock, and settings.
 */
export async function GET() {
  try {
    const sb = getServerSupabase();

    const [snapshots, velocity, restock, planning, settings, seasonality, tpl, awd, capacity, forecast, signalsRaw, leadtime, replenRows, awdInRows] =
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
        (async () => {
          const r = await sb.from("inventory_sku_signals").select("*");
          if (r.error) return [];
          return r.data ?? [];
        })(),
        (async () => {
          const r = await sb
            .from("inventory_leadtime_summary")
            .select("*")
            .order("as_of_date", { ascending: false })
            .limit(1);
          if (r.error) return null;
          return r.data?.[0] ?? null;
        })(),
        sb
          .from("inventory_awd_replenishments")
          .select("created_at,completed_at,order_status")
          .then((r) => r.data ?? []),
        sb
          .from("inventory_awd_inbound_shipments")
          .select("created_at,closed_at,shipment_status")
          .then((r) => r.data ?? []),
      ]);

    const seasonal = buildLeadtimeSeasonal({
      inboundRows: awdInRows as Array<Record<string, unknown>>,
      replenRows: replenRows as Array<Record<string, unknown>>,
      peakCap: Number(
        (settings as { receiving_days_peak?: number } | null)?.receiving_days_peak ?? 35,
      ),
    });
    const accountRecv = seasonal.observed_receive_days;
    const accountReplen = seasonal.observed_awd_to_fba_days;

    const signals: Array<Record<string, unknown>> = (signalsRaw as Array<Record<string, unknown>>).map((s) => {
      return {
        ...s,
        measured_receive_days: accountRecv,
        measured_replenish_days: accountReplen,
        planning_receive_days: seasonal.planning_receive_days,
        planning_replenish_days: seasonal.planning_awd_to_fba_days,
      };
    });

    if (!signals.length && (accountRecv != null || accountReplen != null)) {
      for (const v of velocity as Array<{ sku?: string }>) {
        if (!v.sku) continue;
        signals.push({
          sku: v.sku,
          measured_receive_days: accountRecv,
          measured_replenish_days: accountReplen,
          planning_receive_days: seasonal.planning_receive_days,
          planning_replenish_days: seasonal.planning_awd_to_fba_days,
          receive_sample_n: accountRecv != null ? 1 : 0,
          replenish_sample_n: accountReplen != null ? 1 : 0,
        });
      }
    }

    // Forecast model state (calibrated weights) — best-effort
    let modelState: unknown[] = [];
    try {
      const ms = await sb.from("forecast_model_state").select("*");
      modelState = ms.data ?? [];
    } catch { /* table may not exist */ }

    return Response.json(
      {
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
        modelState,
        signals,
        leadtime: leadtime
          ? {
              ...leadtime,
              fba_receive_median: accountRecv ?? (leadtime as { fba_receive_median?: number }).fba_receive_median,
              awd_replenish_median:
                accountReplen ?? (leadtime as { awd_replenish_median?: number }).awd_replenish_median,
              planning_receive_days: seasonal.planning_receive_days,
              planning_awd_to_fba_days: seasonal.planning_awd_to_fba_days,
            }
          : {
              as_of_date: seasonal.as_of,
              fba_receive_median: accountRecv,
              fba_receive_n: seasonal.observed_inbound_n,
              awd_replenish_median: accountReplen,
              awd_replenish_n: seasonal.observed_replen_n,
              planning_receive_days: seasonal.planning_receive_days,
              planning_awd_to_fba_days: seasonal.planning_awd_to_fba_days,
            },
        leadtimeSeasonal: seasonal,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
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
