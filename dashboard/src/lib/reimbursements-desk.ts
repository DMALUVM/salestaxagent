/**
 * Paid FBA reimbursements desk — cash Amazon already approved.
 *
 * Source of truth is `fba_reimbursements` (GET_FBA_REIMBURSEMENTS_DATA).
 * Cash awareness only — never fold into contribution / net_after_ads.
 */
import { amazonAsOf, shiftDays, windowStart } from "./as-of";
import { approvalLaDay } from "./fba-reimbursements";

export const REIMBURSEMENTS_DEFAULT_DAYS = 90;
export const REIMBURSEMENTS_ALERT_DAYS = 7;

export type ReasonGroup =
  | "warehouse_damage"
  | "lost_inbound"
  | "lost_warehouse"
  | "other";

export type ReasonFilter = "all" | ReasonGroup;

export const ALERT_REASON_CODES = [
  "Damaged_Warehouse",
  "Lost_Inbound",
  "Lost_Warehouse",
] as const;

export const REASON_GROUP_LABELS: Record<ReasonGroup, string> = {
  warehouse_damage: "Warehouse damage",
  lost_inbound: "Lost inbound",
  lost_warehouse: "Lost warehouse",
  other: "Other",
};

const REASON_LABELS: Record<string, string> = {
  Damaged_Warehouse: "Warehouse damage",
  Lost_Inbound: "Lost inbound",
  Lost_Warehouse: "Lost warehouse",
  CustomerReturn: "Customer return",
  Reimbursement_Reversal: "Reimbursement reversal",
  CustomerServiceIssue: "Customer service issue",
};

export interface ReimbursementDeskRow {
  approval_date: string;
  reimbursement_id: string;
  reason: string | null;
  sku: string | null;
  asin: string | null;
  product_name?: string | null;
  qty_cash?: number | null;
  qty_inventory?: number | null;
  qty_total: number | null;
  amount_total: number | string | null;
  case_id?: string | null;
  currency?: string | null;
}

export interface ReasonBucket {
  units: number;
  amount: number;
  rows: number;
  cashUnits: number;
}

export interface ReasonBreakdown {
  reason: string;
  label: string;
  group: ReasonGroup;
  units: number;
  amount: number;
  rows: number;
}

export type DeskSortKey =
  | "approval_date"
  | "reason"
  | "sku"
  | "asin"
  | "qty_total"
  | "amount_total"
  | "reimbursement_id";

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function qtyUnits(row: Pick<ReimbursementDeskRow, "qty_total" | "qty_cash" | "qty_inventory">): number {
  const total = Number(row.qty_total ?? 0);
  if (total !== 0) return total;
  return Number(row.qty_cash ?? 0) + Number(row.qty_inventory ?? 0);
}

export function cashUnits(row: Pick<ReimbursementDeskRow, "qty_cash">): number {
  return Number(row.qty_cash ?? 0);
}

export function rowAmount(row: Pick<ReimbursementDeskRow, "amount_total">): number {
  return Number(row.amount_total ?? 0);
}

export function normalizeReason(reason: string | null | undefined): string {
  return (reason ?? "").trim();
}

function reasonKey(reason: string | null | undefined): string {
  return normalizeReason(reason).toLowerCase().replace(/[\s-]+/g, "_");
}

export function reasonGroup(reason: string | null | undefined): ReasonGroup {
  const key = reasonKey(reason);
  if (key === "damaged_warehouse" || key === "warehouse_damage" || key === "warehousedamage") {
    return "warehouse_damage";
  }
  if (key === "lost_inbound" || key === "lostinbound" || key === "inbound_lost") {
    return "lost_inbound";
  }
  if (key === "lost_warehouse" || key === "lostwarehouse" || key === "warehouse_lost") {
    return "lost_warehouse";
  }
  return "other";
}

export function isAlertReason(reason: string | null | undefined): boolean {
  return reasonGroup(reason) !== "other";
}

