/**
 * Pallet-planner demand / YoY / date / remainder math.
 * Mirrors src/inventory/pallet_planner.py. Mix stays unlocked.
 */

export const PALLET_MAX_UNITS = 19_000;
export const CARTONS_PER_BOX = 270;
export const AMAZON_IN_BY = "2026-10-31";
export const DEFAULT_RECEIVING_DAYS = 18;
export const YOY_WINDOW_MONTHS = [5, 6, 7] as const;
export const LIP_BALM_SKUS = [
  "DDPE0001Shop",
  "DDPE0002Shop",
  "DDPE0003Shop",
  "DDPE0004Shop",
];

export const ACTUAL_2025_SOURCE =
  "forecast_weekly scenario=actual_2025 is the holiday workbook's weekly " +
  "'2025 actual' column, dated onto 2026 week_start. It is not Amazon " +
  "monthly sales_by_sku (and does not match Sep/Oct/Nov–Dec 2025 totals).";

export type AmazonMonthlySale = {
  sku: string;
  period_start: string;
  units: number;
  channel?: string;
  source?: string;
};

export type MonthlyKey = `${string}|${number}|${number}`;

export function normalizeSku(sku: string | null | undefined): string {
  return String(sku ?? "").trim().toLowerCase();
}

export function isAmazonPulseRow(row: AmazonMonthlySale): boolean {
  const channel = String(row.channel ?? "amazon").trim().toLowerCase();
  const source = String(row.source ?? "amazon_spapi").trim().toLowerCase();
  if (channel !== "amazon") return false;
  if (source === "amazon_custom_combined_tax" || source === "amazon_tax_report") {
    return false;
  }
  return source === "amazon_spapi";
}

export function monthlyAmazonUnits(
  rows: AmazonMonthlySale[],
  skus: string[] = LIP_BALM_SKUS,
): Map<MonthlyKey, number> {
  const wanted = new Set(skus.map(normalizeSku));
  const totals = new Map<MonthlyKey, number>();
  for (const r of rows) {
    if (!isAmazonPulseRow(r)) continue;
    const sku = normalizeSku(r.sku);
    if (!wanted.has(sku)) continue;
    const ps = String(r.period_start ?? "").slice(0, 10);
    if (!ps) continue;
    const y = Number(ps.slice(0, 4));
    const m = Number(ps.slice(5, 7));
    const key = `${sku}|${y}|${m}` as MonthlyKey;
    totals.set(key, (totals.get(key) ?? 0) + Number(r.units ?? 0));
  }
  return totals;
}

export function familyYoyMayJul(
  monthly: Map<MonthlyKey, number>,
  skus: string[] = LIP_BALM_SKUS,
  currentYear = 2026,
  priorYear = 2025,
): { yoy: number; priorUnits: number; currentUnits: number; method: string } {
  const keys = skus.map(normalizeSku);
  let prior = 0;
  let current = 0;
  for (const sku of keys) {
    for (const mo of YOY_WINDOW_MONTHS) {
      prior += monthly.get(`${sku}|${priorYear}|${mo}` as MonthlyKey) ?? 0;
      current += monthly.get(`${sku}|${currentYear}|${mo}` as MonthlyKey) ?? 0;
    }
  }
  return {
    yoy: prior > 0 ? current / prior : 1,
    priorUnits: prior,
    currentUnits: current,
    method: "family_may_jul_amazon_sales_by_sku",
  };
}

export function holidayDemandFromSales(
  monthly: Map<MonthlyKey, number>,
  skus: string[],
  yoy: number,
  opts?: { holidayYear?: number; includeJan?: boolean },
): Record<string, {
  novDecPrior: number;
  novDecDemand: number;
  janPrior: number;
  janDemand: number;
  holidayDemand: number;
}> {
  const holidayYear = opts?.holidayYear ?? 2026;
  const includeJan = opts?.includeJan ?? true;
  const prior = holidayYear - 1;
  const out: Record<string, {
    novDecPrior: number;
    novDecDemand: number;
    janPrior: number;
    janDemand: number;
    holidayDemand: number;
  }> = {};
  for (const sku of skus) {
    const key = normalizeSku(sku);
    const novDecPrior =
      (monthly.get(`${key}|${prior}|11` as MonthlyKey) ?? 0) +
      (monthly.get(`${key}|${prior}|12` as MonthlyKey) ?? 0);
    const novDecDemand = Math.round(novDecPrior * yoy);
    const janPrior = monthly.get(`${key}|${holidayYear}|1` as MonthlyKey) ?? 0;
    const janDemand = includeJan ? Math.round(janPrior * yoy) : 0;
    out[sku] = {
      novDecPrior,
      novDecDemand,
      janPrior,
      janDemand,
      holidayDemand: novDecDemand + janDemand,
    };
  }
  return out;
}

