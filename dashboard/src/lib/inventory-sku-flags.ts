/**
 * Operator "not selling" flags — Overview alert hide only.
 * Does not change Holt / replen qty or delete inventory data.
 */

export type InventorySkuFlag = {
  sku: string;
  not_selling: boolean;
  updated_at?: string | null;
  updated_by?: string | null;
};

export function notSellingSkuSet(
  flags: Array<{ sku?: string | null; not_selling?: boolean | null }> | null | undefined,
): Set<string> {
  const set = new Set<string>();
  for (const f of flags ?? []) {
    if (!f?.not_selling || !f.sku) continue;
    set.add(f.sku);
    set.add(f.sku.toUpperCase());
  }
  return set;
}

export function isNotSellingSku(sku: string, hidden: Set<string>): boolean {
  return hidden.has(sku) || hidden.has(sku.toUpperCase());
}

export async function persistSkuNotSelling(
  sku: string,
  notSelling: boolean,
): Promise<void> {
  const r = await fetch("/api/inventory/sku-flags", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sku, not_selling: notSelling }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      (j as { error?: string }).error || "Could not save not-selling flag",
    );
  }
}