export function reasonLabel(reason: string | null | undefined): string {
  const raw = normalizeReason(reason);
  if (!raw) return "Unknown";
  if (REASON_LABELS[raw]) return REASON_LABELS[raw];
  return raw.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function defaultDeskRange(now: Date = new Date()): {
  asOf: string;
  start: string;
  end: string;
} {
  const asOf = amazonAsOf(now);
  return {
    asOf,
    start: windowStart(asOf, REIMBURSEMENTS_DEFAULT_DAYS),
    end: asOf,
  };
}

export function alertWindow(asOf: string): { start: string; end: string } {
  return { start: windowStart(asOf, REIMBURSEMENTS_ALERT_DAYS), end: asOf };
}

export function rowLaDay(row: Pick<ReimbursementDeskRow, "approval_date">): string | null {
  return approvalLaDay(row.approval_date);
}

export function inLaRange(
  row: Pick<ReimbursementDeskRow, "approval_date">,
  start: string,
  end: string,
): boolean {
  const day = rowLaDay(row);
  if (!day) return false;
  return day >= start && day <= end;
}

function emptyBucket(): ReasonBucket {
  return { units: 0, amount: 0, rows: 0, cashUnits: 0 };
}

function addToBucket(bucket: ReasonBucket, row: ReimbursementDeskRow): void {
  bucket.units += qtyUnits(row);
  bucket.amount = money(bucket.amount + rowAmount(row));
  bucket.rows += 1;
  bucket.cashUnits += cashUnits(row);
}

export function summarizeDesk(rows: ReimbursementDeskRow[]): {
  overview: ReasonBucket;
  groups: Record<ReasonGroup, ReasonBucket>;
  resolved: ReasonBucket;
  byReason: ReasonBreakdown[];
} {
  const overview = emptyBucket();
  const groups: Record<ReasonGroup, ReasonBucket> = {
    warehouse_damage: emptyBucket(),
    lost_inbound: emptyBucket(),
    lost_warehouse: emptyBucket(),
    other: emptyBucket(),
  };
  const byReasonMap = new Map<string, ReasonBreakdown>();

  for (const row of rows) {
    addToBucket(overview, row);
    const group = reasonGroup(row.reason);
    addToBucket(groups[group], row);
    const code = normalizeReason(row.reason) || "Unknown";
    const existing = byReasonMap.get(code) ?? {
      reason: code,
      label: reasonLabel(code),
      group,
      units: 0,
      amount: 0,
      rows: 0,
    };
    existing.units += qtyUnits(row);
    existing.amount = money(existing.amount + rowAmount(row));
    existing.rows += 1;
    byReasonMap.set(code, existing);
  }

  const byReason = [...byReasonMap.values()].sort((a, b) => {
    if (b.units !== a.units) return b.units - a.units;
    return Math.abs(b.amount) - Math.abs(a.amount);
  });

  return {
    overview,
    groups,
    resolved: { ...overview },
    byReason,
  };
}

export function filterByGroup(
  rows: ReimbursementDeskRow[],
  filter: ReasonFilter,
): ReimbursementDeskRow[] {
  if (filter === "all") return rows;
  return rows.filter((row) => reasonGroup(row.reason) === filter);
}

export function searchRows(
  rows: ReimbursementDeskRow[],
  query: string,
): ReimbursementDeskRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => {
    const hay = [
      row.sku,
      row.asin,
      row.reason,
      reasonLabel(row.reason),
      row.reimbursement_id,
      row.product_name,
      row.case_id,
    ]
      .map((v) => String(v ?? "").toLowerCase())
      .join(" ");
    return hay.includes(q);
  });
}

export function sortRows(
  rows: ReimbursementDeskRow[],
  key: DeskSortKey,
  dir: "asc" | "desc",
): ReimbursementDeskRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "qty_total") {
      return (qtyUnits(a) - qtyUnits(b)) * sign;
    }
    if (key === "amount_total") {
      return (rowAmount(a) - rowAmount(b)) * sign;
    }
    if (key === "approval_date") {
      const da = rowLaDay(a) ?? "";
      const db = rowLaDay(b) ?? "";
      return da.localeCompare(db) * sign;
    }
    const av = String(
      key === "reason" ? reasonLabel(a.reason) : (a[key] ?? ""),
    ).toLowerCase();
    const bv = String(
      key === "reason" ? reasonLabel(b.reason) : (b[key] ?? ""),
    ).toLowerCase();
    return av.localeCompare(bv) * sign;
  });
}

export function recentAlertRows(
  rows: ReimbursementDeskRow[],
  asOf: string,
  days: number = REIMBURSEMENTS_ALERT_DAYS,
): ReimbursementDeskRow[] {
  const start = windowStart(asOf, days);
  return rows.filter((row) => isAlertReason(row.reason) && inLaRange(row, start, asOf));
}

/** Inclusive ISO pad so a noon-LA timestamptz is not dropped at UTC midnight. */
export function approvalQueryBounds(start: string, end: string): { gte: string; lte: string } {
  return {
    gte: `${shiftDays(start, -1)}T00:00:00.000Z`,
    lte: `${shiftDays(end, 2)}T23:59:59.999Z`,
  };
}
