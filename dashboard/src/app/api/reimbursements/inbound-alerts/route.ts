import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { amazonAsOf } from "@/lib/as-of";
import {
  CASE_QUEUE_DEFAULT_DAYS,
  HOW_TO_FILE_INBOUND,
  NEEDS_CASE_HREF,
  STATUS_CASE_SUBMITTED,
  defaultCaseRange,
  eventQueryBounds,
  filterInboundAlerts,
  inCaseRange,
  isFbaShipmentId,
  normalizeCaseRow,
  type CaseEventRow,
} from "@/lib/reimbursements-eligible";

const SELECT =
  "event_key,source,event_date,sku,asin,fnsku,product_name,quantity,quantity_shipped,quantity_received,reason,reason_group,fulfillment_center,shipment_id,reference_id,disposition,estimated_amount,amount_basis,status,seller_central_url,seller_central_link_kind,synced_at,classification_version,dismissed_at,dismissed_note";

const SELECT_FALLBACK =
  "event_key,source,event_date,sku,asin,fnsku,product_name,quantity,reason,reason_group,fulfillment_center,shipment_id,reference_id,disposition,estimated_amount,amount_basis,status,seller_central_url,seller_central_link_kind,synced_at,classification_version";

/**
 * GET /api/reimbursements/inbound-alerts
 *
 * Active Lost_Inbound / inbound-discrepancy shorts for Overview.
 * Warehouse SoT is fba_case_events (Sellerboard-upserted rows included).
 * Never calls Sellerboard. WORKING / IN_TRANSIT never land as needs_case.
 */
export async function GET() {
  const asOf = amazonAsOf();
  const range = defaultCaseRange();
  try {
    const sb = getServerSupabase();
    const bounds = eventQueryBounds(range.start, range.end);
    const first = await sb
      .from("fba_case_events")
      .select(SELECT)
      .gte("event_date", bounds.gte)
      .lte("event_date", bounds.lte)
      .eq("status", "needs_case")
      .order("event_date", { ascending: false })
      .limit(2000);
    let data: CaseEventRow[] | null = (first.data ?? null) as CaseEventRow[] | null;
    let error = first.error;
    if (error && (error.code === "PGRST204" || (error.message || "").includes("quantity_shipped"))) {
      const retry = await sb
        .from("fba_case_events")
        .select(SELECT_FALLBACK)
        .gte("event_date", bounds.gte)
        .lte("event_date", bounds.lte)
        .eq("status", "needs_case")
        .order("event_date", { ascending: false })
        .limit(2000);
      data = (retry.data ?? null) as CaseEventRow[] | null;
      error = retry.error;
    }
    if (error) {
      if (error.code === "PGRST205") {
        return Response.json({
          asOf,
          href: NEEDS_CASE_HREF,
          howTo: HOW_TO_FILE_INBOUND,
          tableMissing: true,
          alerts: [],
        });
      }
      throw error;
    }
    const rows = ((data ?? []) as CaseEventRow[])
      .filter((r) => inCaseRange(r, range.start, range.end))
      .map(normalizeCaseRow);
    const alerts = filterInboundAlerts(rows);
    return Response.json({
      asOf,
      start: range.start,
      end: range.end,
      href: NEEDS_CASE_HREF,
      howTo: HOW_TO_FILE_INBOUND,
      defaultDays: CASE_QUEUE_DEFAULT_DAYS,
      tableMissing: false,
      alerts,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("not configured")) {
      return Response.json({
        asOf,
        href: NEEDS_CASE_HREF,
        howTo: HOW_TO_FILE_INBOUND,
        tableMissing: false,
        alerts: [],
      });
    }
    return Response.json({ error: message, alerts: [] }, { status: 500 });
  }
}

/**
 * POST /api/reimbursements/inbound-alerts
 *
 * Dave dismisses an Overview inbound alert after filing. Marks the
 * Needs-case row case_submitted (evidence kept). Never writes to Amazon.
 * Body: { event_key: string, note?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { event_key?: string; note?: string };
    const key = String(body.event_key ?? "").trim();
    if (!key) {
      return Response.json({ ok: false, error: "event_key required" }, { status: 400 });
    }
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 400) : "";
    const now = new Date().toISOString();
    const sb = getServerSupabase();
    const { data: existing, error: readError } = await sb
      .from("fba_case_events")
      .select("event_key,status,shipment_id,sku,reason,source")
      .eq("event_key", key)
      .maybeSingle();
    if (readError) {
      if (readError.code === "PGRST205") {
        return Response.json({
          ok: false,
          error: "fba_case_events is missing — apply supabase/migration_fba_case_queue.sql",
        }, { status: 503 });
      }
      throw readError;
    }
    if (!existing) {
      return Response.json({ ok: false, error: "event not found" }, { status: 404 });
    }
    const status = String(existing.status ?? "");
    if (status === "already_reimbursed" || status === "found_offset") {
      return Response.json({
        ok: true,
        persisted: true,
        event_key: key,
        status,
        amazonWrite: false,
      });
    }
    const patch: Record<string, unknown> = {
      status: STATUS_CASE_SUBMITTED,
      dismissed_at: now,
    };
    if (note) patch.dismissed_note = note;
    const { error } = await sb
      .from("fba_case_events")
      .update(patch)
      .eq("event_key", key);
    if (error) {
      if ((error.message || "").includes("dismissed_at") || error.code === "PGRST204") {
        const fallback = await sb
          .from("fba_case_events")
          .update({ status: STATUS_CASE_SUBMITTED })
          .eq("event_key", key);
        if (fallback.error) throw fallback.error;
      } else {
        throw error;
      }
    }
    return Response.json({
      ok: true,
      persisted: true,
      event_key: key,
      status: STATUS_CASE_SUBMITTED,
      shipment_id: isFbaShipmentId(existing.shipment_id) ? existing.shipment_id : null,
      amazonWrite: false,
    });
  } catch (e) {
    return Response.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      amazonWrite: false,
    }, { status: 500 });
  }
}
