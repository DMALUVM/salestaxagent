/**
 * Apply / dismiss wiring — the dashboard half of ads-mark.
 *
 * ads-mark calls src.amazon_ads.learning.mark_recommendation, which updates
 * ads_recommendations.status AND mirrors onto ads_action_decisions via the
 * same decision_patch. This helper is that payload + the two-table writes,
 * so /api/ppc (legacy POST) and /api/ppc/mark cannot drift into a second
 * decision store.
 *
 * Never writes to Amazon. Never auto-applies.
 */

export const MARKABLE = ["applied", "dismissed", "open", "expired"] as const;
export type MarkStatus = (typeof MARKABLE)[number];

export interface MarkRec {
  id: string;
  type?: string | null;
  entity_name?: string | null;
  campaign_id?: string | null;
  decision_id?: string | null;
}

export interface MarkLoop {
  applied: number;
  appliedAwaiting: number;
  outcomesRecorded: number;
}

export interface MarkResult {
  ok: boolean;
  decisionLogged: boolean;
  decisionId: string | null;
  status?: MarkStatus;
  loop?: MarkLoop;
  error?: string;
}

export function isMarkableStatus(status: string): status is MarkStatus {
  return (MARKABLE as readonly string[]).includes(status);
}

/** Same columns learning.decision_patch writes. */
export function decisionPatch(status: string, nowIso: string): Record<string, unknown> | null {
  if (!isMarkableStatus(status)) return null;
  const patch: Record<string, unknown> = { status };
  if (status === "applied") patch.applied_at = nowIso;
  else if (status === "dismissed") patch.dismissed_at = nowIso;
  else if (status === "expired") patch.expired_at = nowIso;
  return patch;
}

export interface MarkClient {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => {
        limit: (n: number) => PromiseLike<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }>;
        order?: (col: string, opts: { ascending: boolean }) => {
          limit: (n: number) => PromiseLike<{ data: Array<Record<string, unknown>> | null; error: { message: string } | null }>;
        };
      };
    };
    update: (patch: Record<string, unknown>) => {
      eq: (col: string, val: unknown) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

/**
 * Resolve the decision row the way learning.resolve_decision_id does:
 * linked decision_id first, then latest natural-key match.
 */
export async function resolveDecisionId(
  sb: MarkClient,
  rec: MarkRec,
): Promise<string | null> {
  if (rec.decision_id) return String(rec.decision_id);
  try {
    const q = sb.from("ads_action_decisions")
      .select("id")
      .eq("rec_type", rec.type ?? "");
    // The generated client chains .eq; keep going for the natural key.
    const keyed = (q as unknown as {
      eq: (c: string, v: unknown) => {
        eq: (c: string, v: unknown) => {
          order: (c: string, o: { ascending: boolean }) => {
            limit: (n: number) => PromiseLike<{ data: Array<Record<string, unknown>> | null }>;
          };
        };
      };
    });
    const r = await keyed
      .eq("entity_name", rec.entity_name ?? "")
      .eq("campaign_id", String(rec.campaign_id ?? ""))
      .order("as_of_date", { ascending: false })
      .limit(1);
    const id = r.data?.[0]?.id;
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

export async function markRecommendation(
  sb: MarkClient,
  rec: MarkRec,
  status: string,
  nowIso: string = new Date().toISOString(),
): Promise<MarkResult> {
  const patch = decisionPatch(status, nowIso);
  if (!patch) {
    return { ok: false, decisionLogged: false, decisionId: null,
             error: `invalid status ${JSON.stringify(status)}` };
  }
  if (!rec.id) {
    return { ok: false, decisionLogged: false, decisionId: null,
             error: "recommendation id required" };
  }

  const upd = await sb.from("ads_recommendations").update({ status }).eq("id", rec.id);
  if (upd.error) {
    return { ok: false, decisionLogged: false, decisionId: null, error: upd.error.message };
  }

  const decisionId = await resolveDecisionId(sb, rec);
  let decisionLogged = false;
  if (decisionId) {
    const d = await sb.from("ads_action_decisions").update(patch).eq("id", decisionId);
    decisionLogged = !d.error;
  }
  return { ok: true, decisionLogged, decisionId, status: status as MarkStatus };
}

export function loopCounts(
  decisions: Array<{ id: string; status: string | null }>,
  outcomes: Array<{ decision_id: string }>,
): MarkLoop {
  const withOutcome = new Set(outcomes.map((o) => o.decision_id));
  const applied = decisions.filter((d) => d.status === "applied");
  return {
    applied: applied.length,
    appliedAwaiting: applied.filter((d) => !withOutcome.has(d.id)).length,
    outcomesRecorded: outcomes.length,
  };
}

/** Payload the Bleeders checkbox writes onto ads_action_decisions. */
export interface BleederMark {
  checklist_id: string;
  as_of: string;
  rec_type: string;
  action_type: string;
  campaign_id: string;
  campaign_name?: string;
  ad_group_id?: string;
  entity_type?: string;
  search_term?: string | null;
  priority?: string;
  impact_estimate?: number;
  evidence?: Record<string, unknown>;
  suggested_action?: string;
}

export interface BleederMarkClient {
  from: (table: string) => {
    upsert: (row: Record<string, unknown>, opts?: { onConflict?: string }) => {
      select: (cols: string) => PromiseLike<{
        data: Array<Record<string, unknown>> | null;
        error: { message: string } | null;
      }>;
    };
    update: (patch: Record<string, unknown>) => {
      eq: (col: string, val: unknown) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

/**
 * Checkbox → ads_action_decisions.status = applied (or open).
 * Never writes to Amazon. Never auto-applies a Seller Central change.
 */
export async function markBleeder(
  sb: BleederMarkClient,
  bleeder: BleederMark,
  status: string,
  nowIso: string = new Date().toISOString(),
): Promise<MarkResult> {
  const patch = decisionPatch(status, nowIso);
  if (!patch) {
    return { ok: false, decisionLogged: false, decisionId: null,
             error: `invalid status ${JSON.stringify(status)}` };
  }
  if (!bleeder.checklist_id || !bleeder.as_of || !bleeder.rec_type || !bleeder.campaign_id) {
    return { ok: false, decisionLogged: false, decisionId: null,
             error: "checklist_id, as_of, rec_type and campaign_id required" };
  }

  const row: Record<string, unknown> = {
    as_of_date: bleeder.as_of,
    rec_type: bleeder.rec_type,
    action_type: bleeder.action_type,
    entity_name: bleeder.checklist_id,
    entity_type: bleeder.entity_type ?? "search_term",
    campaign_id: String(bleeder.campaign_id),
    campaign_name: bleeder.campaign_name ?? "",
    ad_group_id: bleeder.ad_group_id ?? "",
    search_term: bleeder.search_term ?? null,
    priority: bleeder.priority ?? "P0",
    impact_estimate: bleeder.impact_estimate ?? 0,
    evidence: {
      ...(bleeder.evidence ?? {}),
      checklist_id: bleeder.checklist_id,
      action_type: bleeder.action_type,
    },
    suggested_change: { suggested_action: bleeder.suggested_action ?? "" },
    ...patch,
  };

  const upserted = await sb.from("ads_action_decisions")
    .upsert(row, { onConflict: "as_of_date,rec_type,entity_name,campaign_id" })
    .select("id");
  if (upserted.error) {
    return { ok: false, decisionLogged: false, decisionId: null, error: upserted.error.message };
  }
  const decisionId = upserted.data?.[0]?.id ? String(upserted.data[0].id) : null;
  return { ok: true, decisionLogged: true, decisionId, status: status as MarkStatus };
}
