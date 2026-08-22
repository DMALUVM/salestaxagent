/**
 * Calendar grouping / horizon filters so a wall of identical Pending rows
 * can be scanned by month instead of as one undifferentiated table.
 */

export type DueWindow = "30d" | "90d" | "all";

export const DUE_WINDOW_LABELS: Record<DueWindow, string> = {
  "30d": "Next 30 days",
  "90d": "Next 90 days",
  all: "All upcoming",
};

export interface MonthGroup<T> {
  key: string;
  label: string;
  rows: T[];
}

/** Inclusive YYYY-MM-DD shift that does not trip over DST. */
function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
}

/**
 * Keep rows whose due date is on or before today+N.
 * Overdue rows (due_date < today) always stay — they are already late.
 */
export function filterByDueWindow<T extends { due_date: string }>(
  rows: T[],
  today: string,
  window: DueWindow,
): T[] {
  if (window === "all") return rows;
  const days = window === "30d" ? 30 : 90;
  const end = shiftDays(today, days);
  return rows.filter((r) => r.due_date <= end);
}

/** Group already-sorted filings by due-date month, preserving order. */
export function groupByDueMonth<T extends { due_date: string }>(
  rows: T[],
): MonthGroup<T>[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const row of rows) {
    const key = (row.due_date ?? "").slice(0, 7);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(row);
  }
  return order.map((key) => ({
    key,
    label: monthLabel(key),
    rows: groups.get(key)!,
  }));
}
