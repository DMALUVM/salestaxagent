import { getServerSupabase } from "@/lib/supabase-server";
import { amazonAsOf } from "@/lib/as-of";
import {
  CASE_QUEUE_DEFAULT_DAYS,
  CASE_QUEUE_GAP,
  CASE_QUEUE_SOURCES,
  SELLER_CENTRAL_LINK_LIMIT,
  defaultCaseRange,
  eventQueryBounds,
  filterNeedsCase,
  inCaseRange,
  recentNeedsCase,
  type CaseEventRow,
} from "@/lib/reimbursements-eligible";
import { alertWindow } from "@/lib/reimbursements-desk";

const SELECT =
  "event_key,source,event_date,sku,asin,fnsku,product_name,quantity,reason,reason_group,fulfillment_center,shipment_id,reference_id,estimated_amount,amount_basis,status,matched_reimbursement_id,matched_reimbursed_qty,seller_central_url,seller_central_link_kind,synced_at";

async function paginateCases(
  sb: ReturnType<typeof getServerSupabase>,
  gte: string,
  lte: string,
): Promise<{ rows: CaseEventRow[]; missing: boolean }> {
  const PAGE = 1000;
  const out: CaseEventRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from("fba_case_events")
      .select(SELECT)
      .gte("event_date", gte)
      .lte("event_date", lte)
      .order("event_date", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) {
      if (error.code === "PGRST205") return { rows: [], missing: true };
      throw error;
    }
    const page = (data ?? []) as CaseEventRow[];
    out.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
    if (offset > 20000) break;
  }
  return { rows: out, missing: false };
}

/**
 * GET /api/reimbursements/eligible — Needs-case queue (not paid cash).
 *
 * Warehouse SoT is fba_case_events, rebuilt from ledger Adjustments +
 * inbound shorts. GET_FBA_REIMBURSEMENTS_DATA (dedupe only) never
 * seeds this queue. Query: start, end as YYYY-MM-DD (Amazon LA).
 * Defaults to last 90 closed LA days.
 */
export async function GET(request: Request) {
  const fallback = defaultCaseRange();
  const asOf = amazonAsOf();
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  try {
    const url = new URL(request.url);
    const startParam = url.searchParams.get("start") ?? "";
    const endParam = url.searchParams.get("end") ?? "";
    const start = ymd.test(startParam) ? startParam : fallback.start;
    const end = ymd.test(endParam) ? endParam : fallback.end;
    const rangeStart = start <= end ? start : end;
    const rangeEnd = start <= end ? end : start;
    const alert = alertWindow(asOf);
    const fetchStart = rangeStart < alert.start ? rangeStart : alert.start;
    const fetchEnd = rangeEnd > asOf ? rangeEnd : asOf;
    const bounds = eventQueryBounds(fetchStart, fetchEnd);

    const sb = getServerSupabase();
    const { rows: fetched, missing } = await paginateCases(sb, bounds.gte, bounds.lte);
    const inFetch = fetched.filter((r) => inCaseRange(r, fetchStart, fetchEnd));
    const windowRows = inFetch.filter((r) => inCaseRange(r, rangeStart, rangeEnd));
    const needs = filterNeedsCase(windowRows);
    const alerts = recentNeedsCase(inFetch, asOf);
    const syncedAt = needs.reduce<string | null>((best, r) => {
      if (r.synced_at && (!best || r.synced_at > best)) return r.synced_at;
      return best;
    }, null);

    return Response.json({
      asOf,
      start: rangeStart,
      end: rangeEnd,
      alertStart: alert.start,
      defaultDays: CASE_QUEUE_DEFAULT_DAYS,
      nightlyDays: CASE_QUEUE_DEFAULT_DAYS,
      tableMissing: missing,
      gap: CASE_QUEUE_GAP,
      sources: CASE_QUEUE_SOURCES,
      sellerCentralLinkLimit: SELLER_CENTRAL_LINK_LIMIT,
      autoSubmit: false,
      syncedAt,
      rows: needs,
      alertRows: alerts,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("not configured")) {
      return Response.json({
        asOf,
        start: fallback.start,
        end: fallback.end,
        alertStart: alertWindow(asOf).start,
        defaultDays: CASE_QUEUE_DEFAULT_DAYS,
        nightlyDays: CASE_QUEUE_DEFAULT_DAYS,
        tableMissing: false,
        gap: CASE_QUEUE_GAP,
        sources: CASE_QUEUE_SOURCES,
        sellerCentralLinkLimit: SELLER_CENTRAL_LINK_LIMIT,
        autoSubmit: false,
        syncedAt: null,
        rows: [],
        alertRows: [],
      });
    }
    return Response.json({ error: message, rows: [], alertRows: [] }, { status: 500 });
  }
}
