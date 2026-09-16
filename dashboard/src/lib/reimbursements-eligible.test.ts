import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";

import { windowStart } from "./as-of";
import {
  CASE_QUEUE_DEFAULT_DAYS,
  CASE_QUEUE_GAP,
  CASE_QUEUE_SOURCE_NOTE,
  CASE_QUEUE_SOURCES,
  CLASSIFICATION_VERSION,
  CLEAR_REASON_LABELS,
  HOW_TO_FILE_INBOUND,
  HOW_TO_FILE_INBOUND_STEPS,
  HOW_TO_FILE_INTRO,
  HOW_TO_FILE_NO_DEEP_LINK,
  HOW_TO_FILE_STEPS,
  HOW_TO_FILE_TITLE,
  IDR_INSTRUCTION,
  KPI_EVENTS_LABEL,
  KPI_UNITS_LABEL,
  NEEDS_CASE_HREF,
  NO_INBOUND_DISCREPANCIES,
  NOTIFY_BLOCK_COPY,
  REESE_AGENT_ID,
  REESE_AGENT_NAME,
  REESE_PACKAGE_CONTRACT,
  SELLER_CENTRAL_LINK_LIMIT,
  STATUS_CASE_SUBMITTED,
  STATUS_FOUND_OFFSET,
  apiUrl,
  buildReesePackage,
  caseKpi,
  clearReasonLabel,
  clearResultMessage,
  defaultCaseRange,
  evaluateCaseQa,
  fbaShipmentId,
  filterInboundAlerts,
  filterNeedsCase,
  filterSubmittedCases,
  formatCasePacket,
  inCaseRange,
  inboundEmptyCopy,
  isActiveInboundAlert,
  isClearedHistory,
  isFbaShipmentId,
  isNeedsCase,
  normalizeCaseRow,
  normalizeClearKeys,
  notifyGateErrors,
  parseClearReason,
  reasonGroup,
  reasonLabel,
  recentNeedsCase,
  resolveClearAction,
  searchCaseRows,
  sellerCentralHref,
  sortCaseRows,
  sourceLabel,
  summarizeCases,
  type CaseEventRow,
} from "./reimbursements-eligible";

function row(partial: Partial<CaseEventRow> & Pick<CaseEventRow, "event_key" | "event_date">): CaseEventRow {
  return {
    source: "ledger_adjustment",
    sku: "SKU-A",
    asin: "B001",
    quantity: 2,
    reason: "Lost_Warehouse",
    reason_group: "lost_warehouse",
    status: "needs_case",
    fulfillment_center: "ONT8",
    classification_version: CLASSIFICATION_VERSION,
    ...partial,
  };
}

