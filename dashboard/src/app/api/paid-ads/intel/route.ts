import { getServerSupabase } from "@/lib/supabase-server";
import {
  DECISION_STATUSES, INTEL_FILTERS, INTEL_RANGES, buildIntel,
  adaptGa4LandingDaily, adaptGoogleAdsDaily, adaptGscAppearanceDaily,
  adaptGscPageDaily, adaptGscQueryDaily,
  adaptMetaAdsDaily, isoDate, pickOriginStats, preferApiWhenPresent,
  synthesizeGscChart,
  type ApiTableStats, type CampaignDaily, type DecisionStatus, type GaDaily,
  type IntelDecision, type IntelFilter, type IntelRangeDays, type SearchQueryDaily,
  type WarehouseOrigin,
} from "@/lib/paid-intel";

export const runtime = "nodejs";

const PAGE = 1000;

function isMissing(message: string): boolean {
  return /does not exist|schema cache|PGRST205/i.test(message);
}

type Eq = Record<string, string>;

/**
 * Paged read with optional equality filters and a date floor.
 *
 * Official API tables use metric_date; CSV intel tables use date.
 * Only the window the current range needs is fetched; history spans for
 * the Data panel come from `tableStats`.
 */
async function selectRows(
  table: string,
  opts: {
    eq?: Eq;
    sinceDate?: string | null;
    exactDate?: string;
    dateCol?: string;
  } = {},
): Promise<{ rows: Record<string, unknown>[]; missing: boolean; error: string | null }> {
  const dateCol = opts.dateCol ?? "date";
  try {
    const sb = getServerSupabase();
    const rows: Record<string, unknown>[] = [];
    let offset = 0;
    while (true) {
      let q = sb.from(table).select("*");
      for (const [k, v] of Object.entries(opts.eq ?? {})) q = q.eq(k, v);
      if (opts.exactDate != null) q = q.eq(dateCol, opts.exactDate);
      else if (opts.sinceDate) q = q.gte(dateCol, opts.sinceDate);
      const { data, error } = await q.range(offset, offset + PAGE - 1);
      if (error) {
        if (isMissing(error.message)) return { rows: [], missing: true, error: null };
        return { rows: [], missing: false, error: `${table}: ${error.message}` };
      }
      const page = (data ?? []) as Record<string, unknown>[];
      rows.push(...page);
      if (page.length < PAGE) break;
      offset += PAGE;
    }
    return { rows, missing: false, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isMissing(msg)) return { rows: [], missing: true, error: null };
    return { rows: [], missing: false, error: msg };
  }
}

