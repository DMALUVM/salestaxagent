import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { isImpliedFilingId } from "@/lib/next-due";

type FilingPatch = {
  status: string;
  filed_amount?: number | null;
  filed_notes?: string | null;
  filed_date?: string | null;
};

async function advanceLastFiledThrough(
  sb: ReturnType<typeof getServerSupabase>,
  stateCode: string,
  periodEnd: string | null | undefined,
) {
  if (!periodEnd) return;
  const { data: nexus } = await sb
    .from("nexus_status")
    .select("last_filed_through")
    .eq("state_code", stateCode)
    .limit(1);
  if (!nexus?.[0]) return;
  const current = nexus[0].last_filed_through ?? "";
  if (periodEnd > current) {
    await sb
      .from("nexus_status")
      .update({ last_filed_through: periodEnd })
      .eq("state_code", stateCode);
  }
}

/**
 * POST /api/calendar
 *
 * Service-role writes for Filing Calendar (mark filed / undo / not-required /
 * bulk). Mirrors the previous browser-anon filing_calendar + last_filed_through
 * updates so UI behaviour stays the same.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = String(body.action ?? "");
  const sb = getServerSupabase();
  const today = new Date().toISOString().slice(0, 10);

  try {
    if (action === "file") {
      const id = body.id;
      if (id == null || id === "") {
        return Response.json({ error: "id required" }, { status: 400 });
      }
      const amount = body.amount;
      const patch: FilingPatch = {
        status: "filed",
        filed_amount:
          amount === null || amount === undefined || amount === ""
            ? null
            : Number(amount),
        filed_notes: body.notes ? String(body.notes) : null,
        filed_date: today,
      };
      if (patch.filed_amount !== null && !Number.isFinite(patch.filed_amount)) {
        return Response.json({ error: "Invalid amount" }, { status: 400 });
      }
      if (!isImpliedFilingId(String(id))) {
        const { error } = await sb.from("filing_calendar").update(patch).eq("id", id);
        if (error) return Response.json({ error: error.message }, { status: 500 });
      }
      await advanceLastFiledThrough(
        sb,
        String(body.state_code ?? ""),
        body.period_end ? String(body.period_end) : null,
      );
      return Response.json({ ok: true, action, id });
    }

    if (action === "undo") {
      const id = body.id;
      if (id == null || id === "") {
        return Response.json({ error: "id required" }, { status: 400 });
      }
      const { error } = await sb
        .from("filing_calendar")
        .update({
          status: "pending",
          filed_amount: null,
          filed_notes: null,
          filed_date: null,
        })
        .eq("id", id);
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ ok: true, action, id });
    }

    if (action === "not_required") {
      const id = body.id;
      if (id == null || id === "") {
        return Response.json({ error: "id required" }, { status: 400 });
      }
      const notes = String(body.notes ?? "").trim() || "marked not required by user";
      const { error } = await sb
        .from("filing_calendar")
        .update({ status: "not_required", filed_notes: notes })
        .eq("id", id);
      if (error) return Response.json({ error: error.message }, { status: 500 });
      return Response.json({ ok: true, action, id });
    }

    if (action === "bulk_file") {
      const items = Array.isArray(body.items) ? body.items : [];
      const ids = items
        .map((item) => (item as { id?: unknown }).id)
        .filter((id) => id != null && id !== "" && !isImpliedFilingId(String(id)));
      if (ids.length) {
        const { error } = await sb
          .from("filing_calendar")
          .update({
            status: "filed",
            filed_amount: null,
            filed_notes: "Bulk-marked as filed",
            filed_date: today,
          })
          .in("id", ids);
        if (error) return Response.json({ error: error.message }, { status: 500 });
      } else if (!items.length) {
        return Response.json({ error: "items required" }, { status: 400 });
      }

      const byState: Record<string, string> = {};
      for (const raw of items) {
        const item = raw as { state_code?: string; period_end?: string };
        if (!item.state_code || !item.period_end) continue;
        if (!byState[item.state_code] || item.period_end > byState[item.state_code]) {
          byState[item.state_code] = item.period_end;
        }
      }
      for (const [stateCode, periodEnd] of Object.entries(byState)) {
        await advanceLastFiledThrough(sb, stateCode, periodEnd);
      }
      return Response.json({ ok: true, action, count: ids.length });
    }

    return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
