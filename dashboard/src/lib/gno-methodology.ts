/**
 * GNO decision-rule + source-doc reference for /ppc/gno.
 *
 * Borrowed from tallowbourn-ppc (GNO-METHODOLOGY.md, GNOLibrary, GNOExecution)
 * — not a clone of that advisor. Rules are review context. This desk stays
 * observe + export + ledger only. Never writes to Amazon.
 */

import type { GnoLedgerRow } from "./gno-learning";

export const TALLOWBOURN_PPC_DESK = {
  url: "https://tallowbourn-ppc.vercel.app",
  vercel: "https://tallowbourn-ppc.vercel.app",
  github: "https://github.com/DMALUVM/tallowbourn-ppc",
  label: "tallowbourn-ppc",
  why: "152-source library, SKU economics, execution center, and bid model stay on that desk.",
} as const;

export type GnoRuleCategory =
  | "desk"
  | "economics"
  | "placements"
  | "harvesting"
  | "structure"
  | "outcomes";

export const GNO_LEDGER_RECENT_LIMIT = 25;

export const GNO_OUTCOME_CSV_HEADERS = [
  "created_at",
  "pack_date",
  "dave_action",
  "campaign_id",
  "campaign_name",
  "search_term",
  "query_normalized",
  "term_family",
  "proposed_tag",
  "source",
  "notes",
  "implemented",
  "implemented_at",
  "plus_72h_start",
  "plus_72h_end",
  "plus_72h_spend",
  "plus_72h_orders",
  "plus_72h_acos",
  "rollback",
] as const;

export interface GnoRule {
  id: string;
  category: GnoRuleCategory;
  title: string;
  practice: string;
  basis: string;
  application: string;
}

export interface GnoSourceDoc {
  id: string;
  title: string;
  kind: "document" | "desk" | "drive";
  url: string;
  note: string;
}

/**
 * Curated GNO rules from the Sep 12–13 2026 native capture.
 * 37% Bleeders 2.0 is a scenario — this desk's family CM BE stays SoT.
 */
