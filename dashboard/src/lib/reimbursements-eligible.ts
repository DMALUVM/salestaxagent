/**
 * FBA Needs-case queue — inferred eligible / open discrepancies.
 *
 * Not paid cash. Paid SoT remains fba_reimbursements
 * (GET_FBA_REIMBURSEMENTS_DATA). This queue is rebuilt from:
 *   - GET_LEDGER_DETAIL_VIEW_DATA (eventType=Adjustments)
 *   - inbound shipped − received shorts
 * minus units already reimbursed for the same SKU + reason group.
 *
 * Amazon has no SP-API for open claims / eligibility. Do not fake
 * Eligible rows from the paid desk.
 */
import { amazonAsOf, shiftDays, windowStart } from "./as-of";
import {
  REIMBURSEMENTS_ALERT_DAYS,
  REIMBURSEMENTS_DEFAULT_DAYS,
  REASON_GROUP_LABELS,
  type ReasonFilter,
} from "./reimbursements-desk";
import {
  CLASSIFICATION_VERSION,
  MINI_RESYNC_HINT,
  NOTIFY_BLOCK_COPY,
  UNKNOWN_REASON_MAX_PCT,
  isEligibleLossReason,
  isUnknownReason,
  reasonGroup,
  reasonLabel,
  type ReasonGroup,
} from "./reimbursements-reason-legend";

export const REESE_AGENT_ID = "74a7ce8a-6754-4bf1-90aa-afa1f4cd774c";
export const REESE_AGENT_NAME = "Reese · Reimbursements";

export const CASE_QUEUE_DEFAULT_DAYS = REIMBURSEMENTS_DEFAULT_DAYS;
export const CASE_QUEUE_ALERT_DAYS = REIMBURSEMENTS_ALERT_DAYS;

export const SC_SUPPORT_HUB = "https://sellercentral.amazon.com/help/hub/contact-us";
export const SC_LEDGER_HUB = "https://sellercentral.amazon.com/reportcentral/INVENTORY_LEDGER/1";
export const SC_INBOUND_SHIPMENT =
  "https://sellercentral.amazon.com/gp/fba/inbound-shipment-workflow/index.html?shipmentId=";

export const SELLER_CENTRAL_LINK_LIMIT =
  "No stable Seller Central deep link opens a pre-filled FBA case. " +
  "Only real FBA* shipment IDs link to the inbound shipment tracker. " +
  "Ledger reference / transaction IDs (digit strings) are not shipment IDs. " +
  "Warehouse damage is filed in IDR (Inventory → Inventory Defect and Reimbursement), " +
  "not via a generic Support hub button. That hub is NOT a pre-filled lost-inbound or warehouse case. " +
  "Dave submits; this desk never auto-files.";

export const IDR_INSTRUCTION =
  "Open IDR (Inventory → Inventory Defect and Reimbursement)";

export const HOW_TO_FILE_TITLE = "How to file";

export const HOW_TO_FILE_INTRO =
  "Current queue is warehouse damage (codes 7 / E — Damaged at FC). " +
  "Amazon auto-pays many warehouse lost/damaged events. This desk never auto-files.";

export const HOW_TO_FILE_STEPS = [
  {
    title: "Check Paid / Reimbursements report first",
    body:
      "Amazon auto-pays many warehouse lost/damaged units. Skip filing if already paid within ~60 days (Already reimbursed tab).",
  },
  {
    title: "File within 60 days",
    body: "The clock starts on the ledger event date.",
  },
  {
    title: "Use Reference ID + SKU details",
    body:
      "Paste the digit Reference ID plus FNSKU/SKU/ASIN/qty/FC/date. Reference ID is a ledger transaction ID — not a shipment ID.",
  },
  {
    title: "Preferred: Inventory Defect and Reimbursement (IDR)",
    body: "Seller Central → Inventory → Inventory Defect and Reimbursement (IDR).",
  },
  {
    title: "Classic path",
    body:
      "Reports → Fulfillment → Inventory Adjustments / Ledger Adjustments → find Damaged at FC row → Help / Get Support → FBA → warehouse lost/damaged (or the warehouse-damaged status tool with Transaction Item ID).",
  },
  {
    title: "One case per event",
    body: "Copy the case packet from the row and paste those fields. Do not batch unrelated events.",
  },
] as const;

