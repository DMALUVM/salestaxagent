import path from "node:path";

import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/sqp-status — freshness of the organic-rank data the PPC gate reads.
 *
 * Reads the DB directly (fast, no subprocess) and falls back to config on disk
 * for the schedule. Deliberately reports "stale" as its own state: rank older
 * than the configured window gates as unknown, so showing it as merely present
 * would misrepresent what the gate is actually doing.
 */
export async function GET() {
  const out: Record<string, unknown> = { available: false };

  // Config: schedule + ASINs.
  for (const root of [path.join(process.cwd(), ".."), process.cwd()]) {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(path.join(root, "config", "ads_strategy.json"), "utf8");
      const gating = JSON.parse(raw).organic_rank_gating ?? {};
      out.gating = {
        enabled: gating.enabled ?? false,
        staleAfterDays: gating.stale_after_days ?? 14,
        highBidThreshold: gating.high_bid_threshold ?? 2.3,
      };
      out.sqpAuto = gating.sqp_auto ?? null;
      break;
    } catch { /* try next root */ }
  }

  try {
    const sb = getServerSupabase();
    const { data, error } = await sb
      .from("keyword_organic_rank")
      .select("asin,source,as_of,organic_rank")
      .order("as_of", { ascending: false });

    if (error) {
      const missing = /keyword_organic_rank/.test(error.message ?? "");
      out.error = missing ? null : error.message;
      out.setupHint = missing
        ? "Run supabase/migration_organic_rank.sql, then trigger an SQP sync."
        : null;
      return Response.json(out);
    }

    const rows = data ?? [];
    const bySource: Record<string, number> = {};
    const asins = new Set<string>();
    for (const r of rows) {
      const s = String(r.source ?? "unknown");
      bySource[s] = (bySource[s] ?? 0) + 1;
      if (r.asin) asins.add(String(r.asin));
    }
    // Backfill cursor, derived from the data rather than a stored pointer —
    // a cursor drifts after a partial write; the rows cannot.
    const weekEnds = [...new Set(rows.map((r) => String(r.as_of)).filter(Boolean))]
      .sort()
      .reverse();

    const newest = rows.length ? String(rows[0].as_of) : null;
    const staleAfter = Number((out.gating as { staleAfterDays?: number })?.staleAfterDays ?? 14);
    const ageDays = newest
      ? Math.round((Date.now() - Date.parse(`${newest}T00:00:00Z`)) / 86400000)
      : null;

    out.available = true;
    out.keywords = rows.length;
    out.bySource = bySource;
    out.asins = [...asins].sort();
    out.newestAsOf = newest;
    out.weeksStored = weekEnds.length;
    out.weekEnds = weekEnds.slice(0, 20);
    out.oldestAsOf = weekEnds.length ? weekEnds[weekEnds.length - 1] : null;
    out.ageDays = ageDays;
    out.stale = ageDays === null ? true : ageDays > staleAfter;
    return Response.json(out);
  } catch (e) {
    out.error = e instanceof Error ? e.message : "unknown error";
    return Response.json(out);
  }
}
