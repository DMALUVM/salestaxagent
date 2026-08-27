/**
 * Pallet-planner demand / YoY / date / remainder math.
 * Mirrors src/inventory/pallet_planner.py. Mix stays unlocked.
 */

import { parseReservedSplits, scOnHandUnits } from "./inventory-sc-on-hand";

/** Amazon pallet: 65 cases of 13×11×9 (270 units) = 17,550. Not 19,000. */
export const AMAZON_CASES_PER_PALLET = 65;
export const CARTONS_PER_BOX = 270;
export const PALLET_MAX_UNITS = AMAZON_CASES_PER_PALLET * CARTONS_PER_BOX;
export const PALLET_PARTIAL_MIN_RATIO = 0.5;
/** About 2 AWD pallets/month is the max. Not limited to 1. */
export const AWD_CARDS_PER_MONTH_MAX = 2;
export const AUGUST_HOP_LABEL = "Marpac→Tulsa";
export const AUGUST_HOP_DESTINATION = "marpac_tulsa";
export const AMAZON_IN_BY = "2026-10-31";
export const DEFAULT_RECEIVING_DAYS = 18;
export const TULSA_LIP_FLOOR_UNITS = 5_000;
export const CARTON_13X11X9_UNITS = 270;
export const CARTON_20X16X14_UNITS = 540;
export const FBA_INBOUND_MIN_BOXES = 5;
export const FBA_INBOUND_PREFERRED = CARTON_20X16X14_UNITS * FBA_INBOUND_MIN_BOXES;
export const FBA_INBOUND_MIN_FEE_FREE = CARTON_13X11X9_UNITS * FBA_INBOUND_MIN_BOXES;
export const FBA_INBOUND_STEP_AFTER = CARTON_20X16X14_UNITS;
export const DEFAULT_INBOUND_CARTON_UNITS = CARTON_20X16X14_UNITS;
/** Dave's actual August 3PL→FBA send today. Fee-safe on 270-unit / 13×11×9 boxes. */
export const LOCKED_TONIGHT_3PL_FBA_SEND: Record<string, number> = {
  DDPE0004Shop: 5_400, // assorted — 20 boxes of 270
  DDPE0003Shop: 4_860, // orange — 18 boxes of 270
  DDPE0002Shop: 0, // peppermint not in this send
  DDPE0001Shop: 0, // unscented not in this send
};
export const LOCKED_TONIGHT_3PL_FBA_TOTAL = 10_260;
export const FAMILY_FBA_CAP_PEAK = 55_600;
export const FAMILY_FBA_CAP_OCT_DEC = 49_400;

export function familyFbaCapForMonth(month?: string | null): number {
  if (!month) return FAMILY_FBA_CAP_PEAK;
  const mo = Number(String(month).slice(5, 7));
  if (mo === 10 || mo === 11 || mo === 12) return FAMILY_FBA_CAP_OCT_DEC;
  return FAMILY_FBA_CAP_PEAK;
}
export const OPTIMISTIC_AWD_ON_HAND_TARGETS: Record<string, number> = {
  DDPE0001Shop: 17_803,
  DDPE0002Shop: 10_590,
  DDPE0003Shop: 22_827,
  DDPE0004Shop: 24_991,
};
export const OPTIMISTIC_AWD_TARGET_CAP = 76_211;
/** Locked first-wave AWD buy after FBA is maxed. Not the 76,211 high water. */
export const FIRST_WAVE_AWD_TARGETS: Record<string, number> = {
  DDPE0004Shop: 17_550,
  DDPE0003Shop: 17_550,
  DDPE0001Shop: 17_550,
  DDPE0002Shop: 8_775,
};
export const FIRST_WAVE_AWD_TARGET_CAP = 61_425;
/** Assorted + orange first — target end of September, then unscented + peppermint.
 *  August may have two hops: Marpac→Tulsa TBD and 3PL→FBA today. */
