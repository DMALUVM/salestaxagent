import { getServerSupabase } from "@/lib/supabase-server";
import { amazonAsOf, amazonToday } from "@/lib/as-of";
import { buildAmazonMonthlyPnl } from "@/lib/sku-monthly-pnl";
import type { SupabaseClient } from "@supabase/supabase-js";

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

async function paginate<T>(
  load: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  let offset = 0;
  while (true) {
    const r = await load(offset, offset + PAGE - 1);
    if (r.error) break;
    const page = r.data ?? [];
    out.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

/**
 * GET /api/pnl — daily stored contribution plus monthly SKU economics.
 *
 * Daily rows: grain=account from pnl_daily (src/pnl.py). Days with units
 * but $0 sales are dropped — that pattern is a stale/partial write, not a
 * real $0-revenue day.
 *
 * Monthly rows: computed from sales_by_sku (Amazon) × sku_costs + ads.
 * That table already holds 2024-08 → current month, so Month/Year on
 * /profit can show 2024–2026 without a 2-year orders-report pull.
 */
export async function GET() {
  try {
    const sb = getServerSupabase();

    let daily: PnlRow[] = [];
    try {
      daily = await paginate((from, to) =>
        sb.from("pnl_daily").select("*").eq("grain", "account")
          .order("date", { ascending: false })
          .range(from, to),
      );
    } catch { /* table may not exist */ }

    daily = daily.filter((r) => !(Number(r.units) > 0 && Number(r.gross_sales) <= 0));

    let adsDateMax: string | null = null;
    let adsByDay: { date: string; spend: number }[] = [];
    try {
      adsByDay = await paginate((from, to) =>
        sb.from("ads_campaigns_daily").select("date,spend")
          .order("date", { ascending: true })
          .range(from, to),
      );
      if (adsByDay.length) {
        adsDateMax = adsByDay.reduce((m, r) => (r.date > m ? r.date : m), adsByDay[0].date);
      }
    } catch { /* */ }

    let adsByMonth: { period_start: string; spend: number }[] = [];
    try {
      adsByMonth = await paginate((from, to) =>
        sb.from("ads_monthly_spend").select("period_start,spend")
          .order("period_start", { ascending: true })
          .range(from, to),
      );
    } catch { /* table may not exist yet */ }

    const monthly = await loadMonthly(sb, adsByDay, adsByMonth);

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
        source: "daily" as const,
      };
    });

    const asOf = amazonAsOf();
    const today = amazonToday();
    const latestClosed = rows.find(
      (r) => r.date <= asOf && (!adsDateMax || r.date <= adsDateMax)
    )?.date ?? null;

    const historyMin = rows.length
      ? rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date)
      : null;

    return Response.json({
      daily: rows,
      monthly: monthly.months,
      monthlySkus: monthly.skusByMonth,
      skuCoverageMin: monthly.coverageMin,
      skuCoverageMax: monthly.coverageMax,
      skuMissingJan2024: Boolean(
        monthly.coverageMin && monthly.coverageMin > "2024-01",
      ),
      missingCostSkus: monthly.missingCostSkus,
      salesDateMax: rows.length ? rows[0].date : null,
      historyMin,
      historyMax: rows.length ? rows[0].date : null,
      historyDays: rows.length,
      adsDateMax,
      adsDateMin: adsByDay.length
        ? adsByDay.reduce((m, r) => (r.date < m ? r.date : m), adsByDay[0].date)
        : null,
      asOf,
      today,
      latestClosed,
      adsLagging: Boolean(adsDateMax && adsDateMax < asOf),
      timezone: "America/Los_Angeles",
      formula: "gross_sales - referral - fba - ad_spend - cogs",
      adsSource: adsByMonth.length
        ? "ads_monthly_spend (import) then ads_campaigns_daily.spend"
        : "ads_campaigns_daily.spend",
      monthlySource: "sales_by_sku × sku_costs (Amazon)",
      adsImportedMonths: adsByMonth.map((r) => r.period_start),
    });
  } catch {
    return Response.json({
      daily: [], monthly: [], monthlySkus: {},
      salesDateMax: null, adsDateMax: null,
      asOf: null, today: null, latestClosed: null, adsLagging: false,
      formula: "gross_sales - referral - fba - ad_spend - cogs",
    });
  }
}

async function loadMonthly(
  sb: SupabaseClient,
  adsByDay: { date: string; spend: number }[],
  adsByMonth: { period_start: string; spend: number }[] = [],
) {
  const empty = {
    months: [],
    skusByMonth: {} as Record<string, never[]>,
    coverageMin: null as string | null,
    coverageMax: null as string | null,
    missingCostSkus: [] as string[],
  };
  try {
    const skuRows = await paginate((from, to) =>
      sb.from("sales_by_sku").select("channel,sku,period_start,units,gross_sales,product_title,source")
        .eq("channel", "amazon")
        .range(from, to),
    );
    const costs = await paginate((from, to) =>
      sb.from("sku_costs").select("sku,cogs_per_unit").range(from, to),
    );
    return buildAmazonMonthlyPnl({
      skuRows,
      costs,
      adsByDay,
      adsByMonth,
    });
  } catch {
    return empty;
  }
}
