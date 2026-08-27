/**
 * Owned-network Total for the /inventory SKU table.
 *
 * Same formula on every SKU — no lip-family or named-SKU special case:
 *       FBA fulfillable
 *     + FBA reserved (inventory_snapshots.reserved; already includes
 *       customer orders + FC processing + staging)
 *     + inbound to FBA (working + shipped + receiving)
 *     + 3PL on-hand
 *     + AWD on-hand (only if a latest AWD row exists)
 *
 * Latest-per-SKU only. A missing source is blank and omitted from the sum.
 * A known 0 on a present row counts as 0.
 * AWD inbound is not FBA inbound.
 * Reserved is in the sum only — not a table column.
 * researching / unfulfillable are never added to Total or to the FBA
 * column.
 */

export type OwnedSource =
  | "fba_fulfillable"
  | "fba_reserved"
  | "fba_inbound"
  | "tpl_on_hand"
  | "awd_on_hand";

export type FbaSnapshotLike = {
  sku?: string | null;
  fulfillable?: number | null;
  inbound_working?: number | null;
  inbound_shipped?: number | null;
  inbound_receiving?: number | null;
  reserved?: number | null;
  researching?: number | null;
  unfulfillable?: number | null;
  /** Must never be folded into FBA inbound. */
  awd_inbound?: number | null;
  snapshot_at?: string | null;
  pulled_at?: string | null;
};

export type TplSnapshotLike = {
  sku?: string | null;
  available?: number | null;
  incoming?: number | null;
  pulled_at?: string | null;
};

export type AwdSnapshotLike = {
  sku?: string | null;
  awd_on_hand?: number | null;
  awd_inbound?: number | null;
  awd_to_fba_in_transit?: number | null;
  pulled_at?: string | null;
  synced_at?: string | null;
};

export type OwnedTotal = {
  sku: string;
  fbaFulfillable: number | null;
  /** In the Total sum only. Not a table column. */
  fbaReserved: number | null;
  fbaInbound: number | null;
  tplOnHand: number | null;
  awdOnHand: number | null;
  /** Null only when no source row exists. Missing sources are omitted, not zeroed. */
  total: number | null;
  complete: boolean;
  missing: OwnedSource[];
  asOf: {
    fba: string | null;
    tpl: string | null;
    awd: string | null;
  };
};

function skuKey(sku: string | null | undefined): string {
  return String(sku ?? "").trim();
}

function stampOf(value: string | null | undefined): string {
  return value != null ? String(value) : "";
}

export function latestRowPerSkuByStamp<T>(
  rows: T[] | null | undefined,
  stamp: (row: T) => string,
  sku: (row: T) => string | null | undefined = (row) =>
    (row as { sku?: string | null }).sku,
): Map<string, T> {
  const best = new Map<string, T>();
  for (const row of rows ?? []) {
    const key = skuKey(sku(row));
    if (!key) continue;
    const prev = best.get(key);
    const nextStamp = stamp(row);
    const prevStamp = prev ? stamp(prev) : "";
    if (!prev || nextStamp >= prevStamp) best.set(key, row);
  }
  return best;
}

export function latestOwnedSources(input: {
  snapshots?: FbaSnapshotLike[] | null;
  tpl?: TplSnapshotLike[] | null;
  awd?: AwdSnapshotLike[] | null;
}): {
  fba: Map<string, FbaSnapshotLike>;
  tpl: Map<string, TplSnapshotLike>;
  awd: Map<string, AwdSnapshotLike>;
} {
  return {
    fba: latestRowPerSkuByStamp(input.snapshots, (r) =>
      stampOf(r.snapshot_at ?? r.pulled_at),
    ),
    tpl: latestRowPerSkuByStamp(input.tpl, (r) => stampOf(r.pulled_at)),
    awd: latestRowPerSkuByStamp(input.awd, (r) => stampOf(r.pulled_at ?? r.synced_at)),
  };
}

/** FBA inbound only. Ignores awd_inbound even if present on the same object. */
export function fbaInboundUnits(snap: FbaSnapshotLike | null | undefined): number | null {
  if (!snap) return null;
  const { awd_inbound: _awdInbound, ...fba } = snap;
  void _awdInbound;
  return (
    Number(fba.inbound_working ?? 0) +
    Number(fba.inbound_shipped ?? 0) +
    Number(fba.inbound_receiving ?? 0)
  );
}

