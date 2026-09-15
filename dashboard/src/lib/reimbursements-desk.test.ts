import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { windowStart } from "./as-of";
import {
  ALERT_REASON_CODES,
  REIMBURSEMENTS_ALERT_DAYS,
  REIMBURSEMENTS_DEFAULT_DAYS,
  approvalQueryBounds,
  defaultDeskRange,
  filterByGroup,
  inLaRange,
  isAlertReason,
  reasonGroup,
  reasonLabel,
  recentAlertRows,
  searchRows,
  sortRows,
  summarizeDesk,
  type ReimbursementDeskRow,
} from "./reimbursements-desk";

function row(partial: Partial<ReimbursementDeskRow> & Pick<ReimbursementDeskRow, "approval_date" | "reimbursement_id">): ReimbursementDeskRow {
  return {
    reason: null,
    sku: "SKU-A",
    asin: "B001",
    qty_total: 1,
    amount_total: 10,
    ...partial,
  };
}

describe("reason grouping", () => {
  test("maps Amazon codes Dave cares about", () => {
    assert.equal(reasonGroup("Damaged_Warehouse"), "warehouse_damage");
    assert.equal(reasonGroup("Lost_Inbound"), "lost_inbound");
    assert.equal(reasonGroup("Lost_Warehouse"), "lost_warehouse");
    assert.equal(reasonGroup("CustomerReturn"), "other");
    assert.equal(reasonGroup("Reimbursement_Reversal"), "other");
    assert.equal(reasonGroup("CustomerServiceIssue"), "other");
  });

  test("tolerates spacing and case", () => {
    assert.equal(reasonGroup("damaged warehouse"), "warehouse_damage");
    assert.equal(reasonGroup("LOST-INBOUND"), "lost_inbound");
    assert.equal(reasonGroup("Lost Warehouse"), "lost_warehouse");
  });

  test("alert reasons are the three warehouse/inbound codes", () => {
    assert.deepEqual([...ALERT_REASON_CODES], [
      "Damaged_Warehouse",
      "Lost_Inbound",
      "Lost_Warehouse",
    ]);
    assert.equal(isAlertReason("Damaged_Warehouse"), true);
    assert.equal(isAlertReason("CustomerReturn"), false);
    assert.equal(reasonLabel("Damaged_Warehouse"), "Warehouse damage");
    assert.equal(reasonLabel("Lost_Inbound"), "Lost inbound");
  });
});

describe("default 90d LA window and 7d alert", () => {
  test("defaults to 90 closed Amazon LA days ending yesterday", () => {
    const now = new Date("2026-09-15T19:00:00.000Z"); // 12:00 PDT
    const range = defaultDeskRange(now);
    assert.equal(range.asOf, "2026-09-14");
    assert.equal(range.end, "2026-09-14");
    assert.equal(range.start, windowStart("2026-09-14", 90));
    assert.equal(range.start, "2026-06-17");
    assert.equal(REIMBURSEMENTS_DEFAULT_DAYS, 90);
    assert.equal(REIMBURSEMENTS_ALERT_DAYS, 7);
  });

  test("inLaRange uses noon-Pacific approval day, not UTC midnight", () => {
    const rowNoon = row({
      approval_date: "2026-09-14T12:00:00-07:00",
      reimbursement_id: "R1",
    });
    const rowUtcMidnight = row({
      approval_date: "2026-09-15T00:00:00.000Z",
      reimbursement_id: "R2",
    });
    assert.equal(inLaRange(rowNoon, "2026-09-14", "2026-09-14"), true);
    // 2026-09-15T00:00Z is still 2026-09-14 in LA.
    assert.equal(inLaRange(rowUtcMidnight, "2026-09-14", "2026-09-14"), true);
    assert.equal(inLaRange(rowUtcMidnight, "2026-09-15", "2026-09-15"), false);
  });

  test("query bounds pad a day so LA noon is not dropped", () => {
    const bounds = approvalQueryBounds("2026-06-17", "2026-09-14");
    assert.equal(bounds.gte, "2026-06-16T00:00:00.000Z");
    assert.equal(bounds.lte, "2026-09-16T23:59:59.999Z");
  });
});