export const HOW_TO_FILE_NO_DEEP_LINK =
  "There is no stable deep link that opens a pre-filled case. " +
  "Do not use a generic Support hub button as if it does.";

export const CASE_QUEUE_SOURCE_NOTE =
  "Needs case currently comes from (1) ledger adjustments with eligible codes and " +
  "(2) CLOSED/stale inbound shipped−received shorts.";

export const NO_INBOUND_DISCREPANCIES =
  "No CLOSED inbound discrepancies in warehouse right now";

export {
  CLASSIFICATION_VERSION,
  MINI_RESYNC_HINT,
  NOTIFY_BLOCK_COPY,
  UNKNOWN_REASON_MAX_PCT,
  isEligibleLossReason,
  isUnknownReason,
  reasonGroup,
  reasonLabel,
};
export type { ReasonFilter, ReasonGroup };

export const CASE_QUEUE_GAP =
  "Amazon has no SP-API for eligible / open claims. " +
  "GET_FBA_FULFILLMENT_INVENTORY_ADJUSTMENTS_DATA was deprecated 2023-01-31. " +
  "This queue is inferred from GET_LEDGER_DETAIL_VIEW_DATA (Adjustments) plus " +
  "inbound shipped-vs-received, then minus paid fba_reimbursements. " +
  "It is not invented from the paid desk.";

export const CASE_QUEUE_SOURCES = [
  "GET_LEDGER_DETAIL_VIEW_DATA (eventType=Adjustments)",
  "FBA inbound v0 QuantityShipped − QuantityReceived",
  "GET_FBA_REIMBURSEMENTS_DATA (dedupe only)",
] as const;

export type CaseStatus = "needs_case" | "already_reimbursed" | "found_offset";
export type CaseSource = "ledger_adjustment" | "inbound_discrepancy";

export interface CaseEventRow {
  event_key: string;
  source: string;
  event_date: string;
  sku: string | null;
  asin: string | null;
  fnsku?: string | null;
  product_name?: string | null;
  quantity: number | null;
  reason: string | null;
  reason_group: string | null;
  fulfillment_center?: string | null;
  shipment_id?: string | null;
  reference_id?: string | null;
  estimated_amount?: number | string | null;
  amount_basis?: string | null;
  status: string;
  matched_reimbursement_id?: string | null;
  matched_reimbursed_qty?: number | null;
  seller_central_url?: string | null;
  seller_central_link_kind?: string | null;
  synced_at?: string | null;
  disposition?: string | null;
  classification_version?: string | null;
}

export type CaseSortKey =
  | "event_date"
  | "reason"
  | "sku"
  | "asin"
  | "quantity"
  | "estimated_amount"
  | "shipment_id";

export { REASON_GROUP_LABELS };

const FBA_SHIPMENT_RE = /^FBA[A-Z0-9]+$/i;

export function isFbaShipmentId(value: string | null | undefined): boolean {
  return FBA_SHIPMENT_RE.test(String(value ?? "").trim());
}

/** First real FBA* id. Digit ledger transaction IDs are not shipments. */
export function fbaShipmentId(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const value of candidates) {
    const raw = String(value ?? "").trim().toUpperCase();
    if (FBA_SHIPMENT_RE.test(raw)) return raw;
  }
  return null;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function caseQty(row: Pick<CaseEventRow, "quantity">): number {
  return Number(row.quantity ?? 0);
}

export function caseAmount(row: Pick<CaseEventRow, "estimated_amount">): number {
  return Number(row.estimated_amount ?? 0);
}

export function caseDay(row: Pick<CaseEventRow, "event_date">): string {
  const raw = String(row.event_date ?? "");
  return raw.length >= 10 ? raw.slice(0, 10) : raw;
}

