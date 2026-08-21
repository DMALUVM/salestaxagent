/**
 * Review-only entity obligations — the contested ones.
 *
 * These are rules whose `applies_when` is `user_confirmed`: California's $800
 * LLC tax, Kentucky's LLET, the Texas franchise report, Nevada's commerce tax.
 * Whether they apply turns on a legal position about THIS entity (is FBA
 * inventory "doing business"?), not on a fact the profile records. So they are
 * never scheduled and never dated — but they must always be *visible*, because
 * an obligation the user has not decided about is the one most likely to be
 * missed.
 *
 * Mirrors the `user_confirmed` branch of
 * `src/compliance/entity_obligations.py::evaluate_applicability`. The rule DATA
 * is shared (config/seed_entity_obligations.json) — only this thin
 * applicability check is duplicated, so there is one source of truth for what
 * each obligation says.
 */

export interface ReviewItem {
  state_code: string;
  obligation_type: string;
  form_code: string;
  title: string;
  frequency: string;
  due_rule_text: string;
  amount_estimate: number | null;
  amount_note: string | null;
  confidence: "high" | "medium" | "low" | string;
  /** Why it is contested — the sentence that explains the review status. */
  confidence_note: string | null;
  notes: string | null;
  source_authority: string | null;
  source_citation: string | null;
  source_url: string | null;
  /** The profile key that turns it into a scheduled obligation. */
  enable_key: string;
  /** True when the user has already enabled it — then it is NOT review-only. */
  enabled: boolean;
}

interface RawRule {
  state_code?: string;
  obligation_type?: string;
  form_code?: string;
  title?: string;
  frequency?: string;
  applies_when?: string;
  also_applies_when?: string;
  due_rule_text?: string;
  amount_estimate?: number | null;
  amount_note?: string;
  confidence?: string;
  confidence_note?: string;
  notes?: string;
  source?: { authority?: string; citation?: string; url?: string };
}

export interface ProfileLike {
  enabled_obligations?: Record<string, boolean>;
}

/**
 * Every `user_confirmed` rule, with its current enabled state.
 *
 * Enabled ones are returned too (flagged `enabled: true`) so the UI can show
 * that a decision was made rather than having the row silently disappear into
 * the scheduled list with no trace of why it is now there.
 */
export function buildReviewItems(
  rules: RawRule[],
  profile: ProfileLike,
): ReviewItem[] {
  const enabledMap = profile.enabled_obligations ?? {};

  return rules
    .filter((r) => r.applies_when === "user_confirmed" || r.also_applies_when === "user_confirmed")
    .map((r) => {
      const state = String(r.state_code ?? "");
      const type = String(r.obligation_type ?? "");
      const key = `${state}:${type}`;
      return {
        state_code: state,
        obligation_type: type,
        form_code: String(r.form_code ?? ""),
        title: String(r.title ?? ""),
        frequency: String(r.frequency ?? "annual"),
        due_rule_text: String(r.due_rule_text ?? ""),
        amount_estimate: r.amount_estimate ?? null,
        amount_note: r.amount_note ?? null,
        confidence: String(r.confidence ?? "low"),
        confidence_note: r.confidence_note ?? null,
        notes: r.notes ?? null,
        source_authority: r.source?.authority ?? null,
        source_citation: r.source?.citation ?? null,
        source_url: r.source?.url ?? null,
        enable_key: key,
        enabled: enabledMap[key] === true,
      };
    })
    .sort((a, b) => {
      // Highest-confidence first: those are the ones where only the "does it
      // apply to me" question is open, so they are the most actionable.
      const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
      const d = (rank[a.confidence] ?? 3) - (rank[b.confidence] ?? 3);
      return d !== 0 ? d : a.state_code.localeCompare(b.state_code);
    });
}

/**
 * Scope filter for review items.
 *
 * Deliberately NOT horizon-filtered: a review item has no due date, so a
 * "next 12 months" window has nothing to compare it against. Hiding undated
 * items behind a date filter is what made CA/KY/TX/NV invisible.
 */
export function filterReviewItems(
  items: ReviewItem[],
  allowedStates: Set<string> | null,
): ReviewItem[] {
  if (allowedStates === null) return items;
  return items.filter((i) => allowedStates.has(i.state_code));
}
