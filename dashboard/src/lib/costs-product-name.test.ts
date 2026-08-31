import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  attachCostProductNames,
  nonemptyName,
  skuCostWriteRow,
} from "./costs-product-name";

function src(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("attachCostProductNames", () => {
  test("uses sku_velocity name when sku_costs.product_name is null", () => {
    const costs = attachCostProductNames(
      [{ sku: "DDPE0001Shop", product_name: null, cogs_per_unit: 2.49 }],
      [{ sku: "DDPE0001Shop", product_name: "Unscented 3pk" }],
    );
    assert.equal(costs[0].product_name, "Unscented 3pk");
    assert.equal(costs[0].cogs_per_unit, 2.49);
  });

  test("matches Shop suffix variants DDPE0001Shop ↔ DDPE0001", () => {
    const fromBare = attachCostProductNames(
      [{ sku: "DDPE0001Shop", product_name: null }],
      [{ sku: "DDPE0001", product_name: "Unscented" }],
    );
    assert.equal(fromBare[0].product_name, "Unscented");

    const fromShop = attachCostProductNames(
      [{ sku: "DDPE0001", product_name: null }],
      [{ sku: "DDPE0001Shop", product_name: "Unscented 3pk" }],
    );
    assert.equal(fromShop[0].product_name, "Unscented 3pk");
  });

  test("sku_costs.product_name wins over sku_velocity", () => {
    const costs = attachCostProductNames(
      [{ sku: "DDPE0001Shop", product_name: "Seller name" }],
      [{ sku: "DDPE0001Shop", product_name: "Velocity name" }],
    );
    assert.equal(costs[0].product_name, "Seller name");
  });

  test("missing velocity name stays null — never invents", () => {
    const costs = attachCostProductNames(
      [{ sku: "DDPE0099Shop", product_name: null }],
      [{ sku: "DDPE0001Shop", product_name: "Unscented" }],
    );
    assert.equal(costs[0].product_name, null);
  });

  test("blank / whitespace cost name falls back; blank velocity stays null", () => {
    const fallback = attachCostProductNames(
      [{ sku: "DDPE0002Shop", product_name: "   " }],
      [{ sku: "DDPE0002Shop", product_name: "Peppermint" }],
    );
    assert.equal(fallback[0].product_name, "Peppermint");

    const blankVel = attachCostProductNames(
      [{ sku: "DDPE0002Shop", product_name: null }],
      [{ sku: "DDPE0002Shop", product_name: "  " }],
    );
    assert.equal(blankVel[0].product_name, null);
    assert.equal(nonemptyName("  "), null);
    assert.equal(nonemptyName(undefined), null);
  });

  test("GET includes names for SKUs in sku_velocity; missing stays blank", () => {
    const named = attachCostProductNames(
      [
        { sku: "DDPE0001Shop", product_name: null, cogs_per_unit: 2.49 },
        { sku: "MISSING", product_name: null, cogs_per_unit: 1 },
      ],
      [{ sku: "DDPE0001", product_name: "Unscented 3pk" }],
    );
    assert.equal(named.find((c) => c.sku === "DDPE0001Shop")?.product_name, "Unscented 3pk");
    assert.equal(named.find((c) => c.sku === "MISSING")?.product_name, null);
  });
});

describe("skuCostWriteRow", () => {
  test("PUT without product_name still writes cogs_per_unit", () => {
    const row = skuCostWriteRow({
      sku: "DDPE0001Shop",
      cogs_per_unit: 3.1,
      source: "dashboard",
      includeProductName: false,
    });
    assert.equal(row.sku, "DDPE0001Shop");
    assert.equal(row.cogs_per_unit, 3.1);
    assert.equal("product_name" in row, false);
  });

  test("PUT with product_name persists both fields and does not throw", () => {
    const row = skuCostWriteRow({
      sku: "DDPE0001Shop",
      cogs_per_unit: 3.1,
      product_name: "Unscented 3pk",
      source: "dashboard",
      includeProductName: true,
    });
    assert.equal(row.cogs_per_unit, 3.1);
    assert.equal(row.product_name, "Unscented 3pk");
  });
});

describe("costs API + page wiring", () => {
  test("GET joins sku_velocity; PUT/POST still write product_name to sku_costs", () => {
    const route = src("src/app/api/costs/route.ts");
    const page = src("src/app/costs/page.tsx");
    const helper = src("src/lib/costs-product-name.ts");
    const migration = src("../supabase/migration_sku_costs.sql");

    assert.match(helper, /attachCostProductNames/);
    assert.match(helper, /sku_velocity/);
    assert.match(route, /attachCostProductNames/);
    assert.match(route, /sku_velocity/);
    assert.match(route, /skuCostWriteRow/);
    assert.match(route, /includeProductName/);
    assert.match(route, /product_name/);
    assert.doesNotMatch(route, /DROP COLUMN/);

    assert.match(page, /c\.product_name/);
    assert.match(page, /product_name \?\? ""/);
    assert.match(page, /product_name: name/);

    assert.match(migration, /ADD COLUMN IF NOT EXISTS product_name text/);
    assert.doesNotMatch(migration, /DROP COLUMN.*product_name/i);
  });
});
