import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/brand-share — branded vs non-branded weekly rollups.
 *
 * Reads sqp_weekly directly and does the aggregation here so the page renders
 * without a subprocess. The math mirrors src/amazon_ads/brand_rollup.py; the
 * one subtlety worth keeping in sync is that market denominators are counted
 * once per (week, query), never once per ASIN row.
 */
interface WeeklyRow {
  week_start: string;
  query_normalized: string;
  is_branded: boolean;
  asin_purchases: number | null;
  total_purchases: number | null;
}

export async function GET() {
  try {
    const sb = getServerSupabase();
    const { data, error } = await sb
      .from("sqp_weekly")
      .select("week_start,query_normalized,is_branded,asin_purchases,total_purchases")
      .order("week_start", { ascending: true });

    if (error) {
      const missing = /sqp_weekly/.test(error.message ?? "");
      return Response.json({
        available: false,
        setupHint: missing
          ? "Run supabase/migration_sqp_weekly.sql, then `sqp-sync --apply`."
          : null,
        error: missing ? null : error.message,
        weeks: [], opportunities: [], callouts: [],
      });
    }

    const rows = (data ?? []) as WeeklyRow[];
    if (!rows.length) {
      return Response.json({
        available: true, weeks: [], opportunities: [], callouts: [],
        setupHint: "No SQP weeks stored yet — the weekly sync has not run.",
      });
    }

    const n = (v: unknown) => Number(v ?? 0) || 0;
    const weeks = new Map<string, {
      week_start: string;
      brandedPurchases: number; nonBrandedPurchases: number;
      brandedMarket: number; nonBrandedMarket: number;
      brandedQueries: number; nonBrandedQueries: number;
    }>();
    const seenMarket = new Set<string>();

    for (const r of rows) {
      const wk = String(r.week_start ?? "");
      if (!wk) continue;
      let w = weeks.get(wk);
      if (!w) {
        w = { week_start: wk, brandedPurchases: 0, nonBrandedPurchases: 0,
              brandedMarket: 0, nonBrandedMarket: 0,
              brandedQueries: 0, nonBrandedQueries: 0 };
        weeks.set(wk, w);
      }
      if (r.is_branded) w.brandedPurchases += n(r.asin_purchases);
      else w.nonBrandedPurchases += n(r.asin_purchases);

      const key = `${wk}::${r.query_normalized}`;
      if (!seenMarket.has(key)) {
        seenMarket.add(key);
        if (r.is_branded) {
          w.brandedMarket += n(r.total_purchases);
          w.brandedQueries += 1;
        } else {
          w.nonBrandedMarket += n(r.total_purchases);
          w.nonBrandedQueries += 1;
        }
      }
    }

    const series = [...weeks.values()]
      .sort((a, b) => a.week_start.localeCompare(b.week_start))
      .map((w) => {
        const total = w.brandedPurchases + w.nonBrandedPurchases;
        return {
          ...w,
          totalPurchases: total,
          brandedMix: total > 0 ? w.brandedPurchases / total : null,
          brandedShare: w.brandedMarket > 0 ? w.brandedPurchases / w.brandedMarket : null,
          nonBrandedShare:
            w.nonBrandedMarket > 0 ? w.nonBrandedPurchases / w.nonBrandedMarket : null,
        };
      });

    // Opportunities: latest week, non-brand, low share, biggest unclaimed volume.
    const latest = series.length ? series[series.length - 1].week_start : "";
    const agg = new Map<string, { ours: number; market: number; counted: boolean }>();
    for (const r of rows) {
      if (String(r.week_start) !== latest || r.is_branded) continue;
      const q = String(r.query_normalized ?? "");
      if (!q) continue;
      const a = agg.get(q) ?? { ours: 0, market: 0, counted: false };
      a.ours += n(r.asin_purchases);
      if (!a.counted) { a.counted = true; a.market += n(r.total_purchases); }
      agg.set(q, a);
    }
    const opportunities = [...agg.entries()]
      .filter(([, a]) => a.market > 0 && a.ours / a.market <= 0.1)
      .map(([query, a]) => ({
        query, market: a.market, ours: a.ours,
        share: a.ours / a.market, unclaimed: a.market - a.ours,
      }))
      .sort((a, b) => b.unclaimed - a.unclaimed)
      .slice(0, 15);

    const last = series[series.length - 1];
    const callouts: string[] = [];
    if (last?.brandedMix !== null && last?.brandedMix !== undefined && last.brandedMix >= 0.5) {
      callouts.push(
        `${(last.brandedMix * 100).toFixed(0)}% of our purchases come from branded queries — demand is largely people already looking for us, not category discovery.`);
    }
    if (last?.nonBrandedShare !== null && last?.nonBrandedShare !== undefined && last.nonBrandedShare <= 0.05) {
      callouts.push(
        `Non-brand share is ${(last.nonBrandedShare * 100).toFixed(1)}% of the market on queries we appear in — the category is essentially uncaptured.`);
    }
    if (last?.brandedShare && last?.nonBrandedShare) {
      callouts.push(
        `We convert ${(last.brandedShare * 100).toFixed(0)}% of branded demand vs ${(last.nonBrandedShare * 100).toFixed(1)}% of non-brand demand — a ${(last.brandedShare / last.nonBrandedShare).toFixed(0)}x gap.`);
    }

    return Response.json({ available: true, weeks: series, opportunities, callouts });
  } catch (e) {
    return Response.json({
      available: false, weeks: [], opportunities: [], callouts: [],
      error: e instanceof Error ? e.message : "unknown error",
    });
  }
}
