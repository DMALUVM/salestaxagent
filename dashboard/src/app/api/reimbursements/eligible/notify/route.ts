import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { amazonAsOf } from "@/lib/as-of";
import {
  REESE_AGENT_ID,
  REESE_AGENT_NAME,
  REESE_PACKAGE_CONTRACT,
  CLASSIFICATION_VERSION,
  MINI_RESYNC_HINT,
  NOTIFY_BLOCK_COPY,
  buildReesePackage,
  defaultCaseRange,
  evaluateCaseQa,
  eventQueryBounds,
  filterNeedsCase,
  inCaseRange,
  normalizeCaseRow,
  notifyGateErrors,
  type CaseEventRow,
} from "@/lib/reimbursements-eligible";

/**
 * POST /api/reimbursements/eligible/notify
 *
 * Build a fba_case_package/v1 payload for Reese · Reimbursements and
 * persist it on fba_case_packages for Reese · Reimbursements
 * (74a7ce8a-6754-4bf1-90aa-afa1f4cd774c). Dana / SendToAgent can
 * forward the markdown or JSON. This endpoint does not ping Cursor
 * Cloud itself (no in-repo SendToAgent) and never auto-files cases.
 *
 * Body: { start?, end?, event_keys?: string[], source?: string }
 * Omit event_keys to package every Needs-case row in the window.
 */
export async function POST(request: NextRequest) {
  const fallback = defaultCaseRange();
  const asOf = amazonAsOf();
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  try {
    const body = await request.json().catch(() => ({}));
    const startParam = String(body.start ?? "");
    const endParam = String(body.end ?? "");
    const start = ymd.test(startParam) ? startParam : fallback.start;
    const end = ymd.test(endParam) ? endParam : fallback.end;
    const rangeStart = start <= end ? start : end;
    const rangeEnd = start <= end ? end : start;
    const keys = Array.isArray(body.event_keys)
      ? body.event_keys.map((k: unknown) => String(k)).filter(Boolean)
      : [];
    const source = typeof body.source === "string" && body.source.trim()
      ? body.source.trim()
      : "dashboard";

    const sb = getServerSupabase();
    const bounds = eventQueryBounds(rangeStart, rangeEnd);
    const { data, error } = await sb
      .from("fba_case_events")
      .select("*")
      .gte("event_date", bounds.gte)
      .lte("event_date", bounds.lte)
      .eq("status", "needs_case")
      .order("event_date", { ascending: false })
      .limit(2000);

    if (error) {
      if (error.code === "PGRST205") {
        return Response.json(
          {
            error: "fba_case_events is missing — apply supabase/migration_fba_case_queue.sql",
            contract: REESE_PACKAGE_CONTRACT,
            auto_submit: false,
          },
          { status: 503 },
        );
      }
      throw error;
    }

    const storedNeeds = ((data ?? []) as CaseEventRow[])
      .filter((r) => inCaseRange(r, rangeStart, rangeEnd))
      .map(normalizeCaseRow)
      .filter((r) => r.status === "needs_case" && Number(r.quantity ?? 0) > 0);
    let rows = filterNeedsCase(storedNeeds);
    if (keys.length) {
      const want = new Set(keys);
      rows = rows.filter((r) => want.has(r.event_key));
    }

    const qa = evaluateCaseQa(keys.length ? rows : storedNeeds);
    const gate = notifyGateErrors(rows, qa);
    if (gate.length) {
      return Response.json(
        {
          ok: false,
          error: NOTIFY_BLOCK_COPY,
          qa: { ...qa, ok: false, errors: gate },
          errors: gate,
          contract: REESE_PACKAGE_CONTRACT,
          auto_submit: false,
          classificationVersion: CLASSIFICATION_VERSION,
          hint: MINI_RESYNC_HINT,
        },
        { status: 422 },
      );
    }

    const pkg = buildReesePackage(rows, {
      asOf,
      start: rangeStart,
      end: rangeEnd,
      source,
    });

    let packageId: string | null = null;
    const { data: stored, error: storeErr } = await sb
      .from("fba_case_packages")
      .insert({
        target_agent_id: REESE_AGENT_ID,
        target_agent_name: REESE_AGENT_NAME,
        event_keys: pkg.events.map((e) => e.event_key),
        payload_markdown: pkg.markdown,
        payload_json: pkg,
        source,
      })
      .select("id")
      .single();
    if (!storeErr) packageId = stored?.id ?? null;

    try {
      await sb.from("audit_log").insert({
        action: "reimbursements_case_notify",
        category: "ops",
        details: {
          package_id: packageId,
          events: pkg.summary.events,
          target_agent_id: REESE_AGENT_ID,
          source,
        },
      });
    } catch {
      /* best-effort */
    }

    return Response.json({
      ok: true,
      package_id: packageId,
      contract: REESE_PACKAGE_CONTRACT,
      auto_submit: false,
      classificationVersion: CLASSIFICATION_VERSION,
      qa,
      target: pkg.target,
      as_of: pkg.as_of,
      start: pkg.start,
      end: pkg.end,
      summary: pkg.summary,
      events: pkg.events,
      markdown: pkg.markdown,
      json: pkg,
      hint:
        packageId
          ? "Package stored on fba_case_packages. Forward markdown/json to Reese · Reimbursements. Desk does not auto-submit cases."
          : "Package built but fba_case_packages insert failed — still returning the payload for Dana to forward.",
    });
  } catch (e) {
    return Response.json(
      {
        error: e instanceof Error ? e.message : String(e),
        contract: REESE_PACKAGE_CONTRACT,
        auto_submit: false,
      },
      { status: 500 },
    );
  }
}
