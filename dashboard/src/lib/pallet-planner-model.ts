/**
 * Pallet-planner demand / YoY / date / remainder math.
 * Mirrors src/inventory/pallet_planner.py. Mix stays unlocked.
 */

export const PALLET_MAX_UNITS = 19_000;
export const PALLET_PARTIAL_MIN_RATIO = 0.5;
export const CARTONS_PER_BOX = 270;
export const AMAZON_IN_BY = "2026-10-31";
export const DEFAULT_RECEIVING_DAYS = 18;
export const TULSA_LIP_FLOOR_UNITS = 5_000;
export const SEPT_FBA_ON_HAND_TARGETS: Record<string, number> = {
  DDPE0001Shop: 12_800,
  DDPE0002Shop: 8_300,
  DDPE0003Shop: 16_700,
  DDPE0004Shop: 17_800,
};
export const SEPT_FBA_TARGET_CAP = 55_600;
export const SEPT_FBA_NEED_IN_BY = "2026-10-07";
export const ASSORTED_SKU = "DDPE0004Shop";
export const PEAK_START_DEFAULT = "2026-10-01";
export const PEAK_END_DEFAULT = "2027-01-15";
export const EARLY_FEB_COVER_THROUGH = "2027-02-14";
export const DEC_DAYS = 31;
export const JAN_DAYS = 31;
export const YOY_WINDOW_MONTHS = [5, 6, 7] as const;
export const DEMAND_METHOD = "sku_2025_same_month_x_sku_may_jul_yoy";
export const WORKBOOK_WINDOW_MONTHS = new Set(["2026-11", "2026-12", "2026-01", "2027-01"]);
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

export function skuYoyMayJul(
  monthly: Map<MonthlyKey, number>,
  sku: string,
  currentYear = 2026,
  priorYear = 2025,
): {
  sku: string;
  yoy: number;
  priorUnits: number;
  currentUnits: number;
  method: string;
} {
  const key = normalizeSku(sku);
  let prior = 0;
  let current = 0;
  for (const mo of YOY_WINDOW_MONTHS) {
    prior += monthly.get(`${key}|${priorYear}|${mo}` as MonthlyKey) ?? 0;
    current += monthly.get(`${key}|${currentYear}|${mo}` as MonthlyKey) ?? 0;
  }
  return {
    sku,
    yoy: prior > 0 ? current / prior : 1,
    priorUnits: prior,
    currentUnits: current,
    method: "sku_may_jul_amazon_sales_by_sku",
  };
}

export function familyYoyMayJul(
  monthly: Map<MonthlyKey, number>,
  skus: string[] = LIP_BALM_SKUS,
  currentYear = 2026,
  priorYear = 2025,
): {
  yoy: number;
  priorUnits: number;
  currentUnits: number;
  method: string;
  appliedToSkus: boolean;
} {
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
    method: "family_may_jul_context_only",
    appliedToSkus: false,
  };
}

export function forecastSameMonth(
  monthly: Map<MonthlyKey, number>,
  sku: string,
  forecastYear: number,
  month: number,
  yoy: number,
): number {
  const key = normalizeSku(sku);
  const prior = monthly.get(`${key}|${forecastYear - 1}|${month}` as MonthlyKey) ?? 0;
  return Math.round(prior * yoy);
}

