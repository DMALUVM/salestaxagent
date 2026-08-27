import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  ALWAYS_VISIBLE_COLUMN_KEYS,
  DEFAULT_VISIBLE_COLUMN_KEYS,
  formatSkuQty,
  migrateSortColumn,
  resolveVisibleColumns,
  SKU_TABLE_COLUMNS,
  visibleSkuTableColumns,
} from "./inventory-sku-columns";

describe("SKU table default column set", () => {
  test("Total is always in the default visible set", () => {
    assert.equal(DEFAULT_VISIBLE_COLUMN_KEYS.includes("owned_total"), true);
    assert.equal(ALWAYS_VISIBLE_COLUMN_KEYS.includes("owned_total"), true);
    const labels = visibleSkuTableColumns(null).map((c) => c.label);
    assert.deepEqual(labels.slice(0, 10), [
      "SKU",
      "FBA",
      "Reserved",
      "AWD",
      "3PL",
      "Inbnd",
      "Unfulfillable",
      "Total",
      "V7",
      "V30",
    ]);
    assert.equal(DEFAULT_VISIBLE_COLUMN_KEYS.includes("fba_reserved"), true);
    assert.equal(DEFAULT_VISIBLE_COLUMN_KEYS.includes("fba_unfulfillable"), true);
    assert.equal(ALWAYS_VISIBLE_COLUMN_KEYS.includes("fba_reserved"), false);
    assert.equal(ALWAYS_VISIBLE_COLUMN_KEYS.includes("fba_unfulfillable"), false);
  });

  test("forces Total on when saved prefs predate the column", () => {
    const predating = resolveVisibleColumns({
      columns: ["sku", "fba_on_hand", "awd_on_hand", "tpl_available", "inbound", "total_u_7", "total_u_30"],
    });
    assert.equal(predating.includes("owned_total"), true);
    assert.equal(predating.includes("fba_fulfillable"), true);
    assert.equal(predating.includes("fba_reserved"), true);
    assert.equal(predating.includes("fba_unfulfillable"), true);
    assert.equal(predating.includes("fba_on_hand" as never), false);
    assert.equal(predating.indexOf("fba_reserved"), predating.indexOf("fba_fulfillable") + 1);
    assert.equal(predating.indexOf("fba_unfulfillable"), predating.indexOf("inbound") + 1);
    assert.equal(
      predating.indexOf("owned_total"),
      predating.indexOf("fba_unfulfillable") + 1,
    );
  });

  test("forces Total on even if hiddenColumns / omitted visibleColumns try to hide it", () => {
    assert.equal(
      resolveVisibleColumns({ hiddenColumns: ["owned_total", "dos"] }).includes("owned_total"),
      true,
    );
    assert.equal(
      resolveVisibleColumns({
        visibleColumns: ["sku", "fba_fulfillable", "awd_on_hand"],
      }).includes("owned_total"),
      true,
    );
  });

  test("FBA column copy is fulfillable only", () => {
    const fba = SKU_TABLE_COLUMNS.find((c) => c.key === "fba_fulfillable");
    assert.ok(fba);
    assert.match(fba.tip, /fulfillable/i);
    assert.match(fba.tip, /Reserved/);
    assert.doesNotMatch(fba.tip, /checked in at Amazon FBA$/);
  });

  test("Reserved and Unfulfillable tips lock Total vs cover", () => {
    const reserved = SKU_TABLE_COLUMNS.find((c) => c.key === "fba_reserved");
    const unfulfillable = SKU_TABLE_COLUMNS.find((c) => c.key === "fba_unfulfillable");
    const total = SKU_TABLE_COLUMNS.find((c) => c.key === "owned_total");
    assert.ok(reserved && unfulfillable && total);
    assert.match(reserved.tip, /in Total/i);
    assert.match(reserved.tip, /not in the FBA cover/i);
    assert.match(unfulfillable.tip, /Not in the FBA cover/i);
    assert.match(unfulfillable.tip, /Not in Total/i);
    assert.match(total.tip, /every SKU/i);
    assert.match(total.tip, /reserved/i);
    assert.match(total.tip, /Unfulfillable/i);
    assert.doesNotMatch(total.tip, /DDPE0003|lip family|lip-only/i);
  });

  test("explicitly hidden Reserved / Unfulfillable stay hidden", () => {
    const hidden = resolveVisibleColumns({
      columns: ["sku", "fba_fulfillable", "inbound"],
      hiddenColumns: ["fba_reserved", "fba_unfulfillable"],
    });
    assert.equal(hidden.includes("fba_reserved"), false);
    assert.equal(hidden.includes("fba_unfulfillable"), false);
    assert.equal(hidden.includes("owned_total"), true);
  });
});

describe("SKU qty cell", () => {
  test("known 0 renders 0; missing row is blank", () => {
    assert.equal(formatSkuQty(0), "0");
    assert.equal(formatSkuQty(null), "—");
    assert.equal(formatSkuQty(undefined), "—");
  });
});

describe("sort column migration", () => {
  test("old FBA on-hand sort key becomes fulfillable", () => {
    assert.equal(migrateSortColumn("fba_on_hand"), "fba_fulfillable");
    assert.equal(migrateSortColumn(null), "fba_fulfillable");
  });
});
