/**
 * Monthly pallet allocation that stays consistent with inventory reorder.
 *
 * Month 0 ships each SKU's inventory-page reorder in full, then leftover
 * holiday surplus is split with the remaining month weights.
 */

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