export function isNeedsCase(row: Pick<CaseEventRow, "status" | "quantity">): boolean {
  return row.status === "needs_case" && caseQty(row) > 0;
}

export function isEligibleNeedsCase(row: CaseEventRow): boolean {
  return isNeedsCase(row) && isEligibleLossReason(row.reason, row.disposition);
}

export function normalizeCaseRow(row: CaseEventRow): CaseEventRow {
  const group = reasonGroup(row.reason, row.disposition);
  const shipment = fbaShipmentId(row.shipment_id);
  const kind = shipment ? "inbound_shipment" : "idr_instructions";
  const url = shipment ? `${SC_INBOUND_SHIPMENT}${shipment}` : null;
  return {
    ...row,
    reason_group: group,
    shipment_id: shipment,
    seller_central_link_kind: kind,
    seller_central_url: url,
  };
}

export function defaultCaseRange(now: Date = new Date()): {
  asOf: string;
  start: string;
  end: string;
} {
  const asOf = amazonAsOf(now);
  return {
    asOf,
    start: windowStart(asOf, CASE_QUEUE_DEFAULT_DAYS),
    end: asOf,
  };
}

export function inCaseRange(row: Pick<CaseEventRow, "event_date">, start: string, end: string): boolean {
  const day = caseDay(row);
  if (!day) return false;
  return day >= start && day <= end;
}

export function filterNeedsCase(rows: CaseEventRow[]): CaseEventRow[] {
  return rows.filter(isEligibleNeedsCase);
}

export function filterCaseGroup(rows: CaseEventRow[], filter: ReasonFilter): CaseEventRow[] {
  if (filter === "all") return rows;
  return rows.filter((row) => reasonGroup(row.reason, row.disposition) === filter);
}

export function searchCaseRows(rows: CaseEventRow[], query: string): CaseEventRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) => {
    const hay = [
      row.sku,
      row.asin,
      row.reason,
      reasonLabel(row.reason, row.disposition),
      row.shipment_id,
      row.reference_id,
      row.fulfillment_center,
      row.event_key,
      row.product_name,
    ]
      .map((v) => String(v ?? "").toLowerCase())
      .join(" ");
    return hay.includes(q);
  });
}

export function sortCaseRows(
  rows: CaseEventRow[],
  key: CaseSortKey,
  dir: "asc" | "desc",
): CaseEventRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "quantity") return (caseQty(a) - caseQty(b)) * sign;
    if (key === "estimated_amount") return (caseAmount(a) - caseAmount(b)) * sign;
    if (key === "event_date") return caseDay(a).localeCompare(caseDay(b)) * sign;
    const av = String(
      key === "reason" ? reasonLabel(a.reason, a.disposition) : (a[key] ?? ""),
    ).toLowerCase();
    const bv = String(
      key === "reason" ? reasonLabel(b.reason, b.disposition) : (b[key] ?? ""),
    ).toLowerCase();
    return av.localeCompare(bv) * sign;
  });
}

export function summarizeCases(rows: CaseEventRow[]): {
  events: number;
  units: number;
  estimated: number;
  estimatedKnown: boolean;
  groups: Record<ReasonGroup, { events: number; units: number; estimated: number }>;
} {
  const empty = () => ({ events: 0, units: 0, estimated: 0 });
  const groups: Record<ReasonGroup, { events: number; units: number; estimated: number }> = {
    warehouse_damage: empty(),
    lost_inbound: empty(),
    lost_warehouse: empty(),
    other: empty(),
  };
  let units = 0;
  let estimated = 0;
  let estimatedKnown = false;
  for (const row of rows) {
    const q = caseQty(row);
    const amt = caseAmount(row);
    const g = reasonGroup(row.reason, row.disposition);
    groups[g].events += 1;
    groups[g].units += q;
    groups[g].estimated = money(groups[g].estimated + amt);
    units += q;
    estimated = money(estimated + amt);
    if (row.estimated_amount != null && row.estimated_amount !== "") estimatedKnown = true;
  }
  return { events: rows.length, units, estimated, estimatedKnown, groups };
}