export function palletFill(units: number, palletMax = PALLET_MAX_UNITS) {
  const u = Math.max(0, Math.floor(units));
  const max = Math.max(0, palletMax);
  const full = max > 0 ? Math.floor(u / max) : 0;
  const leftover = max > 0 ? u % max : u;
  return {
    units: u,
    fullPallets: full,
    leftoverUnits: leftover,
    fillPct: max > 0 ? u / max : 0,
    isPalletCard: u >= max,
  };
}

function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function lastShipDate(amazonInBy: string, receivingDays = DEFAULT_RECEIVING_DAYS): Date {
  const d = parseIso(amazonInBy);
  d.setDate(d.getDate() - Math.max(receivingDays, 0));
  return d;
}

export function inAmazonDate(
  shipBy: string,
  receivingDays: number,
  amazonInBy: string,
): string {
  const arrive = parseIso(shipBy);
  arrive.setDate(arrive.getDate() + Math.max(receivingDays, 0));
  const gate = parseIso(amazonInBy);
  return arrive.getTime() <= gate.getTime() ? toIso(arrive) : amazonInBy;
}

export function monthCanMakeGate(
  month: string,
  amazonInBy: string,
  receivingDays = DEFAULT_RECEIVING_DAYS,
): boolean {
  const start = parseIso(`${month}-01`);
  return start.getTime() <= lastShipDate(amazonInBy, receivingDays).getTime();
}

export function shipByForMonth(
  month: string,
  amazonInBy: string,
  receivingDays = DEFAULT_RECEIVING_DAYS,
): string {
  const [y, mo] = month.split("-").map(Number);
  const lastDay = new Date(y, mo, 0);
  const preferred = new Date(y, mo - 1, Math.min(20, lastDay.getDate()));
  const lastShip = lastShipDate(amazonInBy, receivingDays);
  const start = new Date(y, mo - 1, 1);
  let ship = preferred.getTime() <= lastShip.getTime() ? preferred : lastShip;
  if (ship.getTime() > lastDay.getTime()) ship = lastDay;
  if (ship.getTime() < start.getTime()) ship = start;
  return toIso(ship);
}

export function productionMonthsBeforeGate(
  today: Date,
  amazonInBy: string,
  receivingDays = DEFAULT_RECEIVING_DAYS,
  n = 3,
): string[] {
  const months: string[] = [];
  let y = today.getFullYear();
  let m = today.getMonth() + 1;
  for (let i = 0; i < n + 3; i++) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    if (monthCanMakeGate(month, amazonInBy, receivingDays)) months.push(month);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months.slice(0, n);
}

export function fbaCoverUnits(snap: {
  fulfillable?: number;
  reserved?: number;
  researching?: number;
  unfulfillable?: number;
}): number {
  return Number(snap.fulfillable ?? 0);
}

export function inboundInTransit(snap: {
  inbound_working?: number;
  inbound_shipped?: number;
  inbound_receiving?: number;
}): number {
  return (
    Number(snap.inbound_working ?? 0) +
    Number(snap.inbound_shipped ?? 0) +
    Number(snap.inbound_receiving ?? 0)
  );
}

export function latestRowPerSku<T extends { sku?: string | null; pulled_at?: string | null }>(
  rows: T[] | null | undefined,
): T[] {
  const best = new Map<string, T>();
  for (const row of rows ?? []) {
    const key = normalizeSku(row.sku);
    if (!key) continue;
    const prev = best.get(key);
    const stamp = row.pulled_at != null ? String(row.pulled_at) : "";
    const prevStamp = prev?.pulled_at != null ? String(prev.pulled_at) : "";
    if (!prev || stamp >= prevStamp) best.set(key, row);
  }
  return [...best.values()];
}

export function stampDate(iso?: string | null): string | null {
  if (!iso) return null;
  const d = String(iso).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}
