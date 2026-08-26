/** Seasonal inbound lead times — mirrors src/inventory/leadtime_seasonal.py */

export const LEAD_MIN_DAYS = 4;
export const LEAD_MAX_DAYS = 45;
export const LOOKAHEAD_DAYS = 30;
export const MIN_MONTH_N = 3;

export const CALENDAR_PRIORS: Record<number, number> = {
  1: 1.15,
  2: 1.0,
  3: 1.0,
  4: 1.0,
  5: 1.0,
  6: 1.0,
  7: 1.0,
  8: 1.1,
  9: 1.25,
  10: 1.35,
  11: 1.5,
  12: 1.55,
};

export const OFFPEAK_MONTHS = new Set([2, 3, 4, 5, 6, 7]);

export type MonthlyLeadRow = {
  year_month: string;
  inbound_p50: number | null;
  inbound_p75: number | null;
  inbound_n: number;
  replenish_p50: number | null;
  replenish_p75: number | null;
  replenish_n: number;
  recv_p75: number | null;
};

export type LeadtimeSeasonal = {
  as_of: string;
  observed_receive_days: number | null;
  observed_inbound_days: number | null;
  observed_awd_to_fba_days: number | null;
  observed_inbound_n: number;
  observed_replen_n: number;
  offpeak_receive_days: number | null;
  offpeak_awd_to_fba_days: number | null;
  planning_receive_days: number | null;
  planning_awd_to_fba_days: number | null;
  factor: number;
  window: "off-peak" | "ramp" | "peak";
  lookahead_days: number;
  history_months: number;
  history_span: string | null;
  yoy_available: boolean;
  monthly: MonthlyLeadRow[];
  note: string;
};

export function daySpan(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const a = Date.parse(String(start));
  const b = Date.parse(String(end));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000);
}

export function percentileInclusive(vals: number[], p: number): number | null {
  const nums = vals
    .filter((n) => n >= LEAD_MIN_DAYS && n <= LEAD_MAX_DAYS)
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  const idx = Math.min(nums.length - 1, Math.floor((nums.length - 1) * p));
  return nums[idx];
}

export function calendarPrior(d: Date): number {
  const month = d.getMonth() + 1;
  const day = d.getDate();
  if (month === 1 && day > 15) return 1.0;
  return CALENDAR_PRIORS[month] ?? 1.0;
}

export function applyFactor(base: number | null, factor: number, cap?: number | null): number | null {
  if (base == null || base <= 0) return null;
  let days = Math.max(1, Math.round(base * factor));
  if (cap != null && cap > 0) days = Math.min(days, cap);
  return days;
}

export function windowLabel(factor: number): LeadtimeSeasonal["window"] {
  if (factor <= 1.02) return "off-peak";
  if (factor < 1.3) return "ramp";
  return "peak";
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function median(vals: number[]): number | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor((s.length - 1) / 2);
  if (s.length % 2 === 1) return s[mid];
  return Math.round((s[mid] + s[mid + 1]) / 2);
}

type Span = { created: Date; days: number };