export function recentNeedsCase(
  rows: CaseEventRow[],
  asOf: string,
  days: number = CASE_QUEUE_ALERT_DAYS,
): CaseEventRow[] {
  const start = windowStart(asOf, days);
  return filterNeedsCase(rows).filter((row) => inCaseRange(row, start, asOf));
}

export function freshnessIso(rows: CaseEventRow[]): string | null {
  let best: string | null = null;
  for (const row of rows) {
    const ts = row.synced_at;
    if (ts && (!best || ts > best)) best = ts;
  }
  return best;
}

export function eventQueryBounds(start: string, end: string): { gte: string; lte: string } {
  return {
    gte: shiftDays(start, -1),
    lte: shiftDays(end, 1),
  };
}

export function sellerCentralHref(row: Pick<CaseEventRow, "seller_central_url" | "shipment_id" | "reference_id">): string | null {
  const sid = fbaShipmentId(row.shipment_id);
  if (sid) return `${SC_INBOUND_SHIPMENT}${sid}`;
  return null;
}

export function isInboundTrackerLink(row: Pick<CaseEventRow, "shipment_id">): boolean {
  return Boolean(fbaShipmentId(row.shipment_id));
}

export function linkKindLabel(kind: string | null | undefined): string {
  if (kind === "inbound_shipment") return "Shipment tracker";
  return IDR_INSTRUCTION;
}

export function inboundDiscrepancyCount(rows: Pick<CaseEventRow, "source">[]): number {
  return rows.filter((row) => row.source === "inbound_discrepancy").length;
}

export function inboundEmptyCopy(rows: Pick<CaseEventRow, "source">[]): string | null {
  return inboundDiscrepancyCount(rows) === 0 ? NO_INBOUND_DISCREPANCIES : null;
}