describe("needs-case vs paid", () => {
  test("D and O never stay in Needs case even with WAREHOUSE_DAMAGED", () => {
    const rows = [
      row({ event_key: "d", event_date: "2026-08-01", reason: "D", reason_group: "warehouse_damage", disposition: "WAREHOUSE_DAMAGED" }),
      row({ event_key: "o", event_date: "2026-08-01", reason: "O", reason_group: "warehouse_damage", disposition: "WAREHOUSE_DAMAGED" }),
      row({ event_key: "e", event_date: "2026-08-01", reason: "E", reason_group: "warehouse_damage" }),
      row({ event_key: "seven", event_date: "2026-08-01", reason: "7", reason_group: "warehouse_damage" }),
      row({ event_key: "m", event_date: "2026-08-01", reason: "M", reason_group: "lost_inbound" }),
    ];
    assert.deepEqual(filterNeedsCase(rows).map((r) => r.event_key).sort(), ["e", "m", "seven"]);
    assert.equal(reasonGroup("M"), "lost_warehouse");
  });

  test("only status=needs_case with qty>0 stays in the queue", () => {
    const rows = [
      row({ event_key: "a", event_date: "2026-08-01", status: "needs_case", quantity: 2 }),
      row({ event_key: "b", event_date: "2026-08-01", status: "already_reimbursed", quantity: 0 }),
      row({ event_key: "c", event_date: "2026-08-01", status: "found_offset", quantity: 0 }),
      row({ event_key: "d", event_date: "2026-08-01", status: "needs_case", quantity: 0 }),
    ];
    assert.deepEqual(filterNeedsCase(rows).map((r) => r.event_key), ["a"]);
    assert.equal(isNeedsCase(rows[1]), false);
  });

  test("summarize counts needs-case units and known estimates", () => {
    const rows = [
      row({
        event_key: "a",
        event_date: "2026-08-01",
        reason: "Lost_Inbound",
        reason_group: "lost_inbound",
        quantity: 3,
        estimated_amount: 30,
      }),
      row({
        event_key: "b",
        event_date: "2026-08-02",
        reason: "Damaged_Warehouse",
        reason_group: "warehouse_damage",
        quantity: 1,
        estimated_amount: null,
      }),
    ];
    const s = summarizeCases(rows);
    assert.equal(s.events, 2);
    assert.equal(s.units, 4);
    assert.equal(s.groups.lost_inbound.units, 3);
    assert.equal(s.groups.warehouse_damage.units, 1);
    assert.equal(s.estimatedKnown, true);
    const kpi = caseKpi(s);
    assert.equal(kpi.primary, 2);
    assert.equal(kpi.primaryLabel, KPI_EVENTS_LABEL);
    assert.equal(kpi.units, 4);
    assert.equal(kpi.unitsLabel, KPI_UNITS_LABEL);
    assert.notEqual(kpi.primary, kpi.units);
  });

  test("default window is 90 closed LA days", () => {
    const now = new Date("2026-09-15T19:00:00.000Z");
    const range = defaultCaseRange(now);
    assert.equal(range.asOf, "2026-09-14");
    assert.equal(range.start, windowStart("2026-09-14", 90));
    assert.equal(CASE_QUEUE_DEFAULT_DAYS, 90);
  });

  test("recent alert is last 7 closed LA days", () => {
    const rows = [
      row({ event_key: "new", event_date: "2026-09-12" }),
      row({ event_key: "old", event_date: "2026-08-01" }),
    ];
    const recent = recentNeedsCase(rows, "2026-09-14", 7);
    assert.deepEqual(recent.map((r) => r.event_key), ["new"]);
    assert.equal(inCaseRange(rows[1], "2026-09-08", "2026-09-14"), false);
  });

  test("search and sort", () => {
    const rows = [
      row({ event_key: "a", event_date: "2026-08-02", sku: "BALM", quantity: 1 }),
      row({ event_key: "b", event_date: "2026-08-01", sku: "DEO", quantity: 4, shipment_id: "FBA123" }),
    ];
    assert.equal(searchCaseRows(rows, "fba123")[0].event_key, "b");
    const sorted = sortCaseRows(rows, "quantity", "desc");
    assert.equal(sorted[0].sku, "DEO");
  });

  test("apiUrl is origin-absolute so basic-auth userinfo cannot enter fetch", () => {
    assert.equal(apiUrl("/api/reimbursements/eligible/sync"), "/api/reimbursements/eligible/sync");
  });

  test("Seller Central href is FBA tracker only — digit refs are not shipments", () => {
    assert.equal(
      sellerCentralHref({
        seller_central_url: "https://sellercentral.amazon.com/help/hub/contact-us",
        shipment_id: null,
        reference_id: null,
        reason: "7",
        reason_group: "warehouse_damage",
        disposition: null,
      }),
      "https://sellercentral.amazon.com/inventory-reimbursement/eligible-for-claim",
    );
    assert.match(
      sellerCentralHref({
        seller_central_url: null,
        shipment_id: "FBA16ABCDE",
        reason: "Lost_Inbound",
        reason_group: "lost_inbound",
      }) ?? "",
      /fba\/inbound-shipment\/summary\/FBA16ABCDE\/shipmentEvents/,
    );
    assert.equal(
      sellerCentralHref({
        seller_central_url: null,
        shipment_id: "FBA16DAMAGE",
        reason: "7",
        reason_group: "warehouse_damage",
      }),
      "https://sellercentral.amazon.com/inventory-reimbursement/eligible-for-claim",
    );
    assert.equal(
      sellerCentralHref({
        seller_central_url: null,
        shipment_id: "FBA16LOST",
        reason: "M",
        reason_group: "lost_warehouse",
      }),
      "https://sellercentral.amazon.com/inventory-reimbursement/eligible-for-claim",
    );
    assert.equal(
      sellerCentralHref({
        seller_central_url: null,
        shipment_id: null,
        reference_id: "20080126439780",
        reason: "7",
        reason_group: "warehouse_damage",
        disposition: null,
      }),
      "https://sellercentral.amazon.com/inventory-reimbursement/eligible-for-claim",
    );
    assert.equal(isFbaShipmentId("20080126439780"), false);
    assert.equal(fbaShipmentId(null, "20080126439780"), null);
    assert.equal(fbaShipmentId("FBA16ABCDE", "20080126439780"), "FBA16ABCDE");
  });

  test("case packet and inbound empty copy stay honest", () => {
    const packet = formatCasePacket(row({
      event_key: "adj|7",
      event_date: "2026-08-10",
      reason: "7",
      reason_group: "warehouse_damage",
      reference_id: "20080126439780",
      fulfillment_center: "PHX6",
      fnsku: "X2",
      quantity: 1,
    }));
    assert.match(packet, /20080126439780/);
    assert.match(packet, /PHX6/);
    assert.match(packet, /not a shipment ID/);
    assert.match(packet, /Inventory Defect and Reimbursement/);
    assert.match(packet, /eligible-for-claim/);
    assert.doesNotMatch(packet, /help\/hub\/contact-us/);
    assert.doesNotMatch(packet, /inbound-shipment-workflow/);
    assert.equal(inboundEmptyCopy([]), NO_INBOUND_DISCREPANCIES);
    assert.equal(
      inboundEmptyCopy([row({ event_key: "in", event_date: "2026-08-01", source: "inbound_discrepancy" })]),
      null,
    );
  });

  test("M is lost_warehouse not lost_inbound; 7 is damage not Found", () => {
    assert.equal(reasonGroup("M"), "lost_warehouse");
    assert.notEqual(reasonGroup("M"), "lost_inbound");
    assert.equal(reasonLabel("M"), "M — Inventory misplaced");
    assert.equal(reasonGroup("7"), "warehouse_damage");
    assert.equal(reasonGroup("Q"), "other");
    assert.equal(reasonGroup("D", "WAREHOUSE_DAMAGED"), "other");
    assert.equal(reasonGroup("O", "WAREHOUSE_DAMAGED"), "other");
    assert.notEqual(reasonGroup("D"), "warehouse_damage");
    const stale = normalizeCaseRow(row({
      event_key: "stale-m",
      event_date: "2026-08-01",
      reason: "M",
      reason_group: "lost_inbound",
      shipment_id: "20080126439780",
      reference_id: "20080126439780",
    }));
    assert.equal(stale.reason_group, "lost_warehouse");
    assert.equal(stale.shipment_id, null);
    assert.equal(stale.seller_central_link_kind, "idr_instructions");
    assert.equal(
      stale.seller_central_url,
      "https://sellercentral.amazon.com/inventory-reimbursement/eligible-for-claim",
    );
    const damage = normalizeCaseRow(row({
      event_key: "dmg-fba",
      event_date: "2026-08-10",
      reason: "7",
      shipment_id: "FBA16DAMAGE",
    }));
    assert.equal(damage.reason_group, "warehouse_damage");
    assert.equal(damage.shipment_id, "FBA16DAMAGE");
    assert.equal(damage.seller_central_link_kind, "idr_instructions");
    assert.equal(
      damage.seller_central_url,
      "https://sellercentral.amazon.com/inventory-reimbursement/eligible-for-claim",
    );
  });

  test("notify gate refuses unknown / missing FC / outdated classification", () => {
    const bad = row({
      event_key: "bad",
      event_date: "2026-08-01",
      reason: "ZZZ",
      fulfillment_center: "",
      classification_version: "old",
    });
    const qa = evaluateCaseQa([bad]);
    assert.equal(qa.ok, false);
    const errors = notifyGateErrors([bad], qa);
    assert.ok(errors.length > 0);
    assert.match(NOTIFY_BLOCK_COPY, /Do not prep/);
    const good = row({
      event_key: "good",
      event_date: "2026-08-01",
      reason: "M",
      fulfillment_center: "ONT8",
      classification_version: CLASSIFICATION_VERSION,
    });
    assert.equal(evaluateCaseQa([good]).ok, true);
    assert.deepEqual(notifyGateErrors([good], evaluateCaseQa([good])), []);
  });
});

