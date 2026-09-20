import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  biggestLeak,
  channelWindow,
  closedDropOff,
  conversionRate,
  deviceWindow,
  dropOffPath,
  filterAbandoned,
  frictionRollup,
  productLeakFromAbandons,
  recoveryOf,
  stepsOf,
  sumDaily,
  topAbandonedProducts,
  windowBounds,
  DEFINITIONS,
  type AbandonedRow,
  type FunnelWindow,
} from "@/lib/shopify-funnel";

/**
 * GET /api/shopify-funnel?window=7|28&view=health|full
 *
 * Read-only. Aggregates tables the Mini `shopify-funnel-sync` writes.
 * Nothing here calls Shopify and nothing here shells out to Python.
 */
export const dynamic = "force-dynamic";

const SETUP =
  "Run supabase/migration_shopify_funnel.sql, then " +
  "`python -m src.main shopify-funnel-sync` on the Mini. " +
  "The custom app needs read_reports (ShopifyQL) and read_orders " +
  "(abandoned checkouts), plus staff permission manage_abandoned_checkouts " +
  "and Protected customer data Level 2. Do not invent numbers from other analytics.";

async function loadAll<T>(
  sb: ReturnType<typeof getServerSupabase>,
  table: string,
  select: string,
  orderBy: string,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    const r = await sb.from(table).select(select).order(orderBy).range(offset, offset + 999);
    if (r.error) throw new Error(r.error.message);
    const page = (r.data ?? []) as T[];
    rows.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

async function handleGet(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const windowRaw = Number(params.get("window") ?? 7);
  const windowDays: FunnelWindow = windowRaw === 28 ? 28 : 7;
  const view = params.get("view") === "health" ? "health" : "full";

  try {
    const sb = getServerSupabase();

    const abandonSelectCore =
      "checkout_id,checkout_name,checkout_date,created_at,completed_at,total_price,currency,recovered,line_items,line_items_qty,triage_severity,triage_note";
    const abandonSelectExpand =
      abandonSelectCore +
      ",shipping_address_started,billing_address_started,has_discount,discount_codes,discount_amount,has_shipping_rate,payment_attempted,recovery_status";

    const loadAbandons = async () => {
      try {
        return await loadAll<AbandonedRow>(
          sb, "shopify_abandoned_checkouts", abandonSelectExpand, "checkout_date");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/column|schema cache|does not exist/i.test(msg)) {
          return loadAll<AbandonedRow>(
            sb, "shopify_abandoned_checkouts", abandonSelectCore, "checkout_date");
        }
        throw e;
      }
    };

    const [daily, splits, abandons, statusRows] = await Promise.all([
      loadAll<Record<string, unknown>>(
        sb, "shopify_funnel_daily",
        "metric_date,split_kind,split_value,sessions,pdp_sessions,add_to_cart,checkout_started,purchases,source,fetched_at",
        "metric_date",
      ),
      loadAll<Record<string, unknown>>(
        sb, "shopify_funnel_splits",
        "window_days,window_end,split_kind,split_value,sessions,add_to_cart,checkout_started,purchases",
        "window_end",
      ),
      loadAbandons(),
      sb.from("shopify_funnel_status").select(
        "last_synced_at,funnel_ok,abandon_ok,missing_scopes,last_error,last_stats",
      ).eq("id", 1).limit(1),
    ]);

    if (statusRows.error && /shopify_funnel_status/.test(statusRows.error.message)) {
      throw new Error(statusRows.error.message);
    }

    const status = (statusRows.data ?? [])[0] ?? null;
    const allDates = daily
      .filter((r) => String(r.split_kind ?? "all") === "all")
      .map((r) => String(r.metric_date));
    const abandonDates = abandons.map((r) => String(r.checkout_date)).sort();
    const end = allDates.length
      ? allDates[allDates.length - 1]
      : (abandonDates.length ? abandonDates[abandonDates.length - 1] : null);

    if (!end) {
      return Response.json({
        available: true,
        empty: true,
        windowDays,
        setupHint: SETUP,
        status: status ?? null,
        definitions: DEFINITIONS,
      });
    }

    const { start } = windowBounds(end, windowDays);
    const counts = sumDaily(daily, start, end);
    const steps = stepsOf(counts);
    const dropOff = dropOffPath(steps);
    const leak = biggestLeak(counts);
    const windowAbandons = filterAbandoned(abandons, start, end);
    const abandon = recoveryOf(windowAbandons);
    const topProducts = topAbandonedProducts(windowAbandons);
    const devices = deviceWindow(daily, start, end);
    const channels = channelWindow(daily, start, end);
    const friction = frictionRollup(windowAbandons);
    const productLeak = productLeakFromAbandons(windowAbandons);

    const landing = splits
      .filter((r) => String(r.split_kind) === "landing_page"
        && Number(r.window_days) === windowDays)
      .sort((a, b) => Number(b.sessions ?? 0) - Number(a.sessions ?? 0))
      .slice(0, 25)
      .map((r) => ({
        path: String(r.split_value),
        sessions: r.sessions ?? null,
        addToCart: r.add_to_cart ?? null,
        checkoutStarted: r.checkout_started ?? null,
        purchases: r.purchases ?? null,
      }));

    const byDay = daily
      .filter((r) => String(r.split_kind ?? "all") === "all"
        && String(r.metric_date) >= start
        && String(r.metric_date) <= end)
      .map((r) => ({
        date: String(r.metric_date),
        sessions: r.sessions ?? null,
        pdpSessions: r.pdp_sessions ?? null,
        addToCart: r.add_to_cart ?? null,
        checkoutStarted: r.checkout_started ?? null,
        purchases: r.purchases ?? null,
      }));

    return Response.json({
      available: true,
      empty: false,
      windowDays,
      start,
      end,
      funnel: counts,
      steps,
      dropOff,
      closedDropOff: closedDropOff(counts),
      biggestLeak: leak,
      conversionRate: conversionRate(counts.sessions, counts.purchases),
      abandoned: {
        ...abandon,
        topProducts,
        friction,
        productLeak,
        rows: view === "health" ? [] : windowAbandons,
      },
      splits: { device: devices, channel: channels, landingPage: landing },
      byDay: view === "health" ? [] : byDay,
      status: status ?? null,
      definitions: DEFINITIONS,
      setupHint: (status?.missing_scopes as string[] | undefined)?.length
        ? `Shopify denied a query. Grant: ${(status?.missing_scopes as string[]).join(", ")}. ${SETUP}`
        : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({
      available: false,
      error: msg.slice(0, 300),
      setupHint: /shopify_funnel|shopify_abandoned/.test(msg) ? SETUP : null,
      definitions: DEFINITIONS,
    });
  }
}

export async function GET(request: NextRequest) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      resolve(Response.json({
        available: false,
        error: "Warehouse timed out.",
        setupHint: SETUP,
        definitions: DEFINITIONS,
      }));
    }, 8000);
  });
  try {
    return await Promise.race([handleGet(request), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
