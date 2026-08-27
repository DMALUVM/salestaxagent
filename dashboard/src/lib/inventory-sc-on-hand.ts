/**
 * Seller Central on-hand + reserved splits for the /inventory SKU table.
 *
 * API fulfillable is not SC on-hand. Restock/planning raw "FC transfer"
 * sits in API reserved but in SC on-hand. If FBA is SC on-hand, adding
 * the full API reserved double-counts that transfer.
 *
 *   FBA (column)     = fulfillable + FC transfer
 *   SC reserved      = FC Processing + Customer Order
 *                    = API reserved − FC transfer
 *   AWD (column)     = on-hand + inbound to AWD (not AWD→FBA transit)
 *   Total Amazon     = AWD + FBA + FBA inbound + SC reserved + researching
 *                    (not unfulfillable; AWD inbound counted once via AWD)
 *   Total            = Total Amazon + 3PL
 *
 * Same formula on every SKU. No new table columns for reserved / age.
 */

export type ReservedSplits = {
  fcTransfer: number;
  fcProcessing: number;
  customerOrder: number;
  /** Planning "Total Reserved Quantity" when present. */
  totalReservedSc: number | null;
};

export type RestockRawLike = {
  sku?: string | null;
  raw?: unknown;
  pulled_at?: string | null;
};

export type PlanningRawLike = {
  sku?: string | null;
  raw?: unknown;
  pulled_at?: string | null;
};

function asRecord(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function intField(record: Record<string, unknown>, aliases: string[]): number | null {
  const wanted = new Set(aliases.map(normKey));
  for (const [key, value] of Object.entries(record)) {
    if (!wanted.has(normKey(key))) continue;
    const n = Number(String(value ?? "").replace(/,/g, "").trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseOne(raw: unknown): ReservedSplits {
  const record = asRecord(raw);
  return {
    fcTransfer: intField(record, ["FC transfer", "fc-transfer", "fc_transfer"]) ?? 0,
    fcProcessing:
      intField(record, ["FC Processing", "Reserved FC Processing", "fc-processing"]) ?? 0,
    customerOrder:
      intField(record, ["Customer Order", "Reserved Customer Order", "customer-order"]) ?? 0,
    totalReservedSc: intField(record, [
      "Total Reserved Quantity",
      "total-reserved-quantity",
      "totalReservedQuantity",
    ]),
  };
}

/** Prefer restock splits; fill gaps from planning raw. */
export function parseReservedSplits(
  restockRaw?: unknown,
  planningRaw?: unknown,
): ReservedSplits {
  const restock = parseOne(restockRaw);
  const planning = parseOne(planningRaw);
  return {
    fcTransfer: restock.fcTransfer || planning.fcTransfer,
    fcProcessing: restock.fcProcessing || planning.fcProcessing,
    customerOrder: restock.customerOrder || planning.customerOrder,
    totalReservedSc: restock.totalReservedSc ?? planning.totalReservedSc,
  };
}

/** Seller Central on-hand (sellable/cover). Not API fulfillable, not SC FBA total. */
export function scOnHandUnits(fulfillable: number, splits: ReservedSplits): number {
  return fulfillable + splits.fcTransfer;
}

/**
 * Reserved that is NOT already inside SC on-hand.
 * Never return the full API reserved when FC transfer is in on-hand.
 */
export function scReservedUnits(apiReserved: number, splits: ReservedSplits): number {
  const fromRestock = splits.fcProcessing + splits.customerOrder;
  if (fromRestock > 0) return fromRestock;
  if (splits.totalReservedSc != null) return splits.totalReservedSc;
  return Math.max(0, apiReserved - splits.fcTransfer);
}

export function totalAmazonUnits(input: {
  awdOnHand?: number | null;
  fbaOnHand?: number | null;
  inbound?: number | null;
  reservedSc?: number | null;
  researching?: number | null;
}): number | null {
  const parts = [
    input.awdOnHand,
    input.fbaOnHand,
    input.inbound,
    input.reservedSc,
    input.researching,
  ].filter((n): n is number => n != null);
  return parts.length ? parts.reduce((sum, n) => sum + n, 0) : null;
}