export function holidayDemandFromSales(
  monthly: Map<MonthlyKey, number>,
  skus: string[],
  opts?: { holidayYear?: number; includeJan?: boolean; currentYear?: number; priorYear?: number },
): Record<string, HolidayDemandRow> {
  const holidayYear = opts?.holidayYear ?? 2026;
  const includeJan = opts?.includeJan ?? true;
  const currentYear = opts?.currentYear ?? 2026;
  const priorYear = opts?.priorYear ?? 2025;
  const prior = holidayYear - 1;
  const out: Record<string, HolidayDemandRow> = {};
  for (const sku of skus) {
    const key = normalizeSku(sku);
    const yoyInfo = skuYoyMayJul(monthly, sku, currentYear, priorYear);
    const yoy = yoyInfo.yoy;
    const months2026: Record<number, number> = {};
    for (const mo of [9, 10, 11, 12]) {
      months2026[mo] = forecastSameMonth(monthly, sku, holidayYear, mo, yoy);
    }
    const novDecPrior =
      (monthly.get(`${key}|${prior}|11` as MonthlyKey) ?? 0) +
      (monthly.get(`${key}|${prior}|12` as MonthlyKey) ?? 0);
    const novDecDemand = months2026[11] + months2026[12];
    const janPrior = monthly.get(`${key}|${holidayYear}|1` as MonthlyKey) ?? 0;
    const janDemand = includeJan
      ? forecastSameMonth(monthly, sku, holidayYear + 1, 1, yoy)
      : 0;
    out[sku] = {
      novDecPrior,
      novDecDemand,
      janPrior,
      janDemand,
      holidayDemand: novDecDemand + janDemand,
      yoy,
      yoyMethod: yoyInfo.method,
      displayMethod: DEMAND_METHOD,
      months2026,
    };
  }
  return out;
}

export function workbookWindowUnits(
  fcRows: ForecastWeeklyRow[] | null | undefined,
  sku: string,
  scenario: string,
  months: Set<string> = WORKBOOK_WINDOW_MONTHS,
): number {
  let total = 0;
  for (const r of fcRows ?? []) {
    if (r.scenario !== scenario || r.sku !== sku) continue;
    const ws = String(r.week_start ?? "").slice(0, 7);
    if (months.has(ws)) total += Number(r.units ?? 0);
  }
  return Math.round(total);
}

export function applyAssortedCorrectionDisplay(
  demand: Record<string, HolidayDemandRow>,
  fcRows: ForecastWeeklyRow[] | null | undefined,
): Record<string, HolidayDemandRow> {
  const row = demand[ASSORTED_SKU];
  if (!row || !fcRows?.length) return demand;
  const cf = workbookWindowUnits(fcRows, ASSORTED_SKU, "correction_factor");
  const current = Number(row.holidayDemand ?? 0);
  if (cf <= 0 || current <= 0) return demand;
  const scale = cf / current;
  const months = { ...row.months2026 };
  let nov = Math.round(Number(months[11] ?? 0) * scale);
  let dec = Math.round(Number(months[12] ?? 0) * scale);
  const jan = Math.round(Number(row.janDemand ?? 0) * scale);
  dec += cf - (nov + dec + jan);
  months[11] = nov;
  months[12] = dec;
  return {
    ...demand,
    [ASSORTED_SKU]: {
      ...row,
      months2026: months,
      novDecDemand: nov + dec,
      janDemand: jan,
      holidayDemand: nov + dec + jan,
      displayMethod: "assorted_correction_factor_scaled",
      correctionFactorUnits: cf,
      yoyHolidayBeforeCf: current,
    },
  };
}

export function coverUnitsFromDaily(daily: number, coverDays: number): number {
  if (daily <= 0 || coverDays <= 0) return 0;
  return Math.round(daily * coverDays);
}

export function decemberDailyRate(decUnits: number): number {
  return Math.max(decUnits, 0) / DEC_DAYS;
}

export function januaryDailyRate(janUnits: number): number {
  return Math.max(janUnits, 0) / JAN_DAYS;
}

export type ForecastWeeklyRow = {
  sku: string;
  week_start: string;
  scenario: string;
  units: number;
};

export type HolidayDemandRow = {
  novDecPrior: number;
  novDecDemand: number;
  janPrior: number;
  janDemand: number;
  holidayDemand: number;
  yoy: number;
  yoyMethod: string;
  displayMethod: string;
  months2026: Record<number, number>;
  correctionFactorUnits?: number;
  yoyHolidayBeforeCf?: number;
};