export const GNO_DECISION_RULES: readonly GnoRule[] = [
  {
    id: "family-cm-be",
    category: "economics",
    title: "Family CM break-even is SoT",
    practice: "Contribution-margin break-even ACOS: lip 42%, deo 36%, balm 36%. Not TACOS.",
    basis: "dashboard/config/gno_ppc_watch.json family_break_even_acos",
    application: "Use these on tiles, alerts, and pack CM notes. GNO Bleeders 2.0 37% is a scenario, not this desk's SoT.",
  },
  {
    id: "portfolio-family",
    category: "structure",
    title: "Portfolio by parent family",
    practice: "One parent family per portfolio. Portfolio budget No Cap.",
    basis: "Shared GNO rule",
    application: "Verify portfolio membership and budget. Keep campaign test limits. Do not restructure from names alone.",
  },
  {
    id: "hero-child",
    category: "structure",
    title: "Prefer one hero child",
    practice: "GNO setup aims for 80%+ of spend toward the main child. Two strong children can stay. Variation-specific queries go to that variation. Auto catch-all is an explicit exception.",
    basis: "Reviewed GNO setup + Child Variations screenshots",
    application: "Preserve Auto Loose's agreed review. Never infer active children from campaign names or Sellerise attributed-product IDs.",
  },
  {
    id: "one-match",
    category: "structure",
    title: "One match type per campaign",
    practice: "Separate match types. Ideal Exact is one child and one Exact keyword.",
    basis: "Reviewed setup screenshot + prior shared playbook",
    application: "Review mixed returned matches and multiple Exact targets without wholesale restructuring.",
  },
  {
    id: "placement",
    category: "placements",
    title: "Evidence-led placement",
    practice: "Compare TOS / ROS / PP over 7 and 30 days. GNO playbook emphasizes TOS. ROS is allowed when evidence supports it. High TOS IS (50%+) is a heuristic against further TOS increases.",
    basis: "Captured native GNO placements guide",
    application: "Check actual modifiers and retain latest campaign-specific agreements. Never overwrite them with a generic 0% ROS/PP rule.",
  },
  {
    id: "harvest-coverage",
    category: "harvesting",
    title: "Protect coverage while harvesting",
    practice: "Create a dedicated Exact destination. Wait for impressions before adding source Negative Exact. Keep discovery running.",
    basis: "Shared GNO rule",
    application: "This desk tags harvest/junk only. Destination child, enabled state, budget, and impressions still Dave/Grok before any negate.",
  },
  {
    id: "isolate-coverage",
    category: "harvesting",
    title: "Protect query coverage when isolating",
    practice: "Harvesting and isolation are distinct. Compare customer search terms with actual target identities. Thresholds come from configured Criteria, not invented numbers.",
    basis: "Captured native GNO harvesting guide",
    application: "Keep converting query coverage. GNO organic-rank heuristics are review context, not proven causal effects.",
  },
  {
    id: "structural-cap",
    category: "structure",
    title: "Limit structural additions",
    practice: "Add only 1–3 missing campaigns per week.",
    basis: "Shared GNO rule",
    application: "Count all launches made in Amazon this week before selecting the next highest-relevance gap.",
  },
  {
    id: "bleeders-1",
    category: "harvesting",
    title: "Bleeders 1.0 — screen waste",
    practice: "10+ clicks, zero orders in 60 days. Pause a target; Negative Exact a customer query. Highly relevant terms, 10–12 clicks, high CTR/low CPC, recent offer improvements, or expensive products can justify another week.",
    basis: "Reviewed GNO Bleeders Report screenshot",
    application: "Review source type, current status, relevance, and attribution before acting. Protect converting conquesting and current agreements. This desk never auto-pauses.",
  },
  {
    id: "one-lever",
    category: "desk",
    title: "Change one lever at a time",
    practice: "Do not turn a screening threshold into an automatic bid or pause rule. Preserve Dave's limits on automatic bid increases, fixed-click actions, and wholesale restructuring.",
    basis: "Dave's operating instruction",
    application: "Reconcile current values first. Use an explicit hypothesis, one test, and a rollback condition. One change per campaign per day still Dave/Grok.",
  },
  {
    id: "cadence",
    category: "desk",
    title: "Use each SOP's cadence",
    practice: "Bleeders 1.0 weekly. Bleeders 2.0 every two weeks (weekly is permitted). Lifetime monthly. Child variations when needed.",
    basis: "Reviewed GNO screenshots + Dave's review plan",
    application: "This desk's pack cadence is P0 / Wednesday 18:00 PT review / optional Mon-Wed-Fri digest. Delivery reviews still use actual implementation +72h.",
  },
  {
    id: "growth",
    category: "economics",
    title: "Profitable growth first",
    practice: "2026 revenue goal: +50% versus 2025, with material bottom-line growth.",
    basis: "Dave's goal",
    application: "Continue PPC execution. Do not label estimated ad efficiency as verified profit. Costs stay deferred unless sku_costs supplies COGS.",
  },
  {
    id: "bleeders-2",
    category: "economics",
    title: "Bleeders 2.0 — low-order high-ACOS",
    practice: "30-day window. 1–4 orders and ACOS above target +20 pp for SP, or target +10 pp for SB/SBV/SD.",
    basis: "Bleeders 2.0 screenshot",
    application: "37% is a GNO scenario, not this desk's SoT. Family CM BE is lip 42 / deo 36 / balm 36. 57% / 47% screens are scenarios, not product-specific limits.",
  },
  {
    id: "lifetime-zero",
    category: "harvesting",
    title: "Lifetime zero-order review",
    practice: "Lifetime history: 10+ clicks with no orders; use 25+ clicks when product conversion is below 5%.",
    basis: "Bleeding Lifetime Targets screenshot",
    application: "Require actual lifetime coverage and product CVR. Never substitute 60 days or the target's own zero-order CVR.",
  },
  {
    id: "acos-100",
    category: "economics",
    title: "Campaigns above 100% ACOS",
    practice: "Review campaigns above 100% ACOS, except deliberate ranking campaigns. GNO proposes pause or a bid-reduction alternative.",
    basis: "Bleeders 2.0 screenshot",
    application: "Do not apply campaign-wide cuts from target rows or overwrite protected recent tests.",
  },
  {
    id: "bad-campaigns",
    category: "economics",
    title: "Potential bad campaigns",
    practice: "30-day ACOS above brand/account average plus CTR <0.5%, CVR <8%, plus orders, campaign type, and targeting context.",
    basis: "Potential Bad Campaigns screenshot",
    application: "Organic-rank benefit or harm cannot be proven from these metrics. Review SP separately from other ad types.",
  },
  {
    id: "weekly-bids",
    category: "outcomes",
    title: "Weekly bid optimization (review)",
    practice: "Compare 7-day and 30-day performance, campaign purpose, and target ACOS. Prioritize top-spend campaigns of best-selling products. Let improving, healthy high-impact campaigns run when change is unnecessary.",
    basis: "Captured native GNO bidding guide",
    application: "Review candidates only. The 30-day no-order bid ladder (5% / 10% / pause) is separate from 60-day Bleeders 1.0. Do not auto-stack them.",
  },
  {
    id: "budget-before-bid",
    category: "outcomes",
    title: "Check budget before raising bids",
    practice: "Inspect spend yesterday and the prior day against budget. If constrained and performing well, review budget headroom. If underperforming, consider bid reductions.",
    basis: "Captured native GNO bidding guide",
    application: "Do not treat a daily average as proof of budget exhaustion. This desk never raises budgets.",
  },
] as const;

