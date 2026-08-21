/**
 * Horizon and scope filtering for entity obligations.
 *
 * Mirror of src/compliance/entity_filters.py — the CLI and this page must not
 * disagree about what "next 12 months" means. Keep the two in step.
 *
 * Horizon: how far ahead to look. A 2028 obligation is real and worth
 * generating for planning, but letting it sit beside a live deadline is what
 * makes the list stop being read. Overdue items are ALWAYS shown regardless of
 * horizon — something already missed does not get less relevant with age.
 *
 * Scope: which states to show. Sales-tax registration and entity qualification
 * are different things, so scope selects a set of states to look at; it never
 * changes what is owed.
 */

/** 12 months: an annual filing always appears well before it is due, while
 *  next year's copy of the same filing stays out of the way. */
export const DEFAULT_HORIZON_DAYS = 365;

export type HorizonKey = "12m" | "24m" | "all";
export type ScopeKey = "all" | "registered" | "home_foreign";

export const HORIZONS: Record<HorizonKey, number | null> = {
  "12m": 365,
  "24m": 730,
  all: null,
};

export const HORIZON_LABELS: Record<HorizonKey, string> = {
  "12m": "Next 12 months",
  "24m": "Next 24 months",
  all: "All open",
};

export const SCOPE_LABELS: Record<ScopeKey, string> = {
  all: "All states",
  registered: "Registered for sales tax",
  home_foreign: "Home + foreign-qualified",
};

export function horizonDays(key: HorizonKey | null | undefined): number | null {
  if (!key || !(key in HORIZONS)) return DEFAULT_HORIZON_DAYS;
  return HORIZONS[key];
}

/**
 * States a scope admits, or null for "no restriction".
 *
 * `registered` deliberately UNIONS home + foreign-qualified rather than
 * replacing them: hiding Maryland because it is not a sales-tax registration
 * would drop a real obligation to satisfy a filter label.
 */
export function scopeStates(
  scope: ScopeKey,
  registered: Set<string>,
  homeState: string | null,
  foreignStates: Set<string>,
): Set<string> | null {
  const base = new Set(foreignStates);
  if (homeState) base.add(homeState);

  if (scope === "registered") return new Set([...registered, ...base]);
  if (scope === "home_foreign") return base;
  return null;
}

/**
 * Is this due date inside the horizon?
 *
 * A row with no due date (its rule needs a profile date the user has not
 * supplied) is never hidden — that is a gap to fill, not a deadline to defer.
 */
export function withinHorizon(
  due: string | null | undefined,
  todayIso: string,
  days: number | null,
): boolean {
  if (!due) return true;
  if (days === null) return true;
  if (due < todayIso) return true; // overdue always shows
  const delta = Math.round(
    (Date.parse(`${due}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000,
  );
  return delta <= days;
}

export interface ObligationLike {
  state_code: string;
  due_date: string | null;
  status?: string | null;
}

export interface FilteredResult<T extends ObligationLike> {
  overdue: T[];
  upcoming: T[];
  needsDate: T[];
  settled: T[];
  hiddenByHorizon: number;
  counts: { overdue: number; upcoming: number; needsDate: number; settled: number };
}

/**
 * Split rows into buckets under the selected horizon and scope.
 *
 * Takes raw rows rather than pre-bucketed ones so the page and the API cannot
 * disagree about which bucket a row belongs to.
 */
export function filterObligations<T extends ObligationLike>(
  rows: T[],
  todayIso: string,
  opts: {
    horizon?: HorizonKey;
    scope?: ScopeKey;
    registered?: Set<string>;
    homeState?: string | null;
    foreignStates?: Set<string>;
  } = {},
): FilteredResult<T> {
  const days = horizonDays(opts.horizon);
  const allowed = scopeStates(
    opts.scope ?? "all",
    opts.registered ?? new Set(),
    opts.homeState ?? null,
    opts.foreignStates ?? new Set(),
  );

  const inScope = rows.filter((r) => allowed === null || allowed.has(r.state_code));

  const settled = inScope.filter((r) => r.status && r.status !== "open");
  const open = inScope.filter((r) => !r.status || r.status === "open");

  const overdue = open.filter((r) => r.due_date && r.due_date < todayIso);
  const needsDate = open.filter((r) => !r.due_date);
  const upcomingAll = open.filter((r) => r.due_date && r.due_date >= todayIso);
  const upcoming = upcomingAll.filter((r) => withinHorizon(r.due_date, todayIso, days));

  const byDue = (a: T, b: T) => String(a.due_date ?? "").localeCompare(String(b.due_date ?? ""));
  overdue.sort(byDue);
  upcoming.sort(byDue);

  return {
    overdue,
    upcoming,
    needsDate,
    settled,
    hiddenByHorizon: upcomingAll.length - upcoming.length,
    counts: {
      overdue: overdue.length,
      upcoming: upcoming.length,
      needsDate: needsDate.length,
      settled: settled.length,
    },
  };
}
