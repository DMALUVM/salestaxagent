import { getServerSupabase } from "@/lib/supabase-server";
import {
  DECISION_STATUSES, INTEL_FILTERS, INTEL_RANGES, buildIntel,
  type CampaignDaily, type DecisionStatus, type GaDaily, type IntelDecision,
  type IntelFilter, type IntelRangeDays, type SearchQueryDaily,
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
 * The warehouse keeps every day ever uploaded (Google goes back to 2023), so
 * reading the whole thing on every page load gets slower forever. Only the
 * window the current range needs is fetched; history spans for the Data panel
 * come from `tableStats`, which reads three rows instead of three thousand.
 */
async function selectRows(
  table: string,
  opts: { eq?: Eq; sinceDate?: string | null; exactDate?: string } = {},
): Promise<{ rows: Record<string, unknown>[]; missing: boolean; error: string | null }> {
  try {
    const sb = getServerSupabase();
    const rows: Record<string, unknown>[] = [];
    let offset = 0;
    while (true) {
      let q = sb.from(table).select("*");
      for (const [k, v] of Object.entries(opts.eq ?? {})) q = q.eq(k, v);
      if (opts.exactDate != null) q = q.eq("date", opts.exactDate);
      else if (opts.sinceDate) q = q.gte("date", opts.sinceDate);
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
  opts: { eq?: Eq; datedOnly?: boolean } = {},
): Promise<{ rows: number; min_date: string | null; max_date: string | null; missing: boolean }> {
  try {
    const sb = getServerSupabase();
    const base = () => {
      let q = sb.from(table).select("date", { count: "exact" });
      for (const [k, v] of Object.entries(opts.eq ?? {})) q = q.eq(k, v);
      if (opts.datedOnly) q = q.neq("date", "");
      return q;
    };
    const [minRes, maxRes] = await Promise.all([
      base().order("date", { ascending: true }).limit(1),
      base().order("date", { ascending: false }).limit(1),
    ]);
    if (minRes.error) {
      if (isMissing(minRes.error.message)) return { rows: 0, min_date: null, max_date: null, missing: true };
      return { rows: 0, min_date: null, max_date: null, missing: false };
    }
    const minRow = (minRes.data ?? [])[0] as { date?: string } | undefined;
    const maxRow = (maxRes.data ?? [])[0] as { date?: string } | undefined;
    return {
      rows: minRes.count ?? 0,
      min_date: minRow?.date || null,
      max_date: maxRow?.date || null,
      missing: false,
    };
  } catch {
    return { rows: 0, min_date: null, max_date: null, missing: true };
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
    frequency: r.frequency == null ? null : num(r.frequency),
    frequency_peak: r.frequency_peak == null ? null : num(r.frequency_peak),
    status: typeof r.status === "string" ? r.status : null,
  };
}

function queryRow(r: Record<string, unknown>): SearchQueryDaily | null {
  const kind = r.kind;
  if (kind !== "query" && kind !== "page" && kind !== "chart") return null;
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

/**
 * GET /api/paid-ads/intel?range=7&filter=all
 * Range is relative to max date in the warehouse, not today.
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

    // Stats first: they give the as-of and the true history span cheaply.
    const [sGoogle, sMeta, sGa, sTrend, sSnap] = await Promise.all([
      tableStats("paid_campaign_daily", { eq: { platform: "google" } }),
      tableStats("paid_campaign_daily", { eq: { platform: "meta" } }),
      tableStats("paid_ga_daily"),
      tableStats("paid_search_query_daily", { eq: { kind: "chart" } }),
      tableStats("paid_search_query_daily", { eq: { date: "" } }),
    ]);
    const stats = {
      google: sGoogle, meta: sMeta, ga4: sGa, gsc_trend: sTrend, gsc_snapshot: sSnap,
    };

    const asOf = [sGoogle.max_date, sMeta.max_date, sGa.max_date]
      .filter((d): d is string => Boolean(d))
      .sort()
      .pop() ?? null;

    // Detectors compare last-7 against prior-7, so always reach one extra week
    // past the selected window. range 0 (All) reads everything.
    const since = asOf && range
      ? shift(asOf, -(Math.max(range, 7) + 7))
      : null;

    const [cRes, chartRes, snapRes, gRes, dRes] = await Promise.all([
      selectRows("paid_campaign_daily", { sinceDate: since }),
      selectRows("paid_search_query_daily", { eq: { kind: "chart" }, sinceDate: since }),
      selectRows("paid_search_query_daily", { exactDate: "" }),
      selectRows("paid_ga_daily", { sinceDate: since }),
      selectRows("paid_intel_decisions"),
    ]);
    const missing = cRes.missing && snapRes.missing && gRes.missing;
    const loadErrors = [cRes.error, chartRes.error, snapRes.error, gRes.error, dRes.error]
      .filter((e): e is string => Boolean(e));

    const bundle = buildIntel({
      campaigns: cRes.rows.map(campRow).filter((r): r is CampaignDaily => Boolean(r)),
      queries: [...snapRes.rows, ...chartRes.rows]
        .map(queryRow).filter((r): r is SearchQueryDaily => Boolean(r)),
      ga: gRes.rows.map(gaRow).filter((r): r is GaDaily => Boolean(r)),
      decisions: dRes.rows.map(decisionRow).filter((r): r is IntelDecision => Boolean(r)),
      range,
      filter,
      stats,
    });

    return Response.json({
      ...bundle,
      migration_needed: missing,
      loadErrors,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ fatalError: msg, loadErrors: [msg] }, { status: 500 });
  }
}
