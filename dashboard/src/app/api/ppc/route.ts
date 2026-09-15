import { getServerSupabase } from "@/lib/supabase-server";
import { amazonAsOf, amazonToday, windowStart } from "@/lib/as-of";
import {
  classifyCampaign, roleLabels, roleOrder, roleDescriptions, roleConfigSource,
} from "@/lib/ads-roles";
import { loadMergedStrategy, roleTargetOf, shareStatusOf } from "@/lib/ads-strategy-settings";
import { decisionPatch, isMarkableStatus } from "@/lib/ppc-mark";
import { buildDailyReconcile } from "@/lib/ads-reconcile";
import { cvrPct, emptyWeeklyList } from "@/lib/ppc-weekly";
import type { WeeklyLockDecision } from "@/lib/ppc-weekly";
import {
  BLAKE_RECOVERY_0905_END,
  BLAKE_RECOVERY_0905_START,
  buildBlakeRecovery0905List,
} from "@/lib/ppc-weekly-blake-recovery-0905";
import { buildBleeders10, emptyBleeders10 } from "@/lib/ppc-bleeders-10";
import { adsSnapshotFromWarehouse } from "@/lib/ppc-bleeders-10-ads";
import type { WeeklyCampaignRef, WeeklyPlacementRef, WeeklyTermRef } from "@/lib/ppc-weekly-blake-recovery-0905";
import { loadSoldScopeKeywordIntel } from "@/lib/soldscope-load";
import { attachKeywordIntel } from "@/lib/soldscope-status";
import { scoreSearchTermActions } from "@/lib/ppc-actions-generate";

/** Raw per-day rollup of ads_campaigns_daily (all campaigns summed). */
interface DailyBase {
  date: string;
  spend: number;
  ad_sales: number;
  orders: number;
  clicks: number;
  impressions: number;
}

/** DailyBase + Amazon sales for that day and the derived ratios. */
interface DailyPoint extends DailyBase {
  amazon_sales: number;
  /** null when the denominator is 0 — the chart draws a gap, never a fake 0. */
  acos: number | null;
  roas: number | null;
  tacos: number | null;
}

interface KPIs {
  spend: number;
  adSales: number;
  orders: number;
  clicks: number;
  impressions: number;
  acos: number;
  roas: number;
  cpc: number;
  cvr: number;
  totalSales: number;
  tacos: number;
}

/** SP | SB | SD. Rows written before the SB/SD sync existed have no type and
 *  are Sponsored Products by definition — that is all the sync ever fetched. */
function campaignTypeOf(c: Record<string, unknown>): string {
  const t = String(c.campaign_type ?? "").trim().toUpperCase();
  return t || "SP";
}

function aggregate(rows: DailyBase[], totalSales: number): KPIs {
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  const adSales = rows.reduce((s, r) => s + r.ad_sales, 0);
  const orders = rows.reduce((s, r) => s + r.orders, 0);
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  return {
    spend, adSales, orders, clicks, impressions,
    acos: adSales > 0 ? (spend / adSales) * 100 : 0,
    roas: spend > 0 ? adSales / spend : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cvr: clicks > 0 ? (orders / clicks) * 100 : 0,
    totalSales,
    tacos: totalSales > 0 ? (spend / totalSales) * 100 : 0,
  };
}

