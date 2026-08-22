import { getServerSupabase } from "@/lib/supabase-server";
import { classifyCampaign } from "@/lib/ads-roles";

/**
 * GET /api/ppc/impact — "impact so far" over the action decision log.
 *
 * OBSERVATIONAL, NOT CAUSAL. These are the numbers that followed an action,
 * not the numbers the action caused: there is no control group, several actions
 * touch the same campaigns, and the account drifts for unrelated reasons. Use
 * it to form hypotheses about which action types are worth trusting, never as
 * proof that a change worked.
 *
 * Read-only over ads_action_decisions + ads_action_outcomes. Returns
 * `available: false` until supabase/migration_ads_learning.sql has been run.
 */

interface DecisionRow {
  id: string; action_type: string | null; status: string | null;
  as_of_date: string; campaign_name: string | null; role: string | null;
  impact_estimate: number | null;
}
interface OutcomeRow {
  decision_id: string; horizon_days: number;
  spend: number | null; ad_sales: number | null; acos: number | null;
  orders: number | null; contribution: number | null;
}

export async function GET() {
  const caveat =
    "Observational only. These are outcomes that followed each action, not effects "
    + "attributable to it — no control group, overlapping actions, and account-wide "
    + "drift are not separated.";

  try {
    const sb = getServerSupabase();

    let decisions: DecisionRow[] = [];
    try {
      const r = await sb.from("ads_action_decisions")
        .select("id,action_type,status,as_of_date,campaign_name,role,impact_estimate")
        .order("as_of_date", { ascending: false }).limit(5000);
      if (r.error) throw r.error;
      decisions = (r.data ?? []) as DecisionRow[];
    } catch {
      return Response.json({
        available: false, caveat,
        note: "Run supabase/migration_ads_learning.sql to start logging action decisions.",
        byType: [], horizons: [], totals: null,
      });
    }

    let outcomes: OutcomeRow[] = [];
    try {
      const r = await sb.from("ads_action_outcomes")
        .select("decision_id,horizon_days,spend,ad_sales,acos,orders,contribution")
        .limit(5000);
      if (!r.error) outcomes = (r.data ?? []) as OutcomeRow[];
    } catch { /* outcomes table may lag the decisions table */ }

    // ── Applied vs dismissed by action type ──
    const byTypeMap = new Map<string, {
      actionType: string; open: number; applied: number; dismissed: number;
      expired: number; total: number; impactEstimate: number;
    }>();
    for (const d of decisions) {
      const key = d.action_type ?? "unknown";
      const e = byTypeMap.get(key) ?? {
        actionType: key, open: 0, applied: 0, dismissed: 0, expired: 0,
        total: 0, impactEstimate: 0,
      };
      const st = (d.status ?? "open") as "open" | "applied" | "dismissed" | "expired";
      if (st in e) (e as unknown as Record<string, number>)[st] += 1;
      e.total += 1;
      e.impactEstimate += Number(d.impact_estimate ?? 0);
      byTypeMap.set(key, e);
    }
    const byType = [...byTypeMap.values()]
      .map((e) => ({ ...e, impactEstimate: Math.round(e.impactEstimate * 100) / 100 }))
      .sort((a, b) => b.total - a.total);

    // ── Post-window aggregates, split by what the operator did ──
    const decById = new Map(decisions.map((d) => [d.id, d]));
    const horizonMap = new Map<number, Map<string, {
      n: number; spend: number; adSales: number; orders: number;
    }>>();
    for (const o of outcomes) {
      const d = decById.get(o.decision_id);
      if (!d) continue;
      const status = d.status ?? "open";
      const perStatus = horizonMap.get(o.horizon_days) ?? new Map();
      const e = perStatus.get(status) ?? { n: 0, spend: 0, adSales: 0, orders: 0 };
      e.n += 1;
      e.spend += Number(o.spend ?? 0);
      e.adSales += Number(o.ad_sales ?? 0);
      e.orders += Number(o.orders ?? 0);
      perStatus.set(status, e);
      horizonMap.set(o.horizon_days, perStatus);
    }
    const horizons = [...horizonMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([days, perStatus]) => ({
        horizonDays: days,
        byStatus: [...perStatus.entries()].map(([status, v]) => ({
          status, n: v.n,
          spend: Math.round(v.spend * 100) / 100,
          adSales: Math.round(v.adSales * 100) / 100,
          orders: v.orders,
          acos: v.adSales > 0 ? Math.round((v.spend / v.adSales) * 1000) / 10 : null,
        })),
      }));

    // Role is stored on the decision; fall back to the classifier for older rows.
    const roleCounts = new Map<string, number>();
    for (const d of decisions) {
      const role = d.role || classifyCampaign(d.campaign_name ?? "");
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }

    const appliedIds = decisions.filter((d) => d.status === "applied").map((d) => d.id);
    const outcomeDecisionIds = new Set(outcomes.map((o) => o.decision_id));
    const appliedAwaiting = appliedIds.filter((id) => !outcomeDecisionIds.has(id)).length;

    return Response.json({
      available: true,
      caveat,
      totals: {
        decisions: decisions.length,
        outcomes: outcomes.length,
        applied: appliedIds.length,
        appliedAwaiting,
        dismissed: decisions.filter((d) => d.status === "dismissed").length,
        open: decisions.filter((d) => (d.status ?? "open") === "open").length,
        firstAsOf: decisions.length ? decisions[decisions.length - 1].as_of_date : null,
        lastAsOf: decisions.length ? decisions[0].as_of_date : null,
      },
      byType,
      horizons,
      byRole: [...roleCounts.entries()].map(([role, n]) => ({ role, n })),
    });
  } catch (e) {
    return Response.json({ available: false, caveat, error: String(e) }, { status: 500 });
  }
}