export type PlannerSettings = {
  target_cover_days?: number;
  receiving_days_peak?: number;
  receiving_days_normal?: number;
  awd_to_fba_days?: number;
  peak_start_date?: string | null;
  peak_end_date?: string | null;
};

export type PlannerLeadtime = {
  fba_receive_median?: number | null;
  fba_receive_n?: number | null;
  awd_replenish_median?: number | null;
  awd_replenish_n?: number | null;
};

export function plannerPolicy(
  settings?: PlannerSettings | null,
  leadtime?: PlannerLeadtime | null,
) {
  const coverDays = Number(settings?.target_cover_days ?? 60);
  const recvPeak = Number(settings?.receiving_days_peak ?? 35);
  const recvNormal = Number(settings?.receiving_days_normal ?? 28);
  const awdCfg = Number(settings?.awd_to_fba_days ?? 14);
  const peakEnd = settings?.peak_end_date || PEAK_END_DEFAULT;
  const peakStart = settings?.peak_start_date || PEAK_START_DEFAULT;
  const measuredFba = leadtime?.fba_receive_median ?? null;
  const measuredAwd = leadtime?.awd_replenish_median ?? null;
  const awdDays = measuredAwd != null && measuredAwd > 0 ? measuredAwd : awdCfg;
  // Q4 / early January MUST use receiving_days_peak (35), not measured 20.
  return {
    targetCoverDays: coverDays,
    receivingDaysPeak: recvPeak,
    receivingDaysNormal: recvNormal,
    awdToFbaDays: awdCfg,
    gateReceiveDays: recvPeak,
    refillReceiveDays: recvPeak,
    effectiveAwdToFbaDays: awdDays,
    measuredFbaReceiveDays: measuredFba,
    peakReceiveOverridesMeasured: true,
    peakStartDate: peakStart,
    peakEndDate: peakEnd,
    earlyJanFbaShipBy: toIso(lastShipDate(peakEnd, recvPeak)),
    tulsaFloorUnits: TULSA_LIP_FLOOR_UNITS,
    tulsaCoverThrough: EARLY_FEB_COVER_THROUGH,
    septFbaNeedInBy: SEPT_FBA_NEED_IN_BY,
    septFbaShipBy: toIso(lastShipDate(SEPT_FBA_NEED_IN_BY, recvPeak)),
    holidayGateLast3plFba: toIso(lastShipDate(AMAZON_IN_BY, recvPeak)),
    fbaReceiveMedian: measuredFba,
    fbaReceiveN: Number(leadtime?.fba_receive_n ?? 0),
    awdReplenishMedian: measuredAwd,
    awdReplenishN: Number(leadtime?.awd_replenish_n ?? 0),
    amazonInBy: AMAZON_IN_BY,
  };
}

export function fbaManufactureGap(
  target: number,
  fba: number,
  inbound: number,
  august = 0,
): number {
  return Math.max(0, (target || 0) - Math.max(0, fba || 0) - Math.max(0, inbound || 0) - Math.max(0, august || 0));
}

export function remainingWantedCover(
  wantedCover: number,
  fbaTarget: number,
  awdOnHand = 0,
): number {
  return Math.max(0, (wantedCover || 0) - (fbaTarget || 0) - Math.max(0, awdOnHand || 0));
}

