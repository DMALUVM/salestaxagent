/**
 * Display helpers for supply plan dates — avoid misleading past MM-DD slices.
 */

export function formatManufactureAction(
  manufactureQty: number,
  orderBy: string | null,
  orderUrgent: boolean,
): string {
  if (manufactureQty <= 0) return "—";
  if (orderUrgent) return "Order now";
  if (orderBy) return orderBy;
  return "—";
}

export function formatShipBy(
  shipQty: number,
  nextShipBy: string | null,
  shipUrgent: boolean,
): string {
  if (shipQty <= 0) return "—";
  if (shipUrgent && !nextShipBy) return "Ship now";
  if (shipUrgent && nextShipBy) return `${nextShipBy} !`;
  if (nextShipBy) return nextShipBy;
  return "—";
}

export function formatStockoutDate(iso: string | null): string {
  if (!iso) return "—";
  return iso;
}

/** Manufacture order-by: place PO so units arrive at warehouse before first ship need. */
export function computeManufactureTiming(opts: {
  manufactureQty: number;
  tplShipWaves: Array<{ ship_by: string; urgent: boolean }>;
  productionLeadDays: number;
  receivingDays: number;
  today?: Date;
}): {
  orderBy: string | null;
  orderUrgent: boolean;
  nextShipBy: string | null;
  shipUrgent: boolean;
} {
  const today = opts.today ?? new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = localDate(today);

  const shipDates = opts.tplShipWaves.map((w) => w.ship_by).sort();
  const nextShipBy =
    shipDates.find((d) => d >= todayStr) ??
    shipDates[0] ??
    null;
  const shipUrgent = opts.tplShipWaves.some((w) => w.urgent);

  if (opts.manufactureQty <= 0) {
    return { orderBy: null, orderUrgent: false, nextShipBy, shipUrgent };
  }

  // Anchor: first warehouse ship we need stock for (future if possible)
  const anchorShip =
    shipDates.find((d) => d >= todayStr) ?? shipDates[0] ?? null;

  let orderBy: string | null = null;
  let orderUrgent = false;

  if (anchorShip) {
    const firstShip = new Date(anchorShip + "T00:00:00");
    const needAtWh = new Date(firstShip);
    needAtWh.setDate(needAtWh.getDate() - opts.receivingDays);
    const ob = new Date(needAtWh);
    ob.setDate(ob.getDate() - opts.productionLeadDays);
    orderUrgent = ob < today;
    orderBy = localDate(ob);
  } else {
    // No waves yet — back off from Oct 1 peak window
    let peakYear = today.getFullYear();
    if (today.getMonth() <= 1) peakYear -= 1;
    const peakStart = new Date(peakYear, 9, 1);
    const needAtWh = new Date(peakStart);
    needAtWh.setDate(needAtWh.getDate() - opts.receivingDays);
    const ob = new Date(needAtWh);
    ob.setDate(ob.getDate() - opts.productionLeadDays);
    orderUrgent = ob < today;
    orderBy = localDate(ob);
  }

  return { orderBy, orderUrgent, nextShipBy, shipUrgent };
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
