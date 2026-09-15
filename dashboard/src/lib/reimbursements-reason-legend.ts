/**
 * Amazon FBA inventory-ledger adjustment reason legend.
 *
 * Twin of src/reimbursements/reason_legend.py.
 * Letter M = Inventory misplaced → lost_warehouse. NEVER lost inbound.
 * Code 7 = Damaged at FC, NOT Found.
 * D = disposed, O = correction — NEVER warehouse_damage. Disposition
 * does not promote excluded or unknown letters into Needs case.
 *
 * After deploy, Mini must:
 *   python -m src.main reimbursements-case-sync --days 90
 */
export type ReasonGroup =
  | "warehouse_damage"
  | "lost_inbound"
  | "lost_warehouse"
  | "other";

export const CLASSIFICATION_VERSION = "ledger-legend-2026-09-15-do";

/** Letter/digit codes that may enter Needs case. Disposition cannot add more. */
export const ELIGIBLE_LETTER_CODES = new Set(["M", "E", "6", "7", "H", "K", "U"]);

export const UNKNOWN_REASON_MAX_PCT = 5;

export const NOTIFY_BLOCK_COPY =
  "Do not prep. Classification or QA checks failed — " +
  "Needs-case packets are not verified. Do not send Reese a package.";

export const MINI_RESYNC_HINT =
  `Mini must re-run: python -m src.main reimbursements-case-sync --days 90 ` +
  `to rebuild fba_case_events with classification_version ${CLASSIFICATION_VERSION}.`;

export const ELIGIBLE_REASON_GROUPS = new Set<ReasonGroup>([
  "warehouse_damage",
  "lost_inbound",
  "lost_warehouse",
]);

export const WAREHOUSE_DAMAGE_DISPOSITIONS = new Set([
  "WAREHOUSE_DAMAGED",
  "CUSTOMER_DAMAGED",
  "CARRIER_DAMAGED",
  "DEFECTIVE",
  "DAMAGED",
]);

export interface ReasonLegendRow {
  code: string;
  sign: string;
  label: string;
  group: "lost_warehouse" | "lost_inbound" | "warehouse_damage" | "found" | "disposition_change" | "disposed" | "correction";
  eligible: boolean;
  notes: string;
}

/** Seller Central / SP-API Adjustment reason codes (authoritative table). */
export const LEDGER_REASON_LEGEND: readonly ReasonLegendRow[] = [
  {
    code: "M",
    sign: "-",
    label: "Inventory misplaced",
    group: "lost_warehouse",
    eligible: true,
    notes: "Missing from a bin in an FC. NOT lost inbound. Eligible if unreconciled / not offset by Found.",
  },
  {
    code: "F",
    sign: "+",
    label: "Inventory found",
    group: "found",
    eligible: false,
    notes: "Offset for M / Lost_Warehouse. Never a Needs-case row.",
  },
  {
    code: "Q",
    sign: "-",
    label: "Disposition change",
    group: "disposition_change",
    eligible: false,
    notes: "Q/P pair is disposition churn — not a reimbursement case.",
  },
  {
    code: "P",
    sign: "+",
    label: "Disposition change",
    group: "disposition_change",
    eligible: false,
    notes: "Q/P pair is disposition churn — not a reimbursement case.",
  },
  {
    code: "E",
    sign: "-",
    label: "Damaged at FC",
    group: "warehouse_damage",
    eligible: true,
    notes: "Sellable decrease at fulfillment center. Typically followed by P.",
  },
  {
    code: "6",
    sign: "-",
    label: "Damaged at FC",
    group: "warehouse_damage",
    eligible: true,
    notes: "Reclass into FC-damaged.",
  },
  {
    code: "7",
    sign: "-",
    label: "Damaged at FC",
    group: "warehouse_damage",
    eligible: true,
    notes: "Damaged at FC variant. Code 7 is NOT Found.",
  },
  {
    code: "H",
    sign: "-",
    label: "Damaged at FC",
    group: "warehouse_damage",
    eligible: true,
    notes: "Reclass into FC-damaged.",
  },
  {
    code: "K",
    sign: "-",
    label: "Damaged at FC",
    group: "warehouse_damage",
    eligible: true,
    notes: "Reclass into FC-damaged.",
  },
  {
    code: "U",
    sign: "-",
    label: "Damaged at FC",
    group: "warehouse_damage",
    eligible: true,
    notes: "Reclass into FC-damaged.",
  },
  {
    code: "D",
    sign: "-",
    label: "Inventory disposed of",
    group: "disposed",
    eligible: false,
    notes: "Same family as G. Exclude from Needs case. Disposition must not promote D.",
  },
  {
    code: "G",
    sign: "-",
    label: "Disposed",
    group: "disposed",
    eligible: false,
    notes: "Charity / disposal. Exclude from Needs case.",
  },
  {
    code: "O",
    sign: "-",
    label: "Inventory correction",
    group: "correction",
    eligible: false,
    notes: "Incorrectly received OR Amazon already reimbursed. Exclude from Needs case. Disposition must not promote O.",
  },
  {
    code: "N",
    sign: "+",
    label: "Ownership / correction",
    group: "correction",
    eligible: false,
    notes: "Not a loss case.",
  },
] as const;