export function skuProductionBuild(
  demandRow: {
    novDecDemand?: number;
    janDemand?: number;
    months2026?: Record<number, number>;
  },
  opts?: { coverDays?: number; receiveDays?: number; optimisticUnits?: number; fbaTarget?: number },
) {
  const coverDays = opts?.coverDays ?? 60;
  const receiveDays = opts?.receiveDays ?? 35;
  const optimisticUnits = Number(opts?.optimisticUnits ?? 0);
  const decUnits = Number(demandRow.months2026?.[12] ?? 0);
  const janUnits = Number(demandRow.janDemand ?? 0);
  const novDec = Number(demandRow.novDecDemand ?? 0);
  const decDaily = decemberDailyRate(decUnits);
  const janDaily = januaryDailyRate(janUnits);
  const peakCover = coverUnitsFromDaily(decDaily, coverDays);
  const janCover = coverUnitsFromDaily(janDaily, coverDays);
  const endingCover = Math.max(peakCover, janCover);
  const pipeline = coverUnitsFromDaily(decDaily, receiveDays);
  const displayDemand = novDec + janUnits;
  const coverFulfill = Math.max(displayDemand, optimisticUnits);
  const stockToCover = Math.max(0, coverFulfill - displayDemand);
  const wantedCover = coverFulfill;
  const fbaTarget = Math.max(0, Number(opts?.fbaTarget ?? 0));
  const awdAmmo = remainingWantedCover(wantedCover, fbaTarget);
  const stackedBuild = coverFulfill + endingCover + pipeline;
  return {
    demand: displayDemand,
    displayDemand,
    sellthrough: displayDemand,
    coverFulfill,
    wantedCover,
    optimisticUnits,
    stockToCover,
    novDecDemand: novDec,
    janDemand: janUnits,
    decUnits,
    decDaily,
    janDaily,
    peakCover,
    janCover,
    endingCover,
    pipeline,
    gateUnits: novDec,
    refillUnits: stockToCover + janUnits,
    awdAmmo,
    fbaTarget,
    skuBuild: displayDemand,
    stackedBuild,
    unstacked: true,
  };
}

export function awdCoversOffFbaReserve(
  skuAwd?: Record<string, number>,
  awdPlanned?: Record<string, number>,
  minUnits = TULSA_LIP_FLOOR_UNITS,
): boolean {
  const oh = Object.values(skuAwd ?? {}).reduce((a, v) => a + Math.max(Number(v) || 0, 0), 0);
  const plan = Object.values(awdPlanned ?? {}).reduce((a, v) => a + Math.max(Number(v) || 0, 0), 0);
  return oh + plan >= Math.max(minUnits || 0, 0);
}

export function effectiveTulsaFloor(
  skuAwd?: Record<string, number>,
  awdPlanned?: Record<string, number>,
  floor = TULSA_LIP_FLOOR_UNITS,
): number {
  return awdCoversOffFbaReserve(skuAwd, awdPlanned) ? 0 : Math.max(0, floor);
}

export function familyTulsaFloor(
  sku3pl: Record<string, number>,
  floor = TULSA_LIP_FLOOR_UNITS,
  skuAwd?: Record<string, number>,
  awdPlanned?: Record<string, number>,
) {
  const awdLoaded = awdCoversOffFbaReserve(skuAwd, awdPlanned);
  const effective = effectiveTulsaFloor(skuAwd, awdPlanned, floor);
  const onHand = Object.values(sku3pl).reduce((a, v) => a + Math.max(Number(v) || 0, 0), 0);
  return {
    floor: effective,
    configuredFloor: Math.max(0, floor),
    awdLoaded,
    onHand,
    transferable: Math.max(0, onHand - effective),
    topUp: awdLoaded ? 0 : Math.max(0, effective - onHand),
    splitPerSku: false,
    neverZeroBoth: true,
  };
}

export function tulsaAfterChristmasOutbound(
  sku3pl: Record<string, number>,
  earlyJanFbaFromTulsa: number,
  floor = TULSA_LIP_FLOOR_UNITS,
  coverThrough = EARLY_FEB_COVER_THROUGH,
  skuAwd?: Record<string, number>,
  awdPlanned?: Record<string, number>,
) {
  const info = familyTulsaFloor(sku3pl, floor, skuAwd, awdPlanned);
  const need = Math.max(Number(earlyJanFbaFromTulsa) || 0, 0);
  const outbound = Math.min(need, info.transferable);
  const after = info.onHand - outbound;
  return {
    ...info,
    earlyJanFbaFromTulsa: need,
    outbound,
    afterOutbound: after,
    neededBeforeOutbound: need + info.floor,
    meetsFloorAfterOutbound: after >= info.floor,
    coverThrough,
    doNotDrainToZero: !info.awdLoaded,
  };
}

