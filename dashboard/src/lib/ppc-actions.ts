/**
 * PPC action vocabulary + plan export.
 *
 * One source of truth for how a recommendation is labelled, explained and
 * written out, so the Actions table, the expanded detail row and the exported
 * markdown plan can never drift apart.
 *
 * Phase 1 is read-only: nothing here writes to Amazon. Every string is an
 * instruction for a human to carry out in Seller Central.
 */

export type ActionType =
  | "negate_exact"
  | "negate_phrase"
  | "harvest_exact"
  | "reduce_bid"
  | "increase_bid"
  | "adjust_tos_modifier"
  | "review_campaign";

/** Short column label. */
export const ACTION_LABELS: Record<ActionType, string> = {
  negate_exact: "Negate exact",
  negate_phrase: "Negate phrase",
  harvest_exact: "Harvest exact",
  reduce_bid: "Reduce bid",
  increase_bid: "Increase bid",
  adjust_tos_modifier: "TOS modifier",
  review_campaign: "Review campaign",
};

/** Badge tint per action type — cool for "add", warm for "cut". */
export const ACTION_STYLES: Record<ActionType, string> = {
  negate_exact: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
  negate_phrase: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
  harvest_exact: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  reduce_bid: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
  increase_bid: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
  adjust_tos_modifier: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-900",
  review_campaign: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900",
};

/** Legacy rows (and Python-engine rows) carry no action_type — derive it. */
const TYPE_TO_ACTION: Record<string, ActionType> = {
  NEGATE_SEARCH_TERM: "negate_exact",
  HARVEST_SEARCH_TERM: "harvest_exact",
  REDUCE_BID: "reduce_bid",
  INCREASE_BID: "increase_bid",
  ADJUST_TOS_MODIFIER: "adjust_tos_modifier",
  WASTED_SPEND_ROLLUP: "review_campaign",
  STARVE_OOS: "review_campaign",
};

export interface RecLike {
  id: string;
  type: string;
  priority: string;
  impact_estimate: number;
  entity_name: string;
  campaign_name: string;
  suggested_action: string;
  evidence: string | Record<string, unknown> | null;
  status: string;
}

