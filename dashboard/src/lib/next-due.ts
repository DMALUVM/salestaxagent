/**
 * Next unfiled period from last_filed_through + assigned frequency.
 *
 * Shared by What do I owe, Filings, and the Calendar implied-period
 * backfill so those pages cannot invent different due dates.
 */
import { formatLocalYmd } from "./as-of";
import { normalizeFilingFrequency } from "./filing-frequencies";
import type { FilingRow, NexusRow } from "./filing-eligibility";

export interface NextDue {
  due: string;
  days: number;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  periodType: string;
}

/**
 * Compute the next unfiled period's due date from filed_through + frequency.
 *
 * Rules:
 *   1. Next period starts the day after filed_through.
 *   2. Period end = end of the calendar month/quarter/half/year containing that start.
 *   3. Due date = dueDay of the month after period end.
 *   4. NEVER returns a due date whose period_end <= filed_through.
 *   5. If filed_through is null, returns null (no mass OVERDUE).
 *
 * Examples:
 *   MD quarterly, filed_through=2026-06-30, due_day=20
 *     → next period = Q3 2026 (07-01 to 09-30), due = 2026-10-20
 *   VT monthly, filed_through=2026-08-17, due_day=25
 *     → next period = August 2026 (08-01 to 08-31), due = 2026-09-25
 *   WY annual, filed_through=2026-08-17, due_day=20
 *     → next period = 2026 (01-01 to 12-31), due = 2027-01-20
 */
export function computeNextDue(
  filedThrough: string | null | undefined,
  frequency: string | null | undefined,
  dueDay: number,
  now: Date = new Date(),
): NextDue | null {
  if (!filedThrough || !frequency) return null;

  const ft = new Date(filedThrough + "T00:00:00");
  const start = new Date(ft);
  start.setDate(start.getDate() + 1);

  const y = start.getFullYear();
  const m = start.getMonth(); // 0-based
  const freq = normalizeFilingFrequency(frequency);

  if (freq === "casual") return null;

  let periodEndDate: Date;
  let periodStartDate: Date;
  let periodLabel: string;
  let periodType: string;

  if (freq === "monthly") {
    periodStartDate = new Date(y, m, 1);
    periodEndDate = new Date(y, m + 1, 0);
    periodLabel = `${y}-${String(m + 1).padStart(2, "0")}`;
    periodType = "monthly";
  } else if (freq === "quarterly") {
    const q = Math.floor(m / 3);
    periodStartDate = new Date(y, q * 3, 1);
    periodEndDate = new Date(y, q * 3 + 3, 0);
    periodLabel = `${y}-Q${q + 1}`;
    periodType = "quarterly";
  } else if (freq === "semi_annual") {
    const firstHalf = m < 6;
    periodStartDate = firstHalf ? new Date(y, 0, 1) : new Date(y, 6, 1);
    periodEndDate = firstHalf ? new Date(y, 6, 0) : new Date(y, 12, 0);
    periodLabel = firstHalf ? `${y}-H1` : `${y}-H2`;
    periodType = "semi_annual";
  } else if (freq === "annual") {
    periodStartDate = new Date(y, 0, 1);
    periodEndDate = new Date(y, 12, 0);
    periodLabel = String(y);
    periodType = "annual";
  } else {
    periodStartDate = new Date(y, m, 1);
    periodEndDate = new Date(y, m + 1, 0);
    periodLabel = `${y}-${String(m + 1).padStart(2, "0")}`;
    periodType = freq || "monthly";
  }

  const dueMonth = periodEndDate.getMonth() + 1;
  const dueYear =
    dueMonth > 11
      ? periodEndDate.getFullYear() + 1
      : periodEndDate.getFullYear();
  const dueDate = new Date(dueYear, dueMonth % 12, Math.min(dueDay, 28));

  const periodEnd = formatLocalYmd(periodEndDate);
  if (periodEnd <= filedThrough) return null;

  const due = formatLocalYmd(dueDate);
  const days = Math.ceil((dueDate.getTime() - now.getTime()) / 86400000);

  return {
    due,
    days,
    periodStart: formatLocalYmd(periodStartDate),
    periodEnd,
    periodLabel,
    periodType,
  };
}

export function dueDayByState(
  rules: Array<{ state_code: string; typical_due_day?: number | null }>,
): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rules) m[r.state_code] = r.typical_due_day ?? 20;
  return m;
}

export function isImpliedFilingId(id: string | null | undefined): boolean {
  return String(id ?? "").startsWith("implied:");
}

export function impliedFilingId(stateCode: string, periodType: string, periodLabel: string): string {
  return `implied:${stateCode}:${periodType}:${periodLabel}`;
}

/**
 * If last_filed_through implies an open period that filing_calendar is missing
 * (Vermont August 2026 while the table starts at September), surface it so
 * Calendar / Overview / Liability cannot disagree with Filings.
 */
export function mergeImpliedObligations<T extends FilingRow>(
  filings: T[],
  nexusRows: NexusRow[],
  dueDays: Record<string, number>,
): T[] {
  const extra: FilingRow[] = [];
  for (const n of nexusRows) {
    if (n.is_registered !== true) continue;
    const freq = n.assigned_frequency;
    if (!freq) continue;
    const next = computeNextDue(n.last_filed_through, freq, dueDays[n.state_code] ?? 20);
    if (!next) continue;
    const exists = filings.some((f) =>
      f.state_code === n.state_code
      && (f.period_end === next.periodEnd || f.period_label === next.periodLabel)
      && (!f.period_type || f.period_type === next.periodType),
    );
    if (exists) continue;
    extra.push({
      id: impliedFilingId(n.state_code, next.periodType, next.periodLabel),
      state_code: n.state_code,
      period_type: next.periodType,
      period_label: next.periodLabel,
      period_end: next.periodEnd,
      due_date: next.due,
      status: "pending",
    });
  }
  // Synthetic rows are FilingRow (plus implied id). Callers pass FilingEntry
  // and still render those fields; they are not a full T, so widen once here.
  return extra.length ? [...filings, ...extra] as unknown as T[] : filings;
}
