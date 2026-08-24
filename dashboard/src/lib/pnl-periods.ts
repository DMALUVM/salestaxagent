import { monthNameFromIso, monthStart, shiftDays, windowStart } from "./as-of";

/**
 * P&L table rollup — week / month / year over stored daily contribution.
 *
 * Every figure is a sum (or a mean of sums) of the account-grain rows
 * `src/pnl.py` already wrote. This file does not re-derive contribution, fill
 * missing days with $0, or invent ads/COGS for dates that were never synced.
 *
 * Week = Sunday–Saturday on the Amazon calendar (America/Los_Angeles dates,
 * which are already the `date` values on `pnl_daily`). Sunday is Seller
 * Central's reporting week, not ISO-8601 Monday.
 */

export type PnlGrain = "day" | "week" | "month" | "year";
export type PnlLookback = 30 | 90 | 365 | "all";

export const PNL_GRAINS: readonly PnlGrain[] = ["day", "week", "month", "year"];
export const PNL_LOOKBACKS: readonly PnlLookback[] = [30, 90, 365, "all"];

export interface PnlRow {
  date: string;
  gross_sales: number;
  units: number;
  ad_spend: number;
  est_referral_fees: number;
  est_fba_fees: number;
  est_cogs: number;
  est_contribution: number;
  amazon_net_proceeds: number | null;
  net_after_ads: number;
  status: string;
  fees_basis?: string;
}

export type FeesBasis = "settled" | "estimated" | "mixed" | "preliminary";

export interface PnlPeriod {
  key: string;
  grain: PnlGrain;
  label: string;
  start: string;
  end: string;
  /** Closed days with a stored P&L row. Gaps are not invented. */
  days: number;
  /** Calendar days in the period up to as-of (Sunday–Saturday = 7, etc.). */
  calendarDays: number;
  /** True when the period is still open or the stored rows do not cover it. */
  partial: boolean;
  /** Day grain only: the row is after as-of (today, still accruing). */
  open: boolean;
  sales: number;
  units: number;
  fees: number;
  ads: number;
  cogs: number;
  contribution: number;
  /** contribution ÷ days. Null when the period has no closed day. */
  avgDaily: number | null;
  feesBasis: FeesBasis;
  rows: PnlRow[];
  openRows: PnlRow[];
}

export interface PnlPeriodSummary {
  periods: number;
  days: number;
  sales: number;
  units: number;
  fees: number;
  ads: number;
  cogs: number;
  contribution: number;
  avgDaily: number | null;
}

export function weekStartSunday(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}

export function monthEnd(iso: string): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  if (!y || !m) return iso;
  return new Date(Date.UTC(y, m, 0, 12, 0, 0)).toISOString().slice(0, 10);
}

export function periodKey(date: string, grain: PnlGrain): string {
  if (grain === "day") return date;
  if (grain === "week") return weekStartSunday(date);
  if (grain === "month") return date.slice(0, 7);
  return date.slice(0, 4);
}

export function periodBounds(date: string, grain: PnlGrain): { start: string; end: string } {
  if (grain === "day") return { start: date, end: date };
  if (grain === "week") {
    const start = weekStartSunday(date);
    return { start, end: shiftDays(start, 6) };
  }
  if (grain === "month") {
    const start = monthStart(date);
    return { start, end: monthEnd(date) };
  }
  const y = date.slice(0, 4);
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

/** Inclusive day count between two YYYY-MM-DD strings. */
export function inclusiveDays(from: string, to: string): number {
  if (!from || !to || from > to) return 0;
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

export function filterLookback(
  rows: PnlRow[],
  asOf: string | null,
  lookback: PnlLookback,
): PnlRow[] {
  const sorted = [...rows].filter((r) => r?.date).sort((a, b) => b.date.localeCompare(a.date));
  if (lookback === "all" || !asOf) return sorted;
  const start = windowStart(asOf, lookback);
  return sorted.filter((r) => r.date >= start);
}

function n(row: PnlRow, key: keyof PnlRow): number {
  return Number(row[key] ?? 0);
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function feesBasisOf(rows: PnlRow[]): FeesBasis {
  const bases = new Set(rows.map((r) => (r.fees_basis === "settled" ? "settled" : "estimated")));
  if (bases.size === 0) return "estimated";
  if (bases.size === 1) return [...bases][0] as FeesBasis;
  return "mixed";
}

function utcMonthDay(iso: string, withYear = false): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
    timeZone: "UTC",
  });
}

export function periodLabel(start: string, end: string, grain: PnlGrain): string {
  if (grain === "day") return start;
  if (grain === "year") return start.slice(0, 4);
  if (grain === "month") return `${monthNameFromIso(start)} ${start.slice(0, 4)}`;
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  if (sameMonth) {
    return `${utcMonthDay(start)}–${Number(end.slice(8, 10))}, ${end.slice(0, 4)}`;
  }
  if (sameYear) return `${utcMonthDay(start)}–${utcMonthDay(end)}, ${end.slice(0, 4)}`;
  return `${utcMonthDay(start, true)}–${utcMonthDay(end, true)}`;
}