/** `evidence` is jsonb, but older rows were written as a JSON string. */
export function parseEvidence(rec: RecLike): Record<string, unknown> {
  const e = rec.evidence;
  if (!e) return {};
  if (typeof e === "object") return e as Record<string, unknown>;
  try {
    const parsed = JSON.parse(e);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function actionTypeOf(rec: RecLike): ActionType {
  const ev = parseEvidence(rec);
  const declared = ev.action_type;
  if (typeof declared === "string" && declared in ACTION_LABELS) return declared as ActionType;
  return TYPE_TO_ACTION[rec.type] ?? "review_campaign";
}

export function actionLabelOf(rec: RecLike): string {
  return ACTION_LABELS[actionTypeOf(rec)];
}

/** The literal "do this in Seller Central" instruction. */
export function doThisOf(rec: RecLike): string {
  return rec.suggested_action?.trim() || "No instruction recorded — regenerate recommendations.";
}

/** One line of evidence. Falls back to composing it from the raw numbers. */
export function whyOf(rec: RecLike): string {
  const ev = parseEvidence(rec);
  if (typeof ev.why === "string" && ev.why) return ev.why;

  const bits: string[] = [];
  const num = (k: string) => (typeof ev[k] === "number" ? ev[k] as number : null);
  const spend = num("spend");
  const orders = num("orders");
  const clicks = num("clicks");
  const acos = num("acos");
  if (spend !== null) bits.push(`$${spend.toFixed(2)} spend`);
  if (orders !== null) bits.push(`${orders} order${orders === 1 ? "" : "s"}`);
  if (clicks !== null) bits.push(`${clicks} clicks`);
  if (acos !== null) bits.push(`ACOS ${acos.toFixed(0)}%`);
  const w = ev.window as { days?: number } | undefined;
  if (w?.days) bits.push(`${w.days}-day window`);
  return bits.length ? bits.join(" · ") : "No evidence recorded.";
}

/** Suggested bid, when the action type has one. */
export function suggestedBidOf(rec: RecLike): number | null {
  const v = parseEvidence(rec).suggested_bid;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function matchTypesOf(rec: RecLike): string[] {
  const v = parseEvidence(rec).match_types;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function adGroupsOf(rec: RecLike): string[] {
  const v = parseEvidence(rec).ad_groups;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/* ── Plan export ─────────────────────────────────────────────── */

export interface PlanContext {
  /** Range label as shown in the UI, e.g. "7D". */
  range: string;
  rangeDays: number;
  dateMin: string | null;
  dateMax: string | null;
  targetAcos: number;
  /** Today, ISO — passed in so the caller owns the clock. */
  generatedOn: string;
  kpi: { spend: number; adSales: number; acos: number; tacos: number } | null;
  wastedSpend: number;
}

const PRIORITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Markdown action plan: window, KPI summary, then the actions numbered in
 * priority order (P0 first — P0 is "money is burning now").
 */
export function buildPlanMarkdown(recs: RecLike[], ctx: PlanContext): string {
  const sorted = [...recs].sort((a, b) =>
    (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
    b.impact_estimate - a.impact_estimate);

  const L: string[] = [];
  L.push("# Amazon PPC action plan");
  L.push("");
  L.push(`**Window:** ${ctx.dateMin ?? "?"} → ${ctx.dateMax ?? "?"} (${ctx.range}, ${ctx.rangeDays} days)  `);
  L.push(`**Target ACOS:** ${ctx.targetAcos}%  `);
  L.push(`**Generated:** ${ctx.generatedOn}`);
  L.push("");
  L.push("## KPI summary");
  L.push("");
  L.push("| Metric | Value |");
  L.push("| --- | --- |");
  if (ctx.kpi) {
    L.push(`| Ad spend | ${money(ctx.kpi.spend)} |`);
    L.push(`| Ad sales | ${money(ctx.kpi.adSales)} |`);
    L.push(`| ACOS | ${ctx.kpi.acos.toFixed(1)}% |`);
    L.push(`| TACOS (ad spend / Amazon sales) | ${ctx.kpi.tacos.toFixed(1)}% |`);
  }
  L.push(`| Wasted spend (0-order search terms) | ${money(ctx.wastedSpend)} |`);
  L.push(`| Open actions | ${sorted.length} |`);
  L.push("");

  if (!sorted.length) {
    L.push("## Actions");
    L.push("");
    L.push("_No open recommendations. Run an Ads sync so search terms are present, then Generate Recommendations._");
    L.push("");
  } else {
    let n = 0;
    let currentPriority = "";
    L.push("## Actions");
    L.push("");
    for (const rec of sorted) {
      if (rec.priority !== currentPriority) {
        currentPriority = rec.priority;
        const count = sorted.filter((r) => r.priority === currentPriority).length;
        L.push(`### ${currentPriority} — ${count} action${count === 1 ? "" : "s"}`);
        L.push("");
      }
      n += 1;
      const bid = suggestedBidOf(rec);
      L.push(`${n}. **${actionLabelOf(rec)} — ${rec.entity_name}**`);
      L.push(`   - **Do this:** ${doThisOf(rec)}`);
      L.push(`   - **Why:** ${whyOf(rec)}`);
      L.push(`   - **Campaign:** ${rec.campaign_name || "—"}`);
      if (bid !== null) L.push(`   - **Suggested bid:** ${money(bid)}`);
      L.push(`   - **Impact estimate:** ${money(rec.impact_estimate)}`);
      L.push("");
    }
  }

  L.push("---");
  L.push("");
  L.push("_Decision support only. Phase 1 is read-only — no bids or negatives are applied automatically._");
  L.push("_Apply each change manually in Seller Central and re-check ACOS after 7 days._");
  L.push("");
  return L.join("\n");
}

/**
 * Wraps the plan in a short system-style ask. Pasted into Grok (or any chat
 * model) by the user — nothing here calls an LLM.
 */
export function buildGrokPrompt(planMarkdown: string, ctx: PlanContext): string {
  return [
    "You are an Amazon Ads (Sponsored Products) operator.",
    "",
    `Below is an action plan generated from ${ctx.rangeDays} days of my own search-term and campaign data,`,
    `with a target ACOS of ${ctx.targetAcos}%. Phase 1 is read-only: I apply every change by hand in Seller Central.`,
    "",
    "Please produce:",
    "1. A 7-day execution checklist — which actions to apply on which day, heaviest-impact and P0 items first,",
    "   grouped so I am not jumping between campaigns.",
    "2. Any action you would skip or modify, and why (call out anything that looks risky or contradictory).",
    "3. What to monitor after the changes: which metrics, at what cadence, and the thresholds that mean",
    "   \"revert this change\".",
    "",
    "Do not invent data that is not in the plan. If something is missing, say so.",
    "",
    "--- ACTION PLAN ---",
    "",
    planMarkdown,
  ].join("\n");
}