export const FIRST_WAVE_AWD_SHIP_ORDER = [
  "DDPE0004Shop",
  "DDPE0003Shop",
  "DDPE0001Shop",
  "DDPE0002Shop",
] as const;
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

export function awdSurgeNeed(target: number, awdOnHand = 0, augustToAwd = 0): number {
  return Math.max(0, (target || 0) - Math.max(0, awdOnHand || 0) - Math.max(0, augustToAwd || 0));
}

export function firstWaveAwdNeed(target: number, augustToAwd = 0, tplToAwd = 0): number {
  return Math.max(0, (target || 0) - Math.max(0, augustToAwd || 0) - Math.max(0, tplToAwd || 0));
}

export function firstWaveShipSkus(skus: string[] = LIP_BALM_SKUS): string[] {
  const wanted = new Set(skus);
  const ordered: string[] = FIRST_WAVE_AWD_SHIP_ORDER.filter((sku) => wanted.has(sku));
  for (const sku of skus) {
    if (!ordered.includes(sku)) ordered.push(sku);
  }
  return ordered;
}

export function splitAugustToPiles(august: number, fbaGap: number): { toFba: number; toAwd: number } {
  const aug = Math.max(0, august || 0);
  const gap = Math.max(0, fbaGap || 0);
  const toFba = Math.min(aug, gap);
  return { toFba, toAwd: aug - toFba };
}

export function inboundCartonMin(cartonUnits = DEFAULT_INBOUND_CARTON_UNITS): number {
  return Math.max(1, cartonUnits || DEFAULT_INBOUND_CARTON_UNITS) * FBA_INBOUND_MIN_BOXES;
}

export function isLegalInboundQty(
  qty: number,
  cartonUnits = DEFAULT_INBOUND_CARTON_UNITS,
): boolean {
  const q = Number(qty || 0);
  if (q === 0) return true;
  const step = Math.max(1, cartonUnits || DEFAULT_INBOUND_CARTON_UNITS);
  return q >= inboundCartonMin(step) && q % step === 0;
}

export function feeFreeInboundQty(
  available: number,
  gap: number,
  preferred = FBA_INBOUND_PREFERRED,
  minSend = FBA_INBOUND_MIN_FEE_FREE,
  allowPartial = false,
): number {
  const cap = Math.min(Math.max(0, available || 0), Math.max(0, gap || 0));
  const step = Math.max(1, preferred || FBA_INBOUND_PREFERRED);
  const qty = Math.floor(cap / step) * step;
  if (qty >= preferred && isLegalInboundQty(qty, FBA_INBOUND_STEP_AFTER)) return qty;
  if (allowPartial && cap >= minSend && minSend > 0) return minSend;
  return 0;
}

export function allocate3plFbaSend(
  sku3pl: Record<string, number>,
  gaps: Record<string, number>,
  opts?: { floor?: number; awdLoaded?: boolean; skus?: string[]; preferred?: number; minSend?: number },
) {
  const skus = opts?.skus ?? Object.keys(sku3pl);
  const preferred = opts?.preferred ?? FBA_INBOUND_PREFERRED;
  const minSend = opts?.minSend ?? FBA_INBOUND_MIN_FEE_FREE;
  const awdLoaded = !!opts?.awdLoaded;
  const onHand: Record<string, number> = {};
  const gap: Record<string, number> = {};
  const send: Record<string, number> = {};
  for (const sku of skus) {
    onHand[sku] = Math.max(0, Number(sku3pl[sku] || 0));
    gap[sku] = Math.max(0, Number(gaps[sku] || 0));
    send[sku] = feeFreeInboundQty(onHand[sku], gap[sku], preferred, minSend);
  }
  const floorNow = awdLoaded ? 0 : Math.max(0, opts?.floor ?? TULSA_LIP_FLOOR_UNITS);
  const hold: Record<string, number> = {};
  for (const sku of skus) hold[sku] = onHand[sku] - send[sku];
  const holdTotal = () => skus.reduce((a, s) => a + hold[s], 0);
  while (!awdLoaded && holdTotal() < floorNow) {
    const candidates = skus.filter((s) => send[s] >= preferred);
    if (!candidates.length) break;
    const victim = candidates.reduce((a, b) => (send[a] < send[b] || (send[a] === send[b] && gap[a] < gap[b]) ? a : b));
    send[victim] -= preferred;
    hold[victim] += preferred;
  }
  for (const sku of skus) {
    if (send[sku] > 0 && send[sku] < minSend) {
      hold[sku] += send[sku];
      send[sku] = 0;
    }
  }
  const hop: Record<string, number> = {};
  for (const sku of skus) hop[sku] = 0;
  if (awdLoaded) {
    for (const sku of skus) {
      hop[sku] = Math.max(0, onHand[sku] - send[sku]);
      hold[sku] = 0;
    }
  }
  return {
    tplToFba: send,
    tulsaHold: hold,
    tplToAwd: hop,
    floor: floorNow,
    awdLoaded,
    sendTotal: skus.reduce((a, s) => a + send[s], 0),
    holdTotal: skus.reduce((a, s) => a + hold[s], 0),
    hopTotal: skus.reduce((a, s) => a + hop[s], 0),
    waitsOnAugust: Object.fromEntries(skus.map((s) => [s, send[s] === 0 && gap[s] > 0 && onHand[s] > 0])),
  };
}