function rollup(
  grain: PnlGrain,
  closed: PnlRow[],
  openRows: PnlRow[],
  asOf: string | null,
): PnlPeriod {
  const sample = closed[0] ?? openRows[0];
  const bounds = periodBounds(sample.date, grain);
  const cap = asOf && asOf < bounds.end ? asOf : bounds.end;
  const calendarDays = inclusiveDays(bounds.start, cap);
  const days = closed.length;
  const open = grain === "day" && closed.length === 0 && openRows.length > 0;
  // Display figures come from closed days. An open (today) day still shows
  // its stored row so the table is not a blank preliminary line — the
  // footer / averages ignore it via `open`.
  const source = days > 0 ? closed : openRows;
  const sales = money(source.reduce((s, r) => s + n(r, "gross_sales"), 0));
  const units = source.reduce((s, r) => s + n(r, "units"), 0);
  const fees = money(source.reduce((s, r) => s + n(r, "est_referral_fees") + n(r, "est_fba_fees"), 0));
  const ads = money(source.reduce((s, r) => s + n(r, "ad_spend"), 0));
  const cogs = money(source.reduce((s, r) => s + n(r, "est_cogs"), 0));
  const contribution = money(source.reduce((s, r) => s + n(r, "net_after_ads"), 0));
  const endsShort = Boolean(asOf && asOf < bounds.end);
  // closed is newest-first; the oldest stored day is the last element.
  const oldest = closed.length ? closed[closed.length - 1].date : "";
  const newest = closed.length ? closed[0].date : "";
  const startsLate = Boolean(oldest && oldest > bounds.start);
  const endsEarly = Boolean(newest && newest < cap);
  const partial = open || endsShort || startsLate || endsEarly || days !== calendarDays;

  return {
    key: periodKey(sample.date, grain),
    grain,
    label: periodLabel(bounds.start, bounds.end, grain),
    start: bounds.start,
    end: bounds.end,
    days,
    calendarDays,
    partial,
    open,
    sales,
    units,
    fees,
    ads,
    cogs,
    contribution,
    avgDaily: days > 0 ? money(contribution / days) : null,
    feesBasis: open ? "preliminary" : feesBasisOf(closed),
    rows: [...closed].sort((a, b) => b.date.localeCompare(a.date)),
    openRows: [...openRows].sort((a, b) => b.date.localeCompare(a.date)),
  };
}

export function buildPnlPeriods(opts: {
  rows: PnlRow[];
  grain: PnlGrain;
  lookback: PnlLookback;
  asOf: string | null;
}): PnlPeriod[] {
  const view = filterLookback(opts.rows, opts.asOf, opts.lookback);
  const asOf = opts.asOf;
  const grain = opts.grain;

  if (grain === "day") {
    return view.map((row) => {
      const open = Boolean(asOf && row.date > asOf);
      return rollup("day", open ? [] : [row], open ? [row] : [], asOf);
    });
  }

  const groups = new Map<string, { closed: PnlRow[]; open: PnlRow[] }>();
  for (const row of view) {
    const key = periodKey(row.date, grain);
    const g = groups.get(key) ?? { closed: [], open: [] };
    if (asOf && row.date > asOf) g.open.push(row);
    else g.closed.push(row);
    groups.set(key, g);
  }

  const out: PnlPeriod[] = [];
  for (const g of groups.values()) {
    if (g.closed.length === 0) continue;
    out.push(rollup(grain, g.closed, g.open, asOf));
  }
  out.sort((a, b) => b.end.localeCompare(a.end) || b.start.localeCompare(a.start));
  return out;
}

/** Window totals from closed periods only — today never enters the average. */
export function summarizePeriods(periods: PnlPeriod[]): PnlPeriodSummary {
  const closed = periods.filter((p) => !p.open);
  const days = closed.reduce((s, p) => s + p.days, 0);
  const contribution = money(closed.reduce((s, p) => s + p.contribution, 0));
  return {
    periods: closed.length,
    days,
    sales: money(closed.reduce((s, p) => s + p.sales, 0)),
    units: closed.reduce((s, p) => s + p.units, 0),
    fees: money(closed.reduce((s, p) => s + p.fees, 0)),
    ads: money(closed.reduce((s, p) => s + p.ads, 0)),
    cogs: money(closed.reduce((s, p) => s + p.cogs, 0)),
    contribution,
    avgDaily: days > 0 ? money(contribution / days) : null,
  };
}

export function lookbackLabel(lookback: PnlLookback): string {
  return lookback === "all" ? "All" : `${lookback}d`;
}

export function grainLabel(grain: PnlGrain): string {
  return grain === "day" ? "Day" : grain === "week" ? "Week" : grain === "month" ? "Month" : "Year";
}

export function coverageLabel(period: PnlPeriod): string {
  if (period.open) return "preliminary · excluded";
  const { days, calendarDays, partial } = period;
  if (partial && days !== calendarDays) return `partial · ${days} of ${calendarDays}d`;
  if (partial) return `partial · ${days}d`;
  if (days !== calendarDays) return `${days} of ${calendarDays}d`;
  return `${days}d`;
}
