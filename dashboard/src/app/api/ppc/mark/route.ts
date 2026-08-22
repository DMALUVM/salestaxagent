import { getServerSupabase } from "@/lib/supabase-server";
import {
  decisionPatch, isMarkableStatus, loopCounts, type MarkLoop,
} from "@/lib/ppc-mark";

/**
 * POST /api/ppc/mark — the dashboard half of `ads-mark`.
 *
 * Updates ads_recommendations.status AND mirrors onto ads_action_decisions
 * with the same decision_patch ads-mark writes. Does not generate
 * recommendations. Does not write to Amazon. Never auto-applies.
 *
 * Body: { id, status: "applied" | "dismissed" }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = typeof body.id === "string" ? body.id : "";
    const status = typeof body.status === "string" ? body.status : "";
    if (!id) {
      return Response.json({ ok: false, error: "id required" }, { status: 400 });
    }
    if (!isMarkableStatus(status) || (status !== "applied" && status !== "dismissed")) {
      return Response.json({
        ok: false,
        error: "status must be applied or dismissed",
      }, { status: 400 });
    }

    const sb = getServerSupabase();

    const recRes = await sb.from("ads_recommendations")
      .select("id,type,entity_name,campaign_id,decision_id")
      .eq("id", id)
      .limit(1);
    if (recRes.error) {
      return Response.json({ ok: false, error: recRes.error.message }, { status: 500 });
    }
    const rec = recRes.data?.[0];
    if (!rec) {
      return Response.json({ ok: false, error: "recommendation not found" }, { status: 404 });
    }

    const upd = await sb.from("ads_recommendations").update({ status }).eq("id", id);
    if (upd.error) {
      return Response.json({ ok: false, error: upd.error.message }, { status: 500 });
    }

    let decisionId: string | null = rec.decision_id ? String(rec.decision_id) : null;
    if (!decisionId) {
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
    const patch = decisionPatch(status, new Date().toISOString());
    if (decisionId && patch) {
      try {
        const d = await sb.from("ads_action_decisions").update(patch).eq("id", decisionId);
        decisionLogged = !d.error;
      } catch { /* learning tables not present yet */ }
    }

    const loop = await readLoop(sb);
    return Response.json({
      ok: true,
      decisionLogged,
      decisionId,
      status,
      loop,
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

async function readLoop(sb: ReturnType<typeof getServerSupabase>): Promise<MarkLoop> {
  const empty: MarkLoop = { applied: 0, appliedAwaiting: 0, outcomesRecorded: 0 };
  try {
    const d = await sb.from("ads_action_decisions").select("id,status").limit(5000);
    if (d.error) return empty;
    const o = await sb.from("ads_action_outcomes").select("decision_id").limit(5000);
    return loopCounts(
      (d.data ?? []) as Array<{ id: string; status: string | null }>,
      (o.error ? [] : (o.data ?? [])) as Array<{ decision_id: string }>,
    );
  } catch {
    return empty;
  }
}
