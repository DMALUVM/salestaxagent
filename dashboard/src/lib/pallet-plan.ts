/**
 * Monthly pallet allocation that stays consistent with inventory reorder.
 *
 * Month 0 ships each SKU's inventory-page reorder in full, then leftover
 * holiday surplus is split with the remaining month weights.
 *
 * A pallet holds PALLET_MAX_UNITS lip-balm cartons. Mixes that exceed
 * that are packed CRITICAL / highest-reorder first.
 */

export const PALLET_MAX_UNITS = 19_000;
export const HOLIDAY_DAYS_NOV_DEC = 61;
export const HOLIDAY_DAYS_NOV_JAN = 92;
export const CRITICAL_DOS_DAYS = 60;
export const RATE_DIVERGENCE_WARN_PCT = 25;
export const AMAZON_IN_BY = "2026-10-31";
/** Holiday build ships in these months so it is Prime-eligible by AMAZON_IN_BY. */
export const HOLIDAY_SHIP_MONTHS = ["2026-09", "2026-10"];

export function manufactureNeed(
  inventoryReorder: number,
  holidayManufacture: number,
): number {
  return Math.max(inventoryReorder, holidayManufacture);
}

function parseIsoDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function lastDayOfMonth(month: string): Date {
  const [y, mo] = month.split("-").map(Number);
  return new Date(y, mo, 0);
}

export function latestShipDate(amazonInBy: string, leadDays: number): string {
  const d = parseIsoDate(amazonInBy);
  d.setDate(d.getDate() - Math.max(leadDays, 0));
  return isoDate(d);
}

/** Latest day this month can ship and still arrive by amazonInBy. */
export function shipByForAmazonDeadline(
  month: string,
  amazonInBy = AMAZON_IN_BY,
  leadDays = 19,
  defaultDay = 20,
): string {
  const [y, mo] = month.split("-").map(Number);
  const last = lastDayOfMonth(month);
  const nominal = new Date(y, mo - 1, Math.min(defaultDay, last.getDate()));
  const latest = parseIsoDate(latestShipDate(amazonInBy, leadDays));
  const pick = nominal.getTime() < latest.getTime() ? nominal : latest;
  const first = new Date(y, mo - 1, 1);
  const clamped = pick.getTime() < first.getTime() ? first : pick;
  const vsLast = clamped.getTime() > last.getTime() ? last : clamped;
  return isoDate(vsLast);
}

export function monthCanArriveBy(
  month: string,
  amazonInBy = AMAZON_IN_BY,
  leadDays = 19,
): boolean {
  const first = parseIsoDate(`${month}-01`);
  const latest = parseIsoDate(latestShipDate(amazonInBy, leadDays));
  return first.getTime() <= latest.getTime();
}

export function holidayInboundMonths(
  months: string[],
  amazonInBy = AMAZON_IN_BY,
  leadDays = 19,
): string[] {
  const preferred = months.filter(
    (m) => HOLIDAY_SHIP_MONTHS.includes(m) && monthCanArriveBy(m, amazonInBy, leadDays),
  );
  if (preferred.length) return preferred;
  const fallback = [...months].reverse().find((m) => monthCanArriveBy(m, amazonInBy, leadDays));
  return fallback ? [fallback] : months.slice(0, 1);
}

export function allocateMonthlyUnits(
  skus: string[],
  inventoryReorder: Record<string, number>,
  holidayManufacture: Record<string, number>,
  months: string[],
  opts?: { amazonInBy?: string; leadDays?: number },
): Record<string, number>[] {
  if (!months.length) return [];

  const amazonInBy = opts?.amazonInBy ?? AMAZON_IN_BY;
  const leadDays = opts?.leadDays ?? 19;
  const holidayMonths = holidayInboundMonths(months, amazonInBy, leadDays);
  const mixes: Record<string, number>[] = Array.from({ length: months.length }, () => ({}));

  for (const sku of skus) {
    const reorder = inventoryReorder[sku] ?? 0;
    const holiday = holidayManufacture[sku] ?? 0;
    const mfg = manufactureNeed(reorder, holiday);
    const floor = Math.min(reorder, mfg);
    mixes[0][sku] = floor;
    let leftover = mfg - floor;
    if (leftover <= 0) continue;

    for (let hi = 0; hi < holidayMonths.length; hi++) {
      const mi = months.indexOf(holidayMonths[hi]);
      if (mi < 0) continue;
      const last = hi === holidayMonths.length - 1;
      const alloc = last
        ? leftover
        : Math.min(Math.round(leftover / (holidayMonths.length - hi)), leftover);
      if (alloc > 0) {
        mixes[mi][sku] = (mixes[mi][sku] ?? 0) + alloc;
        leftover -= alloc;
      }
    }
    if (leftover > 0) {
      mixes[0][sku] = (mixes[0][sku] ?? 0) + leftover;
    }
  }

  return mixes.map((mix) => Object.fromEntries(
    Object.entries(mix).filter(([, qty]) => qty > 0),
  ));
}