export const GNO_SOURCE_DOCS: readonly GnoSourceDoc[] = [
  {
    id: "ppc-desk",
    title: "tallowbourn-ppc — deep advisor",
    kind: "desk",
    url: TALLOWBOURN_PPC_DESK.url,
    note: "152-source GNO library, execution center, SKU economics, bid model, Sellerise worker. Open there for the full advisor — do not clone it here.",
  },
  {
    id: "bidding",
    title: "GNO weekly bidding guide",
    kind: "document",
    url: "https://docs.google.com/document/d/184rQ4eQnjvfRhJrwqltMKoos8eU0VA8Lpe2K-P009rI/edit",
    note: "30-day no-order ladder, converted-target % gap, budget-before-bid. Operator judgment required.",
  },
  {
    id: "placements",
    title: "GNO placement optimization",
    kind: "document",
    url: "https://docs.google.com/document/d/1E_CeuW1ChUtKaY3L7oq9nN8BRJGgxjbKTSdM0lQ_pqo/edit",
    note: "TOS / ROS / PP comparison. High TOS IS is a heuristic, not a universal 0% ROS/PP rule.",
  },
  {
    id: "harvesting",
    title: "GNO harvesting / isolation",
    kind: "document",
    url: "https://docs.google.com/document/d/1Sjk2IOkBbACSrRZ6GJwq30KOCeK1UkGdRdh1K30pXC0/edit",
    note: "Destination Exact before source negate. Thresholds from configured Criteria.",
  },
  {
    id: "looms",
    title: "GNO Looms and docs (Drive index)",
    kind: "drive",
    url: "https://docs.google.com/document/d/1dC59LdeL2QsZTtUtSavEsPPVdHNTEUqVLKiPIwKuLGs/edit",
    note: "Easy-access copies of what Michael shares in #tallowbourn-gno. Historical examples are not current account results.",
  },
] as const;

export function filterGnoRules(
  query: string,
  category: "all" | GnoRuleCategory = "all",
): GnoRule[] {
  const q = query.trim().toLowerCase();
  return GNO_DECISION_RULES.filter((r) => {
    if (category !== "all" && r.category !== category) return false;
    if (!q) return true;
    return `${r.title} ${r.practice} ${r.basis} ${r.application}`.toLowerCase().includes(q);
  });
}

export function gnoDecisionRulesTxt(): string {
  const lines = [
    "GNO decision rules — review reference for this pack.",
    "Observe only. Never writes to Amazon.",
    "Source: tallowbourn-ppc GNO-METHODOLOGY.md (Sep 12–13 2026 native capture).",
    "Dave's current instructions and named campaign agreements take precedence.",
    "This desk's family CM BE (lip 42 / deo 36 / balm 36) is SoT — not the 37% Bleeders 2.0 scenario.",
    "Rules capture pack_date: 2026-09-24.",
    "Ranking agreement: Unscented Lip Balm - SP - Lip Balm - KWs - Exact, Exact keyword lip balm, purpose=ranking. Exempt from ACOS cuts, Bleeders 2.0 pause suggestions, and DAY5 auto-pause. Score organic_rank + sqp_impression_share + sqp_purchase_share. Still emit spend. Never raise budget.",
    `Deep advisor (do not clone the 152-source library): ${TALLOWBOURN_PPC_DESK.url}`,
    "",
  ];
  for (const r of GNO_DECISION_RULES) {
    lines.push(`## ${r.title}`);
    lines.push(`Practice: ${r.practice}`);
    lines.push(`Basis: ${r.basis}`);
    lines.push(`On this desk: ${r.application}`);
    lines.push("");
  }
  lines.push("## Sources");
  for (const s of GNO_SOURCE_DOCS) {
    lines.push(`- ${s.title} — ${s.url}`);
    lines.push(`  ${s.note}`);
  }
  lines.push("");
  return lines.join("\n");
}

function csvEscape(v: string | number | boolean | null | undefined): string {
  if (v == null || v === "") return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll("\"", "\"\"")}"`;
  return s;
}

export function gnoOutcomesCsv(rows: GnoLedgerRow[]): string {
  const lines = [GNO_OUTCOME_CSV_HEADERS.join(",")];
  for (const r of rows) {
    const rec: Record<(typeof GNO_OUTCOME_CSV_HEADERS)[number], string> = {
      created_at: r.created_at ?? "",
      pack_date: r.pack_date ?? "",
      dave_action: r.dave_action,
      campaign_id: "",
      campaign_name: r.campaign_name ?? "",
      search_term: r.search_term ?? "",
      query_normalized: String(r.search_term ?? "").replace(/\s+/g, " ").trim().toLowerCase(),
      term_family: r.term_family ?? "",
      proposed_tag: r.proposed_tag ?? "",
      source: r.source ?? "",
      notes: r.notes ?? "",
      implemented: "unknown",
      implemented_at: "",
      plus_72h_start: "",
      plus_72h_end: "",
      plus_72h_spend: "",
      plus_72h_orders: "",
      plus_72h_acos: "",
      rollback: "",
    };
    lines.push(GNO_OUTCOME_CSV_HEADERS.map((h) => csvEscape(rec[h])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function ledgerRecent(rows: GnoLedgerRow[], limit = GNO_LEDGER_RECENT_LIMIT): GnoLedgerRow[] {
  return [...rows]
    .sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))
    .slice(0, limit);
}