/** Row count and date span without pulling the rows. */
async function tableStats(
  table: string,
  opts: { eq?: Eq; datedOnly?: boolean; dateCol?: string; fetchedAt?: boolean } = {},
): Promise<ApiTableStats> {
  const dateCol = opts.dateCol ?? "date";
  const empty: ApiTableStats = {
    rows: 0, min_date: null, max_date: null, fetched_at: null, missing: true,
  };
  try {
    const sb = getServerSupabase();
    const base = () => {
      const columns = opts.fetchedAt ? `${dateCol},fetched_at` : dateCol;
      let q = sb.from(table).select(columns, { count: "exact" });
      for (const [k, v] of Object.entries(opts.eq ?? {})) q = q.eq(k, v);
      if (opts.datedOnly) q = q.neq(dateCol, "");
      return q;
    };
    const [minRes, maxRes] = await Promise.all([
      base().order(dateCol, { ascending: true }).limit(1),
      base().order(dateCol, { ascending: false }).limit(1),
    ]);
    if (minRes.error) {
      if (isMissing(minRes.error.message)) return empty;
      return { ...empty, missing: false };
    }
    const minRow = ((minRes.data ?? [])[0] ?? null) as unknown as Record<string, unknown> | null;
    const maxRow = ((maxRes.data ?? [])[0] ?? null) as unknown as Record<string, unknown> | null;
    return {
      rows: minRes.count ?? 0,
      min_date: isoDate(minRow?.[dateCol]) || (typeof minRow?.[dateCol] === "string" ? String(minRow[dateCol]) : null) || null,
      max_date: isoDate(maxRow?.[dateCol]) || (typeof maxRow?.[dateCol] === "string" ? String(maxRow[dateCol]) : null) || null,
      fetched_at: typeof maxRow?.fetched_at === "string" ? maxRow.fetched_at : null,
      missing: false,
    };
  } catch {
    return empty;
  }
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function campRow(r: Record<string, unknown>): CampaignDaily | null {
  const platform = r.platform === "meta" ? "meta" : r.platform === "google" ? "google" : null;
  const date = typeof r.date === "string" ? r.date : "";
  const campaign_name = String(r.campaign_name ?? "").trim();
  if (!platform || !date || !campaign_name) return null;
  return {
    platform,
    date,
    campaign_name,
    campaign_type: (r.campaign_type as CampaignDaily["campaign_type"]) || "Other",
    product: (r.product as CampaignDaily["product"]) || "other",
    is_brand: Boolean(r.is_brand),
    audience: (r.audience as CampaignDaily["audience"]) || "unknown",
    spend: num(r.spend),
    conv_value: num(r.conv_value),
    clicks: num(r.clicks),
    impressions: num(r.impressions),
    conversions: num(r.conversions),
    lost_is_budget: r.lost_is_budget == null ? null : num(r.lost_is_budget),
    lost_is_rank: r.lost_is_rank == null ? null : num(r.lost_is_rank),
    search_impr_share: r.search_impr_share == null ? null : num(r.search_impr_share),
    search_top_is: r.search_top_is == null ? null : num(r.search_top_is),
    frequency: r.frequency == null ? null : num(r.frequency),
    frequency_peak: r.frequency_peak == null ? null : num(r.frequency_peak),
    status: typeof r.status === "string" ? r.status : null,
  };
}

function queryRow(r: Record<string, unknown>): SearchQueryDaily | null {
  const kind = r.kind;
  if (kind !== "query" && kind !== "page" && kind !== "chart" && kind !== "appearance") return null;
  const query = String(r.query ?? "").trim();
  if (!query) return null;
  return {
    kind,
    date: typeof r.date === "string" ? r.date : "",
    query,
    clicks: num(r.clicks),
    impressions: num(r.impressions),
    ctr: r.ctr == null ? null : num(r.ctr),
    position: r.position == null ? null : num(r.position),
  };
}

function decisionRow(r: Record<string, unknown>): IntelDecision | null {
  const card_id = String(r.card_id ?? "").trim();
  const as_of = String(r.as_of ?? "").trim();
  const status = String(r.status ?? "");
  if (!card_id || !as_of || !(DECISION_STATUSES as readonly string[]).includes(status)) return null;
  return {
    card_id,
    as_of,
    status: status as DecisionStatus,
    note: typeof r.note === "string" ? r.note : null,
    applied_at: typeof r.applied_at === "string" ? r.applied_at : null,
    dismissed_at: typeof r.dismissed_at === "string" ? r.dismissed_at : null,
    check: (r.check_json ?? null) as IntelDecision["check"],
    baseline_value: r.baseline_value == null ? null : num(r.baseline_value),
    baseline_as_of: typeof r.baseline_as_of === "string" ? r.baseline_as_of : null,
  };
}

function gaRow(r: Record<string, unknown>): GaDaily | null {
  const date = typeof r.date === "string" ? r.date : "";
  if (!date) return null;
  return {
    date,
    channel_group: String(r.channel_group ?? "(not set)"),
    landing_page: String(r.landing_page ?? "/"),
    device: String(r.device ?? "unknown"),
    sessions: num(r.sessions),
    active_users: num(r.active_users),
    key_events: num(r.key_events),
    revenue: num(r.revenue),
    bounce_rate: r.bounce_rate == null ? null : num(r.bounce_rate),
  };
}

function maxDate(...dates: Array<string | null | undefined>): string | null {
  return dates.filter((d): d is string => Boolean(d)).sort().pop() ?? null;
}

/**
 * GET /api/paid-ads/intel?range=7&filter=all
 * Range is relative to max metric_date / date in the preferred warehouse, not today.
 * Google Ads, GA4, and GSC prefer official API tables. Meta prefers
 * meta_ads_daily when it has rows, otherwise paid_campaign_daily (CSV).
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const rawRange = Number(url.searchParams.get("range") ?? "7");
    const range = (INTEL_RANGES as readonly number[]).includes(rawRange)
      ? rawRange as IntelRangeDays
      : 7;
    const rawFilter = (url.searchParams.get("filter") ?? "all") as IntelFilter;
    const filter = (INTEL_FILTERS as readonly string[]).includes(rawFilter) ? rawFilter : "all";

    const apiOpts = { dateCol: "metric_date", fetchedAt: true };
    const [
      sGoogleApi, sMetaApi, sGaApi, sGscQ, sGscP, sGscAppearApi,
      sGoogleCsv, sMetaCsv, sGaCsv, sTrend, sQuery, sPage, sAppearance,
    ] = await Promise.all([
      tableStats("google_ads_daily", apiOpts),
      tableStats("meta_ads_daily", apiOpts),
      tableStats("ga4_landing_daily", apiOpts),
      tableStats("gsc_query_daily", apiOpts),
      tableStats("gsc_page_daily", apiOpts),
      tableStats("gsc_dim_daily", { ...apiOpts, eq: { dim_kind: "search_appearance" } }),
      tableStats("paid_campaign_daily", { eq: { platform: "google" } }),
      tableStats("paid_campaign_daily", { eq: { platform: "meta" } }),
      tableStats("paid_ga_daily"),
      tableStats("paid_search_query_daily", { eq: { kind: "chart" } }),
      tableStats("paid_search_query_daily", { eq: { kind: "query" } }),
      tableStats("paid_search_query_daily", { eq: { kind: "page" } }),
      tableStats("paid_search_query_daily", { eq: { kind: "appearance" } }),
    ]);

    const googleOrigin: WarehouseOrigin = preferApiWhenPresent(sGoogleApi);
    const metaOrigin: WarehouseOrigin = preferApiWhenPresent(sMetaApi);
    const gaOrigin: WarehouseOrigin = preferApiWhenPresent(sGaApi);
    const gscOrigin: WarehouseOrigin = preferApiWhenPresent({
      rows: sGscQ.rows + sGscP.rows,
      min_date: sGscQ.min_date,
      max_date: maxDate(sGscQ.max_date, sGscP.max_date),
      fetched_at: sGscQ.fetched_at || sGscP.fetched_at,
      missing: sGscQ.missing && sGscP.missing,
    });
    const appearanceOrigin: WarehouseOrigin = preferApiWhenPresent(sGscAppearApi);

    const googleStat = pickOriginStats(googleOrigin, sGoogleApi, sGoogleCsv);
    const metaStat = pickOriginStats(metaOrigin, sMetaApi, sMetaCsv);
    const gaStat = pickOriginStats(gaOrigin, sGaApi, sGaCsv);
    const gscStat = pickOriginStats(gscOrigin, {
      rows: sGscQ.rows + sGscP.rows,
      min_date: sGscQ.min_date && sGscP.min_date
        ? (sGscQ.min_date < sGscP.min_date ? sGscQ.min_date : sGscP.min_date)
        : sGscQ.min_date || sGscP.min_date,
      max_date: maxDate(sGscQ.max_date, sGscP.max_date),
      fetched_at: sGscQ.fetched_at || sGscP.fetched_at,
      missing: sGscQ.missing && sGscP.missing,
    }, {
      rows: sQuery.rows + sPage.rows,
      min_date: null,
      max_date: null,
    });
    const trendStat = pickOriginStats(gscOrigin, {
      rows: sGscQ.rows,
      min_date: sGscQ.min_date,
      max_date: sGscQ.max_date,
      fetched_at: sGscQ.fetched_at,
      missing: sGscQ.missing,
    }, sTrend);

    const stats = {
      google: googleStat,
      meta: metaStat,
      ga4: gaStat,
      gsc_trend: trendStat,
      gsc_snapshot: gscStat,
      gsc_appearance: pickOriginStats(appearanceOrigin, sGscAppearApi, sAppearance),
    };

    const asOf = maxDate(googleStat.max_date, metaStat.max_date, gaStat.max_date, trendStat.max_date);

    // Detectors compare last-7 against prior-7, so always reach one extra week
    // past the selected window. range 0 (All) reads everything.
    const since = asOf && range
      ? shift(asOf, -(Math.max(range, 7) + 7))
      : null;

    const needCsvCampaigns = googleOrigin === "csv" || metaOrigin === "csv";
    const [
      googleApiRes, metaApiRes, csvCampRes,
      gaApiRes, gaCsvRes,
      gscQueryRes, gscPageRes, gscAppearApiRes, csvChartRes, csvSnapRes,
      dRes,
    ] = await Promise.all([
      googleOrigin === "api"
        ? selectRows("google_ads_daily", { sinceDate: since, dateCol: "metric_date" })
        : Promise.resolve({ rows: [], missing: false, error: null }),
      metaOrigin === "api"
        ? selectRows("meta_ads_daily", { sinceDate: since, dateCol: "metric_date" })
        : Promise.resolve({ rows: [], missing: false, error: null }),
      needCsvCampaigns
        ? selectRows("paid_campaign_daily", { sinceDate: since })
        : Promise.resolve({ rows: [], missing: false, error: null }),
      gaOrigin === "api"
        ? selectRows("ga4_landing_daily", { sinceDate: since, dateCol: "metric_date" })
        : Promise.resolve({ rows: [], missing: false, error: null }),
      gaOrigin === "csv"
        ? selectRows("paid_ga_daily", { sinceDate: since })
        : Promise.resolve({ rows: [], missing: false, error: null }),
      gscOrigin === "api"
        ? selectRows("gsc_query_daily", { sinceDate: since, dateCol: "metric_date" })
        : Promise.resolve({ rows: [], missing: false, error: null }),
      gscOrigin === "api"
        ? selectRows("gsc_page_daily", { sinceDate: since, dateCol: "metric_date" })
        : Promise.resolve({ rows: [], missing: false, error: null }),
      appearanceOrigin === "api"
        ? selectRows("gsc_dim_daily", {
          sinceDate: since, dateCol: "metric_date",
          eq: { dim_kind: "search_appearance" },
        })
        : Promise.resolve({ rows: [], missing: false, error: null }),
      gscOrigin === "csv"
        ? selectRows("paid_search_query_daily", { eq: { kind: "chart" }, sinceDate: since })
        : Promise.resolve({ rows: [], missing: false, error: null }),
      gscOrigin === "csv"
        ? selectRows("paid_search_query_daily", { exactDate: "" })
        : selectRows("paid_search_query_daily", { eq: { kind: "appearance" }, exactDate: "" }),
      selectRows("paid_intel_decisions"),
    ]);

    const csvCamps = csvCampRes.rows.map(campRow).filter((r): r is CampaignDaily => Boolean(r));
    const googleCamps = googleOrigin === "api"
      ? googleApiRes.rows.map(adaptGoogleAdsDaily).filter((r): r is CampaignDaily => Boolean(r))
      : csvCamps.filter((r) => r.platform === "google");
    const metaCamps = metaOrigin === "api"
      ? metaApiRes.rows.map(adaptMetaAdsDaily).filter((r): r is CampaignDaily => Boolean(r))
      : csvCamps.filter((r) => r.platform === "meta");

    const ga = gaOrigin === "api"
      ? gaApiRes.rows.map(adaptGa4LandingDaily).filter((r): r is GaDaily => Boolean(r))
      : gaCsvRes.rows.map(gaRow).filter((r): r is GaDaily => Boolean(r));

    const appearance = appearanceOrigin === "api"
      ? gscAppearApiRes.rows.map(adaptGscAppearanceDaily).filter((r): r is SearchQueryDaily => Boolean(r))
      : csvSnapRes.rows
        .map(queryRow)
        .filter((r): r is SearchQueryDaily => r != null && r.kind === "appearance");
    const queries: SearchQueryDaily[] = gscOrigin === "api"
      ? (() => {
        const q = gscQueryRes.rows.map(adaptGscQueryDaily).filter((r): r is SearchQueryDaily => Boolean(r));
        const p = gscPageRes.rows.map(adaptGscPageDaily).filter((r): r is SearchQueryDaily => Boolean(r));
        return [...q, ...p, ...synthesizeGscChart(q), ...appearance];
      })()
      : [...csvSnapRes.rows, ...csvChartRes.rows]
        .map(queryRow)
        .filter((r): r is SearchQueryDaily => Boolean(r))
        .filter((r) => appearanceOrigin !== "api" || r.kind !== "appearance")
        .concat(appearanceOrigin === "api" ? appearance : []);

    const missing = googleOrigin === "csv" && metaOrigin === "csv" && gaOrigin === "csv"
      && csvCampRes.missing && csvSnapRes.missing && gaCsvRes.missing;
    const loadErrors = [
      googleApiRes.error, metaApiRes.error, csvCampRes.error,
      gaApiRes.error, gaCsvRes.error,
      gscQueryRes.error, gscPageRes.error, gscAppearApiRes.error,
      csvChartRes.error, csvSnapRes.error, dRes.error,
    ].filter((e): e is string => Boolean(e));

    const bundle = buildIntel({
      campaigns: [...googleCamps, ...metaCamps],
      queries,
      ga,
      decisions: dRes.rows.map(decisionRow).filter((r): r is IntelDecision => Boolean(r)),
      range,
      filter,
      stats,
    });

    return Response.json({
      ...bundle,
      origins: {
        google: googleOrigin,
        meta: metaOrigin,
        ga4: gaOrigin,
        gsc: gscOrigin,
      },
      migration_needed: missing,
      loadErrors,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ fatalError: msg, loadErrors: [msg] }, { status: 500 });
  }
}
