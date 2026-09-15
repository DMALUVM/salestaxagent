import { getServerSupabase } from "@/lib/supabase-server";
import { amazonAsOf } from "@/lib/as-of";
import {
  REIMBURSEMENTS_DEFAULT_DAYS,
  alertWindow,
  approvalQueryBounds,
  defaultDeskRange,
  inLaRange,
  recentAlertRows,
  type ReimbursementDeskRow,
} from "@/lib/reimbursements-desk";

const SELECT =
  "approval_date,reimbursement_id,case_id,reason,sku,asin,product_name,qty_cash,qty_inventory,qty_total,amount_total,currency";

async function paginateReimbursements(
  sb: ReturnType<typeof getServerSupabase>,
  gte: string,
  lte: string,
): Promise<ReimbursementDeskRow[]> {
  const PAGE = 1000;
  const out: ReimbursementDeskRow[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await sb
      .from("fba_reimbursements")
      .select(SELECT)
      .gte("approval_date", gte)
      .lte("approval_date", lte)
      .order("approval_date", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) {
      if (error.code === "PGRST205") return [];
      throw error;
    }
    const page = (data ?? []) as ReimbursementDeskRow[];
    out.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
    if (offset > 20000) break;
  }
  return out;
}

/**
 * GET /api/reimbursements — paid FBA reimbursements for the desk.
 *
 * Query: start, end as YYYY-MM-DD (Amazon LA calendar). Defaults to the last
 * 90 closed LA days. Alert rows are always the last 7 closed LA days.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const fallback = defaultDeskRange();
    const asOf = amazonAsOf();
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const startParam = url.searchParams.get("start") ?? "";
    const endParam = url.searchParams.get("end") ?? "";
    const start = ymd.test(startParam) ? startParam : fallback.start;
    const end = ymd.test(endParam) ? endParam : fallback.end;
    const rangeStart = start <= end ? start : end;
    const rangeEnd = start <= end ? end : start;
    const alert = alertWindow(asOf);
    const fetchStart = rangeStart < alert.start ? rangeStart : alert.start;
    const fetchEnd = rangeEnd > asOf ? rangeEnd : asOf;
    const bounds = approvalQueryBounds(fetchStart, fetchEnd);

    const sb = getServerSupabase();
    const fetched = await paginateReimbursements(sb, bounds.gte, bounds.lte);
    const inFetch = fetched.filter((r) => inLaRange(r, fetchStart, fetchEnd));
    const rows = inFetch.filter((r) => inLaRange(r, rangeStart, rangeEnd));
    const alerts = recentAlertRows(inFetch, asOf);

    return Response.json({
      asOf,
      start: rangeStart,
      end: rangeEnd,
      alertStart: alert.start,
      defaultDays: REIMBURSEMENTS_DEFAULT_DAYS,
      nightlyDays: REIMBURSEMENTS_DEFAULT_DAYS,
      rows,
      alertRows: alerts,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("not configured")) {
      return Response.json({
        asOf: amazonAsOf(),
        start: defaultDeskRange().start,
        end: defaultDeskRange().end,
        alertStart: alertWindow(amazonAsOf()).start,
        defaultDays: REIMBURSEMENTS_DEFAULT_DAYS,
        nightlyDays: REIMBURSEMENTS_DEFAULT_DAYS,
        rows: [],
        alertRows: [],
      });
    }
    return Response.json({ error: message, rows: [], alertRows: [] }, { status: 500 });
  }
}
