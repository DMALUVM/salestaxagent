/**
 * SKU table column set for /inventory.
 *
 * Total is always in the default set and is forced on even when saved
 * localStorage prefs predate the column. It is never default-off.
 */

export type SkuTableColumnKey =
  | "sku"
  | "fba_fulfillable"
  | "awd_on_hand"
  | "tpl_available"
  | "inbound"
  | "total_amazon"
  | "owned_total"
  | "total_u_7"
  | "total_u_30"
  | "inventory_u_30"
  | "measured_receive_days"
  | "measured_replenish_days"
  | "dos"
  | "pipeline_dos"
  | "amz_rec_qty"
  | "our_reorder_qty"
  | "stockout_date"
  | "network_oos_date"
  | "flag";

export type SkuTableColumn = {
  key: SkuTableColumnKey;
  label: string;
  tip: string;
};

export const SKU_TABLE_COLUMNS: SkuTableColumn[] = [
  { key: "sku", label: "SKU", tip: "Seller SKU / MSKU" },
  {
    key: "fba_fulfillable",
    label: "FBA",
    tip: "Seller Central on-hand (sellable/cover): API fulfillable + FC transfer. Not API fulfillable alone, not SC FBA total. Unfulfillable is not included.",
  },
  {
    key: "awd_on_hand",
    label: "AWD",
    tip: "AWD on-hand + inbound to AWD. Not AWD→FBA in transit. 0 means a row exists at 0. Em dash means no AWD row. Cell color: white = inbound only, orange = partial receive, green = fully available. Not the AWD high-water target.",
  },
  { key: "tpl_available", label: "3PL", tip: "Third-party / own warehouse (Tulsa). 0 means a row exists at 0. Em dash means no 3PL row." },
  { key: "inbound", label: "Inbnd", tip: "Amazon inbound to FBA only — not yet sellable. AWD inbound is not included." },
  {
    key: "total_amazon",
    label: "Total Amazon",
    tip: "AWD (on-hand + inbound to AWD) + FBA on-hand + FBA inbound + reserved + researching. Not unfulfillable. AWD inbound is counted once here, never as FBA inbound. FC transfer is already inside FBA on-hand, so reserved is SC reserved only (API reserved minus FC transfer).",
  },
  {
    key: "owned_total",
    label: "Total",
    tip: "Total Amazon + 3PL. Same formula on every SKU. Reserved is in Total Amazon, not a column. Unfulfillable is not included. A missing source is blank and omitted. A known 0 counts as 0. AWD inbound is inside the AWD term, once. As-of is the timestamps of the rows used.",
  },
  { key: "total_u_7", label: "V7", tip: "Average daily units sold over last 7 days" },
  { key: "total_u_30", label: "V30", tip: "Average daily units sold over last 30 days (orders report)" },
  { key: "inventory_u_30", label: "Inv V30", tip: "FBA units shipped/day from the inventory ledger (last 30 days). Compare to orders V30." },
  { key: "measured_receive_days", label: "Recv", tip: "Warehouse ship → FBA sellable: AWD inbound + AWD→FBA (75th percentile, 4–45 day samples). Not the 4-day parcel median." },
  { key: "measured_replenish_days", label: "AWD→FBA", tip: "AWD replenish created → SUCCESS at FBA (75th percentile). Drops 1–3 day status flips." },
  { key: "dos", label: "DOS", tip: "Days of supply — FBA cover (Amazon) or warehouse cover (Shop)" },
  { key: "pipeline_dos", label: "+Pipe", tip: "Cover in days if FBA+AWD+Inbound all become sellable" },
  { key: "amz_rec_qty", label: "AmzRec", tip: "Amazon recommended replenishment quantity" },
  { key: "our_reorder_qty", label: "Reorder", tip: "Units to transfer/produce to reach target cover" },
  { key: "stockout_date", label: "Out", tip: "FBA reaches 0 (Amazon) or warehouse reaches 0 (Shop) — uses forecast + seasonality" },
  { key: "network_oos_date", label: "OOS", tip: "All network stock (FBA+AWD+3PL+Inbound) reaches 0 — uses forecast + seasonality" },
  { key: "flag", label: "Status", tip: "OK ≥ target cover; CRITICAL/LOW below; RESTOCK approaching" },
];

/** Default visible set. Total Amazon sits after Inbnd; Total follows it. */
export const DEFAULT_VISIBLE_COLUMN_KEYS: SkuTableColumnKey[] = SKU_TABLE_COLUMNS.map(
  (c) => c.key,
);

/** Cannot be turned off. Forced on even if saved prefs predate the column. */
export const ALWAYS_VISIBLE_COLUMN_KEYS: SkuTableColumnKey[] = [
  "sku",
  "total_amazon",
  "owned_total",
];

export type SkuTablePrefs = {
  columns?: string[] | null;
  hiddenColumns?: string[] | null;
  visibleColumns?: string[] | null;
  sortColumn?: string | null;
  sortDir?: string | null;
};

function savedColumnList(saved?: SkuTablePrefs | null): string[] | null {
  if (!saved) return null;
  if (Array.isArray(saved.columns) && saved.columns.length) return saved.columns;
  if (Array.isArray(saved.visibleColumns) && saved.visibleColumns.length) {
    return saved.visibleColumns;
  }
  return null;
}

export function resolveVisibleColumns(saved?: SkuTablePrefs | null): SkuTableColumnKey[] {
  const raw = savedColumnList(saved);
  const hidden = new Set(
    Array.isArray(saved?.hiddenColumns) ? saved.hiddenColumns.map(String) : [],
  );
  const allowed = new Set(SKU_TABLE_COLUMNS.map((c) => c.key));
  const picked = new Set<SkuTableColumnKey>();

  if (raw) {
    for (const key of raw) {
      if (key === "fba_on_hand") {
        picked.add("fba_fulfillable");
        continue;
      }
      if (allowed.has(key as SkuTableColumnKey)) picked.add(key as SkuTableColumnKey);
    }
  } else {
    for (const key of DEFAULT_VISIBLE_COLUMN_KEYS) picked.add(key);
  }

  for (const key of hidden) {
    if (key === "owned_total" || key === "total_amazon" || key === "sku") continue;
    picked.delete(key as SkuTableColumnKey);
  }

  for (const key of ALWAYS_VISIBLE_COLUMN_KEYS) picked.add(key);

  return SKU_TABLE_COLUMNS.map((c) => c.key).filter((key) => picked.has(key));
}

export function visibleSkuTableColumns(saved?: SkuTablePrefs | null): SkuTableColumn[] {
  const visible = new Set(resolveVisibleColumns(saved));
  return SKU_TABLE_COLUMNS.filter((c) => visible.has(c.key));
}

/** Blank (—) when the source has no row. A known 0 renders as 0. */
export function formatSkuQty(qty: number | null | undefined): string {
  if (qty == null || Number.isNaN(Number(qty))) return "—";
  return Number(qty).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function migrateSortColumn(saved?: string | null): string {
  if (saved === "fba_on_hand") return "fba_fulfillable";
  return saved || "fba_fulfillable";
}
