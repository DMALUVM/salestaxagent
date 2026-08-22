/**
 * "As of" date for the Contribution P&L.
 *
 * Amazon's day boundary is America/Los_Angeles (business rule 1), and both the
 * orders report and the ads reports are keyed on that calendar. Today is always
 * partial — sales are still accruing and the ads sync only runs through
 * yesterday — so every headline figure is anchored on YESTERDAY IN LA, the most
 * recent day that can actually be closed.
 */

export const AMAZON_TZ = "America/Los_Angeles";

/** Scheduler / filing-deadline zone — mirrors config/business_rules.json agent.timezone. */
export const AGENT_TZ = "America/New_York";

/** Today's date in AGENT_TZ, as YYYY-MM-DD. Filing due-date math uses this. */
export function agentToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AGENT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** Today's date in the Amazon reporting timezone, as YYYY-MM-DD. */
export function amazonToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AMAZON_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** Shift a YYYY-MM-DD string by whole days without tripping over DST. */
export function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`); // midday UTC: never crosses a date line
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Yesterday in the Amazon timezone — the newest day that can be closed. */
export function amazonAsOf(now: Date = new Date()): string {
  return shiftDays(amazonToday(now), -1);
}

/** First day of the month containing `isoDate`. */
export function monthStart(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

/** Inclusive window of `days` closed days ending at `asOf`. */
export function windowStart(asOf: string, days: number): string {
  return shiftDays(asOf, -(days - 1));
}

/** Format a Date using its local calendar fields (never UTC). */
export function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
