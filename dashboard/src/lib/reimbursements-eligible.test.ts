import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";

import { windowStart } from "./as-of";
import {
  CASE_QUEUE_DEFAULT_DAYS,
  CASE_QUEUE_GAP,
  REESE_AGENT_ID,
  REESE_AGENT_NAME,
  REESE_PACKAGE_CONTRACT,
  SC_SUPPORT_HUB,
  SELLER_CENTRAL_LINK_LIMIT,
  buildReesePackage,
  defaultCaseRange,
  filterNeedsCase,
  inCaseRange,
  isNeedsCase,
  recentNeedsCase,
  searchCaseRows,
  sellerCentralHref,
  sortCaseRows,
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
    ...partial,
  };
}

describe("needs-case vs paid", () => {
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

  test("Seller Central href prefers stored URL then FBA shipment tracker", () => {
    assert.equal(
      sellerCentralHref({ seller_central_url: "https://example.com/x" }),
      "https://example.com/x",
    );
    assert.match(
      sellerCentralHref({ seller_central_url: null, shipment_id: "FBA16ABCDE" }),
      /inbound-shipment-workflow.*FBA16ABCDE/,
    );
    assert.equal(
      sellerCentralHref({ seller_central_url: null, shipment_id: null, reference_id: "xyz" }),
      SC_SUPPORT_HUB,
    );
  });
});

describe("Reese package + page contract", () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const page = readFileSync(path.join(here, "../app/reimbursements/page.tsx"), "utf8");
  const api = readFileSync(path.join(here, "../app/api/reimbursements/eligible/route.ts"), "utf8");
  const notify = readFileSync(path.join(here, "../app/api/reimbursements/eligible/notify/route.ts"), "utf8");
  const sync = readFileSync(path.join(here, "../app/api/reimbursements/eligible/sync/route.ts"), "utf8");
  const pyPkg = readFileSync(path.join(here, "../../../src/reimbursements/case_package.py"), "utf8");
  const pyQueue = readFileSync(path.join(here, "../../../src/reimbursements/case_queue.py"), "utf8");

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
          seller_central_url: "https://sellercentral.amazon.com/gp/fba/inbound-shipment-workflow/index.html?shipmentId=FBA1",
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
  });

  test("queue is not built from paid-only reimbursements", () => {
    assert.match(pyQueue, /Do not invent Eligible rows from paid-only/);
    assert.match(api, /GET_FBA_REIMBURSEMENTS_DATA \(dedupe only/);
    assert.doesNotMatch(api, /from\("fba_reimbursements"\)/);
  });
});
