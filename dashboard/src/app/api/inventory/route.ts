import { keepAwdInventoryRows } from "@/lib/inventory-awd-rows";
import { live3plSnapshots } from "@/lib/inventory-3pl";
import { getServerSupabase } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const LEAD_MIN_DAYS = 4;
const LEAD_MAX_DAYS = 45;

function daySpan(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const a = Date.parse(String(start));
  const b = Date.parse(String(end));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000);
}

function percentileInclusive(vals: number[], p: number): number | null {
  const nums = vals
    .filter((n) => n >= LEAD_MIN_DAYS && n <= LEAD_MAX_DAYS)
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  const idx = Math.min(nums.length - 1, Math.floor((nums.length - 1) * p));
  return nums[idx];
}

const LIP_BALM_SALES_SKUS = [
  "ddpe0001shop",
  "ddpe0002shop",
  "ddpe0003shop",
  "ddpe0004shop",
];

async function amazonLipMonthlySales(
  sb: ReturnType<typeof getServerSupabase>,
): Promise<Array<{ sku: string; period_start: string; units: number; channel: string; source: string }>> {
  const wanted = new Set(LIP_BALM_SALES_SKUS);
  const aggregated = new Map<string, {
    sku: string; period_start: string; units: number; channel: string; source: string;
  }>();
  const PAGE = 1000;
  let from = 0;
  try {
    while (true) {
      const { data } = await sb
        .from("sales_by_sku")
        .select("sku,period_start,units,channel,source")
        .eq("channel", "amazon")
        .eq("source", "amazon_spapi")
        .or("sku.ilike.ddpe0001shop,sku.ilike.ddpe0002shop,sku.ilike.ddpe0003shop,sku.ilike.ddpe0004shop")
        .gte("period_start", "2025-01-01")
        .range(from, from + PAGE - 1);
      const rows = data ?? [];
      for (const r of rows as Array<{
        sku?: string; period_start?: string; units?: number; channel?: string; source?: string;
      }>) {
        const sku = String(r.sku ?? "");
        if (!wanted.has(sku.trim().toLowerCase())) continue;
        const period = String(r.period_start ?? "").slice(0, 10);
        if (!period) continue;
        const month = `${period.slice(0, 7)}-01`;
        const key = `${sku.trim().toLowerCase()}|${month}`;
        const prev = aggregated.get(key);
        const units = Number(r.units ?? 0);
        if (prev) prev.units += units;
        else {
          aggregated.set(key, {
            sku,
            period_start: month,
            units,
            channel: "amazon",
            source: "amazon_spapi",
          });
        }
      }
      if (rows.length < PAGE) break;
      from += PAGE;
    }
  } catch {
    return [];
  }
  return [...aggregated.values()];
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

    const [snapshots, velocity, restock, planning, settings, seasonality, tpl, awd, capacity, forecast, signalsRaw, leadtime, replenRows, awdInRows, skuFlags] =
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
        (async () => {
          const r = await sb.from("inventory_sku_flags").select("sku,not_selling,updated_at");
          if (r.error) return [];
          return r.data ?? [];
        })(),
      ]);

    // Amazon list payloads often collapse ship/receive onto the same updatedAt.
    // Use created → closed/SUCCESS, drop 1-3 day status noise and stale 230d rows.
    // p75 matches real LTL/AWD time better than a median pulled down by 4-day parcels.
    const awdInboundDays = percentileInclusive(
      (awdInRows as Array<{ created_at?: string; closed_at?: string; shipment_status?: string }>)
        .filter((r) => (r.shipment_status || "").toUpperCase() === "CLOSED")
        .map((r) => daySpan(r.created_at, r.closed_at))
        .filter((n): n is number => n != null),
      0.75,
    );
    const accountReplen = percentileInclusive(
      (replenRows as Array<{ created_at?: string; completed_at?: string; order_status?: string }>)
        .filter((r) => (r.order_status || "").toUpperCase() === "SUCCESS")
        .map((r) => daySpan(r.created_at, r.completed_at))
        .filter((n): n is number => n != null),
      0.75,
    );
    const accountRecv =
      awdInboundDays != null && accountReplen != null
        ? awdInboundDays + accountReplen
        : awdInboundDays ?? accountReplen;

    const signals: Array<Record<string, unknown>> = (signalsRaw as Array<Record<string, unknown>>).map((s) => {
      return {
        ...s,
        measured_receive_days: accountRecv,
        measured_replenish_days: accountReplen,
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

    // Compact Amazon pulse monthly units for lip-balm pallet demand (sum across states)
    const amazonLipSales = await amazonLipMonthlySales(sb);

    return Response.json(
      {
        snapshots,
        velocity,
        restock,
        planning,
        settings,
        seasonality,
        tpl: live3plSnapshots(tpl),
        awd: keepAwdInventoryRows(awd),
        capacity,
        forecast,
        amazonLipSales,
        modelState,
        signals,
        leadtime,
        skuFlags,
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