describe("Reese package + page contract", () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const page = readFileSync(path.join(here, "../app/reimbursements/page.tsx"), "utf8");
  const ui = readFileSync(path.join(here, "../components/reimbursements-eligible.tsx"), "utf8");
  const api = readFileSync(path.join(here, "../app/api/reimbursements/eligible/route.ts"), "utf8");
  const notify = readFileSync(path.join(here, "../app/api/reimbursements/eligible/notify/route.ts"), "utf8");
  const sync = readFileSync(path.join(here, "../app/api/reimbursements/eligible/sync/route.ts"), "utf8");
  const pyPkg = readFileSync(path.join(here, "../../../src/reimbursements/case_package.py"), "utf8");
  const pyQueue = readFileSync(path.join(here, "../../../src/reimbursements/case_queue.py"), "utf8");
  const pyLegend = readFileSync(path.join(here, "../../../src/reimbursements/reason_legend.py"), "utf8");

  test("buildReesePackage is v1, Reese-targeted, no auto-submit", () => {
    const pkg = buildReesePackage(
      [
        row({
          event_key: "inbound|FBA1|SKU-A",
          event_date: "2026-08-10",
          sku: "SKU-A",
          quantity: 2,
          reason: "Lost_Inbound",
          reason_group: "lost_inbound",
          shipment_id: "FBA1",
          seller_central_url: "https://sellercentral.amazon.com/fba/inbound-shipment/summary/FBA1/shipmentEvents",
          estimated_amount: 20,
        }),
        row({
          event_key: "paid",
          event_date: "2026-08-10",
          status: "already_reimbursed",
          quantity: 0,
        }),
      ],
      { asOf: "2026-09-14", start: "2026-06-17", end: "2026-09-14" },
    );
    assert.equal(pkg.contract, "fba_case_package/v1");
    assert.equal(pkg.auto_submit, false);
    assert.equal(pkg.target.agent_id, REESE_AGENT_ID);
    assert.equal(pkg.summary.events, 1);
    assert.equal(pkg.summary.units, 2);
    assert.match(pkg.markdown, /Needs-case package/);
    assert.match(pkg.markdown, /Do not auto-file/);
    assert.match(pkg.markdown, /How to file/);
    assert.match(pkg.markdown, /Inventory Defect and Reimbursement/);
    assert.doesNotMatch(pkg.markdown, /help\/hub\/contact-us/);
  });

  test("Reese id and no auto-submit", () => {
    assert.equal(REESE_AGENT_ID, "74a7ce8a-6754-4bf1-90aa-afa1f4cd774c");
    assert.equal(REESE_AGENT_NAME, "Reese · Reimbursements");
    assert.equal(REESE_PACKAGE_CONTRACT, "fba_case_package/v1");
    assert.match(notify, /74a7ce8a-6754-4bf1-90aa-afa1f4cd774c/);
    assert.match(notify, /fba_case_package\/v1/);
    assert.match(notify, /auto_submit:\s*false/);
    assert.match(pyPkg, /Do not auto-file/);
    assert.match(pyQueue, /never opens Seller Central cases/);
  });

  test("page distinguishes Needs case from Already reimbursed", () => {
    assert.match(page, /Needs case/);
    assert.match(page, /Already reimbursed/);
    assert.match(page, /GET_LEDGER_DETAIL_VIEW_DATA/);
    assert.match(page, /does not auto-file/);
    assert.doesNotMatch(page, /Sellerise/);
    assert.doesNotMatch(api, /Sellerise/);
    assert.match(api, /fba_case_events/);
    assert.match(sync, /reimbursements_case_sync/);
    assert.match(CASE_QUEUE_GAP, /no SP-API for eligible/);
    assert.match(SELLER_CENTRAL_LINK_LIMIT, /No stable Seller Central deep link/);
    assert.match(SELLER_CENTRAL_LINK_LIMIT, /NOT a pre-filled/);
  });

  test("UI splits FC, Shipment, and Reference ID — never uses reference as shipment", () => {
    assert.match(ui, />FC</);
    assert.match(ui, />Shipment</);
    assert.match(ui, />Reference ID</);
    assert.match(ui, /Copy case packet/);
    assert.match(ui, /HOW_TO_FILE_TITLE/);
    assert.doesNotMatch(ui, /Support \(manual\)/);
    assert.doesNotMatch(ui, /help\/hub\/contact-us/);
    assert.doesNotMatch(ui, /inbound-shipment-workflow/);
    assert.match(ui, /Eligible for claim/);
    assert.match(ui, /shipmentEvents|SC_ELIGIBLE_FOR_CLAIM/);
    assert.doesNotMatch(ui, /FC \/ Shipment/);
    assert.doesNotMatch(ui, /shipment_id \|\| r\.reference_id/);
    assert.match(notify, /status:\s*422/);
    assert.match(notify, /NOTIFY_BLOCK_COPY/);
    assert.match(api, /qa/);
    assert.match(pyLegend, /Inventory misplaced/);
    assert.match(pyQueue, /Digit ``reference_id`` values are ledger transaction IDs/);
    assert.doesNotMatch(pyQueue, /"m".*lost_inbound/);
  });

  test("How to file copy is on the Needs case dashboard", () => {
    assert.equal(HOW_TO_FILE_TITLE, "How to file");
    assert.match(HOW_TO_FILE_INTRO, /codes 7 \/ E/);
    assert.match(HOW_TO_FILE_INTRO, /Damaged at FC/);
    const titles = HOW_TO_FILE_STEPS.map((s) => s.title).join(" | ");
    const bodies = HOW_TO_FILE_STEPS.map((s) => s.body).join(" ");
    assert.match(titles, /Check Paid \/ Reimbursements report first/);
    assert.match(titles, /File within 60 days/);
    assert.match(bodies, /already paid within ~60 days/);
    assert.match(bodies, /ledger transaction ID/);
    assert.match(bodies, /Inventory Defect and Reimbursement/);
    assert.match(bodies, /Inventory Adjustments \/ Ledger Adjustments/);
    assert.match(bodies, /One case per event|Do not batch/);
    assert.match(HOW_TO_FILE_NO_DEEP_LINK, /no stable deep link/);
    assert.match(HOW_TO_FILE_NO_DEEP_LINK, /Support hub/);
    assert.equal(IDR_INSTRUCTION, "Open IDR (Inventory → Inventory Defect and Reimbursement)");
    assert.match(CASE_QUEUE_SOURCE_NOTE, /ledger adjustments with eligible codes/);
    assert.match(CASE_QUEUE_SOURCE_NOTE, /CLOSED\/stale inbound/);
    assert.equal(NO_INBOUND_DISCREPANCIES, "No CLOSED inbound discrepancies in warehouse right now");
    assert.match(ui, /HOW_TO_FILE_TITLE/);
    assert.match(ui, /HOW_TO_FILE_STEPS/);
    assert.match(ui, /Copy case packet/);
    assert.match(ui, /IDR_INSTRUCTION/);
    assert.match(ui, /NO_INBOUND_DISCREPANCIES/);
    assert.match(ui, /CASE_QUEUE_SOURCE_NOTE/);
    assert.match(pyQueue, /How to file/);
    assert.match(pyQueue, /Inventory Defect and Reimbursement/);
    assert.match(pyPkg, /HOW_TO_FILE_TITLE/);
    assert.doesNotMatch(pyPkg, /Get Support: https:\/\/sellercentral/);
  });

  test("queue is not built from paid-only reimbursements", () => {
    assert.match(pyQueue, /Do not invent Eligible rows from paid-only/);
    assert.match(api, /GET_FBA_REIMBURSEMENTS_DATA \(dedupe only/);
    assert.doesNotMatch(api, /from\("fba_reimbursements"\)/);
  });

  test("Sellerboard CLOSED is a warehouse source — dashboard never calls Sellerboard", () => {
    assert.ok(CASE_QUEUE_SOURCES.some((s) => /Sellerboard CLOSED/.test(s)));
    assert.match(HOW_TO_FILE_INBOUND, /Sellerboard CLOSED/);
    assert.match(HOW_TO_FILE_INBOUND, /shipmentEvents/);
    assert.match(HOW_TO_FILE_INBOUND, /Reference ID/);
    assert.ok(HOW_TO_FILE_INBOUND_STEPS.some((s) => /Sellerboard CLOSED/.test(s.title + s.body)));
    assert.doesNotMatch(ui, /sellerboard\.(com|io)/i);
    assert.match(ui, /sourceLabel/);
    assert.match(ui, /HOW_TO_FILE_INBOUND/);
    assert.match(ui, /Shipped/);
    assert.match(ui, /Received/);
    assert.match(ui, /Clear \/ Mark submitted/);
    assert.match(ui, /Clear selected/);
    assert.match(ui, /KPI_UNITS_LABEL/);
    assert.match(ui, /caseKpi/);
    assert.doesNotMatch(ui, /fmt\(summary\.units\)/);
    assert.match(ui, /HOW_TO_FILE_INBOUND/);
    assert.match(page, /does not auto-file/);
    const alertsApi = readFileSync(path.join(here, "../app/api/reimbursements/inbound-alerts/route.ts"), "utf8");
    assert.doesNotMatch(alertsApi, /sellerboard\.(com|io)|oauth/i);
    assert.match(alertsApi, /fba_case_events/);
    assert.match(alertsApi, /case_submitted/);
    assert.match(alertsApi, /found_offset/);
    assert.match(alertsApi, /event_keys/);
    assert.match(alertsApi, /resolveClearAction/);
    assert.match(alertsApi, /amazonWrite:\s*false/);
    const overview = readFileSync(path.join(here, "../app/page.tsx"), "utf8");
    assert.match(overview, /InboundDiscrepancyAlerts/);
    const salesPulseIdx = overview.indexOf("Sales pulse:");
    const alertsJsxIdx = overview.lastIndexOf("<InboundDiscrepancyAlerts");
    const trustIdx = overview.indexOf("P0-5: Trust surface");
    assert.ok(salesPulseIdx >= 0 && alertsJsxIdx >= 0, "Overview must render Sales pulse and inbound alerts");
    assert.ok(
      alertsJsxIdx > salesPulseIdx,
      "Inbound alerts must render after Sales pulse, not above it",
    );
    assert.ok(
      trustIdx < 0 || alertsJsxIdx < trustIdx,
      "Inbound alerts stay above the legal disclaimer",
    );
    const alertUi = readFileSync(path.join(here, "../components/inbound-discrepancy-alerts.tsx"), "utf8");
    assert.match(alertUi, /NEEDS_CASE_HREF|\/reimbursements\?tab=eligible/);
    assert.match(alertUi, /Dismiss/);
    assert.doesNotMatch(alertUi, /Sellerise/);
  });
});

