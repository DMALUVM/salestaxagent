import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function medianPositive(vals: Array<number | null | undefined>): number | null {
  const nums = vals
    .map((v) => (v == null ? NaN : Number(v)))
    .filter((n) => Number.isFinite(n) && n >= 1)
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  return nums[Math.floor((nums.length - 1) / 2)];
}

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
          .select("replenish_days,order_status,replenish_days_basis")
          .then((r) => r.data ?? []),
        sb
          .from("inventory_awd_inbound_shipments")
          .select("receive_days,shipment_status,receive_days_basis")
          .then((r) => r.data ?? []),
      ]);

    const accountRecv = medianPositive(
      (awdInRows as Array<{ receive_days?: number; shipment_status?: string }>).
        filter((r) => (r.shipment_status || "").toUpperCase() === "CLOSED")
        .map((r) => r.receive_days),
    );
    const accountReplen = medianPositive(
      (replenRows as Array<{ replenish_days?: number; order_status?: string; replenish_days_basis?: string }>).
        filter((r) => (r.order_status || "").toUpperCase() === "SUCCESS")
        .filter((r) => (r.replenish_days_basis || "") !== "confirm_to_success_fallback")
        .map((r) => r.replenish_days),
    );

    const signals = (signalsRaw as Array<Record<string, unknown>>).map((s) => {
      const recv = Number(s.measured_receive_days);
      const replen = Number(s.measured_replenish_days);
      return {
        ...s,
        measured_receive_days: recv > 0 ? recv : accountRecv,
        measured_replenish_days: replen > 0 ? replen : accountReplen,
      };
    });

    if (!signals.length && (accountRecv != null || accountReplen != null)) {
      for (const v of velocity as Array<{ sku?: string }>) {
        if (!v.sku) continue;
        signals.push({
          sku: v.sku,
          measured_receive_days: accountRecv,
          measured_replenish_days: accountReplen,
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
        leadtime,
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