/** GET /api/ppc — Server-side aggregated KPIs, daily series, search terms, recs. */
export async function GET() {
  try {
    const sb = getServerSupabase();

    // ── Window bounds — the same closed-day boundary Contribution P&L uses ──
    // As-of is yesterday in America/Los_Angeles (the Amazon/ads reporting day),
    // and every window is inclusive: [asOf - (n-1) .. asOf], so "7D" is always
    // 7 whole closed days.
    //
    // These used to be derived from `new Date().toISOString()`. That is a UTC
    // date, so from 00:00 UTC (17:00 Pacific) the cutoff advanced a day while
    // LA was still on the previous date — "7D" quietly became 6 days of ads and
    // under-reported spend against the P&L for seven hours every evening.
    const asOf = amazonAsOf();
    const cutoffs = {
      "7d": windowStart(asOf, 7),
      "14d": windowStart(asOf, 14),
      "30d": windowStart(asOf, 30),
      "90d": windowStart(asOf, 90),
    };

    // ── Fetch ALL campaign-daily rows (paginated — ~150 campaigns/day, so 90d
    //    is ~13k rows and blows past PostgREST's 1,000-row default). Narrow
    //    select: the client never sees these rows, only the rollups below. ──
    // campaign_type is SP | SB | SD. Every rollup below sums across all three
    // — the console's totals do too — but the campaign table and the by-type
    // panel surface it so a Sponsored Brands line is never mistaken for a
    // Sponsored Products one.
    const CAMPAIGN_COLS =
      "date,campaign_id,campaign_name,campaign_type,campaign_status,spend,sales_14d,orders_14d,clicks,impressions";
    // Errors encountered while loading. An empty page must mean "the database
    // has no rows", never "a query failed" — conflating the two is what turned
    // a runtime bug into a confident "No Ads data yet" on a table with 12,000
    // rows in it.
    const loadErrors: string[] = [];

    let allCampaignRows: Array<Record<string, unknown>> = [];
    try {
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const r = await sb.from("ads_campaigns_daily").select(CAMPAIGN_COLS)
          // Bounded to the widest window the page can show. The unbounded
          // version paged the entire table (12k+ rows, 13 sequential requests)
          // for data no range could display.
          .gte("date", cutoffs["90d"])
          .order("date", { ascending: true })
          .order("campaign_id", { ascending: true })   // full PK — see placement note
          .range(offset, offset + pageSize - 1);
        if (r.error) throw new Error(r.error.message);
        const page = r.data ?? [];
        allCampaignRows = allCampaignRows.concat(page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }
    } catch (e) {
      loadErrors.push(`ads_campaigns_daily: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── Amazon sales per day from sales_daily (drives TACOS, KPI + daily) ──
    //    Bounded to the widest window (90d) and paginated. This is a date
    //    filter, not a row cap — every day inside any window is still summed.
    const salesByDate = new Map<string, number>();
    try {
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const r = await sb.from("sales_daily").select("sale_date,gross_sales")
          .eq("channel", "amazon")
          .gte("sale_date", cutoffs["90d"])
          .order("sale_date", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (r.error) throw new Error(r.error.message);
        const page = r.data ?? [];
        for (const row of page) {
          const d = String(row.sale_date ?? "");
          salesByDate.set(d, (salesByDate.get(d) ?? 0) + Number(row.gross_sales ?? 0));
        }
        if (page.length < pageSize) break;
        offset += pageSize;
      }
    } catch (e) {
      // TACOS divides by these. A silent failure would render every TACOS as
      // 0% rather than as unavailable.
      loadErrors.push(`sales_daily: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── Build daily series from campaign rows (server-side rollup) ──
    const dailyMap = new Map<string, DailyBase>();
    for (const c of allCampaignRows) {
      const d = String(c.date ?? "");
      if (!d) continue;
      const entry = dailyMap.get(d) ?? { date: d, spend: 0, ad_sales: 0, orders: 0, clicks: 0, impressions: 0 };
      entry.spend += Number(c.spend ?? 0);
      entry.ad_sales += Number(c.sales_14d ?? 0);
      entry.orders += Number(c.orders_14d ?? 0);
      entry.clicks += Number(c.clicks ?? 0);
      entry.impressions += Number(c.impressions ?? 0);
      dailyMap.set(d, entry);
    }
    const dailyBase = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // Attach Amazon sales + the derived per-day ratios. Ratios are null (not 0)
    // when the denominator is 0 so the chart can break the line instead of
    // drawing a fake trough. TACOS = ad spend / Amazon sales — same definition
    // as the KPI card, just scoped to a single day.
    // Anything after as-of is an open day: today's ads are still accruing and
    // its Amazon sales are partial, so it is not a complete point on the series
    // and must not land in a KPI window.
    const dailySeries: DailyPoint[] = dailyBase
      .filter(d => d.date <= asOf)
      .map(d => {
        const amazonSales = salesByDate.get(d.date) ?? 0;
        return {
          ...d,
          amazon_sales: amazonSales,
          acos: d.ad_sales > 0 ? (d.spend / d.ad_sales) * 100 : null,
          roas: d.spend > 0 ? d.ad_sales / d.spend : null,
          tacos: amazonSales > 0 ? (d.spend / amazonSales) * 100 : null,
        };
      });

    // ── Date range info ──
    const dateMin = dailySeries.length ? dailySeries[0].date : null;
    const dateMax = dailySeries.length ? dailySeries[dailySeries.length - 1].date : null;
    const daysInDb = dailySeries.length;

    // ── Compute KPIs for 7D / 14D / 30D / 90D windows ──
    // Inclusive on both ends: [cutoff .. asOf]. The upper bound is what keeps a
    // partial today out of the totals, and what makes a "7D" window exactly 7
    // closed days no matter what the server's UTC clock says.
    function kpisForRange(days: 7 | 14 | 30 | 90) {
      const c = cutoffs[`${days}d` as keyof typeof cutoffs];
      const filtered = dailyBase.filter(r => r.date >= c && r.date <= asOf);
      let totalSales = 0;
      for (const [d, g] of salesByDate) {
        if (d >= c && d <= asOf) totalSales += g;
      }
      return { kpis: aggregate(filtered, totalSales), days: filtered.length };
    }

    const kpi7 = kpisForRange(7);
    const kpi14 = kpisForRange(14);
    const kpi30 = kpisForRange(30);
    const kpi90 = kpisForRange(90);

    // ── Campaign-level aggregation per KPI range ──
    // The 7D/14D/30D/90D toggle used to change the KPI strip while the
    // Campaigns table always summed the full 90d pull. Same bounds as
    // rolesByRange / searchTermsByRange so the toggle means one window.
    function campaignsFor(from: string) {
      const campaignAgg: Record<string, {
        spend: number; sales: number; orders: number; clicks: number;
        impressions: number; type: string;
      }> = {};
      for (const c of allCampaignRows) {
        const d = String(c.date ?? "");
        if (!d || d < from || d > asOf) continue;
        const name = String(c.campaign_name ?? "");
        if (!name) continue;
        if (!campaignAgg[name]) {
          campaignAgg[name] = {
            spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0,
            type: campaignTypeOf(c),
          };
        }
        campaignAgg[name].spend += Number(c.spend ?? 0);
        campaignAgg[name].sales += Number(c.sales_14d ?? 0);
        campaignAgg[name].orders += Number(c.orders_14d ?? 0);
        campaignAgg[name].clicks += Number(c.clicks ?? 0);
        campaignAgg[name].impressions += Number(c.impressions ?? 0);
      }
      return Object.entries(campaignAgg)
        .map(([name, d]) => ({
          campaign_name: name, ...d,
          campaign_type: d.type,
          role: classifyCampaign(name),
          acos: d.sales > 0 ? (d.spend / d.sales) * 100 : 0,
          roas: d.spend > 0 ? d.sales / d.spend : 0,
          cvr: d.clicks > 0 ? (d.orders / d.clicks) * 100 : 0,
        }))
        .sort((a, b) => b.spend - a.spend);
    }

    // ── Budget by role and Placement, computed for EVERY range ──
    // Both panels key off the same `cutoffs` the KPI cards and chart use, and
    // the server ships one bucket per range. The client picks a bucket by the
    // selected toggle, so it can never apply its own bounds and disagree with
    // the numbers beside it.
    // Target bands come from config/ads_strategy.json deep-merged with any
    // operator overrides saved from the dashboard, so the bands the UI shows
    // and the ones the nightly Python job reads are the same document.
    const strategy = await loadMergedStrategy(sb);

    const RANGE_KEYS = ["7d", "14d", "30d", "90d"] as const;
    type RangeKey = typeof RANGE_KEYS[number];
    const kpiByRange: Record<RangeKey, { kpis: KPIs; days: number }> = {
      "7d": kpi7, "14d": kpi14, "30d": kpi30, "90d": kpi90,
    };

    /** Role rollup over [from .. asOf]. Classification is unchanged — name
     *  patterns from config/ads_strategy.json via classifyCampaign(). */
    /** Spend/clicks/sales split by ad product over [from .. asOf].
     *  The KPI cards stay account-wide totals (SP+SB+SD, matching the console);
     *  this is the breakdown that shows where those totals came from. */
    function typesFor(from: string, windowSpend: number) {
      const agg: Record<string, {
        spend: number; sales: number; clicks: number; orders: number;
        campaigns: Set<string>;
      }> = {};
      for (const c of allCampaignRows) {
        const d = String(c.date ?? "");
        if (!d || d < from || d > asOf) continue;
        const t = campaignTypeOf(c);
        const e = agg[t] ?? { spend: 0, sales: 0, clicks: 0, orders: 0, campaigns: new Set<string>() };
        e.spend += Number(c.spend ?? 0);
        e.sales += Number(c.sales_14d ?? 0);
        e.clicks += Number(c.clicks ?? 0);
        e.orders += Number(c.orders_14d ?? 0);
        e.campaigns.add(String(c.campaign_name ?? ""));
        agg[t] = e;
      }
      return ["SP", "SB", "SD"].filter((t) => agg[t]).map((t) => {
        const e = agg[t];
        return {
          type: t,
          label: { SP: "Sponsored Products", SB: "Sponsored Brands", SD: "Sponsored Display" }[t] ?? t,
          campaigns: e.campaigns.size,
          spend: Math.round(e.spend * 100) / 100,
          sales: Math.round(e.sales * 100) / 100,
          clicks: e.clicks,
          orders: e.orders,
          spendSharePct: windowSpend > 0 ? Math.round((e.spend / windowSpend) * 1000) / 10 : 0,
          acos: e.sales > 0 ? Math.round((e.spend / e.sales) * 1000) / 10 : null,
          cpc: e.clicks > 0 ? Math.round((e.spend / e.clicks) * 100) / 100 : null,
        };
      });
    }

    function rolesFor(from: string, amazonSales: number, windowSpend: number) {
      const agg: Record<string, {
        spend: number; sales: number; clicks: number; orders: number;
        campaigns: Set<string>; days: Set<string>;
      }> = {};
      for (const c of allCampaignRows) {
        const d = String(c.date ?? "");
        if (!d || d < from || d > asOf) continue;
        const name = String(c.campaign_name ?? "");
        const role = classifyCampaign(name);
        const e = agg[role] ?? {
          spend: 0, sales: 0, clicks: 0, orders: 0,
          campaigns: new Set<string>(), days: new Set<string>(),
        };
        e.spend += Number(c.spend ?? 0);
        e.sales += Number(c.sales_14d ?? 0);
        e.clicks += Number(c.clicks ?? 0);
        e.orders += Number(c.orders_14d ?? 0);
        e.campaigns.add(name);
        e.days.add(d);
        agg[role] = e;
      }
      const totalSpend = Object.values(agg).reduce((s, e) => s + e.spend, 0);
      const rows = roleOrder().filter((r) => agg[r]).map((r) => {
        const e = agg[r];
        const share = totalSpend > 0 ? (e.spend / totalSpend) * 100 : 0;
        return {
          role: r,
          label: roleLabels()[r] ?? r,
          description: roleDescriptions()[r] ?? null,
          campaigns: e.campaigns.size,
          daysWithData: e.days.size,
          spend: Math.round(e.spend * 100) / 100,
          sales: Math.round(e.sales * 100) / 100,
          clicks: e.clicks,
          orders: e.orders,
          budgetSharePct: Math.round(share * 10) / 10,
          acos: e.sales > 0 ? Math.round((e.spend / e.sales) * 1000) / 10 : null,
          roas: e.spend > 0 ? Math.round((e.sales / e.spend) * 100) / 100 : null,
          cvr: e.clicks > 0 ? Math.round((e.orders / e.clicks) * 1000) / 10 : null,
          // TACoS = this role's spend over TOTAL Amazon sales for the SAME
          // window: an additive slice of revenue, not a share of TACoS.
          tacos: amazonSales > 0 ? Math.round((e.spend / amazonSales) * 10000) / 100 : null,
          // Config-driven target band; the UI renders the verdict only.
          targetSharePct: roleTargetOf(strategy.merged, r),
          shareStatus: shareStatusOf(strategy.merged, r, share),
        };
      });

      // Any spend the classifier did not attribute to a role. classifyCampaign
      // has a configured default so this is normally zero, but it is computed
      // from the window's own totals rather than assumed, so the identity
      // sum(roles) + other = account is always checkable.
      const uncategorisedSpend = Math.max(0, windowSpend - totalSpend);
      const other = uncategorisedSpend > 0.005 ? {
        spend: Math.round(uncategorisedSpend * 100) / 100,
        budgetSharePct: windowSpend > 0 ? Math.round((uncategorisedSpend / windowSpend) * 1000) / 10 : 0,
        tacos: amazonSales > 0 ? Math.round((uncategorisedSpend / amazonSales) * 10000) / 100 : null,
      } : null;

      // Reconciliation, computed from UNROUNDED spend so the sum cannot drift
      // from the account figure by rounding.
      const accountTacos = amazonSales > 0 ? (windowSpend / amazonSales) * 100 : null;
      const roleTacosSum = amazonSales > 0 ? (totalSpend / amazonSales) * 100 : null;
      return {
        rows,
        other,
        reconciliation: {
          accountTacos: accountTacos === null ? null : Math.round(accountTacos * 100) / 100,
          roleTacosSum: roleTacosSum === null ? null : Math.round(roleTacosSum * 100) / 100,
          otherTacos: other?.tacos ?? 0,
          roleSpend: Math.round(totalSpend * 100) / 100,
          accountSpend: Math.round(windowSpend * 100) / 100,
          amazonSales: Math.round(amazonSales * 100) / 100,
        },
      };
    }

    const rolesByRange = Object.fromEntries(
      RANGE_KEYS.map((k) => [k, rolesFor(
        cutoffs[k], kpiByRange[k].kpis.totalSales, kpiByRange[k].kpis.spend,
      )])
    ) as Record<RangeKey, ReturnType<typeof rolesFor>>;

    const adTypesByRange = Object.fromEntries(
      RANGE_KEYS.map((k) => [k, typesFor(cutoffs[k], kpiByRange[k].kpis.spend)])
    ) as Record<RangeKey, ReturnType<typeof typesFor>>;

    const campaignsByRange = Object.fromEntries(
      RANGE_KEYS.map((k) => [k, campaignsFor(cutoffs[k])]),
    ) as Record<RangeKey, ReturnType<typeof campaignsFor>>;
    const campaigns = campaignsByRange["90d"];

    // ── Placement rows (optional table) ──
    // Fetched once over the widest window, then aggregated per range in memory
    // — one query, four buckets, identical bounds.
    let placementRows: Array<Record<string, unknown>> = [];
    let placementsAvailable = false;
    try {
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        // ORDER BY the full primary key, not just date. Range pagination
        // without a deterministic order lets Postgres return rows in any
        // sequence between requests, so a page boundary silently drops and
        // duplicates rows. That is what made the placement panel sum to ~$1,960
        // against a $2,800.73 header off identical underlying data. `date`
        // alone is not enough: ~350 placement rows share each date, so a page
        // boundary lands mid-date where the order is still undefined.
        const { data, error } = await sb.from("ads_placement_daily")
          .select("date,campaign_id,placement,spend,sales_14d,orders_14d,clicks,impressions")
          .gte("date", cutoffs["90d"]).lte("date", asOf)
          .order("date", { ascending: true })
          .order("campaign_id", { ascending: true })
          .order("placement", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (error) throw error;
        placementsAvailable = true;
        const page = data ?? [];
        placementRows = placementRows.concat(page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }
    } catch (e) {
      // A genuinely absent table is a setup state; anything else is a fault and
      // must be reported rather than rendered as "no placement data".
      const msg = e instanceof Error ? e.message : String(e);
      placementsAvailable = false;
      placementRows = [];
      if (!/ads_placement_daily/.test(msg) || !/does not exist|schema cache/.test(msg)) {
        loadErrors.push(`ads_placement_daily: ${msg}`);
      }
    }

    function placementsFor(from: string) {
      const agg: Record<string, {
        spend: number; sales: number; clicks: number; orders: number;
        impressions: number; days: Set<string>;
      }> = {};
      for (const r of placementRows) {
        const d = String(r.date ?? "");
        if (!d || d < from || d > asOf) continue;
        const p = String(r.placement ?? "Unknown");
        const e = agg[p] ?? { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0, days: new Set<string>() };
        e.spend += Number(r.spend ?? 0);
        e.sales += Number(r.sales_14d ?? 0);
        e.clicks += Number(r.clicks ?? 0);
        e.orders += Number(r.orders_14d ?? 0);
        e.impressions += Number(r.impressions ?? 0);
        e.days.add(d);
        agg[p] = e;
      }
      const totalSpend = Object.values(agg).reduce((s, e) => s + e.spend, 0);
      return Object.entries(agg).map(([placement, e]) => ({
        placement,
        spend: Math.round(e.spend * 100) / 100,
        sales: Math.round(e.sales * 100) / 100,
        clicks: e.clicks,
        orders: e.orders,
        impressions: e.impressions,
        daysWithData: e.days.size,
        sharePct: totalSpend > 0 ? Math.round((e.spend / totalSpend) * 1000) / 10 : 0,
        acos: e.sales > 0 ? Math.round((e.spend / e.sales) * 1000) / 10 : null,
        cvr: e.clicks > 0 ? Math.round((e.orders / e.clicks) * 1000) / 10 : null,
        cpc: e.clicks > 0 ? Math.round((e.spend / e.clicks) * 100) / 100 : null,
      })).sort((a, b) => b.spend - a.spend);
    }

    // Spend reconciliation per range: which ad products contributed, and
    // whether the placement rows account for the whole campaign total.
    // Placement data is Sponsored Products only, so SB/SD spend can never
    // appear there — that difference is reported as `unallocated` rather than
    // left as an unexplained mismatch between two panels on the same page.
    const spendScopeByRange = Object.fromEntries(
      RANGE_KEYS.map((k) => {
        const from = cutoffs[k];
        const total = kpiByRange[k].kpis.spend;
        let placementSpend = 0;
        for (const r of placementRows) {
          const d = String(r.date ?? "");
          if (!d || d < from || d > asOf) continue;
          placementSpend += Number(r.spend ?? 0);
        }
        const present = new Set(
          allCampaignRows
            .filter((c) => {
              const d = String(c.date ?? "");
              return d >= from && d <= asOf;
            })
            .map((c) => campaignTypeOf(c)),
        );
        return [k, {
          total,
          placementSpend,
          unallocated: Math.round((total - placementSpend) * 100) / 100,
          productsPresent: ["SP", "SB", "SD"].filter((t) => present.has(t)),
          productsMissing: ["SP", "SB", "SD"].filter((t) => !present.has(t)),
        }];
      }),
    ) as Record<RangeKey, {
      total: number; placementSpend: number; unallocated: number;
      productsPresent: string[]; productsMissing: string[];
    }>;

    const placementsByRange = Object.fromEntries(
      RANGE_KEYS.map((k) => [k, placementsFor(cutoffs[k])])
    ) as Record<RangeKey, ReturnType<typeof placementsFor>>;


    // ── Search terms, aggregated ──
    //
    // The previous version selected raw DAILY rows with `.limit(300)` and no
    // date filter, so one term appeared once per (date, campaign, ad group) and
    // the table read as if a single query were running in a dozen different
    // campaigns. Totals were also double-counted across days, and the selected
    // range was ignored entirely.
    //
    // Now: one row per search term for the chosen window, carrying its campaign
    // breakdown for the drilldown and its per-day series for the "by day"
    // expansion. Rolled up server-side so the client never re-derives totals and
    // cannot disagree with the KPI cards.
    interface TermCampaign {
      campaign_id: string; campaign_name: string;
      spend: number; sales: number; orders: number; clicks: number;
      ad_groups: string[];
    }
    interface TermDay {
      date: string; spend: number; sales: number; orders: number; clicks: number;
    }
    interface TermAgg {
      search_term: string;
      /** Lowercased/collapsed — the join key the organic-rank gate uses. */
      term_key: string;
      match_types: string[];
      spend: number; sales: number; orders: number; clicks: number; impressions: number;
      campaign_count: number;
      campaigns: TermCampaign[];
      days: TermDay[];
    }

    const termKey = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

    let termRows: Array<Record<string, unknown>> = [];
    try {
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const r = await sb.from("ads_search_terms_daily")
          .select("date,search_term,campaign_id,campaign_name,ad_group_id,ad_group_name," +
                  "keyword,match_type,spend,sales_14d,orders_14d,clicks,impressions")
          .gte("date", cutoffs["90d"]).lte("date", asOf)
          .order("date", { ascending: true })
          .order("search_term", { ascending: true })
          .order("campaign_id", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (r.error) throw new Error(r.error.message);
        // Cast through unknown: the generated row type is not assignable to the
        // loose Record shape this aggregation uses.
        const page = (r.data ?? []) as unknown as Array<Record<string, unknown>>;
        termRows = termRows.concat(page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }
    } catch (e) {
      loadErrors.push(`ads_search_terms_daily: ${e instanceof Error ? e.message : String(e)}`);
    }

    /** Roll daily rows up to one entry per term for [from .. asOf]. */
    function termsFor(from: string, limit = 250): TermAgg[] {
      const byTerm = new Map<string, TermAgg>();
      const campIdx = new Map<string, Map<string, TermCampaign>>();
      const dayIdx = new Map<string, Map<string, TermDay>>();

      for (const r of termRows) {
        const d = String(r.date ?? "");
        if (!d || d < from || d > asOf) continue;
        const term = String(r.search_term ?? "");
        if (!term) continue;
        const key = termKey(term);

        let t = byTerm.get(key);
        if (!t) {
          t = { search_term: term, term_key: key, match_types: [],
                spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0,
                campaign_count: 0, campaigns: [], days: [] };
          byTerm.set(key, t);
          campIdx.set(key, new Map());
          dayIdx.set(key, new Map());
        }

        const spend = Number(r.spend ?? 0);
        const sales = Number(r.sales_14d ?? 0);
        const orders = Number(r.orders_14d ?? 0);
        const clicks = Number(r.clicks ?? 0);
        t.spend += spend; t.sales += sales; t.orders += orders;
        t.clicks += clicks; t.impressions += Number(r.impressions ?? 0);

        const mt = String(r.match_type ?? "").toLowerCase();
        if (mt && !t.match_types.includes(mt)) t.match_types.push(mt);

        // Per campaign — the drilldown. Keyed on campaign_id so two campaigns
        // sharing a name stay distinct.
        const cid = String(r.campaign_id ?? "");
        const camps = campIdx.get(key)!;
        let c = camps.get(cid);
        if (!c) {
          c = { campaign_id: cid, campaign_name: String(r.campaign_name ?? ""),
                spend: 0, sales: 0, orders: 0, clicks: 0, ad_groups: [] };
          camps.set(cid, c);
        }
        c.spend += spend; c.sales += sales; c.orders += orders; c.clicks += clicks;
        const ag = String(r.ad_group_name ?? "");
        if (ag && !c.ad_groups.includes(ag)) c.ad_groups.push(ag);

        // Per day — only revealed when the user expands, never the default view.
        const days = dayIdx.get(key)!;
        let dd = days.get(d);
        if (!dd) { dd = { date: d, spend: 0, sales: 0, orders: 0, clicks: 0 }; days.set(d, dd); }
        dd.spend += spend; dd.sales += sales; dd.orders += orders; dd.clicks += clicks;
      }

      const out: TermAgg[] = [];
      for (const [key, t] of byTerm) {
        const camps = [...campIdx.get(key)!.values()].sort((a, b) => b.spend - a.spend);
        t.campaigns = camps;
        t.campaign_count = camps.length;
        t.days = [...dayIdx.get(key)!.values()].sort((a, b) => a.date.localeCompare(b.date));
        t.match_types.sort();
        out.push(t);
      }
      out.sort((a, b) => b.spend - a.spend);
      return out.slice(0, limit);
    }

    const searchTermsByRange = Object.fromEntries(
      RANGE_KEYS.map((k) => [k, termsFor(cutoffs[k])]),
    ) as Record<RangeKey, TermAgg[]>;

    // Back-compat for any caller still reading the flat list.
    // Reassigned after SoldScope volume attach so 7d and by-range stay in sync.
    let searchTerms = searchTermsByRange["7d"];

    // ── This week: Blake Recovery Sep 5 (66 rows). ST ~60d through
    //    2026-09-04. Do not call buildBleeders. Recommend-only — nothing
    //    writes to Amazon. ──
    const inBlake = (d: string) => d >= BLAKE_RECOVERY_0905_START && d <= BLAKE_RECOVERY_0905_END;

    const campaignById = new Map<string, WeeklyCampaignRef>();
    for (const r of allCampaignRows) {
      const d = String(r.date ?? "");
      if (!inBlake(d)) continue;
      const id = String(r.campaign_id ?? "");
      const name = String(r.campaign_name ?? "");
      if (!id || !name) continue;
      campaignById.set(id, { campaign_id: id, campaign_name: name });
    }
    const termLookup: WeeklyTermRef[] = [];
    for (const r of termRows) {
      const d = String(r.date ?? "");
      if (!inBlake(d)) continue;
      const id = String(r.campaign_id ?? "");
      const name = String(r.campaign_name ?? "");
      if (id && name && !campaignById.has(id)) {
        campaignById.set(id, { campaign_id: id, campaign_name: name });
      }
      termLookup.push({
        search_term: String(r.search_term ?? ""),
        campaign_id: id,
        campaign_name: name,
        ad_group_name: String(r.ad_group_name ?? ""),
        keyword: String(r.keyword ?? ""),
        match_type: String(r.match_type ?? ""),
        clicks: Number(r.clicks ?? 0),
        spend: Number(r.spend ?? 0),
        sales: Number(r.sales_14d ?? 0),
      });
    }
    const placementLookup: WeeklyPlacementRef[] = [];
    for (const r of placementRows) {
      const d = String(r.date ?? "");
      if (!inBlake(d)) continue;
      const id = String(r.campaign_id ?? "");
      if (id && !campaignById.has(id)) {
        campaignById.set(id, { campaign_id: id, campaign_name: "" });
      }
      placementLookup.push({
        campaign_id: id,
        campaign_name: campaignById.get(id)?.campaign_name ?? "",
        placement: String(r.placement ?? ""),
        clicks: Number(r.clicks ?? 0),
        spend: Number(r.spend ?? 0),
        sales: Number(r.sales_14d ?? 0),
      });
    }

    let campOrders = 0;
    let campClicks = 0;
    for (const r of allCampaignRows) {
      const d = String(r.date ?? "");
      if (!inBlake(d)) continue;
      campOrders += Number(r.orders_14d ?? 0);
      campClicks += Number(r.clicks ?? 0);
    }
    const accountCvr = cvrPct(campOrders, campClicks) ?? 0;

    let decisions: WeeklyLockDecision[] = [];
    try {
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const r = await sb.from("ads_action_decisions")
          .select("id,campaign_id,search_term,action_type,status,applied_at,dismissed_at,entity_name,rec_type")
          .gte("as_of_date", BLAKE_RECOVERY_0905_START)
          .order("as_of_date", { ascending: false })
          .range(offset, offset + pageSize - 1);
        if (r.error) throw new Error(r.error.message);
        const page = (r.data ?? []) as WeeklyLockDecision[];
        decisions = decisions.concat(page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }
    } catch { /* learning table may be absent */ }

    const bleeders = buildBlakeRecovery0905List({
      lookup: {
        campaigns: [...campaignById.values()],
        terms: termLookup,
        placements: placementLookup,
      },
      decisions,
      account_cvr: Math.round(accountCvr * 100) / 100,
    });

    // Bleeders 1.0 — pasted 10. Secondary triage. Not This week.
    // Do not re-aggregate. Do not expand to 22. No 2.0.
    // Ads-truth reconcile from ads_negatives / ads_keyword_targets.
    const ads = await loadBleeders10AdsSnapshot(sb);
    const bleeders10 = buildBleeders10({ decisions, ads });

    const ssIntel = await loadSoldScopeKeywordIntel(sb);
    const attachTerms = (rows: TermAgg[]) => attachKeywordIntel(
      rows as unknown as Record<string, unknown>[],
      (t) => String(t.search_term ?? t.term_key ?? ""),
      ssIntel,
    ) as unknown as TermAgg[];
    for (const key of RANGE_KEYS) {
      searchTermsByRange[key] = attachTerms(searchTermsByRange[key]);
    }
    searchTerms = searchTermsByRange["7d"];
    if (bleeders10.rows?.length) {
      bleeders10.rows = attachKeywordIntel(
        bleeders10.rows as unknown as Record<string, unknown>[],
        (t) => String(t.search_term ?? t.keyword ?? ""),
        ssIntel,
      ) as unknown as typeof bleeders10.rows;
    }

    // ── Recommendations (paginated — a limit here would under-count the
    //    "Actions (N)" badge, which must match what is actually open) ──
    let recommendations: unknown[] = [];
    try {
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const r = await sb.from("ads_recommendations").select("*")
          .eq("status", "open")
          .order("impact_estimate", { ascending: false })
          .range(offset, offset + pageSize - 1);
        if (r.error) throw new Error(r.error.message);
        const page = r.data ?? [];
        recommendations = recommendations.concat(page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }
    } catch { /* */ }

    // ── Last sync from job_runs ──
    // The scheduler writes one row per ads job (campaigns / search terms /
    // backfill), and the CLI still writes ads_sync, so all of them count.
    // Only finished runs qualify: a row stuck in "running" would otherwise
    // report a sync that never landed as the freshest one.
    const ADS_JOBS = ["ads_sync", "ads_campaigns_sync", "ads_search_terms_sync",
                      "ads_search_terms_backfill", "ads_campaigns_backfill"];
    let lastSync: string | null = null;
    let lastSyncJob: string | null = null;
    let lastSyncStatus: string | null = null;
    try {
      const r = await sb.from("job_runs")
        .select("job_name,status,started_at,finished_at")
        .in("job_name", ADS_JOBS)
        .in("status", ["success", "partial", "fail"])
        .order("started_at", { ascending: false })
        .limit(1);
      if (r.data?.[0]) {
        lastSync = r.data[0].started_at;
        lastSyncJob = r.data[0].job_name;
        lastSyncStatus = r.data[0].status;
      }
    } catch { /* */ }

    // Last successful actions run — the queue refreshes on a schedule, so the
    // page can say when, instead of implying a manual Generate is required.
    let lastActions: string | null = null;
    // Break-even target ACOS for the quick-review line. Read from the last
    // actions run rather than recomputed here: the break-even formula lives in
    // src/amazon_ads/strategy.py and must not be duplicated in the dashboard.
    let targetAcos: number | null = null;
    let targetAcosAsOf: string | null = null;
    try {
      const r = await sb.from("job_runs").select("started_at,stats")
        .eq("job_name", "ads_actions").eq("status", "success")
        .order("started_at", { ascending: false }).limit(1);
      if (r.data?.[0]) {
        lastActions = r.data[0].started_at;
        const stats = r.data[0].stats as { target_acos?: unknown } | null;
        if (stats && typeof stats.target_acos === "number") {
          targetAcos = stats.target_acos;
          targetAcosAsOf = r.data[0].started_at;
        }
      }
    } catch { /* */ }

    // Per-day reconcile for the 7D window — surfaces partial SP-only days vs console.
    const dailyReconcile = buildDailyReconcile(
      allCampaignRows as Parameters<typeof buildDailyReconcile>[0],
      asOf,
      7,
      7,
    );

    return Response.json({
      kpi7: kpi7.kpis, kpi7Days: kpi7.days,
      kpi14: kpi14.kpis, kpi14Days: kpi14.days,
      kpi30: kpi30.kpis, kpi30Days: kpi30.days,
      kpi90: kpi90.kpis, kpi90Days: kpi90.days,
      dailySeries, cutoffs,
      asOf, today: amazonToday(), timezone: "America/Los_Angeles",
      /** Newest day with ad data at or before as-of. */
      adsThrough: dateMax,
      dateMin, dateMax, daysInDb,
      campaigns, campaignsByRange, roleConfigSource: roleConfigSource(),
      strategy: {
        isCustom: strategy.isCustom,
        storageAvailable: strategy.storageAvailable,
        updatedAt: strategy.updatedAt,
      },
      loadErrors,
      rolesByRange, adTypesByRange, spendScopeByRange, dailyReconcile,
      placementsByRange, placementsAvailable,
      searchTerms, searchTermsByRange, recommendations,
      bleeders,
      bleeders10,
      lastSync, lastSyncJob, lastSyncStatus, lastActions,
      targetAcos, targetAcosAsOf,
    });
  } catch (e) {
    // The whole route failed. Say so — the page must not present this as an
    // empty account.
    return Response.json({
      fatalError: e instanceof Error ? e.message : "unknown error",
      loadErrors: [],
      kpi7: null, kpi14: null, kpi30: null, kpi90: null,
      dailySeries: [], cutoffs: null, campaigns: [], campaignsByRange: null,
      rolesByRange: null, adTypesByRange: null, spendScopeByRange: null,
      dailyReconcile: null,
      placementsByRange: null, placementsAvailable: false,
      strategy: null,
      searchTerms: [], searchTermsByRange: null, recommendations: [],
      bleeders: emptyWeeklyList(),
      bleeders10: emptyBleeders10(),
      asOf: null, today: null, adsThrough: null,
      lastSyncJob: null, lastSyncStatus: null, lastActions: null,
      dateMin: null, dateMax: null, daysInDb: 0, lastSync: null,
    });
  }
}

async function pageAdsTable(
  sb: ReturnType<typeof getServerSupabase>,
  table: string,
  cols: string,
  order: string,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (true) {
    const r = await sb.from(table).select(cols)
      .order(order, { ascending: true })
      .range(offset, offset + 999);
    if (r.error) {
      const msg = r.error.message || "";
      if (/does not exist|schema cache|PGRST/i.test(msg)) return [];
      throw new Error(`${table}: ${msg}`);
    }
    const page = (r.data ?? []) as unknown as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

/** Live keyword/negative snapshots — first SoT for Bleeders 1.0 already-applied. */
async function loadBleeders10AdsSnapshot(
  sb: ReturnType<typeof getServerSupabase>,
) {
  const NEG_COLS =
    "negative_id,campaign_id,campaign_name,ad_group_id,keyword,match_type,state,level,snapshot_at";
  const NEG_COLS_BASE =
    "negative_id,campaign_id,campaign_name,ad_group_id,keyword,match_type,state,level";
  const KW_COLS =
    "keyword_id,campaign_id,campaign_name,ad_group_id,keyword_text,match_type,state,snapshot_at";
  const KW_COLS_BASE =
    "keyword_id,campaign_id,campaign_name,ad_group_id,keyword_text,match_type,state";
  const META_COLS = "campaign_id,campaign_name";

  let negatives: Array<Record<string, unknown>> = [];
  let keywords: Array<Record<string, unknown>> = [];
  let campaigns: Array<Record<string, unknown>> = [];
  try {
    negatives = await pageAdsTable(sb, "ads_negatives", NEG_COLS, "negative_id");
    if (negatives.length === 0) {
      negatives = await pageAdsTable(sb, "ads_negatives", NEG_COLS_BASE, "negative_id");
    }
  } catch {
    try {
      negatives = await pageAdsTable(sb, "ads_negatives", NEG_COLS_BASE, "negative_id");
    } catch { /* snapshot optional until migration */ }
  }
  try {
    keywords = await pageAdsTable(sb, "ads_keyword_targets", KW_COLS, "keyword_id");
    if (keywords.length === 0) {
      keywords = await pageAdsTable(sb, "ads_keyword_targets", KW_COLS_BASE, "keyword_id");
    }
  } catch {
    try {
      keywords = await pageAdsTable(sb, "ads_keyword_targets", KW_COLS_BASE, "keyword_id");
    } catch { /* snapshot optional until migration */ }
  }
  try {
    campaigns = await pageAdsTable(sb, "ads_campaign_meta", META_COLS, "campaign_id");
  } catch { /* optional name→id map */ }

  return adsSnapshotFromWarehouse({ negatives, keywords, campaigns });
}

/** POST /api/ppc — Update rec status OR generate recommendations. */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Generate recommendations action
    if (body.action === "generate") {
      const targetAcos = Number(body.target_acos);
      if (!Number.isFinite(targetAcos) || targetAcos <= 0 || targetAcos > 200) {
        return Response.json({ ok: false, error: "target_acos must be a number between 1 and 200" }, { status: 400 });
      }
      const rangeDays = Number(body.range_days);
      if (![7, 14, 30, 90].includes(rangeDays)) {
        return Response.json({ ok: false, error: "range_days must be one of 7, 14, 30, 90" }, { status: 400 });
      }

      const sb = getServerSupabase();
      const asOf = amazonAsOf();
      const cutoff = windowStart(asOf, rangeDays);

      // Warehouse max date — if ST lags the closed as-of, 0-order cards must
      // not ship as P0 gospel. Queried separately so freshness is not inferred
      // from the window slice alone.
      let stFreshThrough: string | null = null;
      try {
        const hi = await sb.from("ads_search_terms_daily")
          .select("date").order("date", { ascending: false }).limit(1);
        stFreshThrough = hi.data?.[0]?.date ? String(hi.data[0].date) : null;
      } catch { /* */ }

      // Load search terms inside the closed window, paginated — the PostgREST
      // 1,000-row default would silently truncate the input set and generate
      // recommendations from partial spend. Upper bound is as-of: today is
      // still accruing and is never scored.
      const TERM_COLS = "date,search_term,campaign_id,campaign_name,ad_group_id,ad_group_name,keyword,match_type,spend,sales_14d,orders_14d,clicks";
      const terms: Array<Record<string, unknown>> = [];
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await sb.from("ads_search_terms_daily")
          .select(TERM_COLS)
          .gte("date", cutoff)
          .lte("date", asOf)
          .order("date", { ascending: true })
          .order("search_term", { ascending: true })
          .order("campaign_id", { ascending: true })
          .range(offset, offset + pageSize - 1);
        if (error) {
          return Response.json({ ok: false, error: `Could not read search terms: ${error.message}` }, { status: 500 });
        }
        const page = data ?? [];
        terms.push(...page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }

      if (!terms.length) {
        // Distinguish "nothing synced" from "nothing inside this window" —
        // and do NOT clear the existing recommendations on the way out.
        let available: string | null = null;
        try {
          const [lo, hi] = await Promise.all([
            sb.from("ads_search_terms_daily").select("date").order("date", { ascending: true }).limit(1),
            sb.from("ads_search_terms_daily").select("date").order("date", { ascending: false }).limit(1),
          ]);
          const min = lo.data?.[0]?.date, max = hi.data?.[0]?.date;
          if (min && max) available = min === max ? String(min) : `${min} → ${max}`;
        } catch { /* */ }
        return Response.json({
          ok: true, count: 0,
          window: { days: rangeDays, start: cutoff, end: asOf, from: cutoff,
            as_of: asOf, st_fresh_through: stFreshThrough, closed_days_only: true,
            attribution: "orders_14d" },
          message: available
            ? `No search term data in the ${rangeDays} closed-day window ${cutoff} → ${asOf} (available: ${available}) — run Ads sync or pick a wider range`
            : "No search term data — run Ads sync first",
        });
      }

      // Same rules as src/amazon_ads/actions_engine.py — closed LA days,
      // orders_14d attribution, pause when Exact KW = term, no stale 0-order P0.
      const recs = scoreSearchTermActions({
        rows: terms,
        targetAcos,
        lookbackDays: rangeDays,
        asOf,
        stFreshThrough,
      });
      const win = {
        days: rangeDays, start: cutoff, end: asOf, from: cutoff,
        as_of: asOf, st_fresh_through: stFreshThrough, closed_days_only: true,
        attribution: "orders_14d",
      };

      // Replace the open queue. Both writes are checked: an unchecked insert
      // after a successful delete would wipe the queue and still report ok.
      const del = await sb.from("ads_recommendations").delete().eq("status", "open");
      if (del.error) {
        return Response.json({ ok: false, error: `Could not clear old recommendations: ${del.error.message}` }, { status: 500 });
      }
      for (let i = 0; i < recs.length; i += 500) {
        const ins = await sb.from("ads_recommendations").insert(recs.slice(i, i + 500));
        if (ins.error) {
          return Response.json({
            ok: false,
            error: `Saved ${i} of ${recs.length} recommendations, then failed: ${ins.error.message}`,
          }, { status: 500 });
        }
      }

      return Response.json({
        ok: true, count: recs.length,
        window: { ...win, rows: terms.length },
        target_acos: targetAcos,
      });
    }

    // Update status — same two-table write as /api/ppc/mark and ads-mark.
    // Kept so older clients that POST {id,status} here still close the loop.
    const { id, status } = body;
    if (!id || !status) return Response.json({ ok: false, error: "id and status required" }, { status: 400 });

    if (!isMarkableStatus(String(status))) {
      return Response.json({ ok: false, error: "invalid status" }, { status: 400 });
    }
    const sb = getServerSupabase();

    let rec: { decision_id?: string | null; type?: string; entity_name?: string;
               campaign_id?: string } | null = null;
    try {
      const r = await sb.from("ads_recommendations")
        .select("decision_id,type,entity_name,campaign_id").eq("id", id).limit(1);
      rec = r.data?.[0] ?? null;
    } catch { /* column absent until migration_ads_learning.sql is run */ }

    const upd = await sb.from("ads_recommendations").update({ status }).eq("id", id);
    if (upd.error) return Response.json({ ok: false, error: upd.error.message }, { status: 500 });

    let decisionId: string | null = rec?.decision_id ? String(rec.decision_id) : null;
    if (!decisionId && rec) {
      try {
        const found = await sb.from("ads_action_decisions")
          .select("id")
          .eq("rec_type", rec.type)
          .eq("entity_name", rec.entity_name ?? "")
          .eq("campaign_id", String(rec.campaign_id ?? ""))
          .order("as_of_date", { ascending: false })
          .limit(1);
        decisionId = found.data?.[0]?.id ? String(found.data[0].id) : null;
      } catch { /* learning tables may be absent */ }
    }

    let decisionLogged = false;
    const patch = decisionPatch(String(status), new Date().toISOString());
    if (decisionId && patch && (status === "applied" || status === "dismissed")) {
      try {
        const d = await sb.from("ads_action_decisions").update(patch).eq("id", decisionId);
        decisionLogged = !d.error;
      } catch { /* learning tables not present yet */ }
    }
    return Response.json({ ok: true, decisionLogged, decisionId });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