export function monthShortfall(
  mix: Record<string, number>,
  inventoryReorder: Record<string, number>,
  skus: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sku of skus) {
    const gap = Math.max(0, (inventoryReorder[sku] ?? 0) - (mix[sku] ?? 0));
    if (gap > 0) out[sku] = gap;
  }
  return out;
}

export function planningDaily(vel: {
  total_u_30?: number;
  total_u_90?: number;
  planning_u_30?: number;
  holiday_prior_daily?: number;
  summer_prior_daily?: number;
  holiday_surge_mult?: number;
}): number {
  const v30 = Number(vel.total_u_30 ?? 0);
  const v90 = Number(vel.total_u_90 ?? 0);
  const plan = Number(vel.planning_u_30 ?? 0);
  const holiday = Number(vel.holiday_prior_daily ?? 0);
  const summer = Number(vel.summer_prior_daily ?? 0);
  const surge = Number(vel.holiday_surge_mult ?? 1);
  const baseline = Math.max(v30, v90, summer);
  if (plan > 0) return Math.max(plan, baseline);
  if (surge > 1 && holiday > 0) {
    const yoy = summer > 0.01 ? Math.min(1.4, Math.max(0.75, baseline / summer)) : 1;
    return Math.max(baseline, holiday * yoy);
  }
  return Math.max(baseline, v30);
}

export function holidayDemandWithPlanning(
  forecastUnits: number,
  dailyPlanning: number,
  includeJan = true,
): number {
  const days = includeJan ? HOLIDAY_DAYS_NOV_JAN : HOLIDAY_DAYS_NOV_DEC;
  return Math.max(Math.round(forecastUnits), Math.round(dailyPlanning * days));
}

export function daysOfSupply(fba: number, dailyVelocity: number): number {
  if (dailyVelocity <= 0.001) return fba > 0 ? 9999 : 0;
  return Math.round(fba / dailyVelocity);
}

export function inventoryFlag(dos: number, dailyVelocity: number): "CRITICAL" | "OK" {
  return dailyVelocity > 0.001 && dos < CRITICAL_DOS_DAYS ? "CRITICAL" : "OK";
}

export function skuPackPriority(
  skus: string[],
  flags: Record<string, string>,
  reorders: Record<string, number>,
): string[] {
  return [...skus].sort((a, b) => {
    const fa = flags[a] === "CRITICAL" ? 0 : 1;
    const fb = flags[b] === "CRITICAL" ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return (reorders[b] ?? 0) - (reorders[a] ?? 0);
  });
}

export type PackedPallet = {
  num: number;
  mix: Record<string, number>;
  units: number;
};

export function monthPalletFillPct(
  units: number,
  palletCount: number,
  palletMax = PALLET_MAX_UNITS,
): number {
  const slots = Math.max(palletCount, 1) * palletMax;
  if (units <= 0) return 0;
  return Math.round(100 * units / slots);
}

export function packPallets(
  mix: Record<string, number>,
  priority: string[],
  palletMax = PALLET_MAX_UNITS,
): PackedPallet[] {
  const remaining: Record<string, number> = {};
  for (const [sku, qty] of Object.entries(mix)) {
    if (qty > 0) remaining[sku] = qty;
  }
  const order = [...priority];
  for (const sku of Object.keys(remaining)) {
    if (!order.includes(sku)) order.push(sku);
  }

  const pallets: PackedPallet[] = [];
  while (Object.values(remaining).some((q) => q > 0)) {
    let room = palletMax;
    const palletMix: Record<string, number> = {};
    for (const sku of order) {
      const qty = remaining[sku] ?? 0;
      if (qty <= 0 || room <= 0) continue;
      const take = Math.min(qty, room);
      palletMix[sku] = take;
      remaining[sku] = qty - take;
      room -= take;
    }
    const units = Object.values(palletMix).reduce((a, b) => a + b, 0);
    if (units <= 0) break;
    pallets.push({ num: pallets.length + 1, mix: palletMix, units });
  }
  return pallets;
}