/** August 3PL→FBA today: Dave's actual send. Do not re-allocate. */
export function applyLockedTonight3plFbaSend(
  sku3pl: Record<string, number>,
  gaps: Record<string, number> = {},
  opts?: { floor?: number; awdLoaded?: boolean; skus?: string[] },
) {
  const skus = opts?.skus ?? LIP_BALM_SKUS;
  const awdLoaded = !!opts?.awdLoaded;
  const onHand: Record<string, number> = {};
  const gap: Record<string, number> = {};
  const send: Record<string, number> = {};
  const hold: Record<string, number> = {};
  const hop: Record<string, number> = {};
  for (const sku of skus) {
    onHand[sku] = Math.max(0, Number(sku3pl[sku] || 0));
    gap[sku] = Math.max(0, Number(gaps[sku] || 0));
    send[sku] = Number(LOCKED_TONIGHT_3PL_FBA_SEND[sku] || 0);
    hold[sku] = Math.max(0, onHand[sku] - send[sku]);
    hop[sku] = 0;
  }
  const floorNow = awdLoaded ? 0 : Math.max(0, opts?.floor ?? TULSA_LIP_FLOOR_UNITS);
  return {
    tplToFba: send,
    tulsaHold: hold,
    tplToAwd: hop,
    floor: floorNow,
    awdLoaded,
    sendTotal: skus.reduce((a, s) => a + send[s], 0),
    holdTotal: skus.reduce((a, s) => a + hold[s], 0),
    hopTotal: 0,
    locked: true,
    waitsOnAugust: Object.fromEntries(skus.map((s) => [s, send[s] === 0 && gap[s] > 0 && onHand[s] > 0])),
  };
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
  _awdPlanned?: Record<string, number>,
  minUnits = TULSA_LIP_FLOOR_UNITS,
): boolean {
  const oh = Object.values(skuAwd ?? {}).reduce((a, v) => a + Math.max(Number(v) || 0, 0), 0);
  return oh >= Math.max(minUnits || 0, 0);
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

export function fbaCoverUnits(
  snap: {
    fulfillable?: number;
    reserved?: number;
    researching?: number;
    unfulfillable?: number;
  },
  restockRaw?: unknown,
  planningRaw?: unknown,
): number {
  return scOnHandUnits(
    Number(snap.fulfillable ?? 0),
    parseReservedSplits(restockRaw, planningRaw),
  );
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
  _skuWantedCover: Record<string, number> = {},
  skuAugust: Record<string, number> = {},
  skuAwd: Record<string, number> = {},
  opts?: { receiveDays?: number; tulsaFloor?: number; palletMax?: number; skus?: string[]; skuAwdTargets?: Record<string, number> },
) {
  const skus = opts?.skus ?? LIP_BALM_SKUS;
  const receiveDays = opts?.receiveDays ?? 35;
  const tulsaFloor = opts?.tulsaFloor ?? TULSA_LIP_FLOOR_UNITS;
  const palletMax = opts?.palletMax ?? PALLET_MAX_UNITS;
  const tgt = SEPT_FBA_ON_HAND_TARGETS;
  const useFirstWave = opts?.skuAwdTargets == null;
  const awdTgt = opts?.skuAwdTargets ?? FIRST_WAVE_AWD_TARGETS;
  const gaps = septFbaGaps(skuFba, skuInbound, tgt, skus);
  const skuAugustOut: Record<string, number> = {};
  const augustToFba: Record<string, number> = {};
  const augustToAwd: Record<string, number> = {};
  const gapAfterAug: Record<string, number> = {};
  for (const sku of skus) {
    const august = Math.max(0, Number(skuAugust[sku] || 0));
    skuAugustOut[sku] = august;
    const split = splitAugustToPiles(august, gaps[sku]?.gap ?? 0);
    augustToFba[sku] = split.toFba;
    augustToAwd[sku] = split.toAwd;
    gapAfterAug[sku] = Math.max(0, (gaps[sku]?.gap ?? 0) - split.toFba);
  }
  const awdNeedBefore: Record<string, number> = {};
  for (const sku of skus) {
    awdNeedBefore[sku] = useFirstWave
      ? firstWaveAwdNeed(awdTgt[sku] ?? 0, augustToAwd[sku])
      : awdSurgeNeed(awdTgt[sku] ?? 0, skuAwd[sku] ?? 0, augustToAwd[sku]);
  }
  const awdLoaded = awdCoversOffFbaReserve(skuAwd);
  const sendPlan = applyLockedTonight3plFbaSend(
    Object.fromEntries(skus.map((s) => [s, sku3pl[s] ?? 0])),
    gapAfterAug,
    { floor: tulsaFloor, awdLoaded, skus },
  );
  const tplToFba = sendPlan.tplToFba;
  const tplToAwd = sendPlan.tplToAwd;
  const tulsaHold = sendPlan.tulsaHold;
  const fbaStillShort: Record<string, number> = {};
  const skuManufacture: Record<string, number> = {};
  const mixedNeed: Record<string, number> = {};
  const fbaAfterSend: Record<string, number> = {};
  for (const sku of skus) {
    fbaStillShort[sku] = Math.max(0, gapAfterAug[sku] - (tplToFba[sku] ?? 0));
    mixedNeed[sku] = 0;
    skuManufacture[sku] = Math.max(0, awdNeedBefore[sku] - (tplToAwd[sku] ?? 0));
    fbaAfterSend[sku] = (gaps[sku]?.fbaPlusInbound ?? 0) + (tplToFba[sku] ?? 0) + augustToFba[sku];
  }
  const tulsa = familyTulsaFloor(
    Object.fromEntries(skus.map((s) => [s, sku3pl[s] ?? 0])),
    tulsaFloor, skuAwd,
  );
  const awdPallets = allocateSingleSkuAwdPallets(
    skuManufacture, firstWaveShipSkus(skus), palletMax,
  );
  return {
    targets: Object.fromEntries(skus.map((s) => [s, tgt[s] ?? 0])),
    targetCap: SEPT_FBA_TARGET_CAP,
    awdTargets: Object.fromEntries(skus.map((s) => [s, awdTgt[s] ?? 0])),
    awdTargetCap: skus.reduce((a, s) => a + (awdTgt[s] ?? 0), 0),
    firstWaveAwdTargets: Object.fromEntries(skus.map((s) => [s, FIRST_WAVE_AWD_TARGETS[s] ?? 0])),
    firstWaveAwdCap: FIRST_WAVE_AWD_TARGET_CAP,
    firstWaveShipOrder: firstWaveShipSkus(skus),
    nearTermAwdIsFirstWave: useFirstWave,
    optimisticAwdTargets: Object.fromEntries(skus.map((s) => [s, OPTIMISTIC_AWD_ON_HAND_TARGETS[s] ?? 0])),
    optimisticAwdTargetCap: OPTIMISTIC_AWD_TARGET_CAP,
    needInFba: SEPT_FBA_NEED_IN_BY,
    shipBy: septFbaShipBy(receiveDays),
    holidayGateLast3plFba: holidayGateLast3plFba(receiveDays),
    tulsaFloorUnits: sendPlan.floor,
    tulsa: { ...tulsa, hold: tulsaHold, holdTotal: sendPlan.holdTotal, afterSend: sendPlan.holdTotal },
    awdLoaded,
    gaps,
    skuAugust: skuAugustOut,
    augustToFba,
    augustToAwd,
    augustTbd: skus.every((s) => skuAugustOut[s] <= 0),
    skuManufacture,
    fbaStillShort,
    manufactureIntoFba: mixedNeed,
    tplToFba,
    tplToAwd,
    tulsaHold,
    fbaAfterSend,
    mixedNeed,
    awdNeed: skuManufacture,
    awdNeedBeforeTpl: awdNeedBefore,
    awdPallets,
    firstAction: {
      tplToFba,
      tplToFbaTotal: sendPlan.sendTotal,
      tplToAwd,
      tplToAwdTotal: sendPlan.hopTotal,
      tulsaHold,
      tulsaHoldTotal: sendPlan.holdTotal,
      fbaAfterSend,
      fbaAfterSendTotal: skus.reduce((a, s) => a + fbaAfterSend[s], 0),
      fbaStillShort,
      fbaStillShortTotal: skus.reduce((a, s) => a + fbaStillShort[s], 0),
      inboundPreferred: FBA_INBOUND_PREFERRED,
      inboundMin: FBA_INBOUND_MIN_FEE_FREE,
      skuWaitsOnAugust: sendPlan.waitsOnAugust,
      waitsOnAugust: skus.every((s) => skuAugustOut[s] <= 0),
      augustIsMixed: true,
      augustHop: AUGUST_HOP_LABEL,
      afterAugustSingleSkuAwd: true,
    },
    twoTracks: true,
    mixLocked: false,
    unstacked: true,
  };
}

export const AWD_SCHEDULE_MONTHS = ["2026-09", "2026-10", "2026-11", "2026-12"] as const;

const MONTH_LABELS = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthViewLabel(month: string): string {
  const [y, mo] = month.split("-");
  return `${MONTH_LABELS[Number(mo)] ?? month} ${y}`;
}

export function hopLabel(destination: string, awaitingAugust = false): string {
  if (destination === "3pl_fba") return "3PL→FBA";
  if (destination === "awd") return "single-SKU AWD";
  if (destination === AUGUST_HOP_DESTINATION || awaitingAugust) return AUGUST_HOP_LABEL;
  if (destination === "fba_then_awd") return "remaining FBA then AWD";
  return "";
}

function awdCardShipRank(card: { sku?: string; mix?: Record<string, number>; partial?: boolean; totalUnits: number }): [number, number, number] {
  const sku = card.sku || Object.keys(card.mix ?? {})[0] || "";
  const rank = (FIRST_WAVE_AWD_SHIP_ORDER as readonly string[]).indexOf(sku);
  return [rank < 0 ? 99 : rank, card.partial ? 1 : 0, -card.totalUnits];
}

export function assignAwdCardsToMonths<T extends { sku?: string; mix?: Record<string, number>; partial?: boolean; totalUnits: number }>(
  cards: T[],
  productionMonths: string[],
): Record<string, T[]> {
  let months = AWD_SCHEDULE_MONTHS.filter((m) => productionMonths.includes(m));
  if (months.length === 0) {
    months = productionMonths.filter((m) => !m.endsWith("-08") && m.slice(5, 7) >= "09") as typeof months;
  }
  const ordered = [...cards].sort((a, b) => {
    const ra = awdCardShipRank(a);
    const rb = awdCardShipRank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
  });
  const out: Record<string, T[]> = Object.fromEntries(months.map((m) => [m, []]));
  let i = 0;
  for (const month of months) {
    while (i < ordered.length && (out[month]?.length ?? 0) < AWD_CARDS_PER_MONTH_MAX) {
      out[month].push(ordered[i]);
      i += 1;
    }
  }
  const extras = months[months.length - 1];
  if (extras && i < ordered.length) out[extras].push(...ordered.slice(i));
  return out;
}

export type MonthViewEntry = {
  month: string;
  label: string;
  monthLabel: string;
  role: "gate" | "refill";
  status: "FIRM" | "INDICATIVE";
  pallets: number;
  fullPallets: number;
  leftoverUnits: number;
  heldUnits: number;
  partialUnits: number;
  hasPartial: boolean;
  fillPct: number;
  isPalletCard: boolean;
  awaitingAugustTotals: boolean;
  units: number;
  mix: Record<string, number>;
  destination: string;
  hopLabel: string;
  singleSku: boolean;
  track: string;
  nextHop: boolean;
  remainingFbaThenAwd: boolean;
  shipBy: string;
  inAmazon: string;
};

export function buildMonthViewEntries(opts: {
  productionMonths: string[];
  horizonByMonth: Record<string, HorizonMonth>;
  sept: ReturnType<typeof buildSeptemberPlan>;
  skuAugust?: Record<string, number>;
  committed?: Set<string>;
  amazonInBy?: string;
  peakEnd?: string;
  palletMax?: number;
  skus?: string[];
}): MonthViewEntry[] {
  const productionMonths = opts.productionMonths;
  const horizonByMonth = opts.horizonByMonth;
  const sept = opts.sept;
  const skus = opts.skus ?? LIP_BALM_SKUS;
  const palletMax = opts.palletMax ?? PALLET_MAX_UNITS;
  const amazonInBy = opts.amazonInBy ?? AMAZON_IN_BY;
  const peakEnd = opts.peakEnd ?? PEAK_END_DEFAULT;
  const committed = opts.committed ?? new Set<string>();
  const skuAugust = opts.skuAugust ?? sept.skuAugust ?? {};
  const tplToFba: Record<string, number> = {};
  const mixedNeed: Record<string, number> = {};
  for (const sku of skus) {
    tplToFba[sku] = Math.max(0, Number(sept.tplToFba?.[sku] ?? 0));
    mixedNeed[sku] = Math.max(0, Number(sept.mixedNeed?.[sku] ?? 0));
  }
  let awdCards = sept.awdPallets ?? [];
  if (awdCards.length === 0) {
    awdCards = allocateSingleSkuAwdPallets(sept.skuManufacture ?? {}, firstWaveShipSkus(skus), palletMax);
  }
  const awdByMonth = assignAwdCardsToMonths(awdCards, productionMonths);

  function dates(month: string, destination: string) {
    const h = horizonByMonth[month];
    const recv = h?.receiveDays ?? 35;
    if (destination === "3pl_fba") {
      const shipBy = sept.shipBy || septFbaShipBy(recv);
      return {
        role: "gate" as const,
        shipBy,
        inAmazon: inAmazonDate(shipBy, recv, SEPT_FBA_NEED_IN_BY, { clamp: true }),
      };
    }
    if (destination === "awd") {
      const shipBy = shipByForMonth(month, amazonInBy, recv, {
        role: "refill", needInFba: peakEnd,
      });
      return {
        role: "refill" as const,
        shipBy,
        inAmazon: inAmazonDate(shipBy, recv, peakEnd, { clamp: false }),
      };
    }
    const role = (h?.role ?? "gate") as "gate" | "refill";
    const shipBy = shipByForMonth(month, amazonInBy, recv, {
      role, needInFba: role === "refill" ? peakEnd : undefined,
    });
    const latest = role === "gate" ? amazonInBy : peakEnd;
    return {
      role,
      shipBy,
      inAmazon: inAmazonDate(shipBy, recv, latest, { clamp: role === "gate" }),
    };
  }

  function entry(
    month: string,
    mixIn: Record<string, number>,
    destination: string,
    extra: { singleSku: boolean; track: string; nextHop?: boolean; awaitingAugust?: boolean },
  ): MonthViewEntry {
    const { role, shipBy, inAmazon: arrive } = dates(month, destination);
    const mix: Record<string, number> = {};
    for (const [sku, qty] of Object.entries(mixIn)) {
      if (Number(qty) > 0) mix[sku] = Number(qty);
    }
    const total = Object.values(mix).reduce((a, b) => a + b, 0);
    const fill = palletFill(total, palletMax);
    const is3pl = destination === "3pl_fba";
    return {
      month,
      label: monthViewLabel(month),
      monthLabel: monthViewLabel(month),
      role,
      status: committed.has(month) ? "FIRM" : "INDICATIVE",
      pallets: is3pl ? (total > 0 ? 1 : 0) : fill.palletCards,
      fullPallets: is3pl ? 0 : fill.fullPallets,
      leftoverUnits: fill.leftoverUnits,
      heldUnits: is3pl ? 0 : fill.heldUnits,
      partialUnits: is3pl ? 0 : fill.partialUnits,
      hasPartial: is3pl ? false : fill.hasPartial,
      fillPct: fill.fillPct,
      isPalletCard: is3pl ? total > 0 : fill.isPalletCard,
      awaitingAugustTotals: !!extra.awaitingAugust,
      units: total,
      mix,
      destination,
      hopLabel: hopLabel(destination, !!extra.awaitingAugust),
      singleSku: extra.singleSku,
      track: extra.track,
      nextHop: !!extra.nextHop,
      remainingFbaThenAwd: (destination === "awd" || destination === "fba_then_awd") && month.endsWith("-09"),
      shipBy,
      inAmazon: arrive,
    };
  }

  const entries: MonthViewEntry[] = [];
  for (const month of productionMonths) {
    if (month.endsWith("-08")) {
      const mix: Record<string, number> = {};
      for (const sku of skus) {
        const qty = Number(skuAugust[sku] ?? 0);
        if (qty > 0) mix[sku] = qty;
      }
      entries.push(entry(month, mix, AUGUST_HOP_DESTINATION, {
        singleSku: false, track: "mixed_august",
        awaitingAugust: !!sept.augustTbd && Object.keys(mix).length === 0,
      }));
      const sendTotal = Object.values(tplToFba).reduce((a, b) => a + b, 0);
      if (sendTotal > 0) {
        entries.push(entry(month, tplToFba, "3pl_fba", {
          singleSku: false, track: "3pl_fba", nextHop: true,
        }));
      }
      continue;
    }
    if (month.endsWith("-09")) {
      const mixed: Record<string, number> = {};
      for (const sku of skus) if (mixedNeed[sku] > 0) mixed[sku] = mixedNeed[sku];
      if (Object.keys(mixed).length > 0) {
        entries.push(entry(month, mixed, "fba_then_awd", {
          singleSku: false, track: "remaining_fba",
        }));
      }
      for (const card of awdByMonth[month] ?? []) {
        entries.push(entry(month, card.mix, "awd", {
          singleSku: true, track: "single_sku_awd",
        }));
      }
      if (!entries.some((e) => e.month === month && e.units > 0)) {
        entries.push(entry(month, {}, "awd", { singleSku: true, track: "single_sku_awd" }));
      }
      continue;
    }
    const monthCards = awdByMonth[month] ?? [];
    if (monthCards.length > 0) {
      for (const card of monthCards) {
        entries.push(entry(month, card.mix, "awd", {
          singleSku: true, track: "single_sku_awd",
        }));
      }
    } else {
      entries.push(entry(month, {}, "awd", { singleSku: true, track: "single_sku_awd" }));
    }
  }
  return entries;
}
