import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { DECISION_STATUSES, type DecisionStatus } from "@/lib/paid-intel";

export const runtime = "nodejs";

/**
 * Implementation log for intel cards. Keyed on (card_id, as_of) so the same
 * detector can be tracked week over week without losing last week's decision.
 * `applied` stamps applied_at, `dismissed` stamps dismissed_at, `open` clears both.
 */
export function decisionPatch(
  cardId: string,
  asOf: string,
  status: DecisionStatus,
  extra: { owner?: string; title?: string; stake?: number; metric?: string; note?: string },
  now = new Date().toISOString(),
) {
  return {
    card_id: cardId,
    as_of: asOf,
    status,
    owner: extra.owner ?? null,
    title: extra.title ?? null,
    stake: typeof extra.stake === "number" ? extra.stake : null,
    metric: extra.metric ?? null,
    note: extra.note ?? null,
    applied_at: status === "applied" ? now : null,
    dismissed_at: status === "dismissed" ? now : null,
    updated_at: now,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as {
      card_id?: unknown; as_of?: unknown; status?: unknown;
      owner?: unknown; title?: unknown; stake?: unknown; metric?: unknown; note?: unknown;
    } | null;
    const cardId = String(body?.card_id ?? "").trim();
    const asOf = String(body?.as_of ?? "").trim();
    const status = String(body?.status ?? "") as DecisionStatus;
    if (!cardId || !asOf) {
      return Response.json({ ok: false, error: "card_id and as_of are required" }, { status: 400 });
    }
    if (!(DECISION_STATUSES as readonly string[]).includes(status)) {
      return Response.json({
        ok: false,
        error: `status must be one of ${DECISION_STATUSES.join(", ")}`,
      }, { status: 400 });
    }

    const row = decisionPatch(cardId, asOf, status, {
      owner: typeof body?.owner === "string" ? body.owner : undefined,
      title: typeof body?.title === "string" ? body.title : undefined,
      stake: typeof body?.stake === "number" ? body.stake : undefined,
      metric: typeof body?.metric === "string" ? body.metric : undefined,
      note: typeof body?.note === "string" ? body.note : undefined,
    });

    const { error } = await getServerSupabase()
      .from("paid_intel_decisions")
      .upsert([row], { onConflict: "card_id,as_of" });
    if (error) {
      const migration = /does not exist|schema cache|PGRST205/i.test(error.message);
      return Response.json({
        ok: false,
        error: migration
          ? "paid_intel_decisions is missing — apply supabase/migration_paid_intel.sql"
          : error.message,
        migration_needed: migration,
      }, { status: migration ? 409 : 500 });
    }
    return Response.json({ ok: true, decision: row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
