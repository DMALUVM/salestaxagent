/**
 * FBA reimbursements on the Amazon (America/Los_Angeles) approval day.
 *
 * Cash awareness only — never folded into contribution / net_after_ads.
 * Credits are positive; reversals are negative.
 */
import { AMAZON_TZ } from "./as-of";

export interface ReimbursementRow {
  approval_date: string;
  amount_total: number | string | null;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Calendar day in America/Los_Angeles for a timestamptz / ISO string. */
export function approvalLaDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const raw = String(iso).trim();
  // Date-only is already an Amazon calendar day. `new Date("2026-07-15")`
  // is UTC midnight = the previous LA day — the same trap as taking [:10]
  // of a UTC timestamp in the Python parsers.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    const prefix = raw.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(prefix) ? prefix : null;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AMAZON_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** { YYYY-MM-DD: signed sum } on the Amazon approval day. */
export function sumReimbursementsByDay(rows: ReimbursementRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const day = approvalLaDay(r.approval_date);
    if (!day) continue;
    out[day] = money((out[day] ?? 0) + Number(r.amount_total ?? 0));
  }
  return out;
}

export function dayReimbursements(byDay: Record<string, number>, date: string): number {
  return money(byDay[date] ?? 0);
}

/** Sum every approval day whose YYYY-MM matches. */
export function monthReimbursements(byDay: Record<string, number>, ym: string): number {
  if (!ym || ym.length < 7) return 0;
  const prefix = ym.slice(0, 7);
  let total = 0;
  for (const [day, amt] of Object.entries(byDay)) {
    if (day.startsWith(prefix)) total += amt;
  }
  return money(total);
}

export function attachDayReimbursements<T extends { date: string }>(
  rows: T[],
  byDay: Record<string, number>,
): Array<T & { reimbursements: number }> {
  return rows.map((r) => ({ ...r, reimbursements: dayReimbursements(byDay, r.date) }));
}

export function attachMonthReimbursements<T extends { date: string }>(
  rows: T[],
  byDay: Record<string, number>,
): Array<T & { reimbursements: number }> {
  return rows.map((r) => ({
    ...r,
    reimbursements: monthReimbursements(byDay, r.date.slice(0, 7)),
  }));
}