export function formatCasePacket(row: CaseEventRow): string {
  const shipment = fbaShipmentId(row.shipment_id);
  const ref = row.reference_id && row.reference_id !== shipment ? row.reference_id : "";
  const lines = [
    `FBA Needs-case packet — ${reasonLabel(row.reason, row.disposition)}`,
    `Date: ${caseDay(row)}`,
    `Reference ID: ${ref || "—"} (ledger transaction ID — not a shipment ID)`,
    `FNSKU: ${row.fnsku || "—"}`,
    `SKU: ${row.sku || "—"}`,
    `ASIN: ${row.asin || "—"}`,
    `Qty: ${caseQty(row)}`,
    `FC: ${row.fulfillment_center || "—"}`,
    shipment ? `Shipment: ${shipment}` : null,
    `Preferred path: ${IDR_INSTRUCTION}`,
    HOW_TO_FILE_NO_DEEP_LINK,
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

export interface CaseQa {
  ok: boolean;
  errors: string[];
  classification_version: string;
  unknown_reason_pct: number;
  needs_case: number;
  outdated_classification: number;
  missing_fc: number;
}

export function evaluateCaseQa(
  rows: CaseEventRow[],
  opts?: { classificationVersion?: string },
): CaseQa {
  const version = opts?.classificationVersion ?? CLASSIFICATION_VERSION;
  const errors: string[] = [];
  const needs = rows.filter(isNeedsCase);
  const unknownRows = needs.filter((r) => isUnknownReason(r.reason, r.disposition));
  const pct = needs.length ? Math.round((1000 * unknownRows.length) / needs.length) / 10 : 0;
  if (pct > UNKNOWN_REASON_MAX_PCT) {
    errors.push(
      `${pct}% of Needs-case rows have unknown reason codes (max ${UNKNOWN_REASON_MAX_PCT}%). ${MINI_RESYNC_HINT}`,
    );
  }
  let outdated = 0;
  let missingFc = 0;
  for (const row of needs) {
    if (isUnknownReason(row.reason, row.disposition)) {
      errors.push(`${row.event_key}: unknown reason code ${JSON.stringify(row.reason)}`);
    }
    if (!String(row.fulfillment_center ?? "").trim()) {
      missingFc += 1;
      errors.push(`${row.event_key}: missing FC`);
    }
    if (row.classification_version !== version) {
      outdated += 1;
    }
  }
  if (outdated && needs.length) {
    errors.push(
      `${outdated} Needs-case row(s) have missing or outdated classification_version (want ${version}). ${MINI_RESYNC_HINT}`,
    );
  }
  if (missingFc) {
    errors.push(`${missingFc} Needs-case row(s) are missing fulfillment_center (FC).`);
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const err of errors) {
    if (seen.has(err)) continue;
    seen.add(err);
    deduped.push(err);
  }
  return {
    ok: deduped.length === 0,
    errors: deduped,
    classification_version: version,
    unknown_reason_pct: pct,
    needs_case: needs.length,
    outdated_classification: outdated,
    missing_fc: missingFc,
  };
}

export function notifyGateErrors(rows: CaseEventRow[], qa?: CaseQa): string[] {
  const errors: string[] = [];
  if (qa && !qa.ok) errors.push(...qa.errors);
  const version = CLASSIFICATION_VERSION;
  for (const row of rows.filter(isNeedsCase)) {
    if (isUnknownReason(row.reason, row.disposition)) {
      errors.push(`${row.event_key}: unknown reason code ${JSON.stringify(row.reason)}`);
    }
    if (!String(row.fulfillment_center ?? "").trim()) {
      errors.push(`${row.event_key}: missing FC`);
    }
    if (row.classification_version !== version) {
      errors.push(
        `${row.event_key}: classification_version outdated (${JSON.stringify(row.classification_version)} != ${JSON.stringify(version)})`,
      );
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const err of errors) {
    if (seen.has(err)) continue;
    seen.add(err);
    out.push(err);
  }
  return out;
}

export interface ReesePackageEvent {
  event_key: string;
  source: string;
  event_date: string;
  sku: string | null;
  asin: string | null;
  quantity: number;
  reason: string | null;
  reason_group: string | null;
  fulfillment_center?: string | null;
  shipment_id?: string | null;
  reference_id?: string | null;
  estimated_amount?: number | string | null;
  seller_central_url: string;
}

export interface ReesePackage {
  contract: "fba_case_package/v1";
  purpose: string;
  auto_submit: false;
  target: { agent_id: string; agent_name: string };
  as_of: string;
  start: string;
  end: string;
  source: string;
  summary: { events: number; units: number; estimated_amount: number | null };
  events: ReesePackageEvent[];
  markdown: string;
}

/** Resolve API paths against origin so basic-auth userinfo in the page URL
 *  cannot leak into fetch() (Chrome rejects credentialed relative URLs). */
export function apiUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path.startsWith("/") ? path : `/${path}`}`;
}

export const REESE_PACKAGE_CONTRACT = "fba_case_package/v1";

const PACKAGE_PURPOSE =
  "Case prep only. Dave submits in Seller Central. Do not auto-file, scrape Sellerise, or touch SoldScope.";

export function buildReesePackage(
  rows: CaseEventRow[],
  opts: { asOf: string; start: string; end: string; source?: string },
): ReesePackage {
  const events: ReesePackageEvent[] = filterNeedsCase(rows)
    .slice()
    .sort((a, b) => caseDay(a).localeCompare(caseDay(b)) || String(a.sku).localeCompare(String(b.sku)))
    .map((r) => ({
      event_key: r.event_key,
      source: r.source,
      event_date: caseDay(r),
      sku: r.sku,
      asin: r.asin,
      quantity: caseQty(r),
      reason: r.reason,
      reason_group: r.reason_group,
      fulfillment_center: r.fulfillment_center,
      shipment_id: fbaShipmentId(r.shipment_id),
      reference_id: r.reference_id,
      estimated_amount: r.estimated_amount ?? null,
      seller_central_url: sellerCentralHref(r) ?? "",
    }));
  const units = events.reduce((s, e) => s + e.quantity, 0);
  const known = events.filter((e) => e.estimated_amount != null && e.estimated_amount !== "");
  const estimated = known.length
    ? money(known.reduce((s, e) => s + Number(e.estimated_amount ?? 0), 0))
    : null;
  const pkg: Omit<ReesePackage, "markdown"> = {
    contract: REESE_PACKAGE_CONTRACT,
    purpose: PACKAGE_PURPOSE,
    auto_submit: false,
    target: { agent_id: REESE_AGENT_ID, agent_name: REESE_AGENT_NAME },
    as_of: opts.asOf,
    start: opts.start,
    end: opts.end,
    source: opts.source ?? "dashboard",
    summary: { events: events.length, units, estimated_amount: estimated },
    events,
  };
  return { ...pkg, markdown: renderReeseMarkdown(pkg) };
}

export function renderReeseMarkdown(pkg: Omit<ReesePackage, "markdown">): string {
  const est = pkg.summary.estimated_amount;
  const estS = est != null ? `$${est.toFixed(2)}` : "unknown (no recent paid unit rate)";
  const lines = [
    `# FBA Needs-case package — ${pkg.target.agent_name}`,
    "",
    `**${pkg.purpose}**`,
    "",
    `- As of: \`${pkg.as_of}\` (America/Los_Angeles)`,
    `- Window: \`${pkg.start}\` → \`${pkg.end}\``,
    `- Events: **${pkg.summary.events}** · Units: **${pkg.summary.units}** · Est. $: **${estS}**`,
    `- Target agent: \`${pkg.target.agent_id}\``,
    "",
    `## ${HOW_TO_FILE_TITLE}`,
    "",
    HOW_TO_FILE_INTRO,
    "",
    ...HOW_TO_FILE_STEPS.map((step, i) => `${i + 1}. **${step.title}** — ${step.body}`),
    "",
    HOW_TO_FILE_NO_DEEP_LINK,
    "",
    `- ${IDR_INSTRUCTION}`,
    `- Inventory ledger report: ${SC_LEDGER_HUB}`,
    "",
    SELLER_CENTRAL_LINK_LIMIT,
    "",
  ];
  const groups: Record<string, ReesePackageEvent[]> = {};
  for (const ev of pkg.events) {
    const g = ev.reason_group || "other";
    (groups[g] ??= []).push(ev);
  }
  const headings: Record<string, string> = {
    lost_inbound: "Lost inbound",
    warehouse_damage: "Warehouse damage",
    lost_warehouse: "Lost warehouse",
  };
  if (!pkg.events.length) {
    lines.push("_No open Needs-case rows in this window._", "");
    return lines.join("\n");
  }
  for (const key of ["lost_inbound", "warehouse_damage", "lost_warehouse"]) {
    const rows = groups[key] || [];
    if (!rows.length) continue;
    lines.push(`## ${headings[key] ?? key} (${rows.length})`, "");
    lines.push("| Date | SKU | ASIN | Qty | FC | Shipment | Reference ID | Est $ | Seller Central |");
    lines.push("| --- | --- | --- | ---: | --- | --- | --- | ---: | --- |");
    for (const r of rows) {
      const estCell = r.estimated_amount != null && r.estimated_amount !== ""
        ? Number(r.estimated_amount).toFixed(2)
        : "—";
      const shipment = fbaShipmentId(r.shipment_id) || "—";
      const ref = r.reference_id && r.reference_id !== shipment ? r.reference_id : "—";
      const fileCell = r.seller_central_url || IDR_INSTRUCTION;
      lines.push(
        `| ${r.event_date} | \`${r.sku || "—"}\` | ${r.asin || "—"} | ${r.quantity} | ${r.fulfillment_center || "—"} | ${shipment} | ${ref} | ${estCell} | ${fileCell} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Sources",
    "",
    ...CASE_QUEUE_SOURCES.map((s) => `- ${s}`),
    "",
  );
  return lines.join("\n");
}
