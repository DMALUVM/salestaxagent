/**
 * Which filing_calendar rows are real obligations.
 *
 * Mirror of src/calendar/eligibility.py — the dashboard chips, the Telegram
 * digest and the CLI must not disagree about what "overdue" means. Keep the
 * two in step; tests/test_filing_eligibility.py and filing-eligibility.test.ts
 * cover the same cases on purpose.
 *
 * These rules are about DATA STATUS, not tax law. A period surfaces only when
 * the user's own recorded state says an obligation exists: registered in that
 * state, period after registration, not already filed through, matching the
 * state's current cadence, not settled. Nexus alone never yields a filing
 * chip — it yields a "register / review" action, a different question.
 */

/** Periods needing nothing further from the user. */
export const SETTLED_STATUSES = new Set(["filed", "not_required"]);

/**
 * Recurring within-year cadences. Two different ones covering the same months
 * are a duplicate; `annual` is deliberately excluded because a yearly
 * reconciliation return legitimately coexists with a periodic cadence.
 */
export const PERIODIC_TYPES = new Set(["monthly", "quarterly", "semi_annual"]);

export interface FilingRow {
  state_code: string;
  period_type?: string | null;
  period_label?: string | null;
  period_end?: string | null;
  due_date: string;
  status?: string | null;
}

export interface NexusRow {
  state_code: string;
  is_registered?: boolean | null;
  registration_date?: string | null;
  assigned_frequency?: string | null;
  last_filed_through?: string | null;
}

export type ExclusionReason =
  | "settled"
  | "not_registered"
  | "pre_registration"
  | "filed_through"
  | "superseded_frequency";

export interface Exclusion {
  reason: ExclusionReason;
  detail: string;
}

function iso(v: string | null | undefined): string {
  return v ? String(v) : "";
}

/** null when the row is a live obligation, else why it is not. */
export function obligationStatus(
  filing: FilingRow,
  nexus: NexusRow | undefined,
): Exclusion | null {
  const status = String(filing.status ?? "pending");
  if (SETTLED_STATUSES.has(status)) {
    return { reason: "settled", detail: `status=${status}` };
  }

  // Registration gate. Sales-tax returns are owed because the user registered
  // to collect, not because they crossed a threshold. Rendering an
  // unregistered state's nexus as an overdue return misstates the situation
  // and buries the actual next step ("should I register?").
  if (!nexus) {
    return { reason: "not_registered", detail: "no nexus_status row for this state" };
  }
  if (nexus.is_registered !== true) {
    return { reason: "not_registered", detail: "is_registered is not true" };
  }

  const periodEnd = iso(filing.period_end) || iso(filing.due_date);

  const regDate = iso(nexus.registration_date);
  if (regDate && periodEnd && periodEnd < regDate) {
    return {
      reason: "pre_registration",
      detail: `period ended ${periodEnd}, registered ${regDate}`,
    };
  }

  // nexus_status.last_filed_through is the user's own high-water mark. The
  // Python deadline query always honoured it; the dashboard did not, which is
  // why already-filed NV periods still rendered as OVERDUE chips.
  const filedThrough = iso(nexus.last_filed_through);
  if (filedThrough && periodEnd && periodEnd <= filedThrough) {
    return {
      reason: "filed_through",
      detail: `period ended ${periodEnd}, filed through ${filedThrough}`,
    };
  }

  // The calendar upserts on (state, period_type, period_label), so changing a
  // state's frequency leaves the old cadence behind forever. The state then
  // carries two overlapping sets covering the same months, and filing one
  // leaves the other looking unfiled. Only the current cadence is live.
  //
  // This applies ONLY between two periodic cadences. An `annual` row alongside
  // a periodic cadence is NOT a leftover — several states require a yearly
  // reconciliation on top of periodic returns (Hawaii's G-49 sits on top of
  // the G-45 periodics exactly this way).
  const freq = nexus.assigned_frequency;
  const periodType = filing.period_type;
  if (freq && periodType && periodType !== freq
      && PERIODIC_TYPES.has(periodType) && PERIODIC_TYPES.has(freq)) {
    return {
      reason: "superseded_frequency",
      detail: `period_type=${periodType}, state files ${freq}`,
    };
  }

  return null;
}

export function isOpenObligation(filing: FilingRow, nexus: NexusRow | undefined): boolean {
  return obligationStatus(filing, nexus) === null;
}

export interface Classified<T extends FilingRow> {
  overdue: Array<T & { days_overdue: number }>;
  upcoming: Array<T & { days_until_due: number }>;
  excluded: Array<T & { excluded_reason: ExclusionReason; excluded_detail: string }>;
}

function daysBetween(fromIso: string, toIso: string): number {
  const MS = 86400000;
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / MS);
}

/**
 * Split calendar rows into overdue / upcoming / excluded.
 *
 * `todayIso` is passed in rather than read from the clock so the caller
 * controls the boundary and the function stays testable.
 */
export function classifyFilings<T extends FilingRow>(
  filings: T[],
  nexusRows: NexusRow[],
  todayIso: string,
): Classified<T> {
  const byState = new Map<string, NexusRow>();
  for (const n of nexusRows) byState.set(n.state_code, n);

  const overdue: Classified<T>["overdue"] = [];
  const upcoming: Classified<T>["upcoming"] = [];
  const excluded: Classified<T>["excluded"] = [];

  for (const f of filings) {
    const why = obligationStatus(f, byState.get(f.state_code));
    if (why) {
      excluded.push({ ...f, excluded_reason: why.reason, excluded_detail: why.detail });
      continue;
    }
    const due = iso(f.due_date);
    if (due && due < todayIso) {
      overdue.push({ ...f, days_overdue: daysBetween(due, todayIso) });
    } else {
      upcoming.push({ ...f, days_until_due: due ? daysBetween(todayIso, due) : 0 });
    }
  }

  overdue.sort((a, b) => iso(a.due_date).localeCompare(iso(b.due_date)));
  upcoming.sort((a, b) => iso(a.due_date).localeCompare(iso(b.due_date)));
  return { overdue, upcoming, excluded };
}
