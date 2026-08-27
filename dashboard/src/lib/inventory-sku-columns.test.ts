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
  test("Total is always in the default visible set; no Reserved or Unfulfillable column", () => {
    assert.equal(DEFAULT_VISIBLE_COLUMN_KEYS.includes("owned_total"), true);
    assert.equal(ALWAYS_VISIBLE_COLUMN_KEYS.includes("owned_total"), true);
    const labels = visibleSkuTableColumns(null).map((c) => c.label);
    assert.deepEqual(labels.slice(0, 9), [
      "SKU",
      "FBA",
      "AWD",
      "3PL",
      "Inbnd",
      "Total Amazon",
      "Total",
      "V7",
      "V30",
    ]);
    assert.equal(DEFAULT_VISIBLE_COLUMN_KEYS.includes("total_amazon"), true);
    assert.equal(ALWAYS_VISIBLE_COLUMN_KEYS.includes("total_amazon"), true);
    assert.equal(labels.includes("Reserved"), false);
    assert.equal(labels.includes("Unfulfillable"), false);
    const keys = SKU_TABLE_COLUMNS.map((c) => c.key as string);
    assert.equal(keys.includes("fba_reserved"), false);
    assert.equal(keys.includes("fba_unfulfillable"), false);
    assert.equal(
      SKU_TABLE_COLUMNS.some((c) => /expired|inventory.?age/i.test(c.key) || /expired|age/i.test(c.label)),
      false,
    );
  });

  test("forces Total on when saved prefs predate the column", () => {
    const predating = resolveVisibleColumns({
      columns: ["sku", "fba_on_hand", "awd_on_hand", "tpl_available", "inbound", "total_u_7", "total_u_30"],
    });
    assert.equal(predating.includes("owned_total"), true);
    assert.equal(predating.includes("fba_fulfillable"), true);
    assert.equal(predating.includes("fba_on_hand" as never), false);
    assert.equal(predating.includes("fba_reserved" as never), false);
    assert.equal(predating.includes("fba_unfulfillable" as never), false);
    assert.equal(predating.includes("total_amazon"), true);
    assert.equal(
      predating.indexOf("total_amazon"),
      predating.indexOf("inbound") + 1,
    );
    assert.equal(
      predating.indexOf("owned_total"),
      predating.indexOf("total_amazon") + 1,
    );
  });

  test("forces Total Amazon and Total on even if hidden / omitted", () => {
    assert.equal(
      resolveVisibleColumns({ hiddenColumns: ["owned_total", "total_amazon", "dos"] }).includes(
        "owned_total",
      ),
      true,
    );
    assert.equal(
      resolveVisibleColumns({ hiddenColumns: ["owned_total", "total_amazon"] }).includes(
        "total_amazon",
      ),
      true,
    );
    assert.equal(
      resolveVisibleColumns({
        visibleColumns: ["sku", "fba_fulfillable", "awd_on_hand"],
      }).includes("owned_total"),
      true,
    );
    assert.equal(
      resolveVisibleColumns({
        visibleColumns: ["sku", "fba_fulfillable", "awd_on_hand"],
      }).includes("total_amazon"),
      true,
    );
  });

  test("FBA column copy is Seller Central on-hand, not API fulfillable alone", () => {
    const fba = SKU_TABLE_COLUMNS.find((c) => c.key === "fba_fulfillable");
    assert.ok(fba);
    assert.match(fba.tip, /Seller Central on-hand/i);
    assert.match(fba.tip, /FC transfer/i);
    assert.doesNotMatch(fba.tip, /fulfillable units only/i);
    assert.doesNotMatch(fba.tip, /checked in at Amazon FBA$/);
  });

  test("Total Amazon and Total tips lock the formula; no extra columns", () => {
    const amz = SKU_TABLE_COLUMNS.find((c) => c.key === "total_amazon");
    const total = SKU_TABLE_COLUMNS.find((c) => c.key === "owned_total");
    assert.ok(amz);
    assert.ok(total);
    assert.match(amz.tip, /researching/i);
    assert.match(amz.tip, /Not unfulfillable/i);
    assert.match(amz.tip, /FC transfer/i);
    assert.match(total.tip, /Total Amazon \+ 3PL/i);
    assert.match(total.tip, /every SKU/i);
    assert.match(total.tip, /not a column/i);
    assert.doesNotMatch(total.tip, /DDPE0003|lip family|lip-only/i);
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
