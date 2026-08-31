import { generatesPeriodicCalendar } from "./filing-frequencies";

export interface FilingCalendarEntry {
  state_code: string;
  period_type: string;
  period_label: string;
  period_start: string;
  period_end: string;
  due_date: string;
  status: "pending";
}

/**
 * Generate filing_calendar rows for a state (current year + next year).
 *
 * Mirrors src/calendar/filing_calendar.py. Casual and any other non-periodic
 * frequency are a known no-op — do not invent quarterly (or other) periods.
 */
export function generateEntries(
  stateCode: string,
  frequency: string,
  dueDay: number,
  registrationDate: string | null,
): FilingCalendarEntry[] {
  if (!generatesPeriodicCalendar(frequency)) {
    return [];
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const allEntries: FilingCalendarEntry[] = [];

  for (const year of [currentYear, currentYear + 1]) {
    if (frequency === "monthly") {
      for (let month = 1; month <= 12; month++) {
        const pStart = isoDate(year, month, 1);
        const pEnd = lastDay(year, month);
        const dueMonth = month === 12 ? 1 : month + 1;
        const dueYear = month === 12 ? year + 1 : year;
        allEntries.push({
          state_code: stateCode,
          period_type: "monthly",
          period_label: `${year}-${String(month).padStart(2, "0")}`,
          period_start: pStart,
          period_end: pEnd,
          due_date: safeDate(dueYear, dueMonth, dueDay),
          status: "pending",
        });
      }
    } else if (frequency === "quarterly") {
      const qs: [string, number, number, number][] = [
        ["Q1", 1, 3, 4],
        ["Q2", 4, 6, 7],
        ["Q3", 7, 9, 10],
        ["Q4", 10, 12, 1],
      ];
      for (const [label, sm, em, dm] of qs) {
        const dueYear = dm < sm ? year + 1 : year;
        allEntries.push({
          state_code: stateCode,
          period_type: "quarterly",
          period_label: `${year}-${label}`,
          period_start: isoDate(year, sm, 1),
          period_end: lastDay(year, em),
          due_date: safeDate(dueYear, dm, dueDay),
          status: "pending",
        });
      }
    } else if (frequency === "semi_annual") {
      for (const [label, sm, em, dm] of [
        ["H1", 1, 6, 7],
        ["H2", 7, 12, 1],
      ] as [string, number, number, number][]) {
        const dueYear = dm < sm ? year + 1 : year;
        allEntries.push({
          state_code: stateCode,
          period_type: "semi_annual",
          period_label: `${year}-${label}`,
          period_start: isoDate(year, sm, 1),
          period_end: lastDay(year, em),
          due_date: safeDate(dueYear, dm, dueDay),
          status: "pending",
        });
      }
    } else if (frequency === "annual") {
      allEntries.push({
        state_code: stateCode,
        period_type: "annual",
        period_label: String(year),
        period_start: isoDate(year, 1, 1),
        period_end: isoDate(year, 12, 31),
        due_date: safeDate(year + 1, 1, dueDay),
        status: "pending",
      });
    }
  }

  // Skip periods that end entirely before registration date.
  // Only create filing obligations from registration forward.
  if (registrationDate) {
    return allEntries.filter((e) => e.period_end >= registrationDate);
  }
  return allEntries;
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function lastDay(y: number, m: number): string {
  const d = new Date(y, m, 0).getDate();
  return isoDate(y, m, d);
}

function safeDate(y: number, m: number, d: number): string {
  const max = new Date(y, m, 0).getDate();
  return isoDate(y, m, Math.min(d, max));
}