export function fbaFulfillableUnits(snap: FbaSnapshotLike | null | undefined): number | null {
  if (!snap) return null;
  return Number(snap.fulfillable ?? 0);
}

/** Same 0-vs-blank rule as AWD: present FBA row → number (0 allowed); no row → null. */
export function fbaReservedUnits(snap: FbaSnapshotLike | null | undefined): number | null {
  if (!snap) return null;
  return Number(snap.reserved ?? 0);
}

export function tplOnHandUnits(row: TplSnapshotLike | null | undefined): number | null {
  if (!row) return null;
  return Number(row.available ?? 0);
}

export function awdOnHandUnits(row: AwdSnapshotLike | null | undefined): number | null {
  if (!row) return null;
  return Number(row.awd_on_hand ?? 0);
}

export function ownedNetworkTotal(input: {
  sku: string;
  fba?: FbaSnapshotLike | null;
  tpl?: TplSnapshotLike | null;
  awd?: AwdSnapshotLike | null;
}): OwnedTotal {
  const fbaFulfillable = fbaFulfillableUnits(input.fba);
  const fbaReserved = fbaReservedUnits(input.fba);
  const fbaInbound = fbaInboundUnits(input.fba);
  const tplOnHand = tplOnHandUnits(input.tpl);
  const awdOnHand = awdOnHandUnits(input.awd);

  const missing: OwnedSource[] = [];
  if (fbaFulfillable == null) missing.push("fba_fulfillable");
  if (fbaReserved == null) missing.push("fba_reserved");
  if (fbaInbound == null) missing.push("fba_inbound");
  if (tplOnHand == null) missing.push("tpl_on_hand");
  if (awdOnHand == null) missing.push("awd_on_hand");

  const present = [fbaFulfillable, fbaReserved, fbaInbound, tplOnHand, awdOnHand].filter(
    (n): n is number => n != null,
  );
  const complete = missing.length === 0;
  return {
    sku: input.sku,
    fbaFulfillable,
    fbaReserved,
    fbaInbound,
    tplOnHand,
    awdOnHand,
    total: present.length ? present.reduce((sum, n) => sum + n, 0) : null,
    complete,
    missing,
    asOf: {
      fba: input.fba ? stampOf(input.fba.snapshot_at ?? input.fba.pulled_at) || null : null,
      tpl: input.tpl ? stampOf(input.tpl.pulled_at) || null : null,
      awd: input.awd ? stampOf(input.awd.pulled_at ?? input.awd.synced_at) || null : null,
    },
  };
}

export function ownedNetworkTotalForSku(
  sku: string,
  sources: ReturnType<typeof latestOwnedSources>,
): OwnedTotal {
  const key = skuKey(sku);
  return ownedNetworkTotal({
    sku,
    fba: sources.fba.get(key) ?? null,
    tpl: sources.tpl.get(key) ?? null,
    awd: sources.awd.get(key) ?? null,
  });
}

function ymd(iso: string | null): string | null {
  if (!iso) return null;
  const d = String(iso).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/** Tooltip / title: timestamps of the rows used, plus omitted sources. */
export function formatOwnedAsOf(total: OwnedTotal): string {
  const parts: string[] = [];
  if (total.asOf.fba) parts.push(`FBA ${total.asOf.fba}`);
  if (total.asOf.tpl) parts.push(`3PL ${total.asOf.tpl}`);
  if (total.asOf.awd) parts.push(`AWD ${total.asOf.awd}`);
  if (total.missing.length) {
    const miss = total.missing.join(", ");
    return parts.length
      ? `${parts.join(" · ")} · omitted ${miss}`
      : `No source rows (${miss})`;
  }
  return parts.join(" · ") || "Complete";
}

/** Oldest YMD among rows actually used in the sum. */
export function ownedAsOfLabel(total: OwnedTotal): string | null {
  const dates = [ymd(total.asOf.fba), ymd(total.asOf.tpl), ymd(total.asOf.awd)]
    .filter((d): d is string => !!d)
    .sort();
  return dates[0] ?? null;
}
