import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

/**
 * GET /api/forecast-sku?sku=X&end=YYYY-MM-DD&start=YYYY-MM-DD&safety=0.15
 *
 * Pure TypeScript forecast engine — no Python subprocess.
 * Reads velocity, seasonality, forecast, SnS, returns from Supabase.
 */

function isoWeek(d: Date): number {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
  return Math.max(1, Math.min(52, Math.ceil((days + jan1.getDay() + 1) / 7)));
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function loadAsinTitles(): Record<string, string> {
  try {
    const p = join(process.cwd(), "config", "asin_titles.json");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  } catch { /* ok */ }
  return {};
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const sku = url.searchParams.get("sku");
    const endStr = url.searchParams.get("end");
    const startStr = url.searchParams.get("start") || null;
    const safetyPct = parseFloat(url.searchParams.get("safety") || "0.15");

    if (!sku || !endStr) {
      return Response.json({ error: "sku and end params required" }, { status: 400 });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = startStr ? new Date(startStr + "T00:00:00") : today;
    const end = new Date(endStr + "T00:00:00");

    if (end <= start) {
      return Response.json({ error: "end_date must be after start_date" }, { status: 400 });
    }

    const sb = getServerSupabase();

    // ── Load data sources ──
    const [velRes, seasRes, fcRes, snsRes, retRes] = await Promise.all([
      sb.from("sku_velocity").select("*").eq("sku", sku).limit(1),
      sb.from("seasonality_weekly").select("week,multiplier").eq("sku", "_account_").eq("year", 0),
      sb.from("forecast_weekly").select("week_start,units").eq("sku", sku).eq("scenario", "correction_factor"),
      sb.from("sns_offer_metrics").select("*").eq("sku", sku).order("week_start", { ascending: false }).limit(1),
      sb.from("fba_returns").select("quantity").eq("sku", sku),
    ]);

    const vel = velRes.data?.[0] ?? null;

    // Seasonality: {week: multiplier}
    const seasonality: Record<number, number> = {};
    for (const r of seasRes.data ?? []) {
      seasonality[r.week] = Number(r.multiplier);
    }

    // Holiday forecast: {isoDate: units}
    const holidayFc: Record<string, number> = {};
    for (const r of fcRes.data ?? []) {
      let ws = String(r.week_start ?? "").slice(0, 10);
      // Remap 2026-01 → 2027-01
      if (ws.startsWith("2026-01")) ws = "2027" + ws.slice(4);
      holidayFc[ws] = Number(r.units ?? 0);
    }

    // SnS
    const snsRow = snsRes.data?.[0] ?? null;
    // Also try matching by ASIN if SKU didn't match
    let snsWeeklyShipped = Number(snsRow?.shipped_units ?? 0);
    let snsActiveSubs = Number(snsRow?.active_subscriptions ?? 0);
    if (!snsRow && vel?.asin) {
      const snsAsin = await sb.from("sns_offer_metrics").select("*")
        .eq("asin", vel.asin).order("week_start", { ascending: false }).limit(1);
      const a = snsAsin.data?.[0];
      if (a) {
        snsWeeklyShipped = Number(a.shipped_units ?? 0);
        snsActiveSubs = Number(a.active_subscriptions ?? 0);
      }
    }

    // Returns
    const totalReturns = (retRes.data ?? []).reduce((s, r) => s + Number(r.quantity ?? 1), 0);

    // ASIN + title
    const asin = vel?.asin ?? "";
    const titles = loadAsinTitles();
    const productName = vel?.product_name || titles[asin] || sku;

    // Velocity (fields are already u/day)
    const v7 = Number(vel?.total_u_7 ?? 0);
    const v30 = Number(vel?.total_u_30 ?? 0);
    const v90 = Number(vel?.total_u_90 ?? 0);

    // Blended daily velocity (50/30/20)
    const windows: [number, number][] = [[v7, 0.50], [v30, 0.30], [v90, 0.20]];
    const validVel = windows.filter(([r]) => r > 0);
    const blendedDaily = validVel.length > 0
      ? validVel.reduce((s, [r, w]) => s + r * w, 0) / validVel.reduce((s, [, w]) => s + w, 0)
      : 0;

    // Return rate
    const returnRate = v90 > 0 && totalReturns > 0
      ? Math.min(totalReturns / Math.max(v90 * 90, 1), 0.20)
      : 0;

    // Organic daily (velocity minus SnS portion)
    const organicDaily = Math.max(blendedDaily - (snsWeeklyShipped > 0 ? snsWeeklyShipped / 7 : 0), 0);

    // ── Build weekly series ──
    const weeks: Array<{
      week_start: string; week_end: string; iso_week: number; days: number;
      naive: number; seasonal: number; sns_organic: number; source: string; multiplier: number;
    }> = [];

    let cursor = new Date(start);
    while (cursor < end) {
      const weekEnd = new Date(Math.min(addDays(cursor, 6).getTime(), end.getTime()));
      const iw = isoWeek(cursor);
      const wsIso = toIso(cursor);

      // Holiday forecast override (±3 day fuzzy match)
      let fcMatch: number | null = null;
      for (let off = 0; off <= 3; off++) {
        const t1 = toIso(addDays(cursor, off));
        if (t1 in holidayFc) { fcMatch = holidayFc[t1]; break; }
        if (off > 0) {
          const t2 = toIso(addDays(cursor, -off));
          if (t2 in holidayFc) { fcMatch = holidayFc[t2]; break; }
        }
      }

      const mult = seasonality[iw] ?? 1.0;

      // Method A: naive
      let naive = blendedDaily * 7;
      // Method B: seasonal + holiday
      let seasonal: number;
      let source: string;
      if (fcMatch !== null) { seasonal = fcMatch; source = "forecast"; }
      else { seasonal = blendedDaily * 7 * mult; source = "velocity×seasonality"; }
      // Method C: SnS floor + organic
      let methodC = snsWeeklyShipped + organicDaily * 7 * mult;

      // Partial week
      const daysInWeek = Math.round((weekEnd.getTime() - cursor.getTime()) / 86400000) + 1;
      if (daysInWeek < 7) {
        const frac = daysInWeek / 7;
        naive *= frac;
        seasonal *= frac;
        methodC *= frac;
      }

      weeks.push({
        week_start: wsIso,
        week_end: toIso(weekEnd),
        iso_week: iw,
        days: daysInWeek,
        naive: Math.round(naive),
        seasonal: Math.round(seasonal),
        sns_organic: Math.round(methodC),
        source,
        multiplier: Math.round(mult * 100) / 100,
      });

      cursor = addDays(weekEnd, 1);
    }

    // ── Aggregate ──
    const totalNaive = weeks.reduce((s, w) => s + w.naive, 0);
    const totalSeasonal = weeks.reduce((s, w) => s + w.seasonal, 0);
    const totalSnsOrganic = weeks.reduce((s, w) => s + w.sns_organic, 0);

    const methodsArr = [totalNaive, totalSeasonal, totalSnsOrganic];
    const avgMethods = methodsArr.reduce((a, b) => a + b, 0) / 3;
    const maxSpread = avgMethods > 0
      ? Math.max(...methodsArr.map((m) => Math.abs(m - avgMethods) / avgMethods)) * 100
      : 0;

    // Load calibrated weights from forecast_model_state
    let weights = { a: 0.15, b: 0.60, c: 0.25 };
    let modelVersion = "default";
    try {
      const msRes = await sb.from("forecast_model_state").select("*")
        .in("sku", [sku, "*"]).order("sku", { ascending: false }).limit(2);
      const skuModel = (msRes.data ?? []).find((m: Record<string, unknown>) => m.sku === sku);
      const globalModel = (msRes.data ?? []).find((m: Record<string, unknown>) => m.sku === "*");
      const active = skuModel || globalModel;
      if (active) {
        const w = typeof active.weights === "string" ? JSON.parse(active.weights) : active.weights;
        if (w && typeof w.a === "number") {
          weights = w;
          modelVersion = (active.model_version as string) || "calibrated";
        }
      }
    } catch { /* table may not exist */ }

    const expected = Math.round(
      weights.a * totalNaive + weights.b * totalSeasonal + weights.c * totalSnsOrganic,
    );
    const coverage = Math.ceil(expected * (1 + safetyPct));
    const low = Math.floor(expected * 0.80);
    const high = Math.ceil(expected * 1.20);

    const velWindows = [v7, v30, v90].filter((v) => v > 0).length;
    const holidays: string[] = [];
    if (weeks.some((w) => w.source === "forecast")) holidays.push("Holiday forecast (Nov-Jan) applied");
    const peakWeek = weeks.find((w) => w.multiplier > 2.0);
    if (peakWeek) holidays.push(`Week ${peakWeek.iso_week}: ${peakWeek.multiplier}x seasonal peak`);

    // Read accuracy if available
    let accuracy = null;
    try {
      const accRes = await sb.from("forecast_accuracy").select("mape,n_weeks,best_method")
        .eq("sku", sku).eq("window_days", 90).limit(1);
      if (accRes.data?.[0]) accuracy = accRes.data[0];
    } catch { /* table may not exist */ }

    return Response.json({
      sku,
      asin,
      product_name: productName,
      start_date: toIso(start),
      end_date: endStr,
      num_weeks: weeks.length,
      safety_pct: safetyPct,
      expected_units: expected,
      coverage_units: coverage,
      low_band: low,
      high_band: high,
      methods: {
        A_naive_runrate: totalNaive,
        B_seasonal_yoy: totalSeasonal,
        C_sns_plus_organic: totalSnsOrganic,
        spread_pct: Math.round(maxSpread * 10) / 10,
        spread_warning: maxSpread > 25,
      },
      breakdown: {
        blended_daily_velocity: Math.round(blendedDaily * 10) / 10,
        sns_weekly_shipped: snsWeeklyShipped,
        sns_active_subs: snsActiveSubs,
        organic_daily: Math.round(organicDaily * 10) / 10,
        return_rate_pct: Math.round(returnRate * 1000) / 10,
        holiday_forecast_weeks: Object.keys(holidayFc).length,
      },
      data_quality: {
        velocity_windows: velWindows,
        has_holiday_forecast: Object.keys(holidayFc).length > 0,
        has_sns_data: snsActiveSubs > 0,
        seasonality_weeks: Object.keys(seasonality).length,
      },
      model_version: modelVersion,
      weights,
      accuracy,
      holidays,
      weeks,
      disclaimer: "Planning aid only — not a guarantee. Actual demand may differ materially.",
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
