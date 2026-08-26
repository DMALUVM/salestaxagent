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

export function manufactureNeed(
  inventoryReorder: number,
  holidayManufacture: number,
): number {
  return Math.max(inventoryReorder, holidayManufacture);
}

export function allocateMonthlyUnits(
  skus: string[],
  inventoryReorder: Record<string, number>,
  holidayManufacture: Record<string, number>,
  nMonths: number,
  weights: number[],
): Record<string, number>[] {
  if (nMonths <= 0) return [];

  const w = weights.slice();
  while (w.length < nMonths) w.push(0);
  const wAll = w.slice(0, nMonths).reduce((a, b) => a + b, 0) || 1;

  const leftover: Record<string, number> = {};
  const mixes: Record<string, number>[] = Array.from({ length: nMonths }, () => ({}));

  for (const sku of skus) {
    const reorder = inventoryReorder[sku] ?? 0;
    const holiday = holidayManufacture[sku] ?? 0;
    const mfg = manufactureNeed(reorder, holiday);
    const floor = Math.min(reorder, mfg);
    const extraPool = mfg - floor;
    const extra0 =
      extraPool > 0 ? Math.min(Math.round(extraPool * w[0] / wAll), extraPool) : 0;
    mixes[0][sku] = floor + extra0;
    leftover[sku] = extraPool - extra0;
  }

  const rest = nMonths - 1;
  if (rest <= 0) {
    return mixes.map((mix) => Object.fromEntries(
      Object.entries(mix).filter(([, qty]) => qty > 0),
    ));
  }

  const restW = w.slice(1, nMonths);
  for (let mi = 0; mi < rest; mi++) {
    const last = mi === rest - 1;
    const wi = restW[mi] ?? 0;
    const wSum = restW.slice(mi).reduce((a, b) => a + b, 0) || 0.01;
    for (const sku of skus) {
      const rem = leftover[sku] ?? 0;
      if (rem <= 0) continue;
      const alloc = last ? rem : Math.min(Math.round(rem * wi / wSum), rem);
      if (alloc > 0) {
        mixes[mi + 1][sku] = alloc;
        leftover[sku] = rem - alloc;
      }
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
