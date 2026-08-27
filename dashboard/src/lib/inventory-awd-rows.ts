/**
 * Live AWD rows for the /inventory SKU table.
 *
 * A present row with awd_on_hand=0 must be kept (display 0).
 * Do not drop zero-qty rows. Do not invent a row (or a 0) when none exists.
 * Do not substitute the AWD high-water planning card (76,211) as on-hand.
 */

export type AwdRowLike = {
  sku?: string | null;
  awd_on_hand?: number | null;
  awd_inbound?: number | null;
  pulled_at?: string | null;
  synced_at?: string | null;
};

const AWD_HIGH_WATER_FAMILY = 76_211;

function skuKey(sku: string | null | undefined): string {
  return String(sku ?? "").trim();
}

/** Keep every AWD inventory row, including known zeros. */
export function keepAwdInventoryRows<T extends AwdRowLike>(
  rows: T[] | null | undefined,
): T[] {
  const kept: T[] = [];
  for (const row of rows ?? []) {
    if (!skuKey(row.sku)) continue;
    kept.push(row);
  }
  return kept;
}

export function awdRowOnHand(row: AwdRowLike | null | undefined): number | null {
  if (!row) return null;
  return Number(row.awd_on_hand ?? 0);
}

export function isAwdHighWaterCard(value: number | null | undefined): boolean {
  return value === AWD_HIGH_WATER_FAMILY;
}