export type HorizonMonth = {
  month: string;
  role: "gate" | "refill";
  receiveDays: number;
  needInFba: string;
  label: string;
};

export function productionHorizonMonths(
  today: Date,
  amazonInBy = AMAZON_IN_BY,
  gateReceiveDays = 35,
  peakEnd = PEAK_END_DEFAULT,
  refillReceiveDays?: number,
): HorizonMonth[] {
  const refillRecv = refillReceiveDays ?? gateReceiveDays;
  const out: HorizonMonth[] = [];
  let y = today.getFullYear();
  let m = today.getMonth() + 1;
  const [peY, peM] = peakEnd.split("-").map(Number);
  while (y < peY || (y === peY && m <= peM)) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    const isGate = monthCanMakeGate(month, amazonInBy, gateReceiveDays);
    const gateYear = Number(amazonInBy.slice(0, 4));
    const isAmmo = y === gateYear && (m === 10 || m === 11 || m === 12) && !isGate;
    if (isGate) {
      out.push({
        month, role: "gate", receiveDays: gateReceiveDays,
        needInFba: amazonInBy, label: "in_fba_by_gate",
      });
    } else if (isAmmo) {
      out.push({
        month, role: "refill", receiveDays: refillRecv,
        needInFba: peakEnd, label: "post_christmas_ammo",
      });
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export function palletPartialMinUnits(palletMax = PALLET_MAX_UNITS): number {
  return Math.ceil(Math.max(palletMax, 0) * PALLET_PARTIAL_MIN_RATIO);
}

export function palletFill(units: number, palletMax = PALLET_MAX_UNITS) {
  const u = Math.max(0, Math.floor(units));
  const max = Math.max(0, palletMax);
  const full = max > 0 ? Math.floor(u / max) : 0;
  const leftover = max > 0 ? u % max : u;
  const leftoverPct = max > 0 ? leftover / max : 0;
  const partialMin = max > 0 ? palletPartialMinUnits(max) : 0;
  const hasPartial = leftover >= partialMin && partialMin > 0;
  const partialUnits = hasPartial ? leftover : 0;
  const heldUnits = hasPartial ? 0 : leftover;
  const palletCards = full + (hasPartial ? 1 : 0);
  return {
    units: u,
    fullPallets: full,
    leftoverUnits: leftover,
    leftoverPct,
    fillPct: leftoverPct,
    partialMinUnits: partialMin,
    hasPartial,
    partialUnits,
    heldUnits,
    palletCards,
    isPalletCard: palletCards > 0,
    mergeOrHold: !hasPartial && leftover > 0,
  };
}

export function palletCardSizes(
  fill: ReturnType<typeof palletFill>,
  palletMax = PALLET_MAX_UNITS,
): number[] {
  const sizes = Array.from({ length: fill.fullPallets }, () => palletMax);
  if (fill.hasPartial && fill.partialUnits > 0) sizes.push(fill.partialUnits);
  return sizes;
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

export function sellableDate(shipBy: string, receivingDays: number): string {
  const arrive = parseIso(shipBy);
  arrive.setDate(arrive.getDate() + Math.max(receivingDays, 0));
  return toIso(arrive);
}

export function earlyJanFbaShipBy(peakEnd = PEAK_END_DEFAULT, receivingDays = 35): string {
  return toIso(lastShipDate(peakEnd, receivingDays));
}

export function shipTooLateForEarlyJan(
  shipBy: string,
  receivingDays = 35,
  peakEnd = PEAK_END_DEFAULT,
): boolean {
  return sellableDate(shipBy, receivingDays) > peakEnd;
}

export function inAmazonDate(
  shipBy: string,
  receivingDays: number,
  amazonInBy: string,
  opts?: { clamp?: boolean },
): string {
  const arrive = parseIso(shipBy);
  arrive.setDate(arrive.getDate() + Math.max(receivingDays, 0));
  if (opts?.clamp === false) return toIso(arrive);
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
  opts?: { role?: "gate" | "refill"; needInFba?: string },
): string {
  const [y, mo] = month.split("-").map(Number);
  const lastDay = new Date(y, mo, 0);
  const preferred = new Date(y, mo - 1, Math.min(20, lastDay.getDate()));
  if (opts?.role === "refill") {
    let ship = preferred.getTime() <= lastDay.getTime() ? preferred : lastDay;
    if (opts.needInFba && mo === 12) {
      const lastFba = lastShipDate(opts.needInFba, receivingDays);
      if (lastFba.getTime() < ship.getTime()) ship = lastFba;
    }
    return toIso(ship);
  }
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

export function septFbaShipBy(receivingDays = 35): string {
  return toIso(lastShipDate(SEPT_FBA_NEED_IN_BY, receivingDays));
}

export function holidayGateLast3plFba(receivingDays = 35): string {
  return toIso(lastShipDate(AMAZON_IN_BY, receivingDays));
}

export function septFbaGaps(
  skuFba: Record<string, number>,
  skuInbound: Record<string, number>,
  targets: Record<string, number> = SEPT_FBA_ON_HAND_TARGETS,
  skus: string[] = LIP_BALM_SKUS,
) {
  const out: Record<string, {
    target: number; fba: number; inbound: number; fbaPlusInbound: number; gap: number;
  }> = {};
  for (const sku of skus) {
    const fba = Math.max(Number(skuFba[sku] || 0), 0);
    const inbound = Math.max(Number(skuInbound[sku] || 0), 0);
    const target = Number(targets[sku] || 0);
    out[sku] = {
      target, fba, inbound, fbaPlusInbound: fba + inbound,
      gap: Math.max(0, target - fba - inbound),
    };
  }
  return out;
}

export function transferable3plBySku(
  sku3pl: Record<string, number>,
  floor = TULSA_LIP_FLOOR_UNITS,
): Record<string, number> {
  const info = familyTulsaFloor(sku3pl, floor);
  let leftover = info.transferable;
  if (leftover <= 0) return Object.fromEntries(Object.keys(sku3pl).map((s) => [s, 0]));
  const total = info.onHand || 1;
  const out: Record<string, number> = {};
  for (const [sku, qty] of Object.entries(sku3pl)) {
    const share = Math.max(Number(qty) || 0, 0) / total;
    const alloc = Math.min(Math.round(leftover * share), leftover);
    out[sku] = alloc;
    leftover -= alloc;
  }
  if (leftover > 0) {
    const richest = Object.keys(sku3pl).reduce((a, b) => (sku3pl[a] >= sku3pl[b] ? a : b));
    out[richest] = (out[richest] ?? 0) + leftover;
  }
  return out;
}

export function sept3plToFba(
  sku3pl: Record<string, number>,
  gaps: Record<string, { gap?: number } | number>,
  floor = TULSA_LIP_FLOOR_UNITS,
): Record<string, number> {
  const xfer = transferable3plBySku(sku3pl, floor);
  const rec: Record<string, number> = {};
  for (const sku of Object.keys(sku3pl)) {
    const raw = gaps[sku];
    const gap = typeof raw === "object" ? Number(raw?.gap ?? 0) : Number(raw || 0);
    rec[sku] = Math.min(Math.max(Number(xfer[sku] || 0), 0), Math.max(gap, 0));
  }
  return rec;
}

export function allocateSingleSkuAwdPallets(
  remainder: Record<string, number>,
  skus: string[] = LIP_BALM_SKUS,
  palletMax = PALLET_MAX_UNITS,
) {
  const cards: {
    palletNum: number; sku: string; mix: Record<string, number>;
    totalUnits: number; locked: boolean; partial: boolean;
    destination: "awd"; singleSku: true;
  }[] = [];
  let n = 0;
  for (const sku of skus) {
    const qty = Math.max(Number(remainder[sku] || 0), 0);
    const fill = palletFill(qty, palletMax);
    for (const size of palletCardSizes(fill, palletMax)) {
      n += 1;
      cards.push({
        palletNum: n, sku, mix: { [sku]: size }, totalUnits: size,
        locked: false, partial: size < palletMax, destination: "awd", singleSku: true,
      });
    }
  }
  return cards;
}

export function buildSeptemberPlan(
  skuFba: Record<string, number>,
  skuInbound: Record<string, number>,
  sku3pl: Record<string, number>,
  skuWantedCover: Record<string, number> = {},
  skuAugust: Record<string, number> = {},
  skuAwd: Record<string, number> = {},
  opts?: { receiveDays?: number; tulsaFloor?: number; palletMax?: number; skus?: string[] },
) {
  const skus = opts?.skus ?? LIP_BALM_SKUS;
  const receiveDays = opts?.receiveDays ?? 35;
  const tulsaFloor = opts?.tulsaFloor ?? TULSA_LIP_FLOOR_UNITS;
  const palletMax = opts?.palletMax ?? PALLET_MAX_UNITS;
  const tgt = SEPT_FBA_ON_HAND_TARGETS;
  const gaps = septFbaGaps(skuFba, skuInbound, tgt, skus);
  const skuAugustOut: Record<string, number> = {};
  const skuManufacture: Record<string, number> = {};
  for (const sku of skus) {
    const august = Math.max(0, Number(skuAugust[sku] || 0));
    skuAugustOut[sku] = august;
    skuManufacture[sku] = fbaManufactureGap(tgt[sku] ?? 0, skuFba[sku] ?? 0, skuInbound[sku] ?? 0, august);
  }
  const awdNeed: Record<string, number> = {};
  for (const sku of skus) {
    awdNeed[sku] = remainingWantedCover(skuWantedCover[sku] ?? 0, tgt[sku] ?? 0, skuAwd[sku] ?? 0);
  }
  const floorNow = effectiveTulsaFloor(skuAwd, awdNeed, tulsaFloor);
  const tplToFba = sept3plToFba(
    Object.fromEntries(skus.map((s) => [s, sku3pl[s] ?? 0])),
    Object.fromEntries(skus.map((s) => [s, { gap: skuManufacture[s] }])),
    floorNow,
  );
  const mixedNeed: Record<string, number> = {};
  for (const sku of skus) {
    mixedNeed[sku] = Math.max(0, skuManufacture[sku] - (tplToFba[sku] ?? 0));
  }
  const tulsa = familyTulsaFloor(
    Object.fromEntries(skus.map((s) => [s, sku3pl[s] ?? 0])),
    tulsaFloor, skuAwd, awdNeed,
  );
  return {
    targets: Object.fromEntries(skus.map((s) => [s, tgt[s] ?? 0])),
    targetCap: SEPT_FBA_TARGET_CAP,
    needInFba: SEPT_FBA_NEED_IN_BY,
    shipBy: septFbaShipBy(receiveDays),
    holidayGateLast3plFba: holidayGateLast3plFba(receiveDays),
    tulsaFloorUnits: floorNow,
    tulsa,
    awdLoaded: tulsa.awdLoaded,
    gaps,
    skuAugust: skuAugustOut,
    augustTbd: skus.every((s) => skuAugustOut[s] <= 0),
    skuManufacture,
    tplToFba,
    mixedNeed,
    awdNeed,
    awdPallets: allocateSingleSkuAwdPallets(awdNeed, skus, palletMax),
    mixLocked: false,
    unstacked: true,
  };
}
