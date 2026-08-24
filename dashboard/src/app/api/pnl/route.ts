import { getServerSupabase } from "@/lib/supabase-server";
import { amazonAsOf, amazonToday } from "@/lib/as-of";

interface PnlRow {
  date: string;
  gross_sales: number;
  units: number;
  ad_spend: number;
  est_referral_fees: number;
  est_fba_fees: number;
  est_cogs: number;
  est_contribution: number;
  amazon_net_proceeds: number | null;
  net_after_ads: number;
  status: string;
  meta: string | Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * GET /api/pnl — stored daily contribution (account grain).
 *
 *   contribution = gross_sales - referral - fba - ad_spend - cogs
 *
 * Every field is read as stored by src/pnl.py, which is the single writer. The
 * route does no arithmetic of its own beyond window sums, so the page and the
 * table can never disagree.
 *
 * `amazon_net_proceeds` is Amazon's settlement payout — carried through for
 * cash reconciliation only. It is NOT the daily grain: deposits land roughly
 * twice a month on a posted-date basis.
 */
export async function GET() {
  try {
    const sb = getServerSupabase();

    let daily: PnlRow[] = [];
    try {
      // Account grain is one row per Amazon day. Paginate so a year of
      // history is not silently truncated by PostgREST's default page size
      // (a hard row cap used to hide anything past about thirteen months).
      const PAGE = 1000;
      let offset = 0;
      while (true) {
        const r = await sb.from("pnl_daily").select("*").eq("grain", "account")
          .order("date", { ascending: false })
          .range(offset, offset + PAGE - 1);
        if (r.error) break;
        const page = (r.data ?? []) as PnlRow[];
        daily.push(...page);
        if (page.length < PAGE) break;
        offset += PAGE;
      }
    } catch { /* table may not exist */ }

    // Freshness of the ad-spend input, so the page can flag a partial window.
    let adsDateMax: string | null = null;
    try {
      const r = await sb.from("ads_campaigns_daily").select("date")
        .order("date", { ascending: false }).limit(1);
      if (r.data?.[0]) adsDateMax = String(r.data[0].date);
    } catch { /* */ }

    const parseMeta = (m: PnlRow["meta"]): Record<string, unknown> => {
      if (!m) return {};
      if (typeof m === "object") return m as Record<string, unknown>;
      try { return JSON.parse(m) as Record<string, unknown>; } catch { return {}; }
    };

    const rows = daily.map((r) => {
      const meta = parseMeta(r.meta);
      return {
        ...r,
        fees_basis: typeof meta.fees_basis === "string" ? meta.fees_basis : "estimated",
        cogs_basis: typeof meta.cogs_basis === "string" ? meta.cogs_basis : null,
        settled_payout: typeof meta.settled_payout === "number" ? meta.settled_payout : null,
      };
    });

    // ── Closed-day boundary ──
    // Every window ends at yesterday-in-LA. Today is always partial: sales are
    // still landing and the ads sync only covers through yesterday, so including
    // it would show a day with real COGS and no ad spend.
    const asOf = amazonAsOf();
    const today = amazonToday();
    // Newest day that is actually closed: has a P&L row and ad spend coverage.
    const latestClosed = rows.find(
      (r) => r.date <= asOf && (!adsDateMax || r.date <= adsDateMax)
    )?.date ?? null;

    const historyMin = rows.length
      ? rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date)
      : null;

    return Response.json({
      daily: rows,
      salesDateMax: rows.length ? rows[0].date : null,
      historyMin,
      historyMax: rows.length ? rows[0].date : null,
      historyDays: rows.length,
      adsDateMax,
      asOf,
      today,
      latestClosed,
      /** True when ad spend has not caught up to as-of yet. */
      adsLagging: Boolean(adsDateMax && adsDateMax < asOf),
      timezone: "America/Los_Angeles",
      formula: "gross_sales - referral - fba - ad_spend - cogs",
      adsSource: "ads_campaigns_daily.spend",
    });
  } catch {
    return Response.json({
      daily: [], salesDateMax: null, adsDateMax: null,
      asOf: null, today: null, latestClosed: null, adsLagging: false,
      formula: "gross_sales - referral - fba - ad_spend - cogs",
    });
  }
}
