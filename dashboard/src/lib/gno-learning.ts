/**
 * GNO Watch learning v1 — observe only.
 *
 * Dave/Grok outcomes in gno_decision_ledger adjust harvest/junk *tags*.
 * Nothing here pauses, negates, or writes bids/budgets to Amazon.
 */

import spec from "../../config/gno_ppc_watch.json";

type ProposedTag = "KEEP" | "HARVEST_CANDIDATE" | "JUNK_CANDIDATE";

function normalizeName(name: string | null | undefined): string {
  return String(name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeTerm(term: string | null | undefined): string {
  return normalizeName(term);
}

export const DAVE_ACTIONS = [
  "hold", "bid_down", "bid_up", "approve_harvest_neg", "skip",
] as const;
export type DaveAction = (typeof DAVE_ACTIONS)[number];

export const BID_ACTIONS = ["hold", "bid_down", "bid_up"] as const;
export type BidAction = (typeof BID_ACTIONS)[number];

const SKIP_THRESHOLD = Number(spec.learning_harvest_skip_threshold ?? 2);
const EXTRA_ORDERS = Number(spec.learning_harvest_extra_orders ?? 2);
const LEARNED_JUNK_MIN = Number(spec.learning_junk_min_spend ?? 2);
const HARVEST_MIN = Number(spec.harvest_min_l7_orders ?? 3);

const STOP = new Set(["the", "a", "an", "for", "and", "of", "to", "in", "on"]);

export interface GnoLedgerRow {
  id?: string;
  created_at?: string;
  pack_date?: string | null;
  campaign_name?: string | null;
  search_term?: string | null;
  term_family?: string | null;
  proposed_tag?: string | null;
  dave_action: DaveAction;
  source?: string | null;
  notes?: string | null;
}

export function isDaveAction(v: string): v is DaveAction {
  return (DAVE_ACTIONS as readonly string[]).includes(v);
}

export function isBidAction(v: string | null | undefined): v is BidAction {
  return (BID_ACTIONS as readonly string[]).includes(String(v ?? ""));
}

/** Sorted content tokens so "organic tallow lip balm" == "tallow lip balm organic". */
export function termFamily(term: string | null | undefined): string {
  return normalizeTerm(term)
    .split(" ")
    .filter((t) => t.length > 0 && !STOP.has(t))
    .sort()
    .join(" ");
}

export function skipCountFor(term: string, ledger: GnoLedgerRow[]): number {
  const exact = normalizeTerm(term);
  const fam = termFamily(term);
  let n = 0;
  for (const r of ledger) {
    if (r.dave_action !== "skip") continue;
    const sameTerm = normalizeTerm(r.search_term) === exact && exact !== "";
    const sameFam = !!fam && (r.term_family === fam || termFamily(r.search_term) === fam);
    if (sameTerm || sameFam) n += 1;
  }
  return n;
}

function learnedJunkMatch(term: string, learned: GnoLedgerRow): boolean {
  const t = normalizeTerm(term);
  const learnedTerm = normalizeTerm(learned.search_term);
  if (learnedTerm && t === learnedTerm) return true;
  const fam = termFamily(term);
  const lf = learned.term_family || termFamily(learned.search_term);
  const tokens = lf.split(" ").filter(Boolean);
  if (tokens.length < 2) return false;
  const have = new Set(fam.split(" ").filter(Boolean));
  return tokens.every((tok) => have.has(tok));
}

export function strongerHarvestOrdersNeeded(term: string, ledger: GnoLedgerRow[]): number {
  const skips = skipCountFor(term, ledger);
  if (skips < SKIP_THRESHOLD) return HARVEST_MIN;
  return HARVEST_MIN + EXTRA_ORDERS;
}

/**
 * Post-process a base tag. Base rules in tagAutoLooseTerm stay unchanged;
 * this only down-ranks harvest or strengthens junk from Dave's ledger.
 */
export function applyHarvestLearning(
  tag: ProposedTag,
  term: { orders: number; spend: number; search_term: string },
  ledger: GnoLedgerRow[],
): { tag: ProposedTag; note?: string } {
  if (!ledger.length) return { tag };

  if (tag === "HARVEST_CANDIDATE") {
    const need = strongerHarvestOrdersNeeded(term.search_term, ledger);
    if (need > HARVEST_MIN && term.orders < need) {
      return {
        tag: "KEEP",
        note: `downranked — skipped ${skipCountFor(term.search_term, ledger)}×, need L7 orders ≥ ${need}`,
      };
    }
  }

  const junkHits = ledger.filter((r) => r.dave_action === "approve_harvest_neg");
  if (
    (tag === "KEEP" || tag === "JUNK_CANDIDATE")
    && term.orders === 0
    && term.spend >= LEARNED_JUNK_MIN
    && junkHits.some((r) => learnedJunkMatch(term.search_term, r))
  ) {
    return {
      tag: "JUNK_CANDIDATE",
      note: tag === "JUNK_CANDIDATE"
        ? "junk pattern remembered"
        : "junk pattern learned — stronger JUNK signal",
    };
  }

  return { tag };
}

export function lastCallForCampaign(
  ledger: GnoLedgerRow[],
  campaignName: string,
): BidAction | null {
  const key = normalizeName(campaignName);
  if (!key) return null;
  const rows = ledger
    .filter((r) => isBidAction(r.dave_action) && normalizeName(r.campaign_name) === key)
    .sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""));
  const top = rows[0];
  return top && isBidAction(top.dave_action) ? top.dave_action : null;
}

const ACTION_RE = /^(approve_harvest_neg|bid_down|bid_up|hold|skip)\b/i;
const ACTION_END_RE = /\b(approve_harvest_neg|bid_down|bid_up|hold|skip)$/i;

export interface ParsedOutcome {
  dave_action: DaveAction;
  campaign_name?: string;
  search_term?: string;
  proposed_tag?: string;
  source: "paste";
}

/** One-line Grok outcomes. Never implies an Amazon write. */
export function parseGnoOutcomeLines(text: string): ParsedOutcome[] {
  const out: ParsedOutcome[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    let action: string | null = null;
    let rest = "";
    const head = ACTION_RE.exec(line);
    const tail = ACTION_END_RE.exec(line);
    if (head) {
      action = head[1].toLowerCase();
      rest = line.slice(head[0].length).trim();
    } else if (tail) {
      action = tail[1].toLowerCase();
      rest = line.slice(0, tail.index).trim();
    }
    if (!action || !isDaveAction(action) || !rest) continue;

    if (action === "hold" || action === "bid_down" || action === "bid_up") {
      out.push({
        dave_action: action,
        campaign_name: rest,
        proposed_tag: "NEW_EXACT",
        source: "paste",
      });
    } else {
      out.push({
        dave_action: action,
        search_term: rest,
        proposed_tag: action === "approve_harvest_neg" ? "JUNK_CANDIDATE" : "HARVEST_CANDIDATE",
        source: "paste",
      });
    }
  }
  return out;
}

export function ledgerInsertRow(
  entry: {
    dave_action: DaveAction;
    campaign_name?: string | null;
    search_term?: string | null;
    proposed_tag?: string | null;
    pack_date?: string | null;
    source?: string | null;
    notes?: string | null;
  },
): Record<string, unknown> {
  return {
    pack_date: entry.pack_date ?? null,
    campaign_name: entry.campaign_name ?? null,
    search_term: entry.search_term ?? null,
    term_family: termFamily(entry.search_term),
    proposed_tag: entry.proposed_tag ?? null,
    dave_action: entry.dave_action,
    source: entry.source ?? "ui",
    notes: entry.notes ?? null,
  };
}
