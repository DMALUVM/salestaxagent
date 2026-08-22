/**
 * Dashboard Top-N playbook ranking.
 *
 * Mirrors src/amazon_ads/playbook.py (top_n_playbook). Ranking only — this does
 * not generate recommendations. The Actions tab still owns the full queue.
 *
 * Order: waste / placement cuts (P0) → defend / reduce (P1) → scale only where
 * the organic-rank gate already said yes (P2) → discovery rebalance (P3).
 * Cap is 10. Rank-blocked raises are excluded.
 */

export const PLAYBOOK_TOP_N = 10;

const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export interface PlaybookRec {
  id?: string;
  type?: string;
  priority?: string;
  status?: string;
  impact_estimate?: number;
  impact?: number;
  entity_name?: string;
  campaign_name?: string;
  suggested_action?: string;
  evidence?: Record<string, unknown> | string | null;
}

export interface PlaybookPlacement {
  placement?: string;
  spend?: number;
  sales?: number;
}

export interface PlaybookRole {
  role?: string;
  budgetSharePct?: number;
  spend?: number;
  targetSharePct?: { min?: number; max?: number } | null;
}

export interface PlaybookItem {
  priority: string;
  title: string;
  why: string;
  do: string;
  impact: number;
  recId: string | null;
  evidence: Record<string, unknown>;
}

function ev(rec: PlaybookRec): Record<string, unknown> {
  const e = rec.evidence;
  if (!e) return {};
  if (typeof e === "object") return e;
  try {
    const parsed = JSON.parse(e);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function usd(v: number): string {
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function isRankBlockedRaise(rec: PlaybookRec): boolean {
  const typ = String(rec.type ?? "").toUpperCase();
  if (!typ.includes("INCREASE") && !typ.includes("RAISE")) return false;
  const e = ev(rec);
  return e.needs_rank_check === true
    || e.rank_policy_applied === "capped"
    || e.rank_policy_applied === "hold";
}

export function recToItem(rec: PlaybookRec): PlaybookItem {
  const e = ev(rec);
  const typ = String(rec.type ?? "").replace(/_/g, " ").toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const name = String(rec.entity_name ?? "unknown");
  const impact = Number(rec.impact_estimate ?? rec.impact ?? 0);
  let why = typeof e.why === "string" ? e.why.trim() : "";
  if (!why) {
    const bits: string[] = [];
    if (typeof e.spend === "number") bits.push(`${usd(e.spend)} spend`);
    if (typeof e.acos === "number") bits.push(`${e.acos.toFixed(0)}% ACOS`);
    why = bits.join(", ") || "Queued recommendation — see the Actions list for evidence.";
  }
  return {
    priority: String(rec.priority ?? "P1"),
    title: `${typ} — ${name}`,
    why,
    do: String(rec.suggested_action || "Apply this in Campaign Manager, then mark it here."),
    impact,
    recId: rec.id ? String(rec.id) : null,
    evidence: {
      rec_type: rec.type,
      entity_name: name,
      campaign_name: rec.campaign_name,
      spend: e.spend,
      acos: e.acos,
      impact_estimate: impact,
    },
  };
}

/** Same thresholds as playbook.placement_actions — not a second generator. */
export function placementItems(placements: PlaybookPlacement[], targetAcos: number,
                               minSpend = 25): PlaybookItem[] {
  const out: PlaybookItem[] = [];
  for (const p of placements) {
    const spend = Number(p.spend ?? 0);
    const sales = Number(p.sales ?? 0);
    const name = String(p.placement ?? "Unknown");
    if (spend < minSpend) continue;
    const acos = sales > 0 ? (spend / sales) * 100 : null;
    if (acos === null) {
      out.push({
        priority: "P0",
        title: `Cut ${name} — ${usd(spend)} spent, zero attributed sales`,
        why: `${usd(spend)} on ${name} with no attributed sales in this window. `
          + "Not a bid problem; the placement is not converting at all.",
        do: `In Campaign Manager set the ${name} placement modifier to 0% `
          + "(or the lowest available) on the campaigns driving that spend, "
          + "then re-check in 7 days.",
        impact: spend,
        recId: null,
        evidence: { placement: name, spend, sales: 0, acos: null, target_acos: targetAcos },
      });
      continue;
    }
    if (acos > targetAcos * 1.5) {
      const excess = spend - (sales * targetAcos / 100);
      out.push({
        priority: "P0",
        title: `Bid down ${name} — ${acos.toFixed(0)}% ACOS vs ${targetAcos.toFixed(0)}% target`,
        why: `${name} is running ${acos.toFixed(0)}% ACOS on ${usd(spend)} spend against a `
          + `${targetAcos.toFixed(0)}% break-even target — roughly ${usd(Math.max(excess, 0))} `
          + "above what that revenue supports.",
        do: `Reduce the ${name} placement modifier on the heaviest-spending `
          + `campaigns until ACOS approaches ${targetAcos.toFixed(0)}%. Placement `
          + "modifiers are per-campaign, so this is one setting per campaign, "
          + "not a per-keyword sweep.",
        impact: Math.max(excess, 0),
        recId: null,
        evidence: { placement: name, spend, sales, acos: Math.round(acos * 10) / 10,
                    target_acos: targetAcos },
      });
    }
  }
  return out;
}

export function discoveryItems(roles: PlaybookRole[], targetMaxPct = 30): PlaybookItem[] {
  const out: PlaybookItem[] = [];
  for (const r of roles) {
    if (String(r.role) !== "discovery") continue;
    const share = Number(r.budgetSharePct ?? 0);
    const ceiling = Number(r.targetSharePct?.max ?? targetMaxPct);
    if (share <= ceiling) continue;
    const spend = Number(r.spend ?? 0);
    const over = share ? ((share - ceiling) / 100) * spend : 0;
    out.push({
      priority: "P3",
      title: `Discovery is ${share.toFixed(0)}% of spend vs a ${ceiling.toFixed(0)}% ceiling`,
      why: `Discovery/prospecting is taking ${share.toFixed(0)}% of budget (${usd(spend)}) `
        + `against a ${ceiling.toFixed(0)}% target ceiling — roughly ${usd(over)} above band.`,
      do: "Tighten prospecting: convert proven discovery search terms to exact "
        + "campaigns, then lower broad/auto budgets. More broad spend is not the "
        + "growth lever here — harvesting what discovery already found is.",
      impact: over,
      recId: null,
      evidence: { share_pct: share, ceiling_pct: ceiling, spend },
    });
  }
  return out;
}

export function topNPlaybook(
  targetAcos: number,
  recs: PlaybookRec[],
  placements: PlaybookPlacement[],
  roles: PlaybookRole[] = [],
  n: number = PLAYBOOK_TOP_N,
): PlaybookItem[] {
  const open = recs.filter((r) => (r.status ?? "open") === "open" && !isRankBlockedRaise(r));
  const items = [
    ...placementItems(placements, targetAcos),
    ...open.map(recToItem),
    ...discoveryItems(roles),
  ];
  items.sort((a, b) =>
    (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9)
    || b.impact - a.impact);
  return items.slice(0, Math.max(0, n));
}
