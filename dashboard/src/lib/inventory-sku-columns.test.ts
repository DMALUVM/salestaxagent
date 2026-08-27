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
    assert.deepEqual(labels.slice(0, 8), [
      "SKU",
      "FBA",
      "AWD",
      "3PL",
      "Inbnd",
      "Total",
      "V7",
      "V30",
    ]);
  });

  test("forces Total on when saved prefs predate the column", () => {
    const predating = resolveVisibleColumns({
      columns: ["sku", "fba_on_hand", "awd_on_hand", "tpl_available", "inbound", "total_u_7", "total_u_30"],
    });
    assert.equal(predating.includes("owned_total"), true);
    assert.equal(predating.includes("fba_fulfillable"), true);
    assert.equal(predating.includes("fba_on_hand" as never), false);
    assert.equal(
      predating.indexOf("owned_total"),
      predating.indexOf("inbound") + 1,
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
