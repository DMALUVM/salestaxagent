import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "path";
import {
  AWD_NATIONAL,
  UNKNOWN_STATE,
  attachAwdNational,
  peakByState,
  toCsv,
  type LedgerDailyRow,
} from "./tax-inventory";

function row(
  date: string,
  state: string | null,
  fc: string,
  cogs: number,
  qty: number,
): LedgerDailyRow {
  return {
    snapshot_date: date,
    sku: "SKU-A",
    fc_code: fc,
    state_code: state,
    disposition: "SELLABLE",
    ending_qty: qty,
    cogs_per_unit: 1,
    cogs_value: cogs,
  };
}

describe("tax inventory peak YTD", () => {
  test("peak is the max day, not the latest snapshot", () => {
    const peaks = peakByState(
      [
        row("2026-03-01", "CA", "ONT8", 2946.85, 866),
        row("2026-08-30", "CA", "ONT8", 100, 20),
        row("2026-08-30", "TX", "DFW7", 12, 2),
      ],
      2026,
    );
    const ca = peaks.find((p) => p.state_code === "CA");
    assert.ok(ca);
    assert.equal(ca.peak_cogs, 2946.85);
    assert.equal(ca.peak_date, "2026-03-01");
    assert.equal(ca.current_cogs, 100);
    assert.equal(ca.current_units, 20);
  });

  test("unmapped FCs stay XX, not CA", () => {
    const peaks = peakByState(
      [
        row("2026-08-30", "CA", "ONT8", 10, 2),
        row("2026-08-30", null, "BDU2", 5, 1),
      ],
      2026,
    );
    assert.equal(peaks.find((p) => p.state_code === "CA")?.peak_cogs, 10);
    assert.equal(peaks.find((p) => p.state_code === UNKNOWN_STATE)?.peak_cogs, 5);
  });

  test("AWD is a national row, not assigned to a state", () => {
    const states = attachAwdNational(
      peakByState([row("2026-08-30", "CA", "ONT8", 10, 2)], 2026),
      40,
      8,
    );
    const awd = states.find((s) => s.state_code === AWD_NATIONAL);
    const ca = states.find((s) => s.state_code === "CA");
    assert.ok(awd);
    assert.equal(awd.awd_cogs, 40);
    assert.equal(awd.fba_cogs, 0);
    assert.equal(ca?.awd_cogs, 0);
    assert.equal(ca?.fba_cogs, 10);
  });

  test("CSV has the required columns", () => {
    const csv = toCsv([
      {
        state_code: "CA",
        peak_cogs: 2946.85,
        peak_date: "2026-08-30",
        current_cogs: 2946.85,
        current_units: 866,
        current_fc_count: 24,
        fba_cogs: 2946.85,
        awd_cogs: 0,
      },
    ]);
    assert.match(csv, /state,max_cogs,date_of_max,current_on_hand_cogs,fba_cogs,awd_cogs,unit_count/);
    assert.match(csv, /CA,2946.85,2026-08-30,2946.85,2946.85,0.00,866/);
  });
});

describe("tax inventory page wiring", () => {
  const root = process.cwd();
  const nav = readFileSync(path.join(root, "src/components/nav.tsx"), "utf8");
  const page = readFileSync(path.join(root, "src/app/tax-inventory/page.tsx"), "utf8");
  const inv = readFileSync(path.join(root, "src/app/inventory/page.tsx"), "utf8");

  test("nav lists Tax Inventory next to Sales Map, not under /inventory", () => {
    assert.match(nav, /href: "\/tax-inventory"/);
    assert.match(nav, /Tax Inventory/);
    const sales = nav.indexOf('href: "/sales-map"');
    const tax = nav.indexOf('href: "/tax-inventory"');
    const invHref = nav.indexOf('href: "/inventory"');
    assert.ok(sales >= 0 && tax > sales);
    const inventoryBlock = nav.slice(invHref, nav.indexOf("Planning"));
    assert.doesNotMatch(inventoryBlock, /tax-inventory/);
  });

  test("page is tax/nexus COGS, not the ops inventory table", () => {
    assert.match(page, /Peak COGS by State/);
    assert.match(page, /Physical-nexus inventory \$ at sku_costs/);
    assert.match(page, /not the\s+ops \/inventory table/);
    assert.match(page, /\/api\/tax-inventory\?year=2026/);
    assert.match(page, /format=csv/);
    assert.doesNotMatch(page, /\/api\/inventory[^-]/);
  });

  test("does not change the ops inventory page", () => {
    assert.match(inv, /skuColumnPhoneClass/);
    assert.doesNotMatch(inv, /tax-inventory/);
    assert.doesNotMatch(inv, /ledger_summary/);
  });
});