function cleanSpans(
  rows: Array<Record<string, unknown>>,
  startKey: string,
  endKey: string,
  statusKey: string,
  okStatus: string,
  months?: Set<number>,
): Span[] {
  const out: Span[] = [];
  for (const r of rows) {
    if (String(r[statusKey] ?? "").toUpperCase() !== okStatus) continue;
    const startRaw = r[startKey] as string | null | undefined;
    const days = daySpan(startRaw, r[endKey] as string | null | undefined);
    if (!startRaw || days == null) continue;
    const created = new Date(startRaw);
    if (!Number.isFinite(created.getTime())) continue;
    if (months && !months.has(created.getUTCMonth() + 1)) continue;
    if (days >= LEAD_MIN_DAYS && days <= LEAD_MAX_DAYS) {
      out.push({ created, days });
    }
  }
  return out;
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthlyStatsFromRows(
  inboundRows: Array<Record<string, unknown>>,
  replenRows: Array<Record<string, unknown>>,
): MonthlyLeadRow[] {
  const byMonth = new Map<string, { inbound: number[]; replen: number[] }>();
  for (const s of cleanSpans(inboundRows, "created_at", "closed_at", "shipment_status", "CLOSED")) {
    const key = monthKey(s.created);
    const cur = byMonth.get(key) ?? { inbound: [], replen: [] };
    cur.inbound.push(s.days);
    byMonth.set(key, cur);
  }
  for (const s of cleanSpans(replenRows, "created_at", "completed_at", "order_status", "SUCCESS")) {
    const key = monthKey(s.created);
    const cur = byMonth.get(key) ?? { inbound: [], replen: [] };
    cur.replen.push(s.days);
    byMonth.set(key, cur);
  }

  return [...byMonth.keys()].sort().map((ym) => {
    const g = byMonth.get(ym)!;
    const inP75 = percentileInclusive(g.inbound, 0.75);
    const repP75 = percentileInclusive(g.replen, 0.75);
    const recv =
      inP75 != null && repP75 != null ? inP75 + repP75 : (inP75 ?? repP75);
    return {
      year_month: ym,
      inbound_p50: median(g.inbound),
      inbound_p75: inP75,
      inbound_n: g.inbound.length,
      replenish_p50: median(g.replen),
      replenish_p75: repP75,
      replenish_n: g.replen.length,
      recv_p75: recv,
    };
  });
}

export function monthFactor(
  d: Date,
  monthly: MonthlyLeadRow[],
  offpeakRecv: number | null,
): number {
  const prior = calendarPrior(d);
  if (!monthly.length || !offpeakRecv || offpeakRecv <= 0) return prior;

  const byYm = new Map(monthly.map((r) => [r.year_month, r]));
  const thisYm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const lastYm = `${d.getFullYear() - 1}-${String(d.getMonth() + 1).padStart(2, "0")}`;

  let row: MonthlyLeadRow | undefined;
  let weightScale = 1;
  const last = byYm.get(lastYm);
  if (last && last.recv_p75 && last.inbound_n + last.replenish_n >= MIN_MONTH_N) {
    row = last;
  } else {
    const cur = byYm.get(thisYm);
    if (cur && cur.recv_p75 && cur.inbound_n + cur.replenish_n >= MIN_MONTH_N) {
      row = cur;
      weightScale = 0.5;
    }
  }
  if (!row?.recv_p75) return prior;

  const measured = row.recv_p75 / offpeakRecv;
  if (measured < 0.7 || measured > 2.5) return prior;
  const nMonths = monthly.filter((r) => r.recv_p75 != null).length;
  const w = Math.min(0.8, nMonths / 12) * weightScale;
  return (1 - w) * prior + w * measured;
}

export function lookaheadFactor(
  today: Date,
  monthly: MonthlyLeadRow[],
  offpeakRecv: number | null,
  lookaheadDays = LOOKAHEAD_DAYS,
): number {
  let best = monthFactor(today, monthly, offpeakRecv);
  for (const offset of [15, 30, lookaheadDays]) {
    best = Math.max(best, monthFactor(addDays(today, offset), monthly, offpeakRecv));
  }
  return Math.round(best * 1000) / 1000;
}

function observedFromRows(
  inboundRows: Array<Record<string, unknown>>,
  replenRows: Array<Record<string, unknown>>,
  months?: Set<number>,
) {
  const inbound = cleanSpans(
    inboundRows, "created_at", "closed_at", "shipment_status", "CLOSED", months,
  ).map((s) => s.days);
  const replen = cleanSpans(
    replenRows, "created_at", "completed_at", "order_status", "SUCCESS", months,
  ).map((s) => s.days);
  const inboundDays = percentileInclusive(inbound, 0.75);
  const awdDays = percentileInclusive(replen, 0.75);
  const receiveDays =
    inboundDays != null && awdDays != null
      ? inboundDays + awdDays
      : (inboundDays ?? awdDays);
  return {
    inboundDays,
    awdDays,
    receiveDays,
    inboundN: inbound.length,
    replenN: replen.length,
  };
}

export function buildLeadtimeSeasonal(opts: {
  inboundRows: Array<Record<string, unknown>>;
  replenRows: Array<Record<string, unknown>>;
  today?: Date;
  peakCap?: number | null;
}): LeadtimeSeasonal {
  const today = opts.today ?? new Date();
  today.setHours(12, 0, 0, 0);
  const monthly = monthlyStatsFromRows(opts.inboundRows, opts.replenRows);
  const observed = observedFromRows(opts.inboundRows, opts.replenRows);
  const offpeak = observedFromRows(opts.inboundRows, opts.replenRows, OFFPEAK_MONTHS);
  const offpeakRecv = offpeak.receiveDays ?? observed.receiveDays;
  const offpeakAwd = offpeak.awdDays ?? observed.awdDays;
  const factor = lookaheadFactor(today, monthly, offpeakRecv);
  const cap = opts.peakCap ?? 35;

  let planRecv = applyFactor(offpeakRecv ?? observed.receiveDays, factor, cap);
  let planAwd = applyFactor(offpeakAwd ?? observed.awdDays, factor, null);
  if (planRecv != null && observed.receiveDays != null) {
    planRecv = Math.max(planRecv, observed.receiveDays);
  }
  if (planAwd != null && observed.awdDays != null) {
    planAwd = Math.max(planAwd, observed.awdDays);
  }

  const yms = monthly.map((r) => r.year_month);
  const yoy = monthly.some((r) => {
    const ym = r.year_month ?? "";
    return ym.startsWith(String(today.getFullYear() - 1)) && Number(ym.slice(5, 7)) >= 9 && r.recv_p75 != null;
  });

  return {
    as_of: ymd(today),
    observed_receive_days: observed.receiveDays,
    observed_inbound_days: observed.inboundDays,
    observed_awd_to_fba_days: observed.awdDays,
    observed_inbound_n: observed.inboundN,
    observed_replen_n: observed.replenN,
    offpeak_receive_days: offpeakRecv,
    offpeak_awd_to_fba_days: offpeakAwd,
    planning_receive_days: planRecv,
    planning_awd_to_fba_days: planAwd,
    factor,
    window: windowLabel(factor),
    lookahead_days: LOOKAHEAD_DAYS,
    history_months: yms.length,
    history_span: yms.length ? `${yms[0]} to ${yms[yms.length - 1]}` : null,
    yoy_available: yoy,
    monthly,
    note: yoy
      ? "Same-month last year is in the blend."
      : "No usable last-year Q4 yet (Dec 2025 inbound was a 230d stale row). Late Q3/Q4 uses calendar priors until those months fill in.",
  };
}
