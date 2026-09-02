import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isNotSellingSku, notSellingSkuSet } from "./inventory-sku-flags";

describe("not-selling SKU flags", () => {
  test("empty and false flags produce an empty set", () => {
    assert.equal(notSellingSkuSet(null).size, 0);
    assert.equal(notSellingSkuSet([]).size, 0);
    assert.equal(notSellingSkuSet([{ sku: "A", not_selling: false }]).size, 0);
  });

  test("true flags match case-insensitively", () => {
    const hidden = notSellingSkuSet([
      { sku: "DDPE0011Shop", not_selling: true },
    ]);
    assert.equal(isNotSellingSku("DDPE0011Shop", hidden), true);
    assert.equal(isNotSellingSku("ddpe0011shop", hidden), true);
    assert.equal(isNotSellingSku("DDPE0001Shop", hidden), false);
  });
});
