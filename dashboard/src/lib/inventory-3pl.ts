/**
 * Live 3PL snapshot selection.
 *
 * inventory_3pl_snapshots is upsert-on-sku. A pull that omits a SKU leaves
 * that row at its old pulled_at. Filtering to max(pulled_at) then hides
 * leftover Tulsa stock (e.g. DDPE0001Shop after the 2026-08-26 cohort).
 */

export type TplSnapshotLike = {
  sku?: string | null;
  available?: number | null;
  incoming?: number | null;
  pulled_at?: string | null;
};

function skuKey(sku: string | null | undefined): string {
  return String(sku ?? "").trim().toLowerCase();
}

function pulledStamp(row: TplSnapshotLike): string {
  return row.pulled_at != null ? String(row.pulled_at) : "";
}

/** Latest pulled_at cohort plus leftover in-stock SKUs. Does not invent qty. */
export function live3plSnapshots<T extends TplSnapshotLike>(rows: T[] | null | undefined): T[] {
  if (!rows?.length) return [];

  let latest = "";
  for (const row of rows) {
    const stamp = pulledStamp(row);
    if (stamp > latest) latest = stamp;
  }

  const latestKeys = new Set(
    rows.filter((row) => pulledStamp(row) === latest).map((row) => skuKey(row.sku)),
  );

  return rows.filter((row) => {
    if (pulledStamp(row) === latest) return true;
    const available = Number(row.available ?? 0);
    const incoming = Number(row.incoming ?? 0);
    return (available > 0 || incoming > 0) && !latestKeys.has(skuKey(row.sku));
  });
}