describe("inbound alerts + dismiss", () => {
  test("active Lost_Inbound with FBA id alerts; submitted / transit zeros do not", () => {
    const open = row({
      event_key: "inbound|FBA19K98F8VN|SKU-C",
      event_date: "2026-08-20",
      source: "sellerboard_inbound",
      reason: "Lost_Inbound",
      reason_group: "lost_inbound",
      shipment_id: "FBA19K98F8VN",
      quantity: 77,
      quantity_shipped: 540,
      quantity_received: 463,
      fulfillment_center: "SMF3",
    });
    const submitted = row({
      event_key: "inbound|FBA19OLD|SKU-C",
      event_date: "2026-08-01",
      source: "sellerboard_inbound",
      reason: "Lost_Inbound",
      reason_group: "lost_inbound",
      shipment_id: "FBA19OLD",
      status: STATUS_CASE_SUBMITTED,
      quantity: 3,
    });
    const ledgerNoFba = row({
      event_key: "adj|x",
      event_date: "2026-08-02",
      reason: "Lost_Inbound",
      reason_group: "lost_inbound",
      shipment_id: null,
      quantity: 2,
    });
    const paid = row({
      event_key: "inbound|FBA19PAID|SKU-C",
      event_date: "2026-08-03",
      source: "inbound_discrepancy",
      reason: "Lost_Inbound",
      shipment_id: "FBA19PAID",
      status: "already_reimbursed",
      quantity: 0,
    });
    assert.equal(isActiveInboundAlert(open), true);
    assert.equal(isActiveInboundAlert(submitted), false);
    assert.equal(isActiveInboundAlert(ledgerNoFba), false);
    assert.equal(isActiveInboundAlert(paid), false);
    assert.deepEqual(filterInboundAlerts([open, submitted, ledgerNoFba, paid]).map((r) => r.event_key), [
      open.event_key,
    ]);
    assert.equal(filterNeedsCase([open, submitted]).length, 1);
    assert.equal(filterSubmittedCases([open, submitted])[0].event_key, submitted.event_key);
    assert.equal(sourceLabel("sellerboard_inbound"), "Sellerboard CLOSED");
    assert.equal(sourceLabel("inbound_discrepancy"), "Inbound short");
  });

  test("new event_key still alerts after a dismiss", () => {
    const dismissed = row({
      event_key: "inbound|FBA19OLD|SKU-C",
      event_date: "2026-08-01",
      source: "sellerboard_inbound",
      reason: "Lost_Inbound",
      shipment_id: "FBA19OLD",
      status: STATUS_CASE_SUBMITTED,
      quantity: 3,
    });
    const fresh = row({
      event_key: "inbound|FBA19NEW|SKU-C",
      event_date: "2026-09-01",
      source: "sellerboard_inbound",
      reason: "Lost_Inbound",
      shipment_id: "FBA19NEW",
      quantity: 2,
      fulfillment_center: "SMF3",
    });
    const open = filterInboundAlerts([dismissed, fresh]);
    assert.deepEqual(open.map((r) => r.shipment_id), ["FBA19NEW"]);
    assert.equal(NEEDS_CASE_HREF, "/reimbursements?tab=eligible");
  });

  test("clear reasons map to existing statuses; Overview note=filed stays compatible", () => {
    assert.equal(parseClearReason("filed"), "filed");
    assert.deepEqual(resolveClearAction({ note: "filed" }), {
      reason: "filed",
      status: STATUS_CASE_SUBMITTED,
      note: "filed",
    });
    assert.deepEqual(resolveClearAction({ reason: "reconciled" }), {
      reason: "reconciled",
      status: STATUS_FOUND_OFFSET,
      note: "reconciled",
    });
    assert.deepEqual(resolveClearAction({ reason: "not_pursuing" }), {
      reason: "not_pursuing",
      status: STATUS_CASE_SUBMITTED,
      note: "not_pursuing",
    });
    assert.deepEqual(normalizeClearKeys({ event_key: "a", event_keys: ["b", "a"] }), ["b", "a"]);
    assert.equal(clearResultMessage("filed"), "Marked submitted — row kept in history. No Amazon write.");
    const reconciled = row({
      event_key: "in|FBA1|SKU",
      event_date: "2026-08-01",
      status: STATUS_FOUND_OFFSET,
      dismissed_note: "reconciled",
      quantity: 0,
    });
    const ledgerFound = row({
      event_key: "adj|found",
      event_date: "2026-08-01",
      status: STATUS_FOUND_OFFSET,
      quantity: 0,
    });
    assert.equal(isClearedHistory(reconciled), true);
    assert.equal(isClearedHistory(ledgerFound), false);
    assert.equal(filterSubmittedCases([reconciled, ledgerFound])[0].event_key, reconciled.event_key);
    assert.equal(clearReasonLabel(reconciled), CLEAR_REASON_LABELS.reconciled);
  });
});
