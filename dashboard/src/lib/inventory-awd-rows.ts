/**
 * Live AWD rows for the /inventory SKU table.
 *
 * AWD column = on-hand + inbound to AWD (inventory_awd.awd_inbound).
 * Not AWD→FBA in transit. A present 0-row is kept as 0. Missing row
 * stays blank unless inbound exists — then show inbound (+ on-hand).
 * Do not substitute the AWD high-water planning card (76,211) as on-hand.
 *
 * Number color only (no cell fill, no new column):
 *   white  = inbound > 0 and on-hand = 0 (in transit; sky, not body text)
 *   orange = inbound > 0 and on-hand > 0 (partial receive)
 *   green  = on-hand > 0 and inbound = 0 (fully available)
 *   none   = no AWD row, or a 0/0 row
 */

export type AwdRowLike = {
  sku?: string | null;
  awd_on_hand?: number | null;
  awd_inbound?: number | null;
  awd_to_fba_in_transit?: number | null;
  pulled_at?: string | null;
  synced_at?: string | null;
};

export type AwdCellTone = "white" | "orange" | "green" | null;

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

/** Inbound to AWD. Not AWD→FBA in transit. */
export function awdRowInbound(row: AwdRowLike | null | undefined): number | null {
  if (!row) return null;
  return Number(row.awd_inbound ?? 0);
}

/** AWD column / Total Amazon AWD term. On-hand + inbound to AWD. */
export function awdDisplayUnits(row: AwdRowLike | null | undefined): number | null {
  if (!row) return null;
  return Number(row.awd_on_hand ?? 0) + Number(row.awd_inbound ?? 0);
}

export function awdCellTone(row: AwdRowLike | null | undefined): AwdCellTone {
  if (!row) return null;
  const onHand = Number(row.awd_on_hand ?? 0);
  const inbound = Number(row.awd_inbound ?? 0);
  if (inbound > 0 && onHand === 0) return "white";
  if (inbound > 0 && onHand > 0) return "orange";
  if (onHand > 0 && inbound === 0) return "green";
  return null;
}

/** Text color for the AWD number. Never sets a cell background. */
export function awdCellToneClass(tone: AwdCellTone): string {
  if (tone === "white") {
    // Table body inherits text-foreground (dark ≈ oklch 0.985 / zinc-50).
    // text-zinc-200 matches that, so in-transit looked uncoded. Sky is a
    // cool light tone, readable on the dark table, not body / muted.
    return "text-sky-300";
  }
  if (tone === "orange") {
    return "text-orange-400";
  }
  if (tone === "green") {
    return "text-emerald-400";
  }
  return "";
}

export function isAwdHighWaterCard(value: number | null | undefined): boolean {
  return value === AWD_HIGH_WATER_FAMILY;
}
