import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  CHECK_KINDS, DECISION_STATUSES, type DecisionStatus, type IntelCheck,
} from "@/lib/paid-intel";

export const runtime = "nodejs";

/** Only store a check we recognise, so a bad client cannot poison the grader. */
export function sanitizeCheck(raw: unknown): IntelCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const kind = String(c.kind ?? "");
  if (!(CHECK_KINDS as readonly string[]).includes(kind)) return null;
  const direction = c.direction === "down" ? "down" : "up";
  const unit = ["roas", "usd", "pct", "count", "ratio"].includes(String(c.unit))
    ? String(c.unit) as IntelCheck["unit"]
    : "count";
  const target = typeof c.target === "number" && Number.isFinite(c.target) ? c.target : null;
  return {
    kind: kind as IntelCheck["kind"],
    subject: typeof c.subject === "string" && c.subject.trim() ? c.subject : null,
    direction,
    target,
    unit,
    label: typeof c.label === "string" && c.label.trim() ? c.label : kind,
  };
}

/**
 * Implementation log for intel cards. Keyed on (card_id, as_of) so the same
 * detector can be tracked week over week without losing last week's decision.
 * `applied` stamps applied_at, `dismissed` stamps dismissed_at, `open` clears both.
 *
 * Applying also freezes the card's measurable number as the baseline, which is
 * what the next upload grades the change against.
 */
export function decisionPatch(
  cardId: string,
  asOf: string,
  status: DecisionStatus,
  extra: {
    owner?: string; title?: string; stake?: number; metric?: string; note?: string;
    check?: IntelCheck | null; baselineValue?: number | null;
  },
  now = new Date().toISOString(),
) {
  const applied = status === "applied";
  return {
    card_id: cardId,
    as_of: asOf,
    status,
    owner: extra.owner ?? null,
    title: extra.title ?? null,
    stake: typeof extra.stake === "number" ? extra.stake : null,
    metric: extra.metric ?? null,
    note: extra.note ?? null,
    applied_at: applied ? now : null,
    dismissed_at: status === "dismissed" ? now : null,
    check_json: applied ? extra.check ?? null : null,
    baseline_value: applied && typeof extra.baselineValue === "number" ? extra.baselineValue : null,
    baseline_as_of: applied ? asOf : null,
    updated_at: now,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null) as {
      card_id?: unknown; as_of?: unknown; status?: unknown;
      owner?: unknown; title?: unknown; stake?: unknown; metric?: unknown; note?: unknown;
      check?: unknown; baseline_value?: unknown;
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
      check: sanitizeCheck(body?.check),
      baselineValue: typeof body?.baseline_value === "number" ? body.baseline_value : null,
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