export const FULL_TEXT_REASONS: readonly ReasonLegendRow[] = [
  {
    code: "Lost_Warehouse",
    sign: "",
    label: "Lost warehouse",
    group: "lost_warehouse",
    eligible: true,
    notes: "Full-text ledger / paid-desk reason.",
  },
  {
    code: "Lost_Inbound",
    sign: "",
    label: "Lost inbound",
    group: "lost_inbound",
    eligible: true,
    notes: "Full-text inbound loss only — never inferred from letter M.",
  },
  {
    code: "Damaged_Warehouse",
    sign: "",
    label: "Warehouse damage",
    group: "warehouse_damage",
    eligible: true,
    notes: "Full-text ledger / paid-desk reason.",
  },
  {
    code: "Damaged_Inbound",
    sign: "",
    label: "Warehouse damage",
    group: "warehouse_damage",
    eligible: true,
    notes: "Inbound damage treated as warehouse_damage.",
  },
  {
    code: "Found",
    sign: "+",
    label: "Inventory found",
    group: "found",
    eligible: false,
    notes: "Offset for misplaced / lost warehouse.",
  },
  {
    code: "Found_Warehouse",
    sign: "+",
    label: "Inventory found",
    group: "found",
    eligible: false,
    notes: "Offset for misplaced / lost warehouse.",
  },
] as const;

function reasonKey(reason: string | null | undefined): string {
  return (reason ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function buildIndex(): Map<string, ReasonLegendRow> {
  const out = new Map<string, ReasonLegendRow>();
  for (const row of [...LEDGER_REASON_LEGEND, ...FULL_TEXT_REASONS]) {
    out.set(reasonKey(row.code), row);
    out.set(reasonKey(row.code).replace(/_/g, ""), row);
  }
  const dw = FULL_TEXT_REASONS.find((r) => r.code === "Damaged_Warehouse")!;
  const li = FULL_TEXT_REASONS.find((r) => r.code === "Lost_Inbound")!;
  const lw = FULL_TEXT_REASONS.find((r) => r.code === "Lost_Warehouse")!;
  const fw = FULL_TEXT_REASONS.find((r) => r.code === "Found_Warehouse")!;
  out.set("warehouse_damage", dw);
  out.set("warehousedamage", dw);
  out.set("inbound_lost", li);
  out.set("warehouse_lost", lw);
  out.set("foundwarehouse", fw);
  return out;
}

const LEGEND_INDEX = buildIndex();

export function lookupReason(reason: string | null | undefined): ReasonLegendRow | undefined {
  const key = reasonKey(reason);
  if (!key) return undefined;
  return LEGEND_INDEX.get(key);
}

export function isLetterOrDigitCode(reason: string | null | undefined): boolean {
  const raw = (reason ?? "").trim();
  return raw.length === 1 && /[A-Za-z0-9]/.test(raw);
}

export function reasonGroup(
  reason: string | null | undefined,
  _disposition?: string | null,
): ReasonGroup {
  const entry = lookupReason(reason);
  if (entry && ELIGIBLE_REASON_GROUPS.has(entry.group as ReasonGroup)) {
    return entry.group as ReasonGroup;
  }
  return "other";
}

export function reasonLabel(
  reason: string | null | undefined,
  _disposition?: string | null,
): string {
  const raw = (reason ?? "").trim();
  const entry = lookupReason(raw);
  if (entry) {
    if (isLetterOrDigitCode(raw)) return `${raw.toUpperCase()} — ${entry.label}`;
    return entry.label;
  }
  if (!raw) return "Unknown";
  return raw.replace(/_/g, " ").replace(/-/g, " ");
}

export function isFoundReason(reason: string | null | undefined): boolean {
  const entry = lookupReason(reason);
  if (entry) return entry.group === "found";
  const key = reasonKey(reason);
  return Boolean(key) && key.startsWith("found");
}

export function isEligibleLossReason(
  reason: string | null | undefined,
  _disposition?: string | null,
): boolean {
  return Boolean(lookupReason(reason)?.eligible);
}

export function isUnknownReason(
  reason: string | null | undefined,
  _disposition?: string | null,
): boolean {
  return lookupReason(reason) === undefined;
}