describe("summarize, filter, search, sort, alert", () => {
  const rows: ReimbursementDeskRow[] = [
    row({
      approval_date: "2026-09-12T12:00:00-07:00",
      reimbursement_id: "DW-1",
      reason: "Damaged_Warehouse",
      sku: "BALM",
      asin: "B0DW",
      qty_total: 2,
      qty_cash: 2,
      amount_total: 12.04,
    }),
    row({
      approval_date: "2026-09-11T12:00:00-07:00",
      reimbursement_id: "LW-1",
      reason: "Lost_Warehouse",
      sku: "LIP",
      asin: "B0LW",
      qty_total: 4,
      qty_cash: 4,
      amount_total: 24.11,
    }),
    row({
      approval_date: "2026-09-03T12:00:00-07:00",
      reimbursement_id: "LI-1",
      reason: "Lost_Inbound",
      sku: "TIN",
      asin: "B0LI",
      qty_total: 50,
      qty_cash: 50,
      amount_total: 300,
    }),
    row({
      approval_date: "2026-09-14T12:00:00-07:00",
      reimbursement_id: "CR-1",
      reason: "CustomerReturn",
      sku: "BALM",
      qty_total: 1,
      qty_cash: 1,
      amount_total: 8.5,
    }),
    row({
      approval_date: "2026-09-14T12:00:00-07:00",
      reimbursement_id: "RV-1",
      reason: "Reimbursement_Reversal",
      sku: "BALM",
      qty_total: -1,
      qty_cash: -1,
      amount_total: -8.5,
    }),
  ];

  test("overview and group cards net credits and reversals", () => {
    const s = summarizeDesk(rows);
    assert.equal(s.overview.rows, 5);
    assert.equal(s.overview.units, 56);
    assert.equal(s.overview.amount, 336.15);
    assert.equal(s.groups.warehouse_damage.units, 2);
    assert.equal(s.groups.warehouse_damage.amount, 12.04);
    assert.equal(s.groups.lost_warehouse.units, 4);
    assert.equal(s.groups.lost_inbound.amount, 300);
    assert.equal(s.groups.other.rows, 2);
    assert.equal(s.groups.other.amount, 0);
    assert.equal(s.resolved.amount, s.overview.amount);
    assert.equal(s.byReason[0].reason, "Lost_Inbound");
  });

  test("filter tabs isolate each group", () => {
    assert.equal(filterByGroup(rows, "all").length, 5);
    assert.equal(filterByGroup(rows, "warehouse_damage").length, 1);
    assert.equal(filterByGroup(rows, "lost_inbound")[0].reimbursement_id, "LI-1");
    assert.equal(filterByGroup(rows, "other").every((r) => !isAlertReason(r.reason)), true);
  });

  test("search matches sku, asin, reason label, and reimbursement id", () => {
    assert.equal(searchRows(rows, "b0li")[0].reimbursement_id, "LI-1");
    assert.equal(searchRows(rows, "warehouse damage")[0].reimbursement_id, "DW-1");
    assert.equal(searchRows(rows, "CR-1").length, 1);
    assert.equal(searchRows(rows, "nope").length, 0);
  });

  test("sort by amount and approval day", () => {
    const byAmt = sortRows(rows, "amount_total", "desc");
    assert.equal(byAmt[0].reimbursement_id, "LI-1");
    const byDay = sortRows(rows, "approval_date", "desc");
    assert.equal(byDay[0].approval_date.startsWith("2026-09-14"), true);
  });

  test("alert banner uses last 7 closed LA days on priority reasons", () => {
    const alerts = recentAlertRows(rows, "2026-09-14", 7);
    const ids = alerts.map((r) => r.reimbursement_id).sort();
    // 09-12 DW and 09-11 LW are inside 09-08..09-14; 09-03 Lost_Inbound is not.
    assert.deepEqual(ids, ["DW-1", "LW-1"]);
  });
});

describe("desk wiring stays cash-awareness and Sellerise-free", () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const page = readFileSync(path.join(here, "../app/reimbursements/page.tsx"), "utf8");
  const nav = readFileSync(path.join(here, "../components/nav.tsx"), "utf8");
  const api = readFileSync(path.join(here, "../app/api/reimbursements/route.ts"), "utf8");
  const sync = readFileSync(path.join(here, "../app/api/reimbursements/sync/route.ts"), "utf8");
  const pnl = readFileSync(path.join(here, "pnl-periods.ts"), "utf8");

  test("nav and route exist", () => {
    assert.match(nav, /href: "\/reimbursements"/);
    assert.match(page, /Paid Amazon FBA reimbursements/);
    assert.match(api, /fba_reimbursements/);
    assert.match(sync, /reimbursements_sync/);
  });

  test("desk is observe\/alert — no auto-filing, no Sellerise dependency", () => {
    assert.match(page, /Reese/);
    assert.match(page, /observe\/alert/);
    assert.match(page, /does not auto-file/);
    assert.doesNotMatch(page, /sellerise/i);
    assert.doesNotMatch(page, /openAmazonCase|createCase|auto-open/i);
    assert.doesNotMatch(api, /sellerise/i);
    assert.doesNotMatch(sync, /sellerise/i);
  });

  test("contribution formula still excludes reimbursements", () => {
    assert.match(pnl, /Not inside contribution/);
  });
});
