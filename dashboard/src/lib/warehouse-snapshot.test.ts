import assert from "node:assert/strict";
import { describe, test } from "node:test";
import zlib from "node:zlib";

import {
  SNAPSHOT_FORMAT,
  parseSnapshotBytes,
  validateSnapshot,
  type WarehouseSnapshot,
} from "./warehouse-snapshot";

describe("warehouse-snapshot", () => {
  const sample: WarehouseSnapshot = {
    format: SNAPSHOT_FORMAT,
    version: 1,
    exported_at: "2026-08-24T12:00:00.000Z",
    table_meta: { sku_costs: { row_count: 1, status: "ok" } },
    errors: [],
    tables: { sku_costs: [{ sku: "TB-01", unit_cost: 3.5 }] },
  };

  test("validate accepts v1 snapshot", () => {
    validateSnapshot(sample);
  });

  test("parse gzip round-trip", () => {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(sample), "utf-8"));
    const parsed = parseSnapshotBytes(gz);
    assert.equal(parsed.format, SNAPSHOT_FORMAT);
    assert.equal(parsed.tables.sku_costs?.length, 1);
  });

  test("reject unknown format", () => {
    assert.throws(
      () => validateSnapshot({ ...sample, format: "other" }),
      /Unknown snapshot format/,
    );
  });
});
